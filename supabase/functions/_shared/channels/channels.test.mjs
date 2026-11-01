/**
 * Contratos del canal agnóstico (Etapa B, paso 1).
 *
 * Se ejecuta con node, sin Deno ni red:
 *   node --experimental-strip-types --test supabase/functions/_shared/channels/channels.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { canonicalE164, digitsOnly, toEvolutionNumber, toTwilioAddress } from "./phone.ts";
import { parseTwilioPayload } from "./twilio.ts";
import { parseEvolutionEvent, isRetryableEvolutionIgnoredEvent, normalizeEvolutionStatus, evolutionSendText, evolutionSendMedia, fetchEvolutionMedia } from "./evolution.ts";
import { detectChannel, verifyWebhookSecret, sendOutbound } from "./index.ts";

// ---------------------------------------------------------------------------
// Teléfonos
// ---------------------------------------------------------------------------

test("canonicalE164 entiende Twilio, Baileys y formato humano", () => {
    assert.equal(canonicalE164("whatsapp:+12025550102"), "+12025550102");
    assert.equal(canonicalE164("12025550102@s.whatsapp.net"), "+12025550102");
    assert.equal(canonicalE164("12025550102:12@s.whatsapp.net"), "+12025550102");
    assert.equal(canonicalE164("+12025550102"), "+12025550102");
    assert.equal(canonicalE164("0012025550102"), "+12025550102");
    assert.equal(canonicalE164("+1 (202) 555-0199"), "+12025550199");
});

test("canonicalE164 rechaza lo que no es un teléfono creíble", () => {
    assert.equal(canonicalE164(""), null);
    assert.equal(canonicalE164(null), null);
    assert.equal(canonicalE164(undefined), null);
    assert.equal(canonicalE164("12345"), null);          // demasiado corto
    assert.equal(canonicalE164("1234567890123456"), null); // demasiado largo
    assert.equal(canonicalE164("2025550102"), null);     // sin país: no se adivina
    assert.equal(canonicalE164("0123456789"), null);     // cero inicial
});

test("helpers de dirección por proveedor", () => {
    assert.equal(toTwilioAddress("+12025550102"), "whatsapp:+12025550102");
    assert.equal(toEvolutionNumber("+12025550102"), "12025550102");
    assert.equal(digitsOnly("+12025550102"), "12025550102");
    assert.equal(toTwilioAddress("basura"), null);
});

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

test("Twilio: mensaje de texto produce sobre canónico", () => {
    const parsed = parseTwilioPayload({
        MessageSid: "SM123",
        From: "whatsapp:+12025550102",
        ProfileName: "Usuario de prueba",
        Body: "hola, busco unas Nike talla 42",
        NumMedia: "0",
    });

    assert.equal(parsed.kind, "message");
    assert.equal(parsed.channel, "twilio");
    assert.equal(parsed.messageId, "SM123");
    assert.equal(parsed.from, "+12025550102");
    assert.equal(parsed.fromRaw, "whatsapp:+12025550102");
    assert.equal(parsed.profileName, "Usuario de prueba");
    assert.equal(parsed.media.length, 0);
    assert.match(parsed.text, /Nike/);
});

test("Twilio: la media se enumera con su tipo", () => {
    const parsed = parseTwilioPayload({
        MessageSid: "SM124",
        From: "whatsapp:+12025550102",
        Body: "",
        NumMedia: "2",
        MediaUrl0: "https://api.twilio.com/a",
        MediaContentType0: "audio/ogg",
        MediaUrl1: "https://api.twilio.com/b",
        MediaContentType1: "image/jpeg",
    });

    assert.equal(parsed.kind, "message");
    assert.equal(parsed.media.length, 2);
    assert.deepEqual(parsed.media.map((m) => m.kind), ["audio", "image"]);
    assert.equal(parsed.media[0].url, "https://api.twilio.com/a");
});

test("Twilio: callback de estado no se confunde con un mensaje", () => {
    const parsed = parseTwilioPayload({
        MessageSid: "SM125",
        MessageStatus: "delivered",
        SmsStatus: "delivered",
    });

    assert.equal(parsed.kind, "status");
    assert.equal(parsed.status, "delivered");
    assert.equal(parsed.messageId, "SM125");
});

test("Twilio: sin MessageSid no se procesa", () => {
    const parsed = parseTwilioPayload({ From: "whatsapp:+12025550102", Body: "hola" });
    assert.equal(parsed.kind, "ignored");
    assert.equal(parsed.reason, "missing_message_id");
});

// ---------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------

function evolutionMessage(overrides = {}) {
    return {
        event: "messages.upsert",
        instance: "sportbot",
        data: {
            key: {
                remoteJid: "12025550102@s.whatsapp.net",
                fromMe: false,
                id: "3EB0ABCDEF",
                ...(overrides.key ?? {}),
            },
            pushName: "Usuario de prueba",
            message: overrides.message ?? { conversation: "hola" },
            messageTimestamp: 1730000000,
            ...(overrides.data ?? {}),
        },
        ...(overrides.root ?? {}),
    };
}

test("Evolution: texto simple", () => {
    const parsed = parseEvolutionEvent(evolutionMessage());

    assert.equal(parsed.kind, "message");
    assert.equal(parsed.channel, "evolution");
    assert.equal(parsed.messageId, "3EB0ABCDEF");
    assert.equal(parsed.from, "+12025550102");
    assert.equal(parsed.fromRaw, "12025550102@s.whatsapp.net");
    assert.equal(parsed.text, "hola");
    assert.equal(parsed.profileName, "Usuario de prueba");
    assert.equal(parsed.timestamp, 1730000000 * 1000);
    assert.equal(parsed.raw.messageTimestamp, 1730000000);
});

test("Evolution: extendedTextMessage", () => {
    const parsed = parseEvolutionEvent(evolutionMessage({
        message: { extendedTextMessage: { text: "¿tienen la Jordan 1 en 43?" } },
    }));
    assert.equal(parsed.kind, "message");
    assert.equal(parsed.text, "¿tienen la Jordan 1 en 43?");
});

test("Evolution: imagen con pie de foto", () => {
    const parsed = parseEvolutionEvent(evolutionMessage({
        message: { imageMessage: { mimetype: "image/jpeg", caption: "quiero estas" } },
    }));
    assert.equal(parsed.kind, "message");
    assert.equal(parsed.text, "quiero estas");
    assert.equal(parsed.media.length, 1);
    assert.equal(parsed.media[0].kind, "image");
    assert.equal(parsed.media[0].contentType, "image/jpeg");
});

test("Evolution: nota de voz sin texto", () => {
    const parsed = parseEvolutionEvent(evolutionMessage({
        message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true, seconds: 4 } },
    }));
    assert.equal(parsed.kind, "message");
    assert.equal(parsed.text, "");
    assert.equal(parsed.media[0].kind, "audio");
});

test("Evolution: sobre efímero se desenvuelve", () => {
    const parsed = parseEvolutionEvent(evolutionMessage({
        message: { ephemeralMessage: { message: { conversation: "sigue ahí?" } } },
    }));
    assert.equal(parsed.kind, "message");
    assert.equal(parsed.text, "sigue ahí?");
});

test("Evolution: botones y listas", () => {
    const button = parseEvolutionEvent(evolutionMessage({
        message: { buttonsResponseMessage: { selectedDisplayText: "Sí, confirmo" } },
    }));
    assert.equal(button.kind, "message");
    assert.equal(button.text, "Sí, confirmo");

    const list = parseEvolutionEvent(evolutionMessage({
        message: { listResponseMessage: { title: "Talla 42", singleSelectReply: { selectedRowId: "42" } } },
    }));
    assert.equal(list.kind, "message");
    assert.equal(list.text, "Talla 42");
});

test("Evolution: no responde a sus propios mensajes", () => {
    const parsed = parseEvolutionEvent(evolutionMessage({ key: { fromMe: true } }));
    assert.equal(parsed.kind, "ignored");
    assert.equal(parsed.reason, "from_me");
});

test("Evolution: ignora grupos y difusiones", () => {
    const group = parseEvolutionEvent(evolutionMessage({ key: { remoteJid: "123456789-1234@g.us" } }));
    assert.equal(group.kind, "ignored");
    assert.equal(group.reason, "group_or_broadcast");

    const broadcast = parseEvolutionEvent(evolutionMessage({ key: { remoteJid: "status@broadcast" } }));
    assert.equal(broadcast.reason, "group_or_broadcast");
});

test("Evolution: LID usa el teléfono alterno; sin él se ignora", () => {
    const withAlt = parseEvolutionEvent(evolutionMessage({
        key: { remoteJid: "99887766554433@lid", remoteJidAlt: "12025550102@s.whatsapp.net" },
    }));
    assert.equal(withAlt.kind, "message");
    assert.equal(withAlt.from, "+12025550102");

    const withoutAlt = parseEvolutionEvent(evolutionMessage({
        key: { remoteJid: "99887766554433@lid" },
    }));
    assert.equal(withoutAlt.kind, "ignored");
    assert.equal(withoutAlt.reason, "lid_without_phone");
});

test("Evolution: reacciones y protocolo no son mensajes", () => {
    const reaction = parseEvolutionEvent(evolutionMessage({
        message: { reactionMessage: { text: "👍", key: { id: "X" } } },
    }));
    assert.equal(reaction.kind, "ignored");
    assert.equal(reaction.reason, "unsupported_content");
});

test("Evolution: eventos ajenos al agente se ignoran sin ruido", () => {
    for (const event of ["connection.update", "qrcode.updated", "presence.update", "contacts.update"]) {
        const parsed = parseEvolutionEvent({ event, data: {} });
        assert.equal(parsed.kind, "ignored");
        assert.match(parsed.reason, /event_not_handled/);
    }
});

test("Evolution: sin id de mensaje no hay dedupe posible", () => {
    const parsed = parseEvolutionEvent(evolutionMessage({ key: { id: "" } }));
    assert.equal(parsed.kind, "ignored");
    assert.equal(parsed.reason, "missing_message_id");
    assert.equal(isRetryableEvolutionIgnoredEvent(parsed), true);

    const ownMessage = parseEvolutionEvent(evolutionMessage({ key: { fromMe: true } }));
    assert.equal(isRetryableEvolutionIgnoredEvent(ownMessage), false);
});

test("Evolution: estados numéricos de Baileys se traducen", () => {
    assert.equal(normalizeEvolutionStatus(2), "server_ack");
    assert.equal(normalizeEvolutionStatus("3"), "delivery_ack");
    assert.equal(normalizeEvolutionStatus(4), "read");
    assert.equal(normalizeEvolutionStatus("READ"), "read");

    const parsed = parseEvolutionEvent({
        event: "messages.update",
        data: { key: { id: "3EB0ABCDEF", remoteJid: "12025550102@s.whatsapp.net" }, update: { status: 3 } },
    });
    assert.equal(parsed.kind, "status");
    assert.equal(parsed.messageId, "3EB0ABCDEF");
    assert.equal(parsed.status, "delivery_ack");
});

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

const CONFIG = { baseUrl: "https://gw.example.dev/", apiKey: "k-123", instance: "sportbot" };

function fakeFetch(response) {
    const calls = [];
    const impl = async (url, init) => {
        calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
        return {
            ok: response.ok ?? true,
            status: response.status ?? 200,
            text: async () => (typeof response.body === "string" ? response.body : JSON.stringify(response.body ?? {})),
        };
    };
    impl.calls = calls;
    return impl;
}

test("Evolution sendText: URL, apikey y número en dígitos", async () => {
    const fetchImpl = fakeFetch({ body: { key: { id: "OUT1" } } });
    const result = await evolutionSendText(CONFIG, { to: "+12025550102", text: "Hola" }, fetchImpl);

    assert.equal(result.success, true);
    assert.equal(result.providerMessageId, "OUT1");

    const [call] = fetchImpl.calls;
    assert.equal(call.url, "https://gw.example.dev/message/sendText/sportbot");
    assert.equal(call.init.headers.apikey, "k-123");
    assert.deepEqual(call.body, { number: "12025550102", text: "Hola" });
});

test("Evolution sendText: error HTTP se devuelve, no se lanza", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500, body: { message: "instance offline" } });
    const result = await evolutionSendText(CONFIG, { to: "+12025550102", text: "Hola" }, fetchImpl);

    assert.equal(result.success, false);
    assert.match(result.error, /evolution_http_500/);
    assert.match(result.error, /instance offline/);
});

test("Evolution sendText: configuración incompleta falla explícita", async () => {
    const result = await evolutionSendText(null, { to: "+12025550102", text: "Hola" }, fakeFetch({}));
    assert.equal(result.success, false);
    assert.equal(result.error, "evolution_not_configured");
});

test("Evolution sendMedia: tipo y pie", async () => {
    const fetchImpl = fakeFetch({ body: { key: { id: "OUT2" } } });
    const result = await evolutionSendMedia(
        CONFIG,
        { to: "+12025550102", mediaUrl: "https://cdn/x.jpg", kind: "image", caption: "Nike 42" },
        fetchImpl,
    );

    assert.equal(result.success, true);
    const [call] = fetchImpl.calls;
    assert.match(call.url, /\/message\/sendMedia\/sportbot$/);
    assert.deepEqual(call.body, {
        number: "12025550102",
        mediatype: "image",
        media: "https://cdn/x.jpg",
        caption: "Nike 42",
    });
});

test("Evolution: descarga de media en base64", async () => {
    const fetchImpl = fakeFetch({ body: { base64: Buffer.from("audio-bytes").toString("base64"), mimetype: "audio/ogg; codecs=opus" } });
    const media = await fetchEvolutionMedia(CONFIG, "3EB0ABCDEF", fetchImpl);

    assert.equal(new TextDecoder().decode(media.bytes), "audio-bytes");
    assert.equal(media.contentType, "audio/ogg");
    assert.deepEqual(fetchImpl.calls[0].body, { message: { key: { id: "3EB0ABCDEF" } }, convertToMp4: false });
});

// ---------------------------------------------------------------------------
// Enrutamiento
// ---------------------------------------------------------------------------

test("detectChannel: Evolution por defecto, Twilio por marca explícita", () => {
    const plain = new Request("https://x.supabase.co/functions/v1/twilio_inbound_whatsapp", { method: "POST" });
    assert.equal(detectChannel(plain), "evolution");

    const twilioQuery = new Request("https://x.supabase.co/functions/v1/twilio_inbound_whatsapp?channel=twilio", { method: "POST" });
    assert.equal(detectChannel(twilioQuery), "twilio");

    const twilioHeader = new Request("https://x.supabase.co/functions/v1/twilio_inbound_whatsapp", {
        method: "POST",
        headers: { "x-sportbot-channel": "twilio" },
    });
    assert.equal(detectChannel(twilioHeader), "twilio");

    const query = new Request("https://x.supabase.co/functions/v1/twilio_inbound_whatsapp?channel=evolution", { method: "POST" });
    assert.equal(detectChannel(query), "evolution");

    const header = new Request("https://x.supabase.co/functions/v1/twilio_inbound_whatsapp", {
        method: "POST",
        headers: { "x-evolution-event": "messages.upsert" },
    });
    assert.equal(detectChannel(header), "evolution");

    const path = new Request("https://x.supabase.co/functions/v1/twilio_inbound_whatsapp/evolution", { method: "POST" });
    assert.equal(detectChannel(path), "evolution");
});

test("verifyWebhookSecret: fail-closed y comparación estricta", () => {
    const req = (url, headers = {}) => new Request(url, { method: "POST", headers });

    assert.equal(verifyWebhookSecret(req("https://x/f"), "s3cr3t"), false, "sin secreto configurado no se acepta");
    assert.equal(verifyWebhookSecret(req("https://x/f?token=s3cr3t"), "s3cr3t"), true);
    assert.equal(verifyWebhookSecret(req("https://x/f?token=otro"), "s3cr3t"), false);
    assert.equal(verifyWebhookSecret(req("https://x/f", { "x-evolution-secret": "s3cr3t" }), "s3cr3t"), true);
    assert.equal(verifyWebhookSecret(req("https://x/f"), ""), false);
});

test("sendOutbound: Evolution sin config no finge éxito", async () => {
    const result = await sendOutbound({ channel: "evolution", to: "+12025550102", text: "Hola" });
    assert.equal(result.success, false);
    assert.equal(result.error, "evolution_not_configured");
});

test("sendOutbound: Twilio con destinatario inválido no llama a la red", async () => {
    const result = await sendOutbound({ channel: "twilio", to: "no-es-telefono", text: "Hola" });
    assert.equal(result.success, false);
    assert.equal(result.error, "twilio_invalid_recipient");
});

// ---------------------------------------------------------------------------
// Payloads reales capturados del gateway (Evolution v2.3.7)
// ---------------------------------------------------------------------------

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

test("payload real: qrcode.updated no es un mensaje", () => {
    const parsed = parseEvolutionEvent(fixture("evolution-qrcode-updated.json"));
    assert.equal(parsed.kind, "ignored");
    assert.match(parsed.reason, /event_not_handled:qrcode\.updated/);
});

test("payload real: connection.update no es un mensaje", () => {
    const parsed = parseEvolutionEvent(fixture("evolution-connection-update.json"));
    assert.equal(parsed.kind, "ignored");
    assert.match(parsed.reason, /event_not_handled:connection\.update/);
});

test("la apikey del webhook no llega a messages.raw_payload", () => {
    // Evolution incluye su propia apikey en cada webhook. Guardarla en la base
    // sería filtrar la llave del gateway en una tabla que lee el admin.
    const parsed = parseEvolutionEvent({
        ...evolutionMessage(),
        apikey: "SECRETO_DEL_GATEWAY",
        destination: "https://ejemplo/hook",
    });

    assert.equal(parsed.kind, "message");
    assert.equal(parsed.raw.apikey, undefined);
    assert.equal(parsed.raw.destination, undefined);
});

test("Evolution: el error en array se conserva en el mensaje", async () => {
    const fetchImpl = fakeFetch({
        ok: false,
        status: 400,
        body: { status: 400, error: "Bad Request", response: { message: ["Message not found"] } },
    });

    await assert.rejects(
        () => fetchEvolutionMedia(CONFIG, "NOEXISTE", fetchImpl),
        /Message not found/,
    );
});
