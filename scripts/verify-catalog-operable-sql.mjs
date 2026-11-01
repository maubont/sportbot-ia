#!/usr/bin/env node
/**
 * Verificación real de P1.1 contra Postgres (PGlite).
 *
 * Comprueba que `20261031120000_catalog_operable.sql`:
 *   1. agrega las defensas de precio y talla,
 *   2. normaliza y protege una sola imagen principal,
 *   3. repone stock de forma atómica sin tocar `reserved`,
 *   4. rechaza cantidades inválidas y llamadas sin admin,
 *   5. cambia la imagen principal en una transacción,
 *   6. se puede reaplicar sin perder datos.
 *
 * Uso: node scripts/verify-catalog-operable-sql.mjs
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
    "20261031120000_catalog_operable.sql",
);

const ADMIN_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";
const PRODUCT_ID = "33333333-3333-3333-3333-333333333333";
const VARIANT_42 = "44444444-4444-4444-4444-444444444444";
const VARIANT_43 = "55555555-5555-5555-5555-555555555555";
const MEDIA_FIRST = "66666666-6666-6666-6666-666666666666";
const MEDIA_SECOND = "77777777-7777-7777-7777-777777777777";

const SCHEMA = `
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);

CREATE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
    SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE TABLE public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id),
    email TEXT,
    role TEXT NOT NULL
);

CREATE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.admin_users WHERE user_id = auth.uid()
    )
$$;

CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT UNIQUE NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    colorway TEXT,
    category TEXT,
    price_cents INTEGER NOT NULL,
    description TEXT,
    active BOOLEAN DEFAULT TRUE,
    colors TEXT[] NOT NULL DEFAULT '{}'::text[],
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE public.product_variants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
    size NUMERIC NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT product_variants_reserved_not_above_stock CHECK (reserved <= stock)
);

CREATE UNIQUE INDEX idx_product_variants_product_size_unique
    ON public.product_variants(product_id, size);

CREATE TABLE public.product_media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES public.products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    storage_path TEXT,
    media_type TEXT DEFAULT 'image',
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
`;

const migrationSql = readFileSync(migrationPath, "utf8");
const db = new PGlite();
await db.exec(SCHEMA);

await db.query(
    `INSERT INTO auth.users (id, email) VALUES ($1, 'admin@example.test'), ($2, 'other@example.test')`,
    [ADMIN_ID, OTHER_ID],
);
await db.query(
    `INSERT INTO public.admin_users (user_id, email, role) VALUES ($1, 'admin@example.test', 'owner')`,
    [ADMIN_ID],
);
await db.query(
    `INSERT INTO public.products (id, sku, brand, model, category, price_cents, active, colors)
     VALUES ($1, 'NK-AIR-001', 'Nike', 'Air Max 90', 'casual', 45000000, TRUE, ARRAY['blanco','rojo'])`,
    [PRODUCT_ID],
);
await db.query(
    `INSERT INTO public.product_variants (id, product_id, size, stock, reserved)
     VALUES ($1, $2, 42, 10, 2), ($3, $2, 43, 0, 0)`,
    [VARIANT_42, PRODUCT_ID, VARIANT_43],
);
await db.query(
    `INSERT INTO public.product_media (id, product_id, url, is_primary, created_at)
     VALUES
        ($1, $2, 'https://example.test/one.jpg', TRUE, NOW() - INTERVAL '2 days'),
        ($3, $2, 'https://example.test/two.jpg', TRUE, NOW() - INTERVAL '1 day')`,
    [MEDIA_FIRST, PRODUCT_ID, MEDIA_SECOND],
);

await db.exec(migrationSql);

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(name);
        console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
    }
}

async function asUser(userId, sql, params = []) {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ""]);
    return db.query(sql, params);
}

async function expectFailure(name, promise) {
    try {
        await promise;
        check(name, false, "no lanzó error");
    } catch (error) {
        check(name, true, String(error?.message ?? error));
    }
}

async function primaryState() {
    const result = await db.query(
        `SELECT count(*)::int AS total,
                (array_agg(id))[1]::text AS only_id
           FROM public.product_media
          WHERE product_id = $1 AND is_primary = TRUE`,
        [PRODUCT_ID],
    );
    return result.rows[0];
}

console.log("\nCatálogo operable\n");

const constraints = await db.query(`
    SELECT conname
      FROM pg_constraint
     WHERE conrelid IN ('public.products'::regclass, 'public.product_variants'::regclass)
       AND conname IN ('products_price_positive', 'product_variants_size_range')
     ORDER BY conname
`);
check(
    "agrega los CHECK de precio y talla",
    constraints.rows.length === 2,
    JSON.stringify(constraints.rows),
);

const primaryIndex = await db.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'product_media'
       AND indexname = 'idx_product_media_one_primary'
`);
check("existe el índice único de imagen principal", primaryIndex.rows.length === 1);

const normalizedPrimary = await primaryState();
check(
    "normaliza dos principales a una sola",
    normalizedPrimary.total === 1,
    JSON.stringify(normalizedPrimary),
);
check(
    "conserva la principal más antigua",
    normalizedPrimary.only_id === MEDIA_FIRST,
    normalizedPrimary.only_id,
);

const firstRestock = await asUser(
    ADMIN_ID,
    `SELECT * FROM public.restock_variant($1, $2)`,
    [VARIANT_42, 5],
);
check(
    "admin repone 5 unidades",
    firstRestock.rows[0]?.stock === 15
        && firstRestock.rows[0]?.reserved === 2
        && firstRestock.rows[0]?.available === 13,
    JSON.stringify(firstRestock.rows[0]),
);

const secondRestock = await asUser(
    ADMIN_ID,
    `SELECT * FROM public.restock_variant($1, $2)`,
    [VARIANT_42, 5],
);
check(
    "dos reposiciones acumulan, no pisan",
    secondRestock.rows[0]?.stock === 20 && secondRestock.rows[0]?.available === 18,
    JSON.stringify(secondRestock.rows[0]),
);

const freshVariant = await asUser(
    ADMIN_ID,
    `SELECT * FROM public.restock_variant($1, $2)`,
    [VARIANT_43, 3],
);
check(
    "repone una variante sin reservas",
    freshVariant.rows[0]?.stock === 3
        && freshVariant.rows[0]?.reserved === 0
        && freshVariant.rows[0]?.available === 3,
    JSON.stringify(freshVariant.rows[0]),
);

await expectFailure(
    "rechaza cantidad cero",
    asUser(ADMIN_ID, `SELECT * FROM public.restock_variant($1, 0)`, [VARIANT_42]),
);
await expectFailure(
    "rechaza cantidad negativa",
    asUser(ADMIN_ID, `SELECT * FROM public.restock_variant($1, -3)`, [VARIANT_42]),
);
await expectFailure(
    "rechaza cantidades fuera del límite",
    asUser(ADMIN_ID, `SELECT * FROM public.restock_variant($1, 10001)`, [VARIANT_42]),
);
await expectFailure(
    "rechaza cantidad nula",
    asUser(ADMIN_ID, `SELECT * FROM public.restock_variant($1, NULL)`, [VARIANT_42]),
);
await expectFailure(
    "rechaza una variante inexistente",
    asUser(ADMIN_ID, `SELECT * FROM public.restock_variant(gen_random_uuid(), 1)`),
);
await expectFailure(
    "rechaza a un usuario que no es admin",
    asUser(OTHER_ID, `SELECT * FROM public.restock_variant($1, 1)`, [VARIANT_42]),
);

const unchanged = await db.query(
    `SELECT stock, reserved FROM public.product_variants WHERE id = $1`,
    [VARIANT_42],
);
check(
    "las llamadas rechazadas no alteran el stock",
    unchanged.rows[0]?.stock === 20 && unchanged.rows[0]?.reserved === 2,
    JSON.stringify(unchanged.rows[0]),
);

const setPrimary = await asUser(
    ADMIN_ID,
    `SELECT public.set_primary_product_media($1) AS product_id`,
    [MEDIA_SECOND],
);
const afterSetPrimary = await primaryState();
check(
    "cambia la principal en una transacción",
    setPrimary.rows[0]?.product_id === PRODUCT_ID
        && afterSetPrimary.total === 1
        && afterSetPrimary.only_id === MEDIA_SECOND,
    JSON.stringify({ setPrimary: setPrimary.rows[0], afterSetPrimary }),
);
await expectFailure(
    "rechaza una imagen inexistente",
    asUser(ADMIN_ID, `SELECT public.set_primary_product_media(gen_random_uuid())`),
);
await expectFailure(
    "rechaza cambiar la principal sin admin",
    asUser(OTHER_ID, `SELECT public.set_primary_product_media($1)`, [MEDIA_FIRST]),
);

const grants = await db.query(`
    SELECT
        has_function_privilege('authenticated', 'public.restock_variant(uuid,integer)', 'EXECUTE') AS authenticated_can,
        has_function_privilege('anon', 'public.restock_variant(uuid,integer)', 'EXECUTE') AS anon_can,
        has_function_privilege('authenticated', 'public.set_primary_product_media(uuid)', 'EXECUTE') AS authenticated_media_can,
        has_function_privilege('anon', 'public.set_primary_product_media(uuid)', 'EXECUTE') AS anon_media_can
`);
check(
    "solo authenticated ejecuta las funciones",
    grants.rows[0]?.authenticated_can === true
        && grants.rows[0]?.anon_can === false
        && grants.rows[0]?.authenticated_media_can === true
        && grants.rows[0]?.anon_media_can === false,
    JSON.stringify(grants.rows[0]),
);

await expectFailure(
    "rechaza un precio de cero",
    db.query(
        `INSERT INTO public.products (sku, brand, model, price_cents)
         VALUES ('ZZ-ZERO-001', 'Test', 'Zero', 0)`,
    ),
);
await expectFailure(
    "rechaza una talla cero",
    db.query(
        `INSERT INTO public.product_variants (product_id, size, stock)
         VALUES ($1, 0, 3)`,
        [PRODUCT_ID],
    ),
);
await expectFailure(
    "rechaza una talla mayor a 60",
    db.query(
        `INSERT INTO public.product_variants (product_id, size, stock)
         VALUES ($1, 61, 3)`,
        [PRODUCT_ID],
    ),
);

await db.query(
    `INSERT INTO public.product_variants (product_id, size, stock)
     VALUES ($1, 42.5, 2)`,
    [PRODUCT_ID],
);
const halfSize = await db.query(
    `SELECT size, stock FROM public.product_variants WHERE product_id = $1 AND size = 42.5`,
    [PRODUCT_ID],
);
check(
    "acepta medias tallas",
    Number(halfSize.rows[0]?.size) === 42.5 && halfSize.rows[0]?.stock === 2,
    JSON.stringify(halfSize.rows[0]),
);

await expectFailure(
    "rechaza una talla duplicada",
    db.query(
        `INSERT INTO public.product_variants (product_id, size, stock)
         VALUES ($1, 42, 1)`,
        [PRODUCT_ID],
    ),
);

await db.exec(migrationSql);
const afterReapply = await db.query(
    `SELECT stock, reserved FROM public.product_variants WHERE id = $1`,
    [VARIANT_42],
);
const primaryAfterReapply = await primaryState();
check(
    "reaplicar conserva stock y reservas",
    afterReapply.rows[0]?.stock === 20 && afterReapply.rows[0]?.reserved === 2,
    JSON.stringify(afterReapply.rows[0]),
);
check(
    "reaplicar conserva una sola principal",
    primaryAfterReapply.total === 1 && primaryAfterReapply.only_id === MEDIA_SECOND,
    JSON.stringify(primaryAfterReapply),
);

console.log(`\n${passed}/${passed + failures.length} PASS`);
if (failures.length > 0) {
    console.error(`fallos: ${failures.join(", ")}`);
    process.exit(1);
}
