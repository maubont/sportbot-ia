#!/usr/bin/env node
// SB-109: pruebas rigurosas de conversation_closures (cierre con motivo,
// reapertura y despedida opt-in).
//
// Cada escenario usa conversaciones únicas y su propia transacción
// (BEGIN/COMMIT) para aislar errores esperados. Patrón idéntico a
// scripts/verify-human-messaging-sql.mjs (PGlite + assert).
//   * is_admin() se mockea a TRUE.
//   * auth.uid() se mockea como el operador actor (constante ACTOR).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261104120000_conversation_closures.sql"), "utf8");
const db = new PGlite();

const ACTOR = "00000000-0000-4000-8000-000000000001";
const GHOST = "00000000-0000-4000-8000-000000000009";
const CUSTOMER = "00000000-0000-4000-8000-000000000003";

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
CREATE TABLE public.conversation_operator_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

await db.exec(schema);
await db.exec(migration);

// Datos base.
await db.query(`BEGIN`);
await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'actor@example.test'),($2,'ghost@example.test')`, [ACTOR, GHOST]);
await db.query(`INSERT INTO public.admin_users (user_id,email,role) VALUES ($1,'actor@example.test','operator')`, [ACTOR]);
await db.query(`INSERT INTO public.customers (id,phone_e164) VALUES ($1,'+12025550102')`, [CUSTOMER]);
await db.query(`COMMIT`);

let checks = 0;
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

const convAdmin = "00000000-0000-4000-8000-000000000301";
const convEmpty = "00000000-0000-4000-8000-000000000302";
const convCloseOk = "00000000-0000-4000-8000-000000000303";
const convAlreadyClosed = "00000000-0000-4000-8000-000000000304";
const convReopenOk = "00000000-0000-4000-8000-000000000305";
const convReopenNoReason = "00000000-0000-4000-8000-000000000306";
const convReopenOpen = "00000000-0000-4000-8000-000000000307";
const convEvents = "00000000-0000-4000-8000-000000000308";

// Tabla existe con PK y RLS activa.
await check("tabla conversation_closures con PK y RLS", async () => {
    const rel = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='conversation_closures'`);
    assert.equal(rel.rows[0].relrowsecurity, true);
    const cons = await db.query(`
        SELECT contype FROM pg_constraint
        WHERE conrelid='public.conversation_closures'::regclass AND contype='p'
    `);
    assert.equal(cons.rows.length, 1);
});

// Requiere administrador (usuario no registrado en admin_users).
await check("requiere administrador para cerrar", async () => {
    await newOpenConversation(convAdmin);
    const res = await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convAdmin, GHOST, 'prueba']);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'admin_required');
});

// Rechaza motivo vacío.
await check("rechaza motivo de cierre vacío", async () => {
    await newOpenConversation(convEmpty);
    const res = await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convEmpty, ACTOR, '   ']);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'close_reason_required');
});

// Cerrar conversación abierta guarda motivo y actor.
await check("cerrar conversación abierta con motivo y actor", async () => {
    await newOpenConversation(convCloseOk);
    const res = await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convCloseOk, ACTOR, 'cliente atendido, pedido despachado']);
    assert.equal(res.rows[0].result.success, true);
    assert.equal(res.rows[0].result.status, 'closed');
    assert.equal(res.rows[0].result.close_reason, 'cliente atendido, pedido despachado');
    assert.ok(res.rows[0].result.closed_at);
    const { rows } = await db.query(`SELECT status FROM public.conversations WHERE id=$1`, [convCloseOk]);
    assert.equal(rows[0].status, 'closed');
});

// No se puede cerrar una conversación ya cerrada.
await check("no cierra conversación ya cerrada", async () => {
    await newOpenConversation(convAlreadyClosed);
    await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convAlreadyClosed, ACTOR, 'primero']);
    const res = await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convAlreadyClosed, ACTOR, 'segundo']);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'conversation_already_closed');
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM public.conversation_closures WHERE conversation_id=$1`, [convAlreadyClosed]);
    assert.equal(rows[0].n, 1, 'una sola fila de cierre');
});

// Reabrir conversación cerrada con actor y motivo.
await check("reabrir conversación cerrada con actor y motivo", async () => {
    await newOpenConversation(convReopenOk);
    await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convReopenOk, ACTOR, 'cerrado por prueba']);
    const res = await db.query(`SELECT public.admin_reopen_conversation($1,$2,$3) AS result`, [convReopenOk, ACTOR, 'cliente volvió a escribir']);
    assert.equal(res.rows[0].result.success, true);
    assert.equal(res.rows[0].result.status, 'open');
    assert.equal(res.rows[0].result.reopen_reason, 'cliente volvió a escribir');
    assert.ok(res.rows[0].result.reopened_at);
    const { rows } = await db.query(`SELECT status FROM public.conversations WHERE id=$1`, [convReopenOk]);
    assert.equal(rows[0].status, 'open');
    const { rows: closures } = await db.query(`SELECT reopened_at, reopened_by FROM public.conversation_closures WHERE conversation_id=$1`, [convReopenOk]);
    assert.ok(closures[0].reopened_at);
    assert.equal(closures[0].reopened_by, ACTOR);
});

// Reabrir sin motivo se acepta (motivo opcional).
await check("reabrir sin motivo se acepta", async () => {
    await newOpenConversation(convReopenNoReason);
    await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convReopenNoReason, ACTOR, 'cerrado']);
    const res = await db.query(`SELECT public.admin_reopen_conversation($1,$2) AS result`, [convReopenNoReason, ACTOR]);
    assert.equal(res.rows[0].result.success, true);
    assert.equal(res.rows[0].result.reopen_reason, '');
});

// No se puede reabrir una conversación abierta.
await check("no reabre conversación abierta", async () => {
    await newOpenConversation(convReopenOpen);
    const res = await db.query(`SELECT public.admin_reopen_conversation($1,$2) AS result`, [convReopenOpen, ACTOR]);
    assert.equal(res.rows[0].result.success, false);
    assert.equal(res.rows[0].result.code, 'conversation_not_closed');
});

// Registro de eventos de cierre y reapertura.
await check("registra eventos closed y reopened", async () => {
    await newOpenConversation(convEvents);
    await db.query(`SELECT public.admin_close_conversation($1,$2,$3) AS result`, [convEvents, ACTOR, 'resuelto']);
    await db.query(`SELECT public.admin_reopen_conversation($1,$2,$3) AS result`, [convEvents, ACTOR, 'seguimiento']);
    const { rows } = await db.query(`SELECT event_type FROM public.conversation_operator_events WHERE conversation_id=$1 ORDER BY created_at ASC`, [convEvents]);
    const types = rows.map((r) => r.event_type);
    assert.ok(types.includes('closed'), 'evento closed registrado');
    assert.ok(types.includes('reopened'), 'evento reopened registrado');
});

// Privilegios de RPCs.
await check("privilegios de ejecución de RPCs de cierre", async () => {
    const perms = await db.query(`
        SELECT
          has_function_privilege('authenticated','public.admin_close_conversation(uuid,uuid,text)','EXECUTE') AS auth_close,
          has_function_privilege('authenticated','public.admin_reopen_conversation(uuid,uuid,text)','EXECUTE') AS auth_reopen,
          has_function_privilege('anon','public.admin_close_conversation(uuid,uuid,text)','EXECUTE') AS anon_close
    `);
    assert.deepEqual(perms.rows[0], {
        auth_close: true, auth_reopen: true, anon_close: false,
    });
});

await db.close();
console.log(`\n${checks} conversation-closures SQL checks passed.`);
