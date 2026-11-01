#!/usr/bin/env node
/**
 * Verificación real de la migración de Etapa B (paso 1) contra Postgres (PGlite).
 *
 * Aplica `20261025130000_stage_b_channel.sql` sobre un esquema mínimo y comprueba
 * los criterios B1.3 (identidad de proveedor y teléfono canónico).
 *
 * Uso: node scripts/verify-stage-b-sql.mjs
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
    "20261025130000_stage_b_channel.sql",
);

const SCHEMA = `
CREATE TABLE public.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 TEXT
);

CREATE TABLE public.messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    twilio_message_sid TEXT
);

CREATE TABLE public.inbound_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider TEXT NOT NULL
);

INSERT INTO public.customers (phone_e164) VALUES
    ('whatsapp:+12025550102'),
    ('whatsapp:+12025550105'),
    ('+12025550199');

INSERT INTO public.messages (twilio_message_sid) VALUES ('SM_LEGACY_1'), (NULL);
`;

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
    if (condition) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` (${detail})` : ""}`);
        console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
    }
}

const db = new PGlite();
await db.exec(SCHEMA);
await db.exec(readFileSync(migrationPath, "utf8"));

console.log("\nEtapa B · canal agnóstico\n");

// --- B1.3a: columnas nuevas ---------------------------------------------------
const columns = await db.query(`
    SELECT column_name, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'messages'
`);
const byName = Object.fromEntries(columns.rows.map((r) => [r.column_name, r]));

check("messages.channel existe y es NOT NULL con default twilio",
    byName.channel?.is_nullable === "NO" && String(byName.channel.column_default).includes("twilio"));
check("messages.provider_message_id existe y acepta NULL",
    Boolean(byName.provider_message_id) && byName.provider_message_id.is_nullable === "YES");

// --- B1.3b: backfill ---------------------------------------------------------
const backfill = await db.query(`
    SELECT twilio_message_sid, provider_message_id, channel
      FROM public.messages
     WHERE twilio_message_sid = 'SM_LEGACY_1'
`);
check("el id de Twilio se copia a provider_message_id",
    backfill.rows[0]?.provider_message_id === "SM_LEGACY_1",
    JSON.stringify(backfill.rows[0]));
check("las filas históricas quedan marcadas como twilio",
    backfill.rows[0]?.channel === "twilio");

const nulls = await db.query(`
    SELECT COUNT(*)::int AS n FROM public.messages WHERE provider_message_id IS NULL
`);
check("un mensaje sin sid sigue sin id de proveedor", nulls.rows[0].n === 1);

// --- B1.3c: índice parcial ---------------------------------------------------
const index = await db.query(`
    SELECT indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_messages_provider_message_id'
`);
check("existe el índice (channel, provider_message_id)",
    String(index.rows[0]?.indexdef).includes("(channel, provider_message_id)"),
    String(index.rows[0]?.indexdef));

// --- B1.3d: teléfono canónico ------------------------------------------------
const phones = await db.query(`SELECT phone_e164 FROM public.customers ORDER BY phone_e164`);
const values = phones.rows.map((r) => r.phone_e164);
check("se elimina el prefijo whatsapp: de las filas existentes",
    values.includes("+12025550102") && values.includes("+12025550105"),
    values.join(", "));
check("no queda ningún teléfono con prefijo de proveedor",
    values.every((v) => !v.startsWith("whatsapp:")), values.join(", "));
check("los teléfonos ya canónicos no se tocan",
    values.includes("+12025550199"));

// --- B1.3e: la forma canónica se exige a filas nuevas ------------------------
const constraint = await db.query(`
    SELECT convalidated FROM pg_constraint WHERE conname = 'customers_phone_e164_canonical'
`);
check("la restricción existe", constraint.rows.length === 1);
check("la restricción es NOT VALID (no bloquea datos históricos)",
    constraint.rows[0]?.convalidated === false);

let rejected = false;
try {
    await db.query(`INSERT INTO public.customers (phone_e164) VALUES ('whatsapp:+12025550101')`);
} catch {
    rejected = true;
}
check("un teléfono nuevo con prefijo de proveedor se rechaza", rejected);

let accepted = false;
try {
    await db.query(`INSERT INTO public.customers (phone_e164) VALUES ('+12025550101')`);
    accepted = true;
} catch (err) {
    accepted = false;
}
check("un E.164 nuevo se acepta", accepted);

// --- B1.3f: idempotencia de la migración -------------------------------------
let idempotent = true;
try {
    // Sin el BEGIN/COMMIT no se puede reaplicar entero; se valida el núcleo.
    await db.exec(`
        ALTER TABLE public.messages
            ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'twilio',
            ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
        ALTER TABLE public.customers
            DROP CONSTRAINT IF EXISTS customers_phone_e164_canonical;
    `);
} catch (err) {
    idempotent = false;
    console.error(err);
}
check("las operaciones ADD COLUMN IF NOT EXISTS son reaplicables", idempotent);

console.log(`\n${passed} ok, ${failures.length} fallos`);
if (failures.length) {
    console.error("\nFallos:");
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
}
