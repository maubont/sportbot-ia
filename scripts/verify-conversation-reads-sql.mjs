#!/usr/bin/env node
// SB-106 + SB-107: pruebas rigurosas de conversation_reads y unread_counts.
//
// Cada escenario usa conversaciones independientes y se ejecuta dentro de su
// propia transacción (BEGIN/COMMIT), así que un error esperado (RAISE
// EXCEPTION) no contamina el resto. Patrón idéntico a
// scripts/verify-human-messaging-sql.mjs (PGlite + assert).
//   * is_admin() se mockea a TRUE.
//   * auth.uid() se mockea como el operador actor (constante). La validación
//     cross-operador de admin_conversation_unread_counts se prueba pasando un
//     p_user_id distinto dentro de un SAVEPOINT. En Supabase real, auth.uid()
//     lee el JWT del invocador.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261102120000_conversation_reads.sql"), "utf8");
const db = new PGlite();

const ACTOR = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";
const CUSTOMER = "00000000-0000-4000-8000-000000000003";
const CLOSED = "00000000-0000-4000-8000-000000000050";

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS $$ SELECT '${ACTOR}'::uuid $$;
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
CREATE TABLE public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner','admin','operator'))
);
CREATE TABLE public.customers (id UUID PRIMARY KEY, phone_e164 TEXT);
CREATE TABLE public.conversations (
    id UUID PRIMARY KEY,
    customer_id UUID REFERENCES public.customers(id),
    status TEXT NOT NULL DEFAULT 'open',
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_message_at TIMESTAMPTZ
);
CREATE TABLE public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES public.conversations(id),
    direction TEXT NOT NULL,
    role TEXT NOT NULL,
    body TEXT,
    channel TEXT NOT NULL DEFAULT 'evolution',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.conversation_state (
    conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id),
    stage TEXT NOT NULL DEFAULT 'browsing',
    handoff_status TEXT NOT NULL DEFAULT 'bot',
    bot_paused_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

await db.exec(schema);
await db.exec(migration);

// Datos base en su propia transacción.
await db.query(`BEGIN`);
await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'actor@example.test'),($2,'other@example.test')`, [ACTOR, OTHER]);
await db.query(`INSERT INTO public.admin_users (user_id,email,role) VALUES ($1,'actor@example.test','operator'),($2,'other@example.test','operator')`, [ACTOR, OTHER]);
await db.query(`INSERT INTO public.customers (id,phone_e164) VALUES ($1,'+12025550102')`, [CUSTOMER]);
await db.query(`INSERT INTO public.conversations (id,customer_id,status) VALUES ($1,$2,'closed')`, [CLOSED, CUSTOMER]);
await db.query(`COMMIT`);

let checks = 0;
// Cada check corre en su propia transacción para aislar errores esperados.
async function check(name, run) {
    await db.query(`BEGIN`);
    try {
        await run();
        await db.query(`COMMIT`);
        checks++;
        console.log(`✓ ${name}`);
    } catch (err) {
        await db.query(`ROLLBACK`).catch(() => undefined);
        console.error(`✖ ${name}: ${err.message}`);
        throw err;
    }
}

async function newOpenConversation(id) {
    await db.query(`INSERT INTO public.conversations (id,customer_id,status) VALUES ($1,$2,'open')`, [id, CUSTOMER]);
    return id;
}
async function seedInbound(conversationId, count = 3) {
    const values = [];
    const params = [];
    const now = Date.now();
    for (let i = 0; i < count; i++) {
        const minutesAgo = (count - i) * 10;
        values.push(`($${params.length + 1},$${params.length + 2},$${params.length + 3},$${params.length + 4},$${params.length + 5})`);
        params.push(conversationId, 'inbound', 'user', `cliente mensaje ${i + 1}`, new Date(now - minutesAgo * 60_000));
    }
    await db.query(`INSERT INTO public.messages (conversation_id,direction,role,body,created_at) VALUES ${values.join(',')}`, params);
}

const convMark = "00000000-0000-4000-8000-000000000101";
const convIdem = "00000000-0000-4000-8000-000000000102";
const convOther = "00000000-0000-4000-8000-000000000103";
const convUnreadActor = "00000000-0000-4000-8000-000000000104";
const convUnreadOther = "00000000-0000-4000-8000-000000000105";
const convOutbound = "00000000-0000-4000-8000-000000000107";

// Tabla existe con PK composite y RLS activa.
await check("tabla conversation_reads con PK composite y RLS", async () => {
    const rel = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='conversation_reads'`);
    assert.equal(rel.rows[0].relrowsecurity, true);
    const cons = await db.query(`
        SELECT contype FROM pg_constraint
        WHERE conrelid='public.conversation_reads'::regclass AND contype='p'
    `);
    assert.equal(cons.rows.length, 1);
});

// Operador no admin es rechazado.
await check("requiere administrador", async () => {
    const noAdmin = "00000000-0000-4000-8000-000000000008";
    const res = await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [convMark, noAdmin]);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'admin_required');
});

// Conversación cerrada no se puede marcar.
await check("rechaza conversación cerrada", async () => {
    const res = await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [CLOSED, ACTOR]);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'conversation_not_open');
});

// Marcar lectura devuelve last_message_id y read_at.
await check("marcar lectura registra read_at y último mensaje", async () => {
    await newOpenConversation(convMark);
    await seedInbound(convMark);
    const { rows: msgs } = await db.query(`SELECT id FROM public.messages WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 1`, [convMark]);
    const lastMessageId = msgs[0].id;
    const res = await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [convMark, ACTOR]);
    assert.equal(res.rows[0].result.success, true);
    assert.equal(res.rows[0].result.last_message_id, lastMessageId);
    assert.ok(res.rows[0].result.read_at);
});

