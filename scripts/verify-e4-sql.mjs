#!/usr/bin/env node
/**
 * Verificacion real de E4 (operacion y vigilancia) contra Postgres (PGlite).
 *
 * Aplica `20261028120000_ops_sweep.sql` sobre un esquema minimo y comprueba:
 *
 *   - la ventana de reserva sale de `settings.payment_receipt_window_hours`;
 *   - un pedido con comprobante esperando revision NUNCA vence;
 *   - vencer libera stock una sola vez (idempotente);
 *   - el evento `payment_expired` queda auditado;
 *   - el aviso al cliente se auto-repara y no se duplica;
 *   - el watchdog exige admin y detecta lo que puede salir mal hoy.
 *
 * Uso: node scripts/verify-e4-sql.mjs
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
    "20261028120000_ops_sweep.sql",
);

const ADMIN_ID = "00000000-0000-0000-0000-000000000001";

const MINIMAL_SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE FUNCTION public.uuid_generate_v4() RETURNS UUID
LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;

CREATE SCHEMA auth;

CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT current_setting('test.is_admin', TRUE) = 'on'
$$;

CREATE TABLE public.settings (
    id INTEGER PRIMARY KEY,
    payment_receipt_window_hours INTEGER NOT NULL DEFAULT 24
);
INSERT INTO public.settings (id, payment_receipt_window_hours) VALUES (1, 24);

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
    paid_at TIMESTAMPTZ,
    payment_rejected_at TIMESTAMPTZ,
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
    current_stock INT;
    current_reserved INT;
    release_amount INT;
BEGIN
    IF amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;

    SELECT stock, reserved INTO current_stock, current_reserved
      FROM public.product_variants WHERE id = row_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found';
    END IF;

    release_amount := LEAST(amount, current_reserved);

    UPDATE public.product_variants
       SET reserved = reserved - release_amount,
           updated_at = NOW()
     WHERE id = row_id
     RETURNING stock, reserved INTO current_stock, current_reserved;

    RETURN current_stock - current_reserved;
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
        PERFORM public.release_stock(item.variant_id, item.qty);
        released_total := released_total + item.qty;
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

async function expectError(db, sql, pattern) {
    try {
        await db.exec(sql);
        return { ok: false, message: "no lanzo error" };
    } catch (err) {
        return { ok: new RegExp(pattern, "i").test(String(err.message)), message: err.message };
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
    `);
}

/** Crea un pedido en espera de pago con su variante reservada. */
async function seedOrder(db, { createdAgoHours, status = "awaiting_payment", reserved = 1, rejectedAgoHours = null, reference }) {
    const row = await db.query(
        `WITH c AS (
             INSERT INTO public.customers (phone_e164, name)
             VALUES ('+57300' || floor(random() * 1000000)::text, 'Cliente')
             RETURNING id
         ), p AS (
             INSERT INTO public.products (brand, model, price_cents)
             VALUES ('Nike', 'Air Max', 45000000) RETURNING id
         ), v AS (
             INSERT INTO public.product_variants (product_id, size, stock, reserved)
             SELECT p.id, 42, 5, ${reserved} FROM p RETURNING id, product_id
         ), conv AS (
             INSERT INTO public.conversations (customer_id, last_message_at)
             SELECT c.id, NOW() FROM c RETURNING id, customer_id
         ), o AS (
             INSERT INTO public.orders (
                 customer_id, status, total_cents, payment_reference,
                 created_at, updated_at, payment_rejected_at
             )
             SELECT c.id, '${status}', 45000000, '${reference}',
                    NOW() - INTERVAL '${createdAgoHours} hours',
                    NOW() - INTERVAL '${createdAgoHours} hours',
                    ${rejectedAgoHours === null ? "NULL" : `NOW() - INTERVAL '${rejectedAgoHours} hours'`}
             FROM c RETURNING id, customer_id
         ), oi AS (
             INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price_cents)
             SELECT o.id, v.product_id, v.id, ${reserved}, 45000000 FROM o, v RETURNING order_id
         )
         SELECT o.id AS order_id, o.customer_id, v.id AS variant_id, conv.id AS conversation_id
         FROM o, v, conv`,
    );
    return row.rows[0];
}

