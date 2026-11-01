/**
 * Canal Evolution API (WhatsApp vía Baileys).
 *
 * Módulo puro respecto a Deno: recibe configuración y `fetch` por parámetro, de
 * modo que se puede probar con node sin levantar nada.
 *
 * Responsabilidades:
 *   - Traducir el webhook de Evolution a `InboundEnvelope`.
 *   - Ignorar explícitamente lo que no debe llegar al agente (ecos propios,
 *     grupos, reacciones, mensajes sin teléfono correlacionable).
 *   - Enviar texto y media.
 *
 * No decide nada de negocio ni toca la base de datos.
 */

import { asRecord, isRecord } from "./types.ts";
import type {
    InboundEnvelope,
    InboundMedia,
    InboundStatus,
    MediaKind,
    ParsedInbound,
    SendResult,
} from "./types.ts";
import { canonicalE164, digitsOnly } from "./phone.ts";

export interface EvolutionConfig {
    /** Ej: https://sportbot-gateway.fly.dev */
    baseUrl: string;
    /** API key global o de la instancia. */
    apiKey: string;
    /** Nombre de la instancia conectada al WhatsApp del negocio. */
    instance: string;
    timeoutMs?: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CHANNEL = "evolution" as const;

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

/**
 * Eventos que sí traen un mensaje del cliente.
 * `send.message` se incluye porque Evolution lo emite para mensajes salientes
 * (nos sirve para detectar ecos), pero el filtro `fromMe` los descarta.
 */
function isMessageEvent(event: string): boolean {
    return event === "messages.upsert" || event === "send.message";
}

function isStatusEvent(event: string): boolean {
    return event === "messages.update" || event === "send.message.update";
}

/** A message without a stable provider ID must not be ACKed as processed. */
export function isRetryableEvolutionIgnoredEvent(parsed: ParsedInbound): boolean {
    return parsed.kind === "ignored" && parsed.reason === "missing_message_id";
}

export function parseEvolutionEvent(payload: unknown): ParsedInbound {
    if (!isRecord(payload)) {
        return { kind: "ignored", channel: CHANNEL, reason: "payload_not_object" };
    }

    const event = String(payload.event ?? payload.type ?? "").toLowerCase();
    if (!event) {
        return { kind: "ignored", channel: CHANNEL, reason: "missing_event" };
    }

    if (isStatusEvent(event)) return parseStatusEvent(payload);

    if (!isMessageEvent(event)) {
        // connection.update, qrcode.updated, presence.update, contacts.*,
        // messages.delete, etc. Todos son ruido para el agente.
        return { kind: "ignored", channel: CHANNEL, reason: `event_not_handled:${event}` };
    }

    const data = firstRecord(payload.data);
    if (!data) {
        return { kind: "ignored", channel: CHANNEL, reason: "missing_data" };
    }

    const key = asRecord(data.key);
    if (!key) return { kind: "ignored", channel: CHANNEL, reason: "missing_key" };

    const messageId = typeof key.id === "string" ? key.id.trim() : "";
    if (!messageId) {
        return { kind: "ignored", channel: CHANNEL, reason: "missing_message_id" };
    }

    // Ecos: sin esto, el bot se responde a sí mismo en bucle.
    if (key.fromMe === true) {
        return { kind: "ignored", channel: CHANNEL, reason: "from_me" };
    }

    const remoteJid = typeof key.remoteJid === "string" ? key.remoteJid : "";
    if (!remoteJid) {
        return { kind: "ignored", channel: CHANNEL, reason: "missing_remote_jid" };
    }

    if (/@(g\.us|broadcast|newsletter)$/i.test(remoteJid)) {
        return { kind: "ignored", channel: CHANNEL, reason: "group_or_broadcast" };
    }

    // WhatsApp migró parte de los chats a LIDs (`123456@lid`), que no son
    // teléfonos. Si el payload no trae el número alterno, no hay cliente que
    // crear: se ignora en vez de inventar una identidad.
    const jid = resolvePhoneJid(remoteJid, key);
    if (!jid) {
        return { kind: "ignored", channel: CHANNEL, reason: "lid_without_phone" };
    }

    const from = canonicalE164(jid);
    if (!from) {
        return { kind: "ignored", channel: CHANNEL, reason: "invalid_phone" };
    }

    const message = asRecord(data.message);
    if (!message) {
        return { kind: "ignored", channel: CHANNEL, reason: "missing_message_body" };
    }

    const content = extractContent(message);
    if (!content) {
        return { kind: "ignored", channel: CHANNEL, reason: "unsupported_content" };
    }

    const envelope: InboundEnvelope = {
        kind: "message",
        channel: CHANNEL,
        messageId,
        from,
        fromRaw: remoteJid,
        profileName: typeof data.pushName === "string" && data.pushName.trim()
            ? data.pushName.trim()
            : null,
        text: content.text,
        media: content.media.map((item, index) => ({ ...item, index })),
        timestamp: toEpochMs(data.messageTimestamp),
        raw: data,
    };

    return envelope;
}

/**
 * Devuelve el JID con teléfono. Prefiere `remoteJidAlt` cuando el principal es
 * un LID, porque es donde Baileys expone el número real.
 */
function resolvePhoneJid(remoteJid: string, key: Record<string, unknown>): string | null {
    const alt = typeof key.remoteJidAlt === "string" ? key.remoteJidAlt : null;
    const altPhone = typeof key.participantAlt === "string" ? key.participantAlt : null;

    for (const candidate of [remoteJid, alt, altPhone]) {
        if (!candidate) continue;
        if (/@s\.whatsapp\.net$/i.test(candidate)) return candidate;
        if (/@c\.us$/i.test(candidate)) continue;
    }

    // JID sin sufijo conocido pero con pinta de número: se intenta igual.
    if (!/@/.test(remoteJid)) return remoteJid;
    return null;
}

function firstRecord(value: unknown): Record<string, unknown> | null {
    if (Array.isArray(value)) {
        for (const item of value) {
            const record = asRecord(item);
            if (record) return record;
        }
        return null;
    }
    return asRecord(value);
}

function toEpochMs(value: unknown): number | null {
    let raw: number | null = null;

    if (typeof value === "number") raw = value;
    else if (typeof value === "string" && value.trim()) raw = Number(value);
    else if (isRecord(value) && typeof value.low === "number") raw = value.low;

    if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;
    // Baileys entrega segundos; el resto del sistema usa milisegundos.
    return raw > 1e12 ? raw : raw * 1000;
}

// ---------------------------------------------------------------------------
// Contenido
// ---------------------------------------------------------------------------

const MEDIA_NODES: Array<[string, MediaKind]> = [
    ["imageMessage", "image"],
    ["videoMessage", "video"],
    ["audioMessage", "audio"],
    ["documentMessage", "document"],
    ["stickerMessage", "sticker"],
];

/** Desenvuelve sobres (efímero, ver una vez, documento con pie, editado). */
function unwrapMessage(message: Record<string, unknown>): Record<string, unknown> {
    const wrappers = [
        "ephemeralMessage",
        "viewOnceMessage",
        "viewOnceMessageV2",
        "viewOnceMessageV2Extension",
        "documentWithCaptionMessage",
        "editedMessage",
    ];

    let current = message;
    for (let depth = 0; depth < 5; depth++) {
        let advanced = false;
        for (const wrapper of wrappers) {
            const node = asRecord(current[wrapper]);
            const inner = node ? asRecord(node.message) : null;
            if (inner) {
                current = inner;
                advanced = true;
                break;
            }
        }
        if (!advanced) break;
    }
    return current;
}

function extractContent(
    message: Record<string, unknown>,
): { text: string; media: InboundMedia[] } | null {
    const body = unwrapMessage(message);

    // Reacciones y protocolo (revocar/editar) no son mensajes del cliente.
    if (body.reactionMessage || body.protocolMessage) return null;

    const media: InboundMedia[] = [];
    for (const [node, kind] of MEDIA_NODES) {
        const item = asRecord(body[node]);
        if (!item) continue;
        media.push({
            index: media.length,
            kind,
            contentType: typeof item.mimetype === "string" ? item.mimetype : null,
            url: null,
            providerRef: typeof item.directPath === "string" ? item.directPath : null,
        });
    }

    const text = extractText(body);
    if (!text && media.length === 0) return null;

    return { text, media };
}

function extractText(body: Record<string, unknown>): string {
    const literal = (value: unknown) => (typeof value === "string" ? value.trim() : "");

    const conversation = literal(body.conversation);
    if (conversation) return conversation;

    const extended = asRecord(body.extendedTextMessage);
    if (extended && literal(extended.text)) return literal(extended.text);

    // Pie de foto/video/documento.
    for (const node of ["imageMessage", "videoMessage", "documentMessage"]) {
        const item = asRecord(body[node]);
        if (item && literal(item.caption)) return literal(item.caption);
    }

    const buttons = asRecord(body.buttonsResponseMessage);
    if (buttons) {
        const text = literal(buttons.selectedDisplayText) || literal(buttons.selectedButtonId);
        if (text) return text;
    }

    const list = asRecord(body.listResponseMessage);
    if (list) {
        const reply = asRecord(list.singleSelectReply);
        const text = literal(list.title)
            || (reply ? literal(reply.selectedRowId) : "")
            || literal(list.description);
        if (text) return text;
    }

    const template = asRecord(body.templateButtonReplyMessage);
    if (template && literal(template.selectedDisplayText)) {
        return literal(template.selectedDisplayText);
    }

    if (asRecord(body.locationMessage)) return "[Ubicación compartida]";
    if (asRecord(body.contactMessage)) return "[Contacto compartido]";

    // Audio/imagen sin pie: el texto queda vacío y el webhook decide
    // (transcripción o aclaración).
    return "";
}

// ---------------------------------------------------------------------------
// Estados de entrega
// ---------------------------------------------------------------------------

const STATUS_BY_CODE: Record<string, string> = {
    "0": "error",
    "1": "pending",
    "2": "server_ack",
    "3": "delivery_ack",
    "4": "read",
    "5": "played",
};

export function normalizeEvolutionStatus(value: unknown): string {
    if (typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value))) {
        return STATUS_BY_CODE[String(value)] ?? String(value);
    }
    return typeof value === "string" ? value.toLowerCase() : "unknown";
}

