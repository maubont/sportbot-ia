#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(join(root, "supabase/migrations/20261029120000_admin_human_messaging.sql"), "utf8");
const readOnlyMigration = readFileSync(join(root, "supabase/migrations/20261029130000_admin_messages_read_only.sql"), "utf8");
const db = new PGlite();

const schema = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
CREATE TABLE public.admin_users (user_id UUID PRIMARY KEY REFERENCES auth.users(id), email TEXT, role TEXT NOT NULL);
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
CREATE TABLE public.customers (id UUID PRIMARY KEY, phone_e164 TEXT);
CREATE TABLE public.conversations (id UUID PRIMARY KEY, customer_id UUID REFERENCES public.customers(id), status TEXT DEFAULT 'open', updated_at TIMESTAMPTZ DEFAULT NOW(), last_message_at TIMESTAMPTZ);
CREATE TABLE public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id UUID REFERENCES public.conversations(id),
  direction TEXT NOT NULL, role TEXT NOT NULL, body TEXT, channel TEXT NOT NULL DEFAULT 'twilio',
  provider_message_id TEXT, twilio_message_sid TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE public.conversation_state (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id), stage TEXT NOT NULL DEFAULT 'browsing',
  handoff_status TEXT NOT NULL DEFAULT 'bot', bot_paused_until TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW()
);
`;

await db.exec(schema);
await db.exec(migration);
await db.exec(readOnlyMigration);

const actor = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const customer = "00000000-0000-4000-8000-000000000003";
const conversation = "00000000-0000-4000-8000-000000000004";
const sendId = "00000000-0000-4000-8000-000000000005";
const providerId = "BAE5-OUTBOUND-1";

await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'operator@example.test'),($2,'other@example.test')`, [actor, other]);
await db.query(`INSERT INTO public.admin_users (user_id,email,role) VALUES ($1,'operator@example.test','operator'),($2,'other@example.test','operator')`, [actor, other]);
await db.query(`INSERT INTO public.customers (id,phone_e164) VALUES ($1,'+12025550102')`, [customer]);
await db.query(`INSERT INTO public.conversations (id,customer_id,status) VALUES ($1,$2,'open')`, [conversation, customer]);
await db.query(`INSERT INTO public.messages (conversation_id,direction,role,body,channel,created_at) VALUES
  ($1,'inbound','user','old Twilio message','twilio',NOW()-INTERVAL '1 hour'),
  ($1,'inbound','user','legacy Twilio thread after migration','twilio',NOW()+INTERVAL '1 second')`, [conversation]);

let checks = 0;
async function check(name, run) {
    await run();
    checks++;
    console.log(`✓ ${name}`);
}

await check("solo admin puede tomar y pausar el bot", async () => {
    const { rows } = await db.query(`SELECT public.admin_claim_conversation($1,$2) AS result`, [conversation, actor]);
    assert.equal(rows[0].result.success, true);
    const state = await db.query(`SELECT handoff_status FROM public.conversation_state WHERE conversation_id=$1`, [conversation]);
    assert.equal(state.rows[0].handoff_status, "human");
});

await check("claim es idempotente y otro operador no roba el caso", async () => {
    const same = await db.query(`SELECT public.admin_claim_conversation($1,$2) AS result`, [conversation, actor]);
    assert.equal(same.rows[0].result.already_claimed, true);
    const conflict = await db.query(`SELECT public.admin_claim_conversation($1,$2) AS result`, [conversation, other]);
    assert.equal(conflict.rows[0].result.code, "claimed_by_another_operator");
    const wrongRelease = await db.query(`SELECT public.admin_release_conversation($1,$2) AS result`, [conversation, other]);
    assert.equal(wrongRelease.rows[0].result.code, "not_conversation_owner");
});

await check("el mensaje se prepara una vez y usa el último canal entrante", async () => {
    const prepared = await db.query(`SELECT public.admin_prepare_operator_message($1,$2,$3,$4) AS result`, [conversation, actor, sendId, "  Hola  "]);
    assert.equal(prepared.rows[0].result.channel, "evolution", "human sends must use the active MVP rail, not legacy message history");
    assert.equal(prepared.rows[0].result.body, "Hola");
    const replay = await db.query(`SELECT public.admin_prepare_operator_message($1,$2,$3,$4) AS result`, [conversation, actor, sendId, "Hola"]);
    assert.equal(replay.rows[0].result.existing, true);
    const { rows } = await db.query(`SELECT count(*)::int AS count FROM public.messages WHERE client_send_id=$1`, [sendId]);
    assert.equal(rows[0].count, 1);
});

await check("no libera ni inicia otro envío mientras hay uno en vuelo", async () => {
    const release = await db.query(`SELECT public.admin_release_conversation($1,$2) AS result`, [conversation, actor]);
    assert.equal(release.rows[0].result.code, "send_in_progress");
    const duplicate = await db.query(`SELECT public.admin_prepare_operator_message($1,$2,$3,$4) AS result`, [conversation, actor, "00000000-0000-4000-8000-000000000006", "Otro mensaje"]);
    assert.equal(duplicate.rows[0].result.code, "send_in_progress");
});