async function variantReserved(db, variantId) {
    const r = await db.query(
        `SELECT reserved FROM public.product_variants WHERE id = $1`,
        [variantId],
    );
    return r.rows[0].reserved;
}

async function orderStatus(db, orderId) {
    const r = await db.query(`SELECT status FROM public.orders WHERE id = $1`, [orderId]);
    return r.rows[0].status;
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

    // === E4.1 ventana y vencimiento =====================================
    await reset(db);
    {
        const fresh = await seedOrder(db, { createdAgoHours: 2, reference: "ORD-E4-FRESH" });
        const old = await seedOrder(db, { createdAgoHours: 30, reference: "ORD-E4-OLD" });

        const rows = await sweep(db);
        const ids = rows.map((r) => r.order_id);

        check("E4.1 vence el pedido que paso la ventana", ids.includes(old.order_id));
        check("E4.1 no vence el que sigue dentro de la ventana", !ids.includes(fresh.order_id));
        check("E4.1 el vencido queda en expired", (await orderStatus(db, old.order_id)) === "expired");
        check("E4.1 el vigente sigue en awaiting_payment", (await orderStatus(db, fresh.order_id)) === "awaiting_payment");
        check("E4.1 libera el stock reservado", (await variantReserved(db, old.variant_id)) === 0);
        check("E4.1 no toca el stock del pedido vigente", (await variantReserved(db, fresh.variant_id)) === 1);
        check("E4.1 devuelve la referencia para avisar", rows.some((r) => r.payment_reference === "ORD-E4-OLD"));
        check("E4.1 marca expired_now", rows.find((r) => r.order_id === old.order_id)?.expired_now === true);
    }

    // === E4.2 la ventana sale de settings ===============================
    await reset(db);
    {
        await db.exec(`UPDATE public.settings SET payment_receipt_window_hours = 2 WHERE id = 1`);
        const order = await seedOrder(db, { createdAgoHours: 3, reference: "ORD-E4-WINDOW" });

        const rows = await sweep(db);
        check("E4.2 con ventana de 2 h el pedido de 3 h vence", rows.some((r) => r.order_id === order.order_id));
        check("E4.2 con ventana de 2 h el pedido de 3 h queda expired", (await orderStatus(db, order.order_id)) === "expired");
    }

    // === E4.3 un comprobante pendiente protege el pedido ================
    await reset(db);
    {
        const pending = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-PENDING" });
        const prevalidated = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-PREVALIDATED" });
        const rejected = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-REJECTED" });

        await db.exec(`
            INSERT INTO public.payment_receipts (order_id, status, created_at)
            VALUES ('${pending.order_id}', 'received', NOW() - INTERVAL '40 hours'),
                   ('${prevalidated.order_id}', 'prevalidated', NOW() - INTERVAL '40 hours'),
                   ('${rejected.order_id}', 'rejected', NOW() - INTERVAL '40 hours')
        `);

        const rows = await sweep(db);
        const ids = rows.map((r) => r.order_id);

        check("E4.3 no vence con comprobante recibido", !ids.includes(pending.order_id));
        check("E4.3 no vence con comprobante prevalidado", !ids.includes(prevalidated.order_id));
        check("E4.3 sigue en awaiting_payment esperando revision", (await orderStatus(db, pending.order_id)) === "awaiting_payment");
        check("E4.3 conserva el stock del comprobante pendiente", (await variantReserved(db, pending.variant_id)) === 1);
        check("E4.3 si el comprobante fue rechazado si vence", ids.includes(rejected.order_id));
    }

    // === E4.4 la ventana se cuenta desde el ultimo rechazo =============
    await reset(db);
    {
        const retried = await seedOrder(db, {
            createdAgoHours: 40,
            rejectedAgoHours: 3,
            reference: "ORD-E4-RETRY",
        });

        const first = await sweep(db);
        check("E4.4 un rechazo reciente reinicia la ventana", !first.some((r) => r.order_id === retried.order_id));

        await db.exec(`
            UPDATE public.orders
               SET payment_rejected_at = NOW() - INTERVAL '30 hours'
             WHERE id = '${retried.order_id}'
        `);

        const second = await sweep(db);
        check("E4.4 con el rechazo viejo ya vence", second.some((r) => r.order_id === retried.order_id));
    }

    // === E4.5 nunca toca dinero ya cobrado =============================
    await reset(db);
    {
        const paid = await seedOrder(db, { createdAgoHours: 40, status: "paid", reference: "ORD-E4-PAID" });
        const approvedPayment = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-APPROVED" });

        await db.exec(`
            INSERT INTO public.payments (order_id, status)
            VALUES ('${approvedPayment.order_id}', 'approved')
        `);

        const rows = await sweep(db);
        const ids = rows.map((r) => r.order_id);

        check("E4.5 no vence un pedido pagado", !ids.includes(paid.order_id));
        check("E4.5 el pedido pagado conserva su estado", (await orderStatus(db, paid.order_id)) === "paid");
        check("E4.5 no vence si hay un pago aprobado", !ids.includes(approvedPayment.order_id));
        check("E4.5 no libera stock de un pago aprobado", (await variantReserved(db, approvedPayment.variant_id)) === 1);
    }

    // === E4.6 idempotencia =============================================
    await reset(db);
    {
        const order = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-IDEMPOTENT" });

        const first = await sweep(db);
        check("E4.6 la primera corrida vence el pedido", first.some((r) => r.order_id === order.order_id));

        await db.exec(`
            UPDATE public.product_variants SET reserved = 0 WHERE id = '${order.variant_id}'
        `);

        const second = await sweep(db);
        check("E4.6 la segunda corrida no lo vuelve a vencer", second.every((r) => r.expired_now === false));
        check("E4.6 el stock no se libera dos veces", (await variantReserved(db, order.variant_id)) === 0);

        const events = await db.query(
            `SELECT COUNT(*)::int AS n FROM public.conversation_events
              WHERE dedupe_key = 'order:${order.order_id}:expired'`,
        );
        check("E4.6 registra un solo evento payment_expired", events.rows[0].n === 1);
    }

    // === E4.7 auditoria y aviso que se auto-repara =====================
    await reset(db);
    {
        const order = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-EVENT" });

        const rows = await sweep(db);
        const row = rows.find((r) => r.order_id === order.order_id);

        const event = await db.query(
            `SELECT event_type, actor_type, order_id, metadata
               FROM public.conversation_events
              WHERE dedupe_key = 'order:${order.order_id}:expired'`,
        );
        check("E4.7 escribe el evento payment_expired", event.rows[0]?.event_type === "payment_expired");
        check("E4.7 el evento es del sistema", event.rows[0]?.actor_type === "system");
        check("E4.7 el evento apunta al pedido", event.rows[0]?.order_id === order.order_id);
        check("E4.7 el evento guarda la ventana usada", event.rows[0]?.metadata?.window_hours === 24);
        check("E4.7 pide avisar al cliente", row?.should_notify === true);
        check("E4.7 trae el telefono del cliente", typeof row?.customer_phone === "string" && row.customer_phone.startsWith("+57"));
        check("E4.7 trae la conversacion para responder", Boolean(row?.conversation_id));

        // El aviso ya enviado se marca y no se repite.
        await db.exec(`
            INSERT INTO public.conversation_events (
                conversation_id, customer_id, order_id, actor_type, event_type, source, dedupe_key
            ) VALUES (
                '${order.conversation_id}', '${order.customer_id}', '${order.order_id}',
                'bot', 'payment_expired_notified', 'ops_sweep',
                'order:${order.order_id}:expired_notified'
            )
        `);

        const after = await sweep(db);
        const again = after.find((r) => r.order_id === order.order_id);
        check("E4.7 no vuelve a pedir el aviso ya enviado", again?.should_notify !== true);
    }

    // === E4.8 limpieza historica sin molestar al cliente ===============
    await reset(db);
    {
        const ancient = await seedOrder(db, { createdAgoHours: 24 * 159, reference: "ORD-E4-ANCIENT" });

        const rows = await sweep(db);
        const row = rows.find((r) => r.order_id === ancient.order_id);

        check("E4.8 vence un pedido abandonado de hace meses", (await orderStatus(db, ancient.order_id)) === "expired");
        check("E4.8 no avisa a un cliente por un pedido de hace meses", row?.should_notify === false);
        check("E4.8 igual libera el stock del pedido abandonado", (await variantReserved(db, ancient.variant_id)) === 0);
    }

    // === E4.9 el barrido no es publico =================================
    {
        const r = await db.query(`
            SELECT has_function_privilege('anon', 'public.expire_stale_payment_orders(integer, timestamptz)', 'EXECUTE') AS anon_can,
                   has_function_privilege('authenticated', 'public.expire_stale_payment_orders(integer, timestamptz)', 'EXECUTE') AS auth_can,
                   has_function_privilege('service_role', 'public.expire_stale_payment_orders(integer, timestamptz)', 'EXECUTE') AS service_can
        `);
        check("E4.9 anon no puede ejecutar el barrido", r.rows[0].anon_can === false);
        check("E4.9 authenticated no puede ejecutar el barrido", r.rows[0].auth_can === false);
        check("E4.9 service_role si puede ejecutar el barrido", r.rows[0].service_can === true);
    }

    // === E4.10 watchdog ================================================
    await reset(db);
    {
        const noAdmin = await expectError(
            db,
            `SELECT public.admin_ops_watchdog()`,
            "admin",
        );
        check("E4.10 el watchdog exige admin", noAdmin.ok);

        await db.exec(`SELECT set_config('test.is_admin', 'on', false)`);

        const staleReceipt = await seedOrder(db, { createdAgoHours: 40, reference: "ORD-E4-STALE" });
        await db.exec(`
            INSERT INTO public.payment_receipts (order_id, status, created_at)
            VALUES ('${staleReceipt.order_id}', 'received', NOW() - INTERVAL '5 hours')
        `);

        const soon = await seedOrder(db, { createdAgoHours: 20, reference: "ORD-E4-SOON" });

        const paidToday = await seedOrder(db, { createdAgoHours: 1, status: "paid", reference: "ORD-E4-TODAY" });
        await db.exec(`UPDATE public.orders SET paid_at = NOW() WHERE id = '${paidToday.order_id}'`);

        const overSla = await seedOrder(db, { createdAgoHours: 30, status: "paid", reference: "ORD-E4-SLA" });
        await db.exec(`UPDATE public.orders SET paid_at = NOW() - INTERVAL '30 hours' WHERE id = '${overSla.order_id}'`);

        await db.exec(`
            INSERT INTO public.logistics_notifications (order_id, status)
            VALUES ('${paidToday.order_id}', 'failed')
        `);

        const snap = (await db.query(`SELECT public.admin_ops_watchdog() AS s`)).rows[0].s;

        check("E4.10 cuenta comprobantes pendientes", snap.payments.receipts_pending_count === 1);
        check("E4.10 detecta el comprobante viejo", snap.payments.receipts_stale_count === 1);
        check("E4.10 alerta por comprobante sin revisar", snap.alerts.some((a) => a.key === "receipts_stale"));
        check("E4.10 la alerta de comprobante es de severidad alta", snap.alerts.find((a) => a.key === "receipts_stale")?.severity === "high");
        check("E4.10 cuenta pedidos por vencer", snap.payments.expiring_within_6h_count === 1);
        check("E4.10 alerta por pedidos por vencer", snap.alerts.some((a) => a.key === "expiring_soon"));
        check("E4.10 cuenta pedidos pagados sin despachar", snap.logistics.paid_pending_dispatch_count === 2);
        check("E4.10 detecta pagados fuera de SLA", snap.logistics.paid_over_sla_count === 1);
        check("E4.10 alerta por pago sin despacho", snap.alerts.some((a) => a.key === "paid_over_sla"));
        check("E4.10 cuenta avisos fallidos de 24 h", snap.logistics.failed_notification_count_24h === 1);
        check("E4.10 alerta por aviso fallido", snap.alerts.some((a) => a.key === "failed_notifications"));
        check("E4.10 cuenta el pedido pagado de hoy", snap.today.orders_paid === 1);
        check("E4.10 suma la recaudacion de hoy", Number(snap.today.revenue_cents) === 45000000);
        check("E4.10 expone la ventana vigente", snap.window_hours === 24);
        check("E4.10 expone el stock reservado", snap.inventory.reserved_units === 4);
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
