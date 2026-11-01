#!/usr/bin/env node
/**
 * Smoke test del gateway Evolution (B2).
 *
 * Verifica que el gateway responde, que exige apikey, que la instancia existe y
 * que los endpoints que usa `_shared/channels/evolution.ts` están donde deben.
 *
 * No envía mensajes reales: solo llama endpoints con datos inválidos a propósito
 * para distinguir "la ruta no existe" de "la ruta existe y rechazó la petición".
 *
 * Uso:
 *   node scripts/smoke-gateway.mjs <baseUrl> <apiKey> [instance]
 *
 * Ejemplo:
 *   node scripts/smoke-gateway.mjs https://sportbot-gateway.up.railway.app <key> sportbot
 */

const [, , baseUrlArg, apiKeyArg, instanceArg] = process.argv;

if (!baseUrlArg || !apiKeyArg) {
    console.error("uso: node scripts/smoke-gateway.mjs <baseUrl> <apiKey> [instance]");
    process.exit(2);
}

const baseUrl = baseUrlArg.replace(/\/+$/, "");
const apiKey = apiKeyArg;
const instance = instanceArg ?? "sportbot";

let passed = 0;
const failures = [];

function report(name, ok, detail = "") {
    if (ok) {
        passed++;
        console.log(`  ok   ${name}`);
    } else {
        failures.push(`${name}${detail ? ` -> ${detail}` : ""}`);
        console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ""}`);
    }
}

async function probe(path, init = {}) {
    const url = `${baseUrl}${path}`;
    try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
        const text = await res.text();
        let json = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        return { ok: true, status: res.status, text, json };
    } catch (err) {
        return { ok: false, status: 0, text: String(err), json: null };
    }
}

const jsonHeaders = { "Content-Type": "application/json" };

console.log(`\nGateway: ${baseUrl}`);
console.log(`Instancia: ${instance}\n`);

// 1. Vivo y autenticado
const alive = await probe("/", { headers: { apikey: apiKey } });
report("el gateway responde con la apikey correcta", alive.ok && alive.status < 300,
    alive.ok ? `HTTP ${alive.status}` : alive.text);

// 2. Rechaza apikey inválida
const unauthorized = await probe("/instance/fetchInstances", { headers: { apikey: "clave-invalida" } });
report("rechaza una apikey inválida", unauthorized.status === 401, `HTTP ${unauthorized.status}`);

// 3. La instancia existe
const instances = await probe("/instance/fetchInstances", { headers: { apikey: apiKey } });
const list = Array.isArray(instances.json) ? instances.json : [];
const found = list.find((item) => {
    const name = item?.name ?? item?.instance?.instanceName ?? item?.instanceName;
    return name === instance;
});
report(`la instancia "${instance}" está creada`, Boolean(found),
    found ? "" : `encontradas: ${list.length}`);

// 4. Estado de conexión
const stateRes = await probe(`/instance/connectionState/${encodeURIComponent(instance)}`, {
    headers: { apikey: apiKey },
});
const state = stateRes.json?.instance?.state ?? "desconocido";
report("el estado de conexión es legible", stateRes.status === 200, `HTTP ${stateRes.status}`);

// 5. Endpoints del contrato (datos inválidos a propósito)
const media = await probe(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: { apikey: apiKey, ...jsonHeaders },
    body: JSON.stringify({ message: { key: { id: "smoke-test-no-existe" } }, convertToMp4: false }),
});
report("existe /chat/getBase64FromMediaMessage", media.status === 400,
    `HTTP ${media.status} (se esperaba 400 "Message not found")`);

const send = await probe(`/message/sendText/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: { apikey: "clave-invalida", ...jsonHeaders },
    body: JSON.stringify({ number: "12025550103", text: "smoke" }),
});
report("existe /message/sendText (y exige apikey)", send.status === 401,
    `HTTP ${send.status} (se esperaba 401)`);

// 6. Webhook configurado
const webhook = await probe(`/webhook/find/${encodeURIComponent(instance)}`, { headers: { apikey: apiKey } });
const webhookUrl = webhook.json?.url ?? "";
report("hay un webhook configurado", Boolean(webhookUrl), webhookUrl || "sin url");
report("el webhook apunta al canal de Supabase",
    webhookUrl.includes("twilio_inbound_whatsapp") && webhookUrl.includes("channel=evolution"),
    webhookUrl || "sin url");
report("el webhook lleva secreto (cabecera o token)",
    Boolean(webhook.json?.headers?.["x-evolution-secret"]) || webhookUrl.includes("token="),
    "sin secreto: cualquiera podría inyectar mensajes");

console.log(`\nEstado de la sesión: ${state}`);
if (state !== "open") {
    console.log("  aviso: la sesión no está abierta; enviar mensajes va a fallar hasta escanear el QR.");
}

console.log(`\n${passed} ok, ${failures.length} fallos`);
if (failures.length) {
    console.error("\nFallos:");
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
}