let messageId;
await check("guarda el resultado aceptado del proveedor con ID", async () => {
    const { rows } = await db.query(`SELECT id FROM public.messages WHERE client_send_id=$1`, [sendId]);
    messageId = rows[0].id;
    const finish = await db.query(`SELECT public.admin_finish_operator_message($1,$2,$3,'accepted',$4,NULL) AS result`, [conversation, messageId, actor, providerId]);
    assert.equal(finish.rows[0].result.delivery_status, "accepted");
    const message = await db.query(`SELECT delivery_status,provider_message_id,channel FROM public.messages WHERE id=$1`, [messageId]);
    assert.deepEqual(message.rows[0], { delivery_status: "accepted", provider_message_id: providerId, channel: "evolution" });
});

await check("rechazo de mensajería deja auditoría y no afecta otros mensajes", async () => {
    const secondId = "00000000-0000-4000-8000-000000000007";
    const prepared = await db.query(`SELECT public.admin_prepare_operator_message($1,$2,$3,$4) AS result`, [conversation, actor, secondId, "Otro"]);
    const finish = await db.query(`SELECT public.admin_finish_operator_message($1,$2,$3,'failed',NULL,'evolution_http_400') AS result`, [conversation, prepared.rows[0].result.message_id, actor]);
    assert.equal(finish.rows[0].result.delivery_status, "failed");
    const events = await db.query(`SELECT count(*)::int AS count FROM public.conversation_operator_events WHERE conversation_id=$1`, [conversation]);
    assert.equal(events.rows[0].count, 5);
});

await check("devuelve el control al bot y escribe evento de liberación", async () => {
    const result = await db.query(`SELECT public.admin_release_conversation($1,$2) AS result`, [conversation, actor]);
    assert.equal(result.rows[0].result.success, true);
    const state = await db.query(`SELECT handoff_status FROM public.conversation_state WHERE conversation_id=$1`, [conversation]);
    assert.equal(state.rows[0].handoff_status, "bot");
    const releaseEvents = await db.query(`SELECT count(*)::int AS count FROM public.conversation_operator_events WHERE conversation_id=$1 AND event_type='released'`, [conversation]);
    assert.equal(releaseEvents.rows[0].count, 1);
});

await check("rechaza usuario no admin y mensajes sin texto", async () => {
    const noAdmin = "00000000-0000-4000-8000-000000000008";
    const claim = await db.query(`SELECT public.admin_claim_conversation($1,$2) AS result`, [conversation, noAdmin]);
    assert.equal(claim.rows[0].result.code, "admin_required");
    const claimAgain = await db.query(`SELECT public.admin_claim_conversation($1,$2) AS result`, [conversation, actor]);
    assert.equal(claimAgain.rows[0].result.success, true);
    const noText = await db.query(`SELECT public.admin_prepare_operator_message($1,$2,$3,'  ') AS result`, [conversation, actor, "00000000-0000-4000-8000-000000000009"]);
    assert.equal(noText.rows[0].result.code, "invalid_message");
});

await check("RPC admin no es ejecutable por anon/authenticated y sí por service_role", async () => {
    const permissions = await db.query(`SELECT
      has_function_privilege('anon','public.admin_claim_conversation(uuid,uuid)','EXECUTE') AS anon_exec,
      has_function_privilege('authenticated','public.admin_prepare_operator_message(uuid,uuid,uuid,text)','EXECUTE') AS auth_exec,
      has_function_privilege('service_role','public.admin_finish_operator_message(uuid,uuid,uuid,text,text,text)','EXECUTE') AS service_exec,
      has_table_privilege('authenticated','public.messages','INSERT') AS browser_message_insert,
      has_table_privilege('authenticated','public.messages','UPDATE') AS browser_message_update,
      has_table_privilege('service_role','public.messages','INSERT') AS service_message_insert`);
    assert.deepEqual(permissions.rows[0], {
        anon_exec: false, auth_exec: false, service_exec: true,
        browser_message_insert: false, browser_message_update: false, service_message_insert: true,
    });
});

await check("envío abandonado se marca incierto antes de liberar y no queda colgado", async () => {
    const sendKey = "00000000-0000-4000-8000-000000000010";
    const prepared = await db.query(`SELECT public.admin_prepare_operator_message($1,$2,$3,$4) AS result`, [conversation, actor, sendKey, "Prueba de recuperación"]);
    const messageId = prepared.rows[0].result.message_id;
    await db.query(`UPDATE public.messages SET created_at=NOW()-INTERVAL '2 minutes' WHERE id=$1`, [messageId]);
    const released = await db.query(`SELECT public.admin_release_conversation($1,$2) AS result`, [conversation, actor]);
    assert.equal(released.rows[0].result.success, true);
    const message = await db.query(`SELECT delivery_status FROM public.messages WHERE id=$1`, [messageId]);
    assert.equal(message.rows[0].delivery_status, "unknown");
});

await db.close();
console.log(`\n${checks} human-messaging SQL checks passed.`);
