#!/usr/bin/env node
/**
 * Verificación real de P1.2 contra Postgres (PGlite).
 *
 * Comprueba que `20261101120000_shipments_tracking_url_check.sql`:
 *   1. agrega el guard de forma para `shipments.tracking_url`,
 *   2. no revalida filas históricas (NOT VALID),
 *   3. acepta URL http(s) reales y rechaza esquemas peligrosos,
 *   4. respeta el límite de 500 caracteres en el borde,
 *   5. se puede reaplicar sin duplicar el constraint.
 *
 * Uso: node scripts/verify-order-ficha-sql.mjs
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
    "20261101120000_shipments_tracking_url_check.sql",
);
const migrationSql = readFileSync(migrationPath, "utf8");

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
    if (condition) {
        passed += 1;
        console.log(`  ok  ${name}`);
    } else {
        failed += 1;
        console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

async function expectReject(db, sql, params, name) {
    try {
        await db.query(sql, params);
        check(name, false, "la inserción debió fallar");
    } catch (error) {
        const message = String(error?.message || error);
        check(name, message.includes("shipments_tracking_url_shape"), message);
    }
}

const db = new PGlite();

// Esquema mínimo equivalente a la 20260518090000 (sin el guard nuevo).
await db.exec(`
    CREATE TABLE public.orders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        status TEXT DEFAULT 'draft',
        carrier_name TEXT,
        tracking_number TEXT,
        shipped_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE public.shipments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
        shipment_number INTEGER NOT NULL DEFAULT 1 CHECK (shipment_number > 0),
        status TEXT NOT NULL DEFAULT 'ready_to_fulfill',
        carrier_name TEXT,
        tracking_number TEXT,
        tracking_url TEXT,
        service_level TEXT,
        shipped_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'::jsonb
    );

    INSERT INTO public.orders (status) VALUES ('paid');
    -- Fila histórica con un valor que el guard nuevo habría rechazado:
    INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
    SELECT id, 'shipped', 'Servientrega', 'LEGACY-1', 'javascript:alert(1)'
    FROM public.orders LIMIT 1;
`);

console.log("P1.2 — shipments.tracking_url (20261101120000)");

// 1. La fila histórica existe antes del guard.
const legacyBefore = await db.query(`SELECT count(*)::int AS n FROM public.shipments WHERE tracking_url = 'javascript:alert(1)'`);
check("fila histórica con URL mala existe antes del guard", legacyBefore.rows[0].n === 1);

// 2. Aplicar la migración.
await db.exec(migrationSql);

const constraint = await db.query(`
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shipments_tracking_url_shape'
      AND conrelid = 'public.shipments'::regclass
`);
check("constraint shipments_tracking_url_shape existe", constraint.rows.length === 1);

// 3. NOT VALID: la fila histórica sobrevive sin ser revalidada.
const legacyAfter = await db.query(`SELECT count(*)::int AS n FROM public.shipments WHERE tracking_url = 'javascript:alert(1)'`);
check("NOT VALID no purga ni bloquea la fila histórica", legacyAfter.rows[0].n === 1);

// 4. NULL y http(s) reales pasan.
await db.query(`INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
    SELECT id, 'shipped', 'Servientrega', 'OK-1', NULL FROM public.orders LIMIT 1`);
check("tracking_url NULL se acepta", true);

await db.query(`INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
    SELECT id, 'shipped', 'Servientrega', 'OK-2', 'https://rastreo.servientrega.com/Tracking/Guia/12345' FROM public.orders LIMIT 1`);
check("URL https real se acepta", true);

await db.query(`INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
    SELECT id, 'shipped', 'Coordinadora', 'OK-3', 'HTTP://coordinadora.com/guia=ABC' FROM public.orders LIMIT 1`);
check("URL http en mayúsculas se acepta (guard case-insensitive)", true);

// 5. Esquemas peligrosos y sin esquema se rechazan en el borde.
await expectReject(
    db,
    `INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
     SELECT id, 'shipped', 'Deprisa', 'BAD-1', 'javascript:alert(1)' FROM public.orders LIMIT 1`,
    [],
    "javascript: se rechaza",
);
await expectReject(
    db,
    `INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
     SELECT id, 'shipped', 'Deprisa', 'BAD-2', 'ftp://archivos.com/guia' FROM public.orders LIMIT 1`,
    [],
    "ftp:// se rechaza",
);
await expectReject(
    db,
    `INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
     SELECT id, 'shipped', 'Deprisa', 'BAD-3', 'rastreo.com/123' FROM public.orders LIMIT 1`,
    [],
    "texto sin esquema se rechaza",
);
await expectReject(
    db,
    `INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
     SELECT id, 'shipped', 'Deprisa', 'BAD-4', '' FROM public.orders LIMIT 1`,
    [],
    "cadena vacía se rechaza (la función guarda NULL en su lugar)",
);

// 6. Borde de longitud: 500 pasa, 501 no.
const url500 = `https://g.com/${"a".repeat(486)}`;
const url501 = `https://g.com/${"a".repeat(487)}`;
await db.query(
    `INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
     SELECT id, 'shipped', 'Envia', 'OK-4', $1 FROM public.orders LIMIT 1`,
    [url500],
);
check("URL de 500 caracteres se acepta", true);
await expectReject(
    db,
    `INSERT INTO public.shipments (order_id, status, carrier_name, tracking_number, tracking_url)
     SELECT id, 'shipped', 'Envia', 'BAD-5', $1 FROM public.orders LIMIT 1`,
    [url501],
    "URL de 501 caracteres se rechaza",
);

// 7. Reaplicar la migración no duplica el constraint.
await db.exec(migrationSql);
const constraintsAfterReapply = await db.query(`
    SELECT count(*)::int AS n FROM pg_constraint
    WHERE conname = 'shipments_tracking_url_shape'
      AND conrelid = 'public.shipments'::regclass
`);
check("reaplicar no duplica el constraint", constraintsAfterReapply.rows[0].n === 1);

// 8. El path de lectura del bot sigue intacto.
const botRead = await db.query(`
    SELECT tracking_url FROM public.shipments
    WHERE tracking_url LIKE 'https://rastreo.servientrega.com%' LIMIT 1
`);
check("el bot puede leer tracking_url de shipments", botRead.rows.length === 1 && botRead.rows[0].tracking_url.includes("12345"));

await db.close();

console.log(`\n${passed} checks OK, ${failed} fallidos`);
process.exit(failed > 0 ? 1 : 0);