function parseStatusEvent(payload: Record<string, unknown>): ParsedInbound {
    const data = firstRecord(payload.data);
    if (!data) return { kind: "ignored", channel: CHANNEL, reason: "missing_data" };

    const key = asRecord(data.key);
    const update = asRecord(data.update);

    const messageId =
        (key && typeof key.id === "string" ? key.id : null)
        ?? (typeof data.keyId === "string" ? data.keyId : null)
        ?? "";

    if (!messageId) {
        return { kind: "ignored", channel: CHANNEL, reason: "status_without_message_id" };
    }

    const rawStatus = data.status ?? (update ? update.status : undefined);
    const errorValue = (update ? update.message : undefined) ?? data.error;

    const status: InboundStatus = {
        kind: "status",
        channel: CHANNEL,
        messageId,
        status: normalizeEvolutionStatus(rawStatus),
        errorMessage: typeof errorValue === "string" ? errorValue : null,
        raw: data,
    };

    return status;
}

// ---------------------------------------------------------------------------
// Salida
// ---------------------------------------------------------------------------

function describeConfig(config: EvolutionConfig | null | undefined): string | null {
    if (!config) return "evolution_not_configured";
    if (!config.baseUrl) return "evolution_missing_base_url";
    if (!config.apiKey) return "evolution_missing_api_key";
    if (!config.instance) return "evolution_missing_instance";
    return null;
}