// Marcar dos veces es idempotente (una sola fila por conversación+operador).
await check("marcar lectura es idempotente (una fila por conversación+operador)", async () => {
    await newOpenConversation(convIdem);
    await seedInbound(convIdem);
    await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [convIdem, ACTOR]);
    await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [convIdem, ACTOR]);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.conversation_reads WHERE conversation_id=$1 AND user_id=$2`, [convIdem, ACTOR]);
    assert.equal(rows[0].n, 1);
});

// Otro operador conserva su propia fila de lectura (no comparte con actor).
await check("otro operador conserva su propia fila de lectura", async () => {
    await newOpenConversation(convOther);
    await seedInbound(convOther);
    const res = await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [convOther, OTHER]);
    assert.equal(res.rows[0].result.success, true);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.conversation_reads WHERE conversation_id=$1 AND user_id=$2`, [convOther, OTHER]);
    assert.equal(rows[0].n, 1);
});

// Sin leer: actor ve 3 no leídos (sin fila de lectura → read_at NULL → todos cuentan).
await check("sin leer el actor ve 3 no leídos", async () => {
    await newOpenConversation(convUnreadActor);
    await seedInbound(convUnreadActor);
    const { rows } = await db.query(`SELECT * FROM public.admin_conversation_unread_counts($1)`, [ACTOR]);
    const row = rows.find((r) => r.conversation_id === convUnreadActor);
    assert.ok(row, `conversación ${convUnreadActor} presente en conteos`);
    assert.equal(row.unread_count, 3);
});

// Tras leer del actor: 0 no leídos para él (read_at = ahora, mensajes son del pasado).
await check("tras leer del actor: 0 no leídos para el actor", async () => {
    await db.query(`SELECT public.admin_mark_conversation_read($1,$2) AS result`, [convUnreadActor, ACTOR]);
    const { rows } = await db.query(`SELECT * FROM public.admin_conversation_unread_counts($1)`, [ACTOR]);
    const row = rows.find((r) => r.conversation_id === convUnreadActor);
    assert.equal(row.unread_count, 0);
});

// Una conversación que el actor no leyó sigue contando 3 no leídos para él.
await check("una conversación ajena sigue contando no leídos para el actor", async () => {
    await newOpenConversation(convUnreadOther);
    await seedInbound(convUnreadOther);
    const { rows } = await db.query(`SELECT * FROM public.admin_conversation_unread_counts($1)`, [ACTOR]);
    const row = rows.find((r) => r.conversation_id === convUnreadOther);
    assert.equal(row.unread_count, 3);
});

// Un operador no puede consultar los conteos de otro (auth.uid()).
// Se aísla con SAVEPOINT porque RAISE EXCEPTION aborta la transacción.
await check("rechaza consultar conteos de otro operador", async () => {
    await db.query("SAVEPOINT sp_reject");
    try {
        await db.query(`SELECT * FROM public.admin_conversation_unread_counts($1)`, [OTHER]);
        throw new Error("debió rechazar la consulta de otro operador");
    } catch {
        await db.query("ROLLBACK TO sp_reject");
        await db.query("RELEASE SAVEPOINT sp_reject");
    }
});

// Los mensajes outbound del operador no cuentan como no leídos.
await check("outbound del operador no cuenta como no leído", async () => {
    await newOpenConversation(convOutbound);
    await db.query(`INSERT INTO public.messages (conversation_id,direction,role,body) VALUES
      ($1,'outbound','agent','solo yo escribí'),
      ($1,'inbound','user','cliente escribió')`, [convOutbound]);
    const { rows } = await db.query(`SELECT * FROM public.admin_conversation_unread_counts($1)`, [ACTOR]);
    const row = rows.find((r) => r.conversation_id === convOutbound);
    assert.equal(row.unread_count, 1);
});

// Conversaciones cerradas no aparecen en conteos.
await check("conversaciones cerradas no aparecen", async () => {
    const { rows } = await db.query(`SELECT * FROM public.admin_conversation_unread_counts($1)`, [ACTOR]);
    assert.ok(!rows.find((r) => r.conversation_id === CLOSED), 'conversación cerrada no debe aparecer');
});

// Privilegios: navegador (authenticated) ejecuta ambos RPCs; anon no.
await check("privilegios de ejecución de RPCs", async () => {
    const perms = await db.query(`
        SELECT
          has_function_privilege('authenticated','public.admin_mark_conversation_read(uuid,uuid)','EXECUTE') AS auth_mark,
          has_function_privilege('authenticated','public.admin_conversation_unread_counts(uuid)','EXECUTE') AS auth_counts,
          has_function_privilege('anon','public.admin_mark_conversation_read(uuid,uuid)','EXECUTE') AS anon_mark,
          has_function_privilege('anon','public.admin_conversation_unread_counts(uuid)','EXECUTE') AS anon_counts,
          has_table_privilege('authenticated','public.conversation_reads','INSERT') AS browser_insert,
          has_table_privilege('service_role','public.conversation_reads','INSERT') AS service_insert
    `);
    assert.deepEqual(perms.rows[0], {
        auth_mark: true, auth_counts: true, anon_mark: false, anon_counts: false,
        browser_insert: false, service_insert: true,
    });
});

await db.close();
console.log(`\n${checks} conversation-reads SQL checks passed.`);
