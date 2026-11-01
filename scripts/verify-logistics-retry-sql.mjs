#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
    join(root, "supabase/migrations/20261030120000_logistics_evolution_retry.sql"),
    "utf8",
);
const db = new PGlite();

await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);
    CREATE TABLE public.admin_users (user_id UUID PRIMARY KEY REFERENCES auth.users(id), role TEXT NOT NULL);
    CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT TRUE $$;
    CREATE TABLE public.orders (id UUID PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE public.shipments (
        id UUID PRIMARY KEY,
        order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
        status TEXT NOT NULL
    );
    CREATE TABLE public.logistics_notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
        shipment_id UUID REFERENCES public.shipments(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL CHECK (purpose IN ('dispatch', 'delivery')),
        channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
        recipient_phone TEXT,
        message_body TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
            'pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'skipped'
        )),
        provider TEXT NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio')),
        provider_message_sid TEXT,
        error_message TEXT,
        sent_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        read_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE public.logistics_notifications ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.shipment_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        shipment_id UUID NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
        order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL CHECK (event_type IN (
            'created', 'ready_to_fulfill', 'picking', 'packed', 'label_created', 'shipped',
            'in_transit', 'out_for_delivery', 'delivered', 'exception', 'notification_sent',
            'notification_failed', 'notification_read', 'note', 'cancelled'
        )),
        source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'system', 'twilio', 'carrier', 'wompi', 'migration'))
    );
`);
await db.exec(migration);

const actor = "00000000-0000-4000-8000-000000000001";
const order = "00000000-0000-4000-8000-000000000002";
const activeShipment = "00000000-0000-4000-8000-000000000003";
const failedNotice = "00000000-0000-4000-8000-000000000004";
const retryRequest = "00000000-0000-4000-8000-000000000005";
const staleNotice = "00000000-0000-4000-8000-000000000006";
const staleRequest = "00000000-0000-4000-8000-000000000007";
const secondFailedNotice = "00000000-0000-4000-8000-000000000008";
const otherRetryRequest = "00000000-0000-4000-8000-000000000009";
const concurrentParent = "00000000-0000-4000-8000-000000000014";
const concurrentRequest = "00000000-0000-4000-8000-000000000015";

await db.query(`INSERT INTO auth.users (id,email) VALUES ($1,'admin@example.test')`, [actor]);
await db.query(`INSERT INTO admin_users (user_id,role) VALUES ($1,'admin')`, [actor]);
await db.query(`INSERT INTO orders (id,status) VALUES ($1,'shipped')`, [order]);
await db.query(`INSERT INTO shipments (id,order_id,status) VALUES ($1,$2,'shipped')`, [activeShipment, order]);
await db.query(`
    INSERT INTO logistics_notifications (
        id, order_id, shipment_id, purpose, recipient_phone, message_body, status, error_message, created_by
    ) VALUES
        ($1,$2,$3,'dispatch','+12025550102','Tu pedido salió','failed','evolution_http_400', $4),
        ($5,$2,$3,'dispatch','+12025550102','Tu pedido salió','unknown','evolution_timeout', $4)