function endpoint(config: EvolutionConfig, path: string): string {
    return `${config.baseUrl.replace(/\/+$/, "")}${path}`;
}

function describeError(payload: unknown, fallback: string): string {
    if (!isRecord(payload)) return fallback;

    const parts: string[] = [];
    const candidates = [
        payload.message,
        payload.error,
        asRecord(payload.response)?.message,
    ];

    for (const value of candidates) {
        if (typeof value === "string" && value.trim()) {
            parts.push(value.trim());
        } else if (Array.isArray(value)) {
            // Evolution devuelve `message: ["Message not found"]`.
            const joined = value.filter((item): item is string => typeof item === "string").join("; ");
            if (joined) parts.push(joined);
        }
    }

    const unique = [...new Set(parts)].filter((part) => part !== "Bad Request");
    return unique.join(" | ") || fallback;
}

async function postJson(
    url: string,
    apiKey: string,
    body: unknown,
    timeoutMs: number,
    fetchImpl: FetchLike,
): Promise<
    | { ok: true; json: Record<string, unknown> }
    | { ok: false; error: string }
> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetchImpl(url, {
            method: "POST",
            headers: { apikey: apiKey, "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        const text = await res.text();
        let parsed: unknown = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = null;
        }

        if (!res.ok) {
            const detail = describeError(parsed, text.slice(0, 200));
            return { ok: false, error: `evolution_http_${res.status}${detail ? `:${detail}` : ""}` };
        }

        return { ok: true, json: isRecord(parsed) ? parsed : {} };
    } catch (err) {
        const name = isRecord(err) ? String(err.name ?? "") : "";
        if (name === "AbortError") return { ok: false, error: "evolution_timeout" };
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `evolution_network_error:${message}` };
    } finally {
        clearTimeout(timer);
    }
}

