#!/usr/bin/env node
/**
 * Corre (o previsualiza) el latido de operacion E4.
 *
 *   node scripts/run-ops-sweep.mjs --dry-run   # que venceria ahora, sin tocar nada
 *   node scripts/run-ops-sweep.mjs             # lo ejecuta de verdad
 *   node scripts/run-ops-sweep.mjs --limit 5   # tope de pedidos por corrida
 *
 * Requiere `gateway/cleanup-job-secret.txt` (lo crea scripts/sync-ops-cron.mjs).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const secretPath = join(root, "gateway", "cleanup-job-secret.txt");

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "";
if (!PROJECT_REF) throw new Error("Set SUPABASE_PROJECT_REF in the local environment.");
const FUNCTION_URL = `https://${PROJECT_REF}.supabase.co/functions/v1/ops_sweep`;

const dryRun = process.argv.includes("--dry-run");
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : 50;

if (!dryRun && !existsSync(secretPath)) {
    console.error(`Falta ${secretPath}. Corre primero: node scripts/sync-ops-cron.mjs`);
    process.exit(1);
}

function queryLinked(sql) {
    return execFileSync("supabase", ["db", "query", "--linked", sql], { encoding: "utf8" }).trim();
}

if (dryRun) {
    console.log("--dry-run: solo lectura, no vence nada.\n");
    console.log(
        queryLinked(`
            WITH cfg AS (
                SELECT COALESCE(NULLIF(payment_receipt_window_hours, 0), 24) AS window_hours
                  FROM public.settings WHERE id = 1
            )
            SELECT o.payment_reference,
                   o.status,
                   cu.name AS cliente,
                   o.total_cents,
                   ROUND(EXTRACT(EPOCH FROM (now() - COALESCE(o.payment_rejected_at, o.created_at))) / 3600)::int AS horas,
                   cfg.window_hours,
                   COALESCE(SUM(oi.qty), 0)::int AS unidades_a_liberar,
                   EXISTS (
                       SELECT 1 FROM public.payment_receipts pr
                        WHERE pr.order_id = o.id AND pr.status IN ('received', 'prevalidated')
                   ) AS tiene_comprobante,
                   EXISTS (
                       SELECT 1 FROM public.payments pay
                        WHERE pay.order_id = o.id AND pay.status = 'approved'
                   ) AS ya_cobrado
              FROM public.orders o
              CROSS JOIN cfg
              LEFT JOIN public.customers cu ON cu.id = o.customer_id
              LEFT JOIN public.order_items oi ON oi.order_id = o.id
             WHERE o.status = 'awaiting_payment'
               AND COALESCE(o.payment_rejected_at, o.created_at)
                   < now() - make_interval(hours => cfg.window_hours)
             GROUP BY o.id, o.payment_reference, o.status, cu.name, o.total_cents,
                      o.created_at, o.payment_rejected_at, cfg.window_hours
             ORDER BY horas DESC;
        `),
    );
    process.exit(0);
}

const secret = readFileSync(secretPath, "utf8").trim();

const response = await fetch(FUNCTION_URL, {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ limit }),
});

const text = await response.text();
console.log(`HTTP ${response.status}`);
try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
    console.log(text);
}

if (!response.ok) process.exit(1);
