#!/usr/bin/env node
/**
 * Verificacion real de E3.8 (el comprobante como primer filtro) contra Postgres.
 *
 * Aplica `20261028180000_payment_shortfall.sql` sobre un esquema minimo y
 * comprueba:
 *
 *   - la aritmetica del faltante la hace Postgres, no el modelo;
 *   - el plazo se reinicia solo cuando el cliente abona algo nuevo;
 *   - un abono parcial NO protege la reserva al vencer la ventana;
 *   - un comprobante completo pendiente SI la protege;
 *   - el panel y el watchdog ven el abono;
 *   - la funcion no es publica.
 *
 * Uso: node scripts/verify-e3-shortfall-sql.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const migrationPath = join(
    root,
    "supabase",
    "migrations",
    "20261028180000_payment_shortfall.sql",
);

const MINIMAL_SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT current_setting('test.is_admin', TRUE) = 'on'
$$;

CREATE TABLE public.settings (
    id INTEGER PRIMARY KEY,
    payment_receipt_window_hours INTEGER NOT NULL DEFAULT 24,
    payment_nequi_number TEXT,
    payment_breb_key TEXT
);
INSERT INTO public.settings (id, payment_receipt_window_hours, payment_nequi_number)
VALUES (1, 24, '2025550100');

CREATE TABLE public.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 TEXT UNIQUE,
    name TEXT
);

CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brand TEXT,
    model TEXT,
    price_cents INTEGER NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE public.product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES public.products(id),
    size NUMERIC NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    reserved INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES public.customers(id),
    status TEXT,
    total_cents INTEGER NOT NULL DEFAULT 0,
    payment_reference TEXT UNIQUE,
    payment_method TEXT,
    paid_at TIMESTAMPTZ,
    payment_rejected_at TIMESTAMPTZ,
    payment_rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES public.products(id),
    variant_id UUID REFERENCES public.product_variants(id),
    qty INTEGER NOT NULL DEFAULT 1,
    unit_price_cents INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID REFERENCES public.customers(id),
    last_message_at TIMESTAMPTZ
);

CREATE TABLE public.conversation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID,
    customer_id UUID,
    message_id UUID,
    order_id UUID,
    payment_id UUID,
    shipment_id UUID,
    product_id UUID,
    variant_id UUID,
    channel TEXT NOT NULL DEFAULT 'whatsapp',
    actor_type TEXT NOT NULL,
    direction TEXT,
    event_type TEXT NOT NULL,
    funnel_stage TEXT,
    intent TEXT,
    sentiment TEXT,
    revenue_risk TEXT,
    handoff_required BOOLEAN NOT NULL DEFAULT FALSE,
    handoff_reason TEXT,
    size_requested NUMERIC,
    quantity_requested INTEGER,
    amount_cents INTEGER,
    currency TEXT NOT NULL DEFAULT 'COP',
    source TEXT NOT NULL DEFAULT 'system',
    confidence NUMERIC,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    latency_ms INTEGER,
    dedupe_key TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_conversation_events_dedupe
    ON public.conversation_events (dedupe_key)
    WHERE dedupe_key IS NOT NULL;

CREATE TABLE public.payment_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'received',
    storage_bucket TEXT,
    storage_path TEXT,
    content_type TEXT,
    ai_verdict TEXT,
    ai_confidence NUMERIC,
    ai_extracted JSONB,
    ai_evidence JSONB,
    ai_checked_at TIMESTAMPTZ,
    review_note TEXT,
    sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.payment_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
    decision TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.shipments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
    status TEXT,
    delivered_at TIMESTAMPTZ
);

CREATE TABLE public.logistics_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID,
    status TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION public.release_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    current_reserved INT;
    release_amount INT;
BEGIN
    IF amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;

    SELECT reserved INTO current_reserved
      FROM public.product_variants WHERE id = row_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found';
    END IF;

    release_amount := LEAST(amount, current_reserved);

    UPDATE public.product_variants
       SET reserved = reserved - release_amount,
           updated_at = NOW()
     WHERE id = row_id;

    RETURN release_amount;
END;
$$;

CREATE FUNCTION public.release_order_stock(target_order_id UUID)
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    item RECORD;
    released_total INT := 0;
BEGIN
    FOR item IN
        SELECT variant_id, COALESCE(qty, 0)::integer AS qty
          FROM public.order_items
         WHERE order_id = target_order_id
           AND variant_id IS NOT NULL
           AND COALESCE(qty, 0) > 0
    LOOP
        released_total := released_total + public.release_stock(item.variant_id, item.qty);
    END LOOP;

    RETURN released_total;
END;
$$;
`;

const migrationSql = readFileSync(migrationPath, "utf8");

let passed = 0;
let failed = 0;
const results = [];

function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        results.push(`  PASS  ${name}`);
    } else {
        failed++;
        results.push(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
    }
}

async function reset(db) {
    await db.exec(`
        TRUNCATE public.conversation_events, public.payment_decisions,
                 public.payment_receipts, public.payments, public.order_items,
                 public.orders, public.conversations, public.customers,
                 public.shipments, public.logistics_notifications,
                 public.product_variants, public.products CASCADE;
        UPDATE public.settings SET payment_receipt_window_hours = 24 WHERE id = 1;
        DELETE FROM public.conversation_events;
    `);
}

/** Crea un pedido con su variante reservada y una conversacion. */
async function seedOrder(db, {
    createdAgoHours = 0,
    status = "awaiting_payment",
    totalCents = 550_000_00,
    reference = "ORD-E38",
    rejectedAgoHours = null,
    reserved = 1,
} = {}) {
    const row = await db.query(
        `WITH c AS (
             INSERT INTO public.customers (phone_e164, name)
             VALUES ('+57300' || floor(random() * 1000000)::text, 'Cliente')
             RETURNING id
         ), p AS (
             INSERT INTO public.products (brand, model, price_cents)
             VALUES ('Nike', 'Metcon 9', ${totalCents}) RETURNING id
         ), v AS (
             INSERT INTO public.product_variants (product_id, size, stock, reserved)
             SELECT p.id, 42, 5, ${reserved} FROM p RETURNING id
         ), conv AS (
             INSERT INTO public.conversations (customer_id, last_message_at)
             SELECT c.id, NOW() FROM c RETURNING id
         ), o AS (
             INSERT INTO public.orders (
                 customer_id, status, total_cents, payment_reference,
                 created_at, updated_at, payment_rejected_at
             )
             SELECT c.id, '${status}', ${totalCents}, '${reference}',
                    NOW() - INTERVAL '${createdAgoHours} hours',
                    NOW() - INTERVAL '${createdAgoHours} hours',
                    ${rejectedAgoHours === null ? "NULL" : `NOW() - INTERVAL '${rejectedAgoHours} hours'`}
             FROM c RETURNING id, customer_id
         ), oi AS (
             INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price_cents)
             SELECT o.id, p.id, v.id, ${reserved}, ${totalCents} FROM o, p, v RETURNING order_id
         )
         SELECT o.id AS order_id, o.customer_id, v.id AS variant_id, conv.id AS conversation_id
         FROM o, v, conv`,
    );
    return row.rows[0];
}

