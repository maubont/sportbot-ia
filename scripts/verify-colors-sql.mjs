#!/usr/bin/env node
/**
 * Verificación real de la migración de color contra Postgres (PGlite).
 *
 * Comprueba que `20261026120000_product_colors.sql`:
 *   1. crea la columna con default vacío y no nula,
 *   2. rellena los SKU conocidos sin tocar los demás,
 *   3. rechaza colores fuera del vocabulario,
 *   4. se puede reaplicar.
 *
 * Uso: node scripts/verify-colors-sql.mjs
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
    "20261026120000_product_colors.sql",
);
const seedPath = join(root, "supabase", "seed.sql");

const SCHEMA = `
CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sku TEXT UNIQUE,
    brand TEXT,
    model TEXT,
    colorway TEXT,
    category TEXT,
    price_cents INTEGER
);

INSERT INTO public.products (sku, brand, model, colorway, category, price_cents) VALUES
    ('NK-AIR-001', 'Nike', 'Air Max 90', 'Infrared', 'casual', 45000000),
    ('NK-DUN-005', 'Nike', 'Dunk Low', 'Panda', 'casual', 48000000),
    ('ZZ-NEW-999', 'Otra', 'Sin color', 'Plain', 'casual', 10000000);
`;

const migrationSql = readFileSync(migrationPath, "utf8");

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

const db = new PGlite();
await db.exec(SCHEMA);
await db.exec(migrationSql);

console.log("\nColor del catálogo\n");

const column = await db.query(`
    SELECT column_name, is_nullable, data_type, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'products'
       AND column_name = 'colors'
`);
check("crea products.colors como TEXT[] not null", column.rows.length === 1
    && column.rows[0].data_type === "ARRAY"
    && column.rows[0].is_nullable === "NO");
check("el default es un array vacío", String(column.rows[0]?.column_default).includes("'{}'"));

const constraint = await db.query(`
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.products'::regclass
       AND conname = 'products_colors_vocabulary'
`);
check("existe el CHECK del vocabulario", constraint.rows.length === 1);

const index = await db.query(`
    SELECT indexname
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'products'
       AND indexname = 'products_colors_gin'
`);
check("existe el índice GIN para filtrar por color", index.rows.length === 1);

const rows = await db.query(`
    SELECT sku, colors
      FROM public.products
     ORDER BY sku
`);
const colorsBySku = Object.fromEntries(rows.rows.map((row) => [row.sku, row.colors]));
check(
    "rellena Air Max 90",
    JSON.stringify(colorsBySku["NK-AIR-001"]) === JSON.stringify(["blanco", "gris", "rojo"]),
    JSON.stringify(colorsBySku["NK-AIR-001"]),
);
check(
    "rellena Dunk Low",
    JSON.stringify(colorsBySku["NK-DUN-005"]) === JSON.stringify(["blanco", "negro"]),
    JSON.stringify(colorsBySku["NK-DUN-005"]),
);
check(
    "no inventa colores para un SKU desconocido",
    JSON.stringify(colorsBySku["ZZ-NEW-999"]) === JSON.stringify([]),
    JSON.stringify(colorsBySku["ZZ-NEW-999"]),
);

let rejected = false;
try {
    await db.exec(`UPDATE public.products SET colors = ARRAY['Negro'] WHERE sku = 'NK-DUN-005'`);
} catch {
    rejected = true;
}
check("rechaza un color fuera del vocabulario", rejected);

let rejectedUnknown = false;
try {
    await db.exec(`UPDATE public.products SET colors = ARRAY['turquesa'] WHERE sku = 'NK-DUN-005'`);
} catch {
    rejectedUnknown = true;
}
check("rechaza un color que no existe en el vocabulario", rejectedUnknown);

await db.exec(migrationSql);
const afterReapply = await db.query(`
    SELECT colors FROM public.products WHERE sku = 'NK-AIR-001'
`);
check(
    "reaplicar no pisa lo ya escrito",
    JSON.stringify(afterReapply.rows[0]?.colors) === JSON.stringify(["blanco", "gris", "rojo"]),
);

// La semilla debe dejar el mismo resultado que la migración en una base nueva.
const seedSql = readFileSync(seedPath, "utf8");
check("la semilla trae el bloque de colores", /UPDATE products AS p\s+SET colors = v\.colors/.test(seedSql));
const seedSkus = [...seedSql.matchAll(/^\('([A-Z]{2}-[A-Z0-9]{3}-\d{3})',/gm)].map((match) => match[1]);
const migrationSkus = [...migrationSql.matchAll(/^\s*\('([A-Z]{2}-[A-Z0-9]{3}-\d{3})', ARRAY\[/gm)].map((match) => match[1]);
check(
    "semilla y migración cubren los mismos SKU",
    JSON.stringify(seedSkus.sort()) === JSON.stringify(migrationSkus.sort()),
    `seed=${seedSkus.length} migracion=${migrationSkus.length}`,
);

console.log(`\n${passed}/${passed + failures.length} PASS`);
if (failures.length > 0) {
    console.error(`fallos: ${failures.join(", ")}`);
    process.exit(1);
}