function extractProviderMessageId(json: Record<string, unknown>): string | undefined {
    const key = asRecord(json.key);
    if (key && typeof key.id === "string") return key.id;
    if (typeof json.messageId === "string") return json.messageId;
    if (typeof json.id === "string") return json.id;
    return undefined;
}

export async function evolutionSendText(
    config: EvolutionConfig | null | undefined,
    message: { to: string; text: string },
    fetchImpl: FetchLike = fetch,
): Promise<SendResult> {
    const configError = describeConfig(config);
    if (configError || !config) return { success: false, error: configError ?? "evolution_not_configured" };

    const number = digitsOnly(message.to);
    if (!number) return { success: false, error: "evolution_invalid_recipient" };
    if (!message.text.trim()) return { success: false, error: "evolution_empty_text" };

    const result = await postJson(
        endpoint(config, `/message/sendText/${encodeURIComponent(config.instance)}`),
        config.apiKey,
        { number, text: message.text },
        config.timeoutMs ?? 10_000,
        fetchImpl,
    );

    if (!result.ok) return { success: false, error: result.error };
    return { success: true, providerMessageId: extractProviderMessageId(result.json) };
}

export async function evolutionSendMedia(
    config: EvolutionConfig | null | undefined,
    message: { to: string; mediaUrl: string; kind?: MediaKind; caption?: string },
    fetchImpl: FetchLike = fetch,
): Promise<SendResult> {
    const configError = describeConfig(config);
    if (configError || !config) return { success: false, error: configError ?? "evolution_not_configured" };

    const number = digitsOnly(message.to);
    if (!number) return { success: false, error: "evolution_invalid_recipient" };
    if (!message.mediaUrl) return { success: false, error: "evolution_missing_media_url" };

    const mediatype = message.kind === "video"
        ? "video"
        : message.kind === "audio"
            ? "audio"
            : message.kind === "document"
                ? "document"
                : "image";

    const result = await postJson(
        endpoint(config, `/message/sendMedia/${encodeURIComponent(config.instance)}`),
        config.apiKey,
        {
            number,
            mediatype,
            media: message.mediaUrl,
            caption: message.caption ?? "",
        },
        config.timeoutMs ?? 15_000,
        fetchImpl,
    );

    if (!result.ok) return { success: false, error: result.error };
    return { success: true, providerMessageId: extractProviderMessageId(result.json) };
}

/**
 * Descarga el binario de un mensaje entrante. Evolution no expone una URL
 * pública: hay que pedirle el base64 a la instancia.
 */
export async function fetchEvolutionMedia(
    config: EvolutionConfig | null | undefined,
    messageId: string,
    fetchImpl: FetchLike = fetch,
): Promise<{ bytes: Uint8Array; contentType: string }> {
    const configError = describeConfig(config);
    if (configError || !config) throw new Error(configError ?? "evolution_not_configured");
    if (!messageId) throw new Error("evolution_missing_message_id");

    const result = await postJson(
        endpoint(config, `/chat/getBase64FromMediaMessage/${encodeURIComponent(config.instance)}`),
        config.apiKey,
        { message: { key: { id: messageId } }, convertToMp4: false },
        config.timeoutMs ?? 20_000,
        fetchImpl,
    );

    if (!result.ok) throw new Error(result.error);

    const raw = typeof result.json.base64 === "string" ? result.json.base64 : "";
    if (!raw) throw new Error("evolution_media_without_base64");

    const dataUri = raw.replace(/^data:[^;]+;base64,/, "");
    const binary = atob(dataUri);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const contentType = typeof result.json.mimetype === "string"
        ? result.json.mimetype.split(";")[0].trim()
        : "application/octet-stream";

    return { bytes, contentType };
}
