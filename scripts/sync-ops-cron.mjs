#!/usr/bin/env node
/**
 * Publica el latido de operacion (E4) y arregla el cron.
 *
 * El cron viejo (`cleanup-zombie-orders`) llamaba a la funcion SIN cabecera de
 * autorizacion: la funcion respondia 401 y nadie miraba la respuesta. Resultado:
 * reservas congeladas durante meses.
 *
 * Este script:
 *   1. reutiliza o genera `gateway/cleanup-job-secret.txt` (gitignored);
 *   2. lo publica como `CLEANUP_JOB_SECRET` en Supabase;
 *   3. reemplaza el job por `ops-sweep`, con `Authorization: Bearer ...`;
 *   4. verifica que quedo agendado y activo.
 *
 * Uso:
 *   node scripts/sync-ops-cron.mjs            # aplica
 *   node scripts/sync-ops-cron.mjs --dry-run  # solo muestra
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const secretPath = join(root, "gateway", "cleanup-job-secret.txt");

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "";
if (!PROJECT_REF) throw new Error("Set SUPABASE_PROJECT_REF in the local environment.");
const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/ops_sweep`;
const JOB_NAME = "ops-sweep";
const LEGACY_JOB_NAME = "cleanup-zombie-orders";
const SCHEDULE = "5 * * * *"; // cada hora a los 5 minutos

const dryRun = process.argv.includes("--dry-run");

let secret;
if (existsSync(secretPath)) {
    secret = readFileSync(secretPath, "utf8").trim();
    if (secret.length < 32) {
        console.error(`El secreto en ${secretPath} es demasiado corto. Borralo y volve a correr.`);
        process.exit(1);
    }
    console.log("Secreto: reutilizo el existente.");
} else {
    secret = randomBytes(32).toString("hex");
    console.log("Secreto: genero uno nuevo.");
}

if (!dryRun && !existsSync(secretPath)) {
    writeFileSync(secretPath, secret + "\n", { mode: 0o600 });
    console.log(`Secreto guardado en ${secretPath} (no se versiona).`);
}

const sql = `
-- Quitar el job viejo que llamaba sin autorizacion.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${LEGACY_JOB_NAME}') THEN
        PERFORM cron.unschedule('${LEGACY_JOB_NAME}');
    END IF;
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = '${JOB_NAME}') THEN
        PERFORM cron.unschedule('${JOB_NAME}');
    END IF;
END;
$$;

SELECT cron.schedule(
    '${JOB_NAME}',
    '${SCHEDULE}',
    $job$
    SELECT net.http_post(
        url := '${FUNCTION_URL}',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ${secret}'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 20000
    );
    $job$
);
`;

if (dryRun) {
    console.log("\n--dry-run: no publico nada.");
    console.log(`Funcion: ${FUNCTION_URL}`);
    console.log(`Horario: ${SCHEDULE}`);
    console.log(`Job: ${JOB_NAME} (reemplaza ${LEGACY_JOB_NAME})`);
    process.exit(0);
}

console.log("Publicando CLEANUP_JOB_SECRET...");
execFileSync(
    "supabase",
    ["secrets", "set", `CLEANUP_JOB_SECRET=${secret}`, "--project-ref", PROJECT_REF],
    { stdio: "inherit" },
);

const dir = mkdtempSync(join(tmpdir(), "sportbot-cron-"));
const sqlPath = join(dir, "ops-sweep.sql");
writeFileSync(sqlPath, sql, "utf8");

try {
    console.log("Agendando el job...");
    const out = execFileSync(
        "supabase",
        ["db", "query", "--linked", "--file", sqlPath],
        { encoding: "utf8" },
    );
    console.log(out.trim());
} finally {
    rmSync(dir, { recursive: true, force: true });
}

const verify = execFileSync(
    "supabase",
    [
        "db",
        "query",
        "--linked",
        "select jobname, schedule, active from cron.job order by jobname;",
    ],
    { encoding: "utf8" },
);
console.log(verify.trim());

if (!verify.includes(JOB_NAME)) {
    console.error("\nEl job no quedo agendado. Revisa el SQL y el proyecto vinculado.");
    process.exit(1);
}

console.log("\nListo. El proximo latido corre a los 5 minutos de cada hora.");
console.log("Para probarlo ahora sin esperar:");
console.log("  node scripts/run-ops-sweep.mjs --dry-run");