async function progress(db, orderId, receivedCents, source = "vision") {
    const r = await db.query(
        `SELECT public.record_payment_progress($1, $2, $3) AS result`,
        [orderId, receivedCents, source],
    );
    return r.rows[0].result;
}

async function orderRow(db, orderId) {
    const r = await db.query(
        `SELECT status, total_cents, payment_received_cents,
                payment_shortfall_cents, payment_shortfall_at, payment_rejected_at
           FROM public.orders WHERE id = $1`,
        [orderId],
    );
    return r.rows[0];
}

async function sweep(db, limit = 50) {
    await db.exec(`SET search_path = public, pg_temp;`);
    const r = await db.query(
        `SELECT * FROM public.expire_stale_payment_orders($1)`,
        [limit],
    );
    return r.rows;
}

async function main() {
    const db = new PGlite();
    await db.exec(MINIMAL_SCHEMA);
    await db.exec(migrationSql);

    // === E3.8.1 esquema ================================================
    {
        const columns = await db.query(`
            SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'orders'
               AND column_name IN ('payment_received_cents', 'payment_shortfall_cents', 'payment_shortfall_at')
        `);
        check("E3.8.1 el pedido guarda lo recibido y el faltante", columns.rows.length === 3);
    }

    // === E3.8.2 no es una funcion publica ==============================
    {
        const r = await db.query(`
            SELECT has_function_privilege('anon', 'public.record_payment_progress(uuid, integer, text)', 'EXECUTE') AS anon_can,
                   has_function_privilege('authenticated', 'public.record_payment_progress(uuid, integer, text)', 'EXECUTE') AS auth_can,
                   has_function_privilege('service_role', 'public.record_payment_progress(uuid, integer, text)', 'EXECUTE') AS service_can
        `);
        check("E3.8.2 anon no puede registrar abonos", r.rows[0].anon_can === false);
        check("E3.8.2 authenticated no puede registrar abonos", r.rows[0].auth_can === false);
        check("E3.8.2 service_role si puede registrar abonos", r.rows[0].service_can === true);
    }

    // === E3.8.3 abono parcial =========================================
    await reset(db);
    {
        const order = await seedOrder(db, { totalCents: 550_000_00, reference: "ORD-E38-PARTIAL" });
        const before = await orderRow(db, order.order_id);

        check("E3.8.3 arranca sin abono conocido", before.payment_received_cents === null);

        const result = await progress(db, order.order_id, 100_000_00);
        const after = await orderRow(db, order.order_id);

        check("E3.8.3 la RPC aplica el abono", result.applied === true);
        check("E3.8.3 calcula el faltante exacto", Number(result.shortfall_cents) === 450_000_00);
        check("E3.8.3 guarda lo recibido", Number(after.payment_received_cents) === 100_000_00);
        check("E3.8.3 guarda el faltante", Number(after.payment_shortfall_cents) === 450_000_00);
        check("E3.8.3 abre el plazo del saldo", Boolean(after.payment_shortfall_at));
        check("E3.8.3 el pedido sigue pendiente de pago", after.status === "awaiting_payment");
    }

    // === E3.8.4 el mismo comprobante no estira el plazo ===============
    await reset(db);
    {
        const order = await seedOrder(db, { reference: "ORD-E38-REPEAT" });

        await progress(db, order.order_id, 100_000_00);
        const first = await orderRow(db, order.order_id);

        await db.exec(`
            UPDATE public.orders
               SET payment_shortfall_at = NOW() - INTERVAL '5 hours'
             WHERE id = '${order.order_id}'
        `);
        const moved = await orderRow(db, order.order_id);

        const replay = await progress(db, order.order_id, 100_000_00);
        const after = await orderRow(db, order.order_id);

        check("E3.8.4 reenviar lo mismo no cuenta como abono nuevo", replay.advanced === false);
        check("E3.8.4 reenviar lo mismo no reinicia el plazo", after.payment_shortfall_at.getTime() === moved.payment_shortfall_at.getTime());
        check("E3.8.4 el primer abono si reinicio el plazo", first.payment_shortfall_at.getTime() !== moved.payment_shortfall_at.getTime());

        const events = await db.query(
            `SELECT COUNT(*)::int AS n FROM public.conversation_events
              WHERE dedupe_key = 'order:${order.order_id}:shortfall:10000000'`,
        );
        check("E3.8.4 el evento del faltante no se duplica", events.rows[0].n === 1);
    }

    // === E3.8.5 abono nuevo ===========================================
    await reset(db);
    {
        const order = await seedOrder(db, { reference: "ORD-E38-MORE" });

        await progress(db, order.order_id, 100_000_00);
        await db.exec(`
            UPDATE public.orders
               SET payment_shortfall_at = NOW() - INTERVAL '5 hours'
             WHERE id = '${order.order_id}'
        `);

        const result = await progress(db, order.order_id, 300_000_00);
        const after = await orderRow(db, order.order_id);
        const hours = (Date.now() - new Date(after.payment_shortfall_at).getTime()) / 3_600_000;

        check("E3.8.5 un abono mayor si cuenta como avance", result.advanced === true);
        check("E3.8.5 el faltante baja", Number(after.payment_shortfall_cents) === 250_000_00);
        check("E3.8.5 el abono nuevo reinicia el plazo", hours < 0.1);

        const events = await db.query(
            `SELECT COUNT(*)::int AS n FROM public.conversation_events
              WHERE event_type = 'payment_shortfall_registered'
                AND order_id = '${order.order_id}'`,
        );
        check("E3.8.5 cada abono deja su evento", events.rows[0].n === 2);
    }

    // === E3.8.6 completar el pago =====================================
    await reset(db);
    {
        const order = await seedOrder(db, { reference: "ORD-E38-COMPLETE" });

        await progress(db, order.order_id, 100_000_00);
        const result = await progress(db, order.order_id, 550_000_00);
        const after = await orderRow(db, order.order_id);

        check("E3.8.6 el faltante queda en cero", Number(result.shortfall_cents) === 0);
        check("E3.8.6 limpia el faltante guardado", after.payment_shortfall_cents === null);
        check("E3.8.6 limpia el plazo del saldo", after.payment_shortfall_at === null);
        check("E3.8.6 no toca el estado del pedido", after.status === "awaiting_payment");

        const events = await db.query(
            `SELECT COUNT(*)::int AS n FROM public.conversation_events
              WHERE event_type = 'payment_shortfall_registered'
                AND order_id = '${order.order_id}'`,
        );
        check("E3.8.6 pagar completo no registra faltante", events.rows[0].n === 1);
    }

    // === E3.8.7 pedido ya resuelto ====================================
    await reset(db);
    {
        const paid = await seedOrder(db, { status: "paid", reference: "ORD-E38-PAID" });
        const result = await progress(db, paid.order_id, 100_000_00);
        const after = await orderRow(db, paid.order_id);

        check("E3.8.7 no registra abonos de un pedido ya pagado", result.applied === false);
        check("E3.8.7 explica por que no aplico", result.reason === "order_not_payable");
        check("E3.8.7 no toca el pedido pagado", after.payment_received_cents === null);
    }

    // === E3.8.8 el abono parcial reinicia la ventana ==================
    await reset(db);
    {
        const order = await seedOrder(db, {
            createdAgoHours: 40,
            reference: "ORD-E38-RESET",
        });

        await progress(db, order.order_id, 100_000_00);

        const rows = await sweep(db);
        check("E3.8.8 un abono reciente da una ventana nueva", !rows.some((r) => r.order_id === order.order_id));
        check("E3.8.8 el pedido sigue reservado", (await orderRow(db, order.order_id)).status === "awaiting_payment");
    }

    // === E3.8.9 el abono parcial NO protege al vencer =================
    await reset(db);
    {
        const order = await seedOrder(db, {
            createdAgoHours: 40,
            reference: "ORD-E38-PARTIAL-EXPIRES",
        });

        await progress(db, order.order_id, 100_000_00);
        await db.exec(`
            UPDATE public.orders
               SET payment_shortfall_at = NOW() - INTERVAL '30 hours'
             WHERE id = '${order.order_id}';
            INSERT INTO public.payment_receipts (order_id, status, created_at)
            VALUES ('${order.order_id}', 'received', NOW() - INTERVAL '30 hours');
        `);

        const rows = await sweep(db);
        const row = rows.find((r) => r.order_id === order.order_id);

        check("E3.8.9 con abono parcial vencido si se libera", Boolean(row));
        check("E3.8.9 el pedido queda expired", (await orderRow(db, order.order_id)).status === "expired");
        check("E3.8.9 libera el stock reservado", row && (await db.query(
            `SELECT reserved FROM public.product_variants WHERE id = $1`,
            [order.variant_id],
        )).rows[0].reserved === 0);
        check("E3.8.9 avisa al cliente que la reserva vencio", row?.should_notify === true);
    }

    // === E3.8.10 el pago completo pendiente SI protege ================
    await reset(db);
    {
        const order = await seedOrder(db, {
            createdAgoHours: 40,
            reference: "ORD-E38-FULL-PROTECTS",
        });

        await progress(db, order.order_id, 550_000_00);
        await db.exec(`
            INSERT INTO public.payment_receipts (order_id, status, created_at)
            VALUES ('${order.order_id}', 'received', NOW() - INTERVAL '30 hours')
        `);

        const rows = await sweep(db);
        check("E3.8.10 un comprobante completo pendiente protege", !rows.some((r) => r.order_id === order.order_id));
        check("E3.8.10 el pedido espera la decision humana", (await orderRow(db, order.order_id)).status === "awaiting_payment");
    }

    // === E3.8.11 un rechazo viejo no tapa un abono nuevo ==============
    await reset(db);
    {
        const order = await seedOrder(db, {
            createdAgoHours: 40,
            rejectedAgoHours: 30,
            reference: "ORD-E38-REJECT-THEN-PARTIAL",
        });

        await progress(db, order.order_id, 100_000_00);

        const rows = await sweep(db);
        check("E3.8.11 el abono nuevo manda sobre el rechazo viejo", !rows.some((r) => r.order_id === order.order_id));
    }

    // === E3.8.12 el panel ve el abono =================================
    await reset(db);
    {
        await db.exec(`SELECT set_config('test.is_admin', 'on', false)`);
        const order = await seedOrder(db, { reference: "ORD-E38-PANEL" });
        await progress(db, order.order_id, 100_000_00);

        const snapshot = (await db.query(`SELECT public.admin_payment_queue() AS q`)).rows[0].q;
        const entry = snapshot.orders.find((o) => o.order_id === order.order_id);

        check("E3.8.12 la cola trae lo recibido", Number(entry?.payment_received_cents) === 100_000_00);
        check("E3.8.12 la cola trae el faltante", Number(entry?.payment_shortfall_cents) === 450_000_00);
        check("E3.8.12 la cola trae el plazo del saldo", Boolean(entry?.payment_shortfall_at));
        check("E3.8.12 la cola sigue mostrando el total", Number(entry?.total_cents) === 550_000_00);
    }

    // === E3.8.13 el watchdog ve los abonos sin completar ==============
    await reset(db);
    {
        await db.exec(`SELECT set_config('test.is_admin', 'on', false)`);
        const order = await seedOrder(db, { reference: "ORD-E38-WATCHDOG" });
        await progress(db, order.order_id, 100_000_00);

        const snapshot = (await db.query(`SELECT public.admin_ops_watchdog() AS s`)).rows[0].s;

        check("E3.8.13 cuenta los abonos parciales", snapshot.payments.partial_count === 1);
        check("E3.8.13 alerta por abono parcial", snapshot.alerts.some((a) => a.key === "partial_payments"));
        check("E3.8.13 la alerta es de severidad media al principio", snapshot.alerts.find((a) => a.key === "partial_payments")?.severity === "medium");
    }

    // === E3.8.14 la auditoria del abono ===============================
    await reset(db);
    {
        const order = await seedOrder(db, { reference: "ORD-E38-AUDIT" });
        await progress(db, order.order_id, 100_000_00);

        const event = (await db.query(
            `SELECT event_type, actor_type, direction, intent, funnel_stage, amount_cents, metadata
               FROM public.conversation_events
              WHERE dedupe_key = 'order:${order.order_id}:shortfall:10000000'`,
        )).rows[0];

        check("E3.8.14 registra el faltante", event?.event_type === "payment_shortfall_registered");
        check("E3.8.14 el evento es del sistema", event?.actor_type === "system");
        check("E3.8.14 guarda el monto que falta", Number(event?.amount_cents) === 450_000_00);
        check("E3.8.14 guarda el total y lo recibido", Number(event?.metadata?.total_cents) === 550_000_00 && Number(event?.metadata?.received_cents) === 100_000_00);
        check("E3.8.14 usa la etapa de revision de pago", event?.funnel_stage === "payment_review");
    }

    console.log(results.join("\n"));
    console.log(`\n${passed} ok, ${failed} fallos`);
    if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
    console.error(results.join("\n"));
    console.error("\nFallo inesperado:", err);
    process.exitCode = 1;
});