`, [failedNotice, order, activeShipment, actor, staleNotice]);
await db.query(`UPDATE logistics_notifications SET created_at=NOW()-INTERVAL '2 minutes' WHERE id=$1`, [staleNotice]);

let checks = 0;
async function check(name, run) {
    await run();
    checks++;
    console.log(`✓ ${name}`);
}

await check("solo una cuenta admin puede iniciar un reintento", async () => {
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [failedNotice, "00000000-0000-4000-8000-000000000099", retryRequest],
    );
    assert.equal(rows[0].result.code, "admin_required");
});

let retryId;
await check("el reintento crea un nuevo intento Evolution sin alterar pedido ni envío", async () => {
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [failedNotice, actor, retryRequest],
    );
    const result = rows[0].result;
    assert.equal(result.success, true);
    assert.equal(result.existing, false);
    assert.equal(result.status, "pending");
    assert.equal(result.attempt_number, 2);
    assert.equal(result.purpose, "dispatch");
    assert.equal(result.recipient_phone, "+12025550102");
    assert.equal(result.message_body, "Tu pedido salió");
    retryId = result.notification_id;

    const attempt = await db.query(
        `SELECT status, provider, attempt_number, retry_of_notification_id, retry_request_id
           FROM logistics_notifications WHERE id=$1`,
        [retryId],
    );
    assert.deepEqual(attempt.rows[0], {
        status: "pending", provider: "evolution", attempt_number: 2,
        retry_of_notification_id: failedNotice, retry_request_id: retryRequest,
    });
    const states = await db.query(`
        SELECT o.status AS order_status, s.status AS shipment_status
          FROM orders o JOIN shipments s ON s.order_id=o.id
         WHERE o.id=$1
    `, [order]);
    assert.deepEqual(states.rows[0], { order_status: "shipped", shipment_status: "shipped" });
});

await check("repetir la misma clave devuelve el intento existente y no crea otro", async () => {
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [failedNotice, actor, retryRequest],
    );
    assert.equal(rows[0].result.existing, true);
    assert.equal(rows[0].result.notification_id, retryId);
    const count = await db.query(`SELECT count(*)::int AS count FROM logistics_notifications WHERE retry_of_notification_id=$1`, [failedNotice]);
    assert.equal(count.rows[0].count, 1);
});

await check("un intento pendiente bloquea otro reenvío explícito", async () => {
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [failedNotice, actor, otherRetryRequest],
    );
    assert.equal(rows[0].result.code, "retry_already_attempted");
    assert.equal(rows[0].result.status, "pending");
});

await check("un intento activo bloquea otro desde una fila padre diferente", async () => {
    await db.query(`
        INSERT INTO logistics_notifications (
            id,order_id,shipment_id,purpose,status,recipient_phone,message_body,created_by
        ) VALUES ($1,$2,$3,'dispatch','failed','+12025550102','Tu pedido salió',$4)
    `, [concurrentParent, order, activeShipment, actor]);
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [concurrentParent, actor, concurrentRequest],
    );
    assert.equal(rows[0].result.code, "retry_already_attempted");
    assert.equal(rows[0].result.notification_id, retryId);
});

await check("pending antiguo se marca incierto y no se reenvía", async () => {
    await db.query(`UPDATE logistics_notifications SET created_at=NOW()-INTERVAL '2 minutes' WHERE id=$1`, [retryId]);
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [failedNotice, actor, retryRequest],
    );
    assert.equal(rows[0].result.existing, true);
    assert.equal(rows[0].result.status, "unknown");
    const attempt = await db.query(`SELECT status, unknown_at FROM logistics_notifications WHERE id=$1`, [retryId]);
    assert.equal(attempt.rows[0].status, "unknown");
    assert.ok(attempt.rows[0].unknown_at);
});

await check("resultado desconocido nunca puede iniciar otro reintento", async () => {
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [retryId, actor, otherRetryRequest],
    );
    assert.equal(rows[0].result.code, "notification_outcome_unknown");
});

await check("rechaza reintentos sin teléfono o texto", async () => {
    const incompleteId = "00000000-0000-4000-8000-000000000010";
    const requestId = "00000000-0000-4000-8000-000000000011";
    await db.query(`
        INSERT INTO logistics_notifications (id,order_id,shipment_id,purpose,status,created_by)
        VALUES ($1,$2,$3,'dispatch','failed',$4)
    `, [incompleteId, order, activeShipment, actor]);
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [incompleteId, actor, requestId],
    );
    assert.equal(rows[0].result.code, "notification_payload_incomplete");
});

await check("revisa la vigencia logística antes de volver a avisar", async () => {
    const staleDispatchId = "00000000-0000-4000-8000-000000000012";
    const staleDispatchRequest = "00000000-0000-4000-8000-000000000013";
    await db.query(`UPDATE shipments SET status='ready_to_fulfill' WHERE id=$1`, [activeShipment]);
    await db.query(`
        INSERT INTO logistics_notifications (id,order_id,shipment_id,purpose,status,recipient_phone,message_body,created_by)
        VALUES ($1,$2,$3,'dispatch','failed','+12025550102','Aviso',$4)
    `, [staleDispatchId, order, activeShipment, actor]);
    const { rows } = await db.query(
        `SELECT begin_logistics_notification_retry($1,$2,$3) AS result`,
        [staleDispatchId, actor, staleDispatchRequest],
    );
    assert.equal(rows[0].result.code, "dispatch_notification_stale");
});

await check("RPC solo la ejecuta service_role", async () => {
    const { rows } = await db.query(`SELECT
        has_function_privilege('anon','public.begin_logistics_notification_retry(uuid,uuid,uuid)','EXECUTE') AS anon_exec,
        has_function_privilege('authenticated','public.begin_logistics_notification_retry(uuid,uuid,uuid)','EXECUTE') AS auth_exec,
        has_function_privilege('service_role','public.begin_logistics_notification_retry(uuid,uuid,uuid)','EXECUTE') AS service_exec`);
    assert.deepEqual(rows[0], { anon_exec: false, auth_exec: false, service_exec: true });
});

await check("el navegador admin solo lee auditoría; las funciones mantienen escritura", async () => {
    const { rows } = await db.query(`SELECT
        has_table_privilege('authenticated','public.logistics_notifications','SELECT') AS auth_read,
        has_table_privilege('authenticated','public.logistics_notifications','INSERT') AS auth_insert,
        has_table_privilege('authenticated','public.logistics_notifications','UPDATE') AS auth_update,
        has_table_privilege('authenticated','public.logistics_notifications','DELETE') AS auth_delete,
        has_table_privilege('service_role','public.logistics_notifications','INSERT') AS service_insert,
        has_table_privilege('service_role','public.logistics_notifications','UPDATE') AS service_update`);
    assert.deepEqual(rows[0], {
        auth_read: true, auth_insert: false, auth_update: false, auth_delete: false,
        service_insert: true, service_update: true,
    });
});

await db.close();
console.log(`\n${checks} logistics retry SQL checks passed.`);
