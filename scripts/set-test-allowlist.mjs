#!/usr/bin/env node
/**
 * Publica el candado de pruebas (SPORTBOT_TEST_ALLOWLIST) en Supabase.
 *
 * Fuente de verdad: gateway/test-allowlist.txt (un numero por linea, `#`
 * comenta). Ese archivo NO se versiona: son numeros de personas reales.
 *
 * Regla que este script protege:
 *   - Lista vacia = el bot atiende a CUALQUIERA.
 *   - Lista invalida = el bot no atiende a NADIE (falla cerrado).
 * Por eso se niega a publicar si no queda ningun numero valido: publicar una
 * lista vacia por accidente es el error caro.
 *
 * Uso:
 *   node scripts/set-test-allowlist.mjs
 *   node scripts/set-test-allowlist.mjs --dry-run
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF ?? "hjusliaruysnbelkjwol";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const listPath = join(repoRoot, "gateway", "test-allowlist.txt");
const dryRun = process.argv.includes("--dry-run");

function canonicalE164(raw) {
    const digits = String(raw ?? "").replace(/[\s()\-.]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(digits)) return null;
    return digits;
}

if (!existsSync(listPath)) {
    console.error(`Falta ${listPath}`);
    console.error("Copiá gateway/test-allowlist.example.txt y agregá los números.");
    process.exit(1);
}

const numbers = [];
for (const line of readFileSync(listPath, "utf8").split(/\r?\n/)) {
    const entry = line.replace(/#.*$/, "").trim();
    if (!entry) continue;
    const canonical = canonicalE164(entry);
    if (!canonical) {
        console.error(`Número inválido (se ignora): "${entry}" — usá formato +12025550102`);
        continue;
    }
    numbers.push(canonical);
}

const unique = [...new Set(numbers)];
if (unique.length === 0) {
    console.error("No hay ningún número válido. No publico nada:");
    console.error("una lista vacía abriría el bot a cualquiera.");
    process.exit(1);
}

console.log(`${unique.length} número(s) autorizado(s):`);
for (const n of unique) console.log(`  ${n}`);

if (dryRun) {
    console.log("\n--dry-run: no se publicó nada.");
    process.exit(0);
}

execFileSync(
    "supabase",
    ["secrets", "set", `SPORTBOT_TEST_ALLOWLIST=${unique.join(",")}`, "--project-ref", PROJECT_REF],
    { stdio: "inherit" },
);

console.log("\nPublicado. El próximo mensaje ya usa la lista nueva.");
