#!/usr/bin/env node
// SB-111: pruebas rigurosas de inbox_notification_preferences,
// inbox_activity_feed y la vista inbox_first_response_pending.
//
// Patrón idéntico a scripts/verify-human-messaging-sql.mjs (PGlite + assert).
//   * is_admin() se mockea a TRUE.
//   * auth.uid() se mockea como el operador actor (constante ACTOR).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261106120000_inbox_notifications_activity.sql"), "utf8");
const db = new PGlite();

const ACTOR = "00000000-0000-4000-8000-000000000001";
const OTHER = "00000000-0000-4000-8000-000000000002";

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
CREATE TABLE public.customers (
    id UUID PRIMARY KEY,
    name TEXT,
    phone_e164 TEXT
);
CREATE TABLE public.conversations (
    id UUID PRIMARY KEY,
    customer_id UUID REFERENCES public.customers(id),
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
CREATE TABLE public.admin_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

await db.exec(schema);
await db.exec(migration);

// Datos base.
await db.query(`BEGIN`);
await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'actor@example.test'),($2,'other@example.test')`, [ACTOR, OTHER]);
await db.query(`INSERT INTO public.admin_users (user_id,email,role) VALUES ($1,'actor@example.test','operator'),($2,'other@example.test','operator')`, [ACTOR, OTHER]);
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

async function insertCustomer(id, name, phone) {
    await db.query(`INSERT INTO public.customers (id,name,phone_e164) VALUES ($1,$2,$3)`, [id, name, phone]);
}
async function insertConversation(id, customerId, status = 'open', lastMessageAt = null) {
    if (lastMessageAt) {
        await db.query(`INSERT INTO public.conversations (id,customer_id,status,last_message_at) VALUES ($1,$2,$3,$4)`, [id, customerId, status, lastMessageAt]);
    } else {
        await db.query(`INSERT INTO public.conversations (id,customer_id,status) VALUES ($1,$2,$3)`, [id, customerId, status]);
    }
}
async function insertMessage(conversationId, body, direction = 'inbound', role = 'user', minutesAgo = 0) {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    await db.query(`INSERT INTO public.messages (conversation_id,direction,role,body,created_at) VALUES ($1,$2,$3,$4,$5)`, [conversationId, direction, role, body, createdAt]);
}

const cust1 = "00000000-0000-4000-8000-000000000111";
const conv1 = "00000000-0000-4000-8000-000000000333";
const conv2 = "00000000-0000-4000-8000-000000000444";

// Operador inserta sus propias preferencias de notificación.
await check("operador inserta preferencias propias", async () => {
    await db.query(`INSERT INTO public.inbox_notification_preferences (user_id, sound_enabled, sound_volume, notify_new_message, notify_when_in_thread, silent_mode) VALUES ($1,true,0.7,true,false,false)`, [ACTOR]);
    const { rows } = await db.query(`SELECT * FROM public.inbox_notification_preferences WHERE user_id=$1`, [ACTOR]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sound_enabled, true);
    assert.equal(rows[0].sound_volume, 0.7);
});

// Datos de cliente y conversación para tests de actividad.
await insertCustomer(cust1, 'Juan Perez', '+12025550101');
await insertConversation(conv1, cust1, 'open');
await insertMessage(conv1, 'Hola, ¿tienen Nike 42?', 'inbound', 'user', 5);

// Tabla de actividad existe con RLS y check de event_type.
await check("tabla inbox_activity_feed con RLS y check de evento", async () => {
    const rel = await db.query(`SELECT relrowsecurity FROM pg_class WHERE relname='inbox_activity_feed'`);
    assert.equal(rel.rows[0].relrowsecurity, true);
    const cons = await db.query(`
        SELECT contype FROM pg_constraint
        WHERE conrelid='public.inbox_activity_feed'::regclass AND contype='c'
    `);
    assert.ok(cons.rows.length >= 1, 'debe tener CHECK de event_type');
});

// Insertar actividad de nuevo mensaje.
await check("insertar actividad de nuevo mensaje", async () => {
    const res = await db.query(`SELECT public.admin_inbox_activity_log($1,$2,$3,$4,$5) AS result`, [conv1, ACTOR, 'new_message', 'customer', 'Hola, ¿tienen Nike 42?']);
    assert.equal(res.rows[0].result.success, true);
    assert.ok(res.rows[0].result.id);
});

// Activity feed no permite insertar como service_role desde navegador (solo authenticated + service_role tienen EXECUTE).
await check("privilegios de ejecución de admin_inbox_activity_log", async () => {
    const perms = await db.query(`
        SELECT
          has_function_privilege('authenticated','public.admin_inbox_activity_log(uuid,uuid,text,text,text)','EXECUTE') AS auth_exec,
          has_function_privilege('anon','public.admin_inbox_activity_log(uuid,uuid,text,text,text)','EXECUTE') AS anon_exec,
          has_function_privilege('service_role','public.admin_inbox_activity_log(uuid,uuid,text,text,text)','EXECUTE') AS service_exec
    `);
    assert.deepEqual(perms.rows[0], {
        auth_exec: true, anon_exec: false, service_exec: true,
    });
});

// Vista inbox_first_response_pending: conversación abierta con inbound y sin respuesta de agent.
await check("vista inbox_first_response_pending detecta primera respuesta pendiente", async () => {
    await insertConversation(conv2, cust1, 'open');
    await insertMessage(conv2, 'Mensaje sin respuesta', 'inbound', 'user', 10);
    const { rows } = await db.query(`SELECT * FROM public.inbox_first_response_pending WHERE conversation_id=$1`, [conv2]);
    assert.equal(rows.length, 1, 'conversación sin respuesta debe aparecer');
    assert.ok(rows[0].seconds_pending > 0, 'segundos pendientes debe ser positivo');
    assert.equal(rows[0].match_type, undefined, 'vista no tiene match_type (es de conversaciones)');
});

// Vista no incluye conversación ya respondida por agent.
await check("vista no incluye conversación con respuesta de agent", async () => {
    await insertConversation("00000000-0000-4000-8000-000000000555", cust1, 'open');
    await insertMessage("00000000-0000-4000-8000-000000000555", 'Mensaje con respuesta', 'inbound', 'user', 10);
    await insertMessage("00000000-0000-4000-8000-000000000555", 'Respuesta del agente', 'outbound', 'agent', 5);
    const { rows } = await db.query(`SELECT * FROM public.inbox_first_response_pending WHERE conversation_id='00000000-0000-4000-8000-000000000555'`);
    assert.equal(rows.length, 0, 'conversación ya respondida no debe aparecer');
});

// Conversación cerrada no aparece en la vista.
await check("vista no incluye conversación cerrada", async () => {
    await insertConversation("00000000-0000-4000-8000-000000000666", cust1, 'closed');
    await insertMessage("00000000-0000-4000-8000-000000000666", 'Mensaje en cerrada', 'inbound', 'user', 10);
    const { rows } = await db.query(`SELECT * FROM public.inbox_first_response_pending WHERE conversation_id='00000000-0000-4000-8000-000000000666'`);
    assert.equal(rows.length, 0, 'conversación cerrada no debe aparecer');
});

// Preferencias: verifica que el policy de RLS restringe por usuario propio.
await check("preferencias: policy RLS restringe por usuario propio", async () => {
    const { rows } = await db.query(`
        SELECT policyname, qual
        FROM pg_policies
        WHERE tablename = 'inbox_notification_preferences'
    `);
    assert.ok(rows.length >= 1, 'debe existir al menos un policy');
    const qualText = rows.map((r) => r.qual).join(' ');
    assert.ok(qualText.includes('user_id = auth.uid()'), 'policy debe restringir por auth.uid()');
});

// Activity feed: lectura como autenticado.
await check("activity feed: lectura autenticada", async () => {
    const { rows } = await db.query(`SELECT * FROM public.inbox_activity_feed WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 5`, [conv1]);
    assert.ok(rows.length >= 1, 'debe haber al menos una actividad');
    assert.ok(rows.some((r) => r.event_type === 'new_message'), 'debe contener evento new_message');
});

await db.close();
console.log(`\n${checks} inbox-notifications-activity SQL checks passed.`);
