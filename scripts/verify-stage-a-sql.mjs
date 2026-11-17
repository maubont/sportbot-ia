#!/usr/bin/env node
/**
 * Verificación real de la Etapa A contra Postgres (PGlite, WASM).
 * Aplica la migración `20261025120000_stage_a_truth.sql` sobre un esquema mínimo
 * y comprueba los criterios C1-C4 del PLAN-ETAPA-A.md.
 *
 * Uso: node scripts/verify-stage-a-sql.mjs
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
    "20261025120000_stage_a_truth.sql",
);
const idempotencyScopeMigrationPath = join(
    root,
    "supabase",
    "migrations",
    "20261106150000_order_message_idempotency_scope.sql",
);
const activeOrderDeduplicationMigrationPath = join(
    root,
    "supabase",
    "migrations",
    "20261106160000_active_order_deduplication.sql",
);

const MINIMAL_SCHEMA = `
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE TABLE public.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    price_cents INTEGER NOT NULL,
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
    shipping_name TEXT,
    shipping_city TEXT,
    shipping_address TEXT,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    payment_reference TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$ SELECT FALSE $$;
`;

let passed = 0;
let failed = 0;
const results = [];

function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        results.push(`  PASS  ${name}`);
    } else {
        failed++;
        results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

async function expectError(name, fn, code) {
    try {
        await fn();
        check(name, false, "no lanzó excepción");
    } catch (error) {
        const message = String(error?.message ?? error);
        check(name, message.includes(code), message.slice(0, 240));
    }
}

function payload(value) {
    const row = value.rows[0];
    const raw = row?.result ?? row?.r ?? row?.create_order_atomic;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
}

const db = new PGlite();

try {
    console.log("→ Creando esquema mínimo…");
    await db.exec(MINIMAL_SCHEMA);

    console.log("→ Aplicando migración de Etapa A…");
    await db.exec(readFileSync(migrationPath, "utf8"));

    console.log("→ Aplicando comentario de idempotencia por mensaje…");
    await db.exec(readFileSync(idempotencyScopeMigrationPath, "utf8"));
    const idempotencyComment = (
        await db.query(`
            SELECT col_description(
                'public.orders'::regclass,
                (SELECT attnum FROM pg_attribute
                 WHERE attrelid = 'public.orders'::regclass AND attname = 'idempotency_key')
            ) AS description
        `)
    ).rows[0].description;
    check(
        "el esquema documenta idempotencia por mensaje entrante",
        String(idempotencyComment).includes("ID estable del mensaje entrante"),
        String(idempotencyComment),
    );

    console.log("→ Aplicando regla de una orden idéntica activa…");
    await db.exec(readFileSync(activeOrderDeduplicationMigrationPath, "utf8"));

    const customer = (
        await db.query("INSERT INTO public.customers DEFAULT VALUES RETURNING id")
    ).rows[0].id;
    const conversation = (
        await db.query("INSERT INTO public.conversations DEFAULT VALUES RETURNING id")
    ).rows[0].id;

    const productA = (
        await db.query(
            "INSERT INTO public.products (price_cents, active) VALUES (100000, TRUE) RETURNING id",
        )
    ).rows[0].id;
    const variantA = (
        await db.query(
            `INSERT INTO public.product_variants (product_id, size, stock, reserved)
             VALUES ($1, 42, 1, 0) RETURNING id`,
            [productA],
        )
    ).rows[0].id;

    const productB = (
        await db.query(
            "INSERT INTO public.products (price_cents, active) VALUES (50000, TRUE) RETURNING id",
        )
    ).rows[0].id;
    const variantB = (
        await db.query(
            `INSERT INTO public.product_variants (product_id, size, stock, reserved)
             VALUES ($1, 40, 10, 0) RETURNING id`,
            [productB],
        )
    ).rows[0].id;

    const callCreate = (key, items, shipping) =>
        db.query(
            `SELECT public.create_order_atomic(
                $1::uuid, $2::jsonb, $3::jsonb, $4::text
            ) AS result`,
            [customer, JSON.stringify(items), JSON.stringify(shipping), key],
        );

    const shipping = {
        name: "Ana Pérez",
        city: "Bogotá",
        address: "Calle 1 # 2-3",
    };

    console.log("→ C1/C2: creación e idempotencia…");
    const first = payload(
        await callCreate(
            "stage-a-key-0001",
            [{ product_id: productA, size: 42, quantity: 1 }],
            shipping,
        ),
    );
    check("crea el pedido", first?.success === true, JSON.stringify(first));
    check("total calculado desde la BD", first?.total_cents === 100000);
    check("no marca deduplicado en la primera llamada", first?.deduplicated === false);

    const second = payload(
        await callCreate(
            "stage-a-key-0001",
            [{ product_id: productA, size: 42, quantity: 1 }],
            shipping,
        ),
    );
    check("la segunda llamada es deduplicada", second?.deduplicated === true);
    check("devuelve el mismo pedido", second?.order_id === first?.order_id);
    check(
        "la deduplicación identifica una orden idéntica activa",
        second?.duplicate_reason === "active_identical_order",
    );

    const newMessageDuplicate = payload(
        await callCreate(
            "stage-a-key-new-message-0001",
            [{ product_id: productA, size: 42, quantity: 1 }],
            shipping,
        ),
    );
    check("un mensaje nuevo no duplica una orden idéntica activa", newMessageDuplicate?.deduplicated === true);
    check("la regla devuelve la orden activa existente", newMessageDuplicate?.order_id === first?.order_id);
    check("la regla reporta el motivo comercial", newMessageDuplicate?.duplicate_reason === "active_identical_order");

    const orderCount = (
        await db.query("SELECT count(*)::int AS c FROM public.orders")
    ).rows[0].c;
    check("existe una sola orden", orderCount === 1, `orders=${orderCount}`);

    const reservedA = (
        await db.query("SELECT reserved FROM public.product_variants WHERE id = $1", [
            variantA,
        ])
    ).rows[0].reserved;
    check("reserva una sola unidad", reservedA === 1, `reserved=${reservedA}`);

    console.log("→ C1/C3: stock insuficiente y rollback…");
    await expectError(
        "rechaza la segunda compra de la última unidad",
        () =>
            callCreate(
                "stage-a-key-0002",
                [{ product_id: productA, size: 42, quantity: 1 }],
                { ...shipping, address: "Calle 1 # 2-4" },
            ),
        "INSUFFICIENT_STOCK",
    );

    const afterFail = (
        await db.query("SELECT count(*)::int AS c FROM public.orders")
    ).rows[0].c;
    check("el fallo no deja orden huérfana", afterFail === 1, `orders=${afterFail}`);

    await expectError(
        "revierte la reserva si un ítem posterior falla",
        () =>
            callCreate(
                "stage-a-key-0003",
                [
                    { product_id: productB, size: 40, quantity: 1 },
                    { product_id: productB, size: 99, quantity: 1 },
                ],
                shipping,
            ),
        "PRODUCT_VARIANT_NOT_FOUND",
    );

    const reservedB = (
        await db.query("SELECT reserved FROM public.product_variants WHERE id = $1", [
            variantB,
        ])
    ).rows[0].reserved;
    check("no queda reserva parcial", reservedB === 0, `reserved=${reservedB}`);

    const validB = payload(
        await callCreate(
            "stage-a-key-0004",
            [
                { product_id: productB, size: 40, quantity: 1 },
                { product_id: productB, size: 40, quantity: 1 },
            ],
            shipping,
        ),
    );
    check("crea el pedido válido posterior", validB?.success === true);

    const activeBRepeat = payload(
        await callCreate(
            "stage-a-key-new-message-0002",
            [{ product_id: productB, size: 40, quantity: 2 }],
            { name: "  ANA Pérez ", city: "BOGOTÁ", address: " Calle 1   # 2-3 " },
        ),
    );
    check("bloquea recompra idéntica durante el ciclo activo", activeBRepeat?.deduplicated === true);
    check("devuelve el pedido B activo", activeBRepeat?.order_id === validB?.order_id);
    check("normaliza líneas, mayúsculas y espacios", activeBRepeat?.duplicate_reason === "active_identical_order");

    for (const activeStatus of ["paid", "processing", "shipped"]) {
        await db.query(
            "UPDATE public.orders SET status = $2, delivered_at = NULL WHERE id = $1",
            [validB?.order_id, activeStatus],
        );
        const duplicate = payload(
            await callCreate(
                `stage-a-key-${activeStatus}-duplicate`,
                [{ product_id: productB, size: 40, quantity: 2 }],
                shipping,
            ),
        );
        check(`bloquea duplicado mientras status=${activeStatus}`, duplicate?.deduplicated === true);
        check(`conserva la orden mientras status=${activeStatus}`, duplicate?.order_id === validB?.order_id);
    }

    await db.query(
        "UPDATE public.orders SET status = 'delivered', delivered_at = NOW() WHERE id = $1",
        [validB?.order_id],
    );
    const afterDelivery = payload(
        await callCreate(
            "stage-a-key-after-delivery",
            [{ product_id: productB, size: 40, quantity: 2 }],
            shipping,
        ),
    );
    check("permite recompra idéntica después de la entrega", afterDelivery?.success === true && afterDelivery?.deduplicated === false);
    check("la recompra posterior crea una orden nueva", afterDelivery?.order_id !== validB?.order_id);

    await db.query("UPDATE public.orders SET status = 'cancelled' WHERE id = $1", [afterDelivery?.order_id]);
    const afterCancellation = payload(
        await callCreate(
            "stage-a-key-after-cancellation",
            [{ product_id: productB, size: 40, quantity: 2 }],
            shipping,
        ),
    );
    check("permite recompra tras cancelación", afterCancellation?.success === true && afterCancellation?.deduplicated === false);

    await db.query("UPDATE public.orders SET status = 'expired' WHERE id = $1", [afterCancellation?.order_id]);
    const afterExpiry = payload(
        await callCreate(
            "stage-a-key-after-expiry",
            [{ product_id: productB, size: 40, quantity: 2 }],
            shipping,
        ),
    );
    check("permite recompra tras expiración", afterExpiry?.success === true && afterExpiry?.deduplicated === false);

    console.log("→ C1: validación de entrada…");
    await expectError(
        "rechaza envío incompleto",
        () =>
            callCreate(
                "stage-a-key-0005",
                [{ product_id: productB, size: 40, quantity: 1 }],
                { name: "", city: "Bogotá", address: "Calle 1" },
            ),
        "INVALID_SHIPPING",
    );
    await expectError(
        "rechaza lista vacía",
        () => callCreate("stage-a-key-0006", [], shipping),
        "INVALID_ITEM",
    );
    await expectError(
        "rechaza cantidad inválida",
        () =>
            callCreate(
                "stage-a-key-0007",
                [{ product_id: productB, size: 40, quantity: 0 }],
                shipping,
            ),
        "INVALID_ITEM",
    );

    console.log("→ C4: dedupe de mensajes…");
    const claim = (id) =>
        db.query("SELECT public.claim_inbound_message($1, $2, $3) AS claimed", [
            "twilio",
            id,
            conversation,
        ]).then((r) => r.rows[0].claimed);
    const finish = (id, status) =>
        db.query("SELECT public.finish_inbound_message($1, $2, $3, NULL)", [
            "twilio",
            id,
            status,
        ]);

    check("reclama el primer mensaje", (await claim("SM-1")) === true);
    check("no reclama el mismo mensaje en proceso", (await claim("SM-1")) === false);
    await finish("SM-1", "done");
    check("no reclama un mensaje ya procesado", (await claim("SM-1")) === false);

    check("reclama un mensaje nuevo", (await claim("SM-2")) === true);
    await finish("SM-2", "failed");
    check("permite reintentar un mensaje fallido", (await claim("SM-2")) === true);

    console.log("→ C5: estado tipado…");
    await db.query(
        `INSERT INTO public.conversation_state (conversation_id, stage)
         VALUES ($1, 'browsing')`,
        [conversation],
    );
    await db.query(
        `UPDATE public.conversation_state
            SET stage = 'awaiting_payment', active_product_id = $2
          WHERE conversation_id = $1`,
        [conversation, productA],
    );
    const state = (
        await db.query(
            "SELECT stage, active_product_id FROM public.conversation_state WHERE conversation_id = $1",
            [conversation],
        )
    ).rows[0];
    check("persiste el stage", state.stage === "awaiting_payment");
    check("persiste el producto activo", state.active_product_id === productA);

    await expectError(
        "rechaza un stage inválido",
        () =>
            db.query(
                "UPDATE public.conversation_state SET stage = 'invented' WHERE conversation_id = $1",
                [conversation],
            ),
        "check constraint",
    );
} catch (error) {
    failed++;
    results.push(`  FAIL  error inesperado — ${error?.message ?? error}`);
    console.error(error);
} finally {
    await db.close();
}

console.log("\nResultados:");
console.log(results.join("\n"));
console.log(`\n${passed}/${passed + failed} PASS`);
process.exit(failed === 0 ? 0 : 1);
