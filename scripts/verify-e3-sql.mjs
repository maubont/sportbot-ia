#!/usr/bin/env node
/**
 * Verificacion real de E3 (camino del dinero) contra Postgres (PGlite, WASM).
 *
 * Aplica `20261027120000_payment_approval.sql` sobre un esquema minimo y
 * comprueba los criterios E3.1-E3.7:
 *
 *   - aprobar exige admin, referencia, monto exacto y comprobante;
 *   - aprobar es atomico e idempotente (no duplica pago ni stock);
 *   - rechazar deja el pedido en `awaiting_payment` con motivo;
 *   - ningun UPDATE directo puede dejar un pedido en `paid`;
 *   - la cola del admin devuelve comprobantes y veredicto.
 *
 * Uso: node scripts/verify-e3-sql.mjs
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
    "20261027120000_payment_approval.sql",
);

const ADMIN_ID = "00000000-0000-0000-0000-000000000001";

const MINIMAL_SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

-- El baseline usa uuid_generate_v4(); PGlite no trae uuid-ossp por defecto.
CREATE FUNCTION public.uuid_generate_v4() RETURNS UUID
LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$ SELECT '${ADMIN_ID}'::uuid $$;

CREATE TABLE public.admin_users (
    user_id UUID PRIMARY KEY,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'admin'
);
INSERT INTO public.admin_users (user_id, email) VALUES ('${ADMIN_ID}', 'contact@example.test');

CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
    SELECT current_setting('test.is_admin', TRUE) = 'on'
$$;

CREATE TABLE public.settings (id INTEGER PRIMARY KEY);
INSERT INTO public.settings (id) VALUES (1);

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

CREATE TABLE public.messages (id UUID PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.media_files (id UUID PRIMARY KEY DEFAULT gen_random_uuid());

CREATE TABLE public.conversation_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT,
    funnel_stage TEXT
);

CREATE TABLE public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID REFERENCES public.orders(id) ON DELETE CASCADE,
    provider TEXT DEFAULT 'wompi',
    reference TEXT NOT NULL UNIQUE,
    transaction_id TEXT,
    status TEXT DEFAULT 'pending',
    approved_at TIMESTAMPTZ,
    raw_event JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE FUNCTION public.commit_order_stock(target_order_id UUID)
RETURNS INT
LANGUAGE plpgsql AS $$
DECLARE
    item RECORD;
    total INT := 0;
BEGIN
    FOR item IN
        SELECT variant_id, COALESCE(qty, 0)::integer AS qty
          FROM public.order_items
         WHERE order_id = target_order_id
           AND variant_id IS NOT NULL
           AND COALESCE(qty, 0) > 0
    LOOP
        UPDATE public.product_variants
           SET stock = stock - item.qty,
               reserved = reserved - LEAST(item.qty, reserved),
               updated_at = NOW()
         WHERE id = item.variant_id;
        total := total + item.qty;
    END LOOP;
    RETURN total;
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

async function main() {
    const db = new PGlite();
    await db.exec(MINIMAL_SCHEMA);
    await db.exec(migrationSql);

    // --- Datos base -------------------------------------------------------
    const seed = await db.query(`
        WITH c AS (
            INSERT INTO public.customers (phone_e164, name)
            VALUES ('+12025550101', 'Cliente Prueba') RETURNING id
        ), p AS (
            INSERT INTO public.products (brand, model, price_cents)
            VALUES ('Nike', 'Air Max 90', 45000000) RETURNING id
        ), v AS (
            INSERT INTO public.product_variants (product_id, size, stock, reserved)
            SELECT p.id, 42, 2, 1 FROM p RETURNING id, product_id
        ), o AS (
            INSERT INTO public.orders (
                customer_id, status, total_cents, payment_reference
            )
            SELECT c.id, 'awaiting_payment', 45000000, 'ORD-20261027120000-AAAAAA' FROM c
            RETURNING id, customer_id
        ), oi AS (
            INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price_cents)
            SELECT o.id, v.product_id, v.id, 1, 45000000 FROM o, v RETURNING order_id
        ), r AS (
            INSERT INTO public.payment_receipts (
                order_id, storage_path, content_type, bytes, status, ai_verdict
            )
            SELECT o.id, 'inbound/receipt.jpg', 'image/jpeg', 1200, 'received', 'uncertain'
            FROM o RETURNING id, order_id
        )
        SELECT o.id AS order_id, o.customer_id, v.id AS variant_id, r.id AS receipt_id
        FROM o, v, r;
    `);

    const base = seed.rows[0];

    // --- E3.5: aprobar exige admin ---------------------------------------
    await db.exec("SELECT set_config('test.is_admin', 'off', false)");
    let err = await expectError(
        db,
        `SELECT public.approve_payment('${base.order_id}', 'ORD-20261027120000-AAAAAA', 45000000, '${base.receipt_id}')`,
        "NOT_ADMIN",
    );
    check("E3.5 un usuario sin rol admin no puede aprobar", err.ok, err.message);

    await db.exec("SELECT set_config('test.is_admin', 'on', false)");

    // --- E3.1/E3.5: referencia y monto exactos ---------------------------
    err = await expectError(
        db,
        `SELECT public.approve_payment('${base.order_id}', 'ORD-OTRA', 45000000, '${base.receipt_id}')`,
        "REFERENCE_MISMATCH",
    );
    check("E3.5 rechaza una referencia que no es la del pedido", err.ok, err.message);

    err = await expectError(
        db,
        `SELECT public.approve_payment('${base.order_id}', 'ORD-20261027120000-AAAAAA', 1000, '${base.receipt_id}')`,
        "AMOUNT_MISMATCH",
    );
    check("E3.1 el monto aprobado debe ser exactamente el de la BD", err.ok, err.message);

    // --- E3.2: aprobar exige comprobante ---------------------------------
    const noReceipt = await db.query(
        `INSERT INTO public.orders (customer_id, status, total_cents, payment_reference)
         VALUES ('${base.customer_id}', 'awaiting_payment', 10000000, 'ORD-20261027120000-BBBBBB')
         RETURNING id`,
    );
    err = await expectError(
        db,
        `SELECT public.approve_payment('${noReceipt.rows[0].id}', 'ORD-20261027120000-BBBBBB', 10000000)`,
        "RECEIPT_REQUIRED",
    );
    check("E3.2 no se aprueba un pago sin comprobante", err.ok, err.message);

    // --- E3.7: UPDATE directo a paid bloqueado ---------------------------
    err = await expectError(
        db,
        `UPDATE public.orders SET status = 'paid' WHERE id = '${base.order_id}'`,
        "PAYMENT_APPROVAL_REQUIRED",
    );
    check("E3.7 un UPDATE directo no puede dejar el pedido en paid", err.ok, err.message);

    // --- E3.5: aprobacion correcta ---------------------------------------
    const approved = await db.query(
        `SELECT public.approve_payment(
            '${base.order_id}',
            'ORD-20261027120000-AAAAAA',
            45000000,
            '${base.receipt_id}',
            'Verificado en Nequi'
        ) AS result`,
    );
    const approval = approved.rows[0].result;
    check("E3.5 la aprobacion devuelve success", approval.success === true);
    check("E3.5 la aprobacion no se marca como repetida", approval.already_approved === false);

    const orderAfter = await db.query(
        `SELECT status, paid_at, payment_approved_by, payment_rejection_reason
           FROM public.orders WHERE id = '${base.order_id}'`,
    );
    check("E3.5 el pedido queda en paid", orderAfter.rows[0].status === "paid");
    check("E3.5 paid_at queda registrado", Boolean(orderAfter.rows[0].paid_at));
    check("E3.5 queda registrado el aprobador", orderAfter.rows[0].payment_approved_by === ADMIN_ID);

    const payAfter = await db.query(
        `SELECT status, provider, receipt_id, approved_by_user_id
           FROM public.payments WHERE order_id = '${base.order_id}'`,
    );
    check("E3.5 hay un solo pago aprobado", payAfter.rows.length === 1);
    check("E3.5 el pago queda aprobado", payAfter.rows[0].status === "approved");
    check("E3.5 el pago guarda el comprobante", payAfter.rows[0].receipt_id === base.receipt_id);

    const stockAfter = await db.query(
        `SELECT stock, reserved FROM public.product_variants WHERE id = '${base.variant_id}'`,
    );
    check(
        "E3.5 la aprobacion compromete el stock reservado",
        stockAfter.rows[0].stock === 1 && stockAfter.rows[0].reserved === 0,
        JSON.stringify(stockAfter.rows[0]),
    );

    const receiptAfter = await db.query(
        `SELECT status, reviewed_by_user_id FROM public.payment_receipts WHERE id = '${base.receipt_id}'`,
    );
    check("E3.2 el comprobante queda marcado como aprobado", receiptAfter.rows[0].status === "approved");

    const decisions = await db.query(
        `SELECT decision, amount_cents, actor_user_id FROM public.payment_decisions WHERE order_id = '${base.order_id}'`,
    );
    check("E3.5 la decision queda auditada", decisions.rows.length === 1 && decisions.rows[0].decision === "approved");

    // --- E3.5: idempotencia ----------------------------------------------
    const again = await db.query(
        `SELECT public.approve_payment(
            '${base.order_id}',
            'ORD-20261027120000-AAAAAA',
            45000000,
            '${base.receipt_id}'
        ) AS result`,
    );
    check("E3.5 reintentar la aprobacion es idempotente", again.rows[0].result.already_approved === true);

    const payCount = await db.query(
        `SELECT count(*)::int AS n FROM public.payments WHERE order_id = '${base.order_id}'`,
    );
    const stockAgain = await db.query(
        `SELECT stock, reserved FROM public.product_variants WHERE id = '${base.variant_id}'`,
    );
    const decisionCount = await db.query(
        `SELECT count(*)::int AS n FROM public.payment_decisions WHERE order_id = '${base.order_id}'`,
    );
    check("E3.5 reintentar no duplica el pago", payCount.rows[0].n === 1);
    check("E3.5 reintentar no vuelve a descontar stock", stockAgain.rows[0].stock === 1);
    check("E3.5 reintentar no duplica la auditoria", decisionCount.rows[0].n === 1);

    // --- E3.6: rechazo ----------------------------------------------------
    const rejectSeed = await db.query(`
        WITH p AS (
            SELECT id FROM public.products LIMIT 1
        ), v AS (
            INSERT INTO public.product_variants (product_id, size, stock, reserved)
            SELECT p.id, 40, 1, 1 FROM p RETURNING id, product_id
        ), o AS (
            INSERT INTO public.orders (customer_id, status, total_cents, payment_reference)
            VALUES ('${base.customer_id}', 'awaiting_payment', 52000000, 'ORD-20261027120000-CCCCCC')
            RETURNING id
        ), oi AS (
            INSERT INTO public.order_items (order_id, product_id, variant_id, qty, unit_price_cents)
            SELECT o.id, v.product_id, v.id, 1, 52000000 FROM o, v RETURNING order_id
        ), r AS (
            INSERT INTO public.payment_receipts (order_id, storage_path, content_type, status)
            SELECT o.id, 'inbound/dudoso.jpg', 'image/jpeg', 'received' FROM o RETURNING id, order_id
        )
        SELECT o.id AS order_id, v.id AS variant_id, r.id AS receipt_id FROM o, v, r;
    `);
    const reject = rejectSeed.rows[0];

    err = await expectError(
        db,
        `SELECT public.reject_payment('${reject.order_id}', 'no')`,
        "REASON_REQUIRED",
    );
    check("E3.6 exige un motivo visible para rechazar", err.ok, err.message);

    const rejected = await db.query(
        `SELECT public.reject_payment('${reject.order_id}', 'El comprobante no coincide con el monto', '${reject.receipt_id}') AS result`,
    );
    check("E3.6 el rechazo devuelve success", rejected.rows[0].result.success === true);

    const rejectedOrder = await db.query(
        `SELECT status, payment_rejection_reason, paid_at FROM public.orders WHERE id = '${reject.order_id}'`,
    );
    check(
        "E3.6 el pedido sigue pendiente de pago",
        rejectedOrder.rows[0].status === "awaiting_payment",
        rejectedOrder.rows[0].status,
    );
    check(
        "E3.6 el motivo queda visible en el pedido",
        rejectedOrder.rows[0].payment_rejection_reason === "El comprobante no coincide con el monto",
    );
    check("E3.6 rechazar no marca paid_at", rejectedOrder.rows[0].paid_at === null);

    const rejectedReceipt = await db.query(
        `SELECT status, review_note FROM public.payment_receipts WHERE id = '${reject.receipt_id}'`,
    );
    check("E3.6 el comprobante queda rechazado", rejectedReceipt.rows[0].status === "rejected");
    check(
        "E3.6 el motivo queda en el comprobante",
        rejectedReceipt.rows[0].review_note === "El comprobante no coincide con el monto",
    );

    const rejectedPayment = await db.query(
        `SELECT status, review_note FROM public.payments WHERE order_id = '${reject.order_id}'`,
    );
    check("E3.6 el pago queda registrado como rechazado", rejectedPayment.rows[0]?.status === "rejected");

    const stockRejected = await db.query(
        `SELECT stock, reserved FROM public.product_variants WHERE id = '${reject.variant_id}'`,
    );
    check(
        "E3.6 rechazar mantiene la reserva para reintentar",
        stockRejected.rows[0].stock === 1 && stockRejected.rows[0].reserved === 1,
    );

    // --- Reintento: nuevo comprobante y aprobacion ------------------------
    const retryReceipt = await db.query(
        `INSERT INTO public.payment_receipts (order_id, storage_path, content_type, status)
         VALUES ('${reject.order_id}', 'inbound/bueno.jpg', 'image/jpeg', 'received')
         RETURNING id`,
    );
    const retry = await db.query(
        `SELECT public.approve_payment(
            '${reject.order_id}',
            'ORD-20261027120000-CCCCCC',
            52000000,
            '${retryReceipt.rows[0].id}'
        ) AS result`,
    );
    check("E3.6 un pedido rechazado se puede aprobar con un comprobante nuevo", retry.rows[0].result.success === true);

    const cleared = await db.query(
        `SELECT status, payment_rejection_reason FROM public.orders WHERE id = '${reject.order_id}'`,
    );
    check("E3.6 aprobar limpia el motivo de rechazo", cleared.rows[0].payment_rejection_reason === null);
    check("E3.6 el reintento termina en paid", cleared.rows[0].status === "paid");

    // --- E3.4: cola del admin --------------------------------------------
    await db.query(
        `INSERT INTO public.orders (customer_id, status, total_cents, payment_reference)
         VALUES ('${base.customer_id}', 'awaiting_payment', 30000000, 'ORD-20261027120000-DDDDDD')`,
    );
    const queue = await db.query(`SELECT public.admin_payment_queue(60) AS q`);
    const q = queue.rows[0].q;
    check(
        "E3.4 la cola solo trae pedidos pendientes de pago",
        q.orders.length === 2
            && q.orders.every((row) => row.status === "awaiting_payment"),
        JSON.stringify(q.orders.map((row) => row.status)),
    );
    check("E3.4 la cola calcula las horas de espera", typeof q.orders[0].waiting_hours === "number");
    check("E3.4 la cola avisa si falta configurar el recaudo", q.payment_config_complete === false);
    check("E3.4 la cola trae los items del pedido", q.orders[0].items.length === 0);

    // --- Cierre -----------------------------------------------------------
    await db.close();

    console.log(results.join("\n"));
    console.log(`\n${passed} ok, ${failed} fallos`);
    if (failed > 0) process.exit(1);
}

main().catch((err) => {
    console.error("Error inesperado:", err);
    process.exit(1);
});
