/**
 * Canal Twilio (WhatsApp Sandbox / número de producción).
 *
 * Traduce el formulario del webhook al mismo `InboundEnvelope` que Evolution,
 * de modo que el agente tenga un solo contrato.
 *
 * La verificación de firma sigue viviendo en el webhook: aquí solo se interpreta
 * un payload ya autenticado.
 */

import { asRecord } from "./types.ts";
import type { InboundEnvelope, InboundMedia, MediaKind, ParsedInbound } from "./types.ts";
import { canonicalE164 } from "./phone.ts";

const CHANNEL = "twilio" as const;

function mediaKind(contentType: string): MediaKind {
    if (contentType.startsWith("audio/")) return "audio";
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
    if (contentType.startsWith("application/") || contentType.startsWith("text/")) return "document";
    return "unknown";
}

export function parseTwilioPayload(input: Record<string, unknown>): ParsedInbound {
    const data = asRecord(input) ?? {};

    const mediaCount = Number.parseInt(String(data.NumMedia ?? "0"), 10) || 0;
    const hasMedia = mediaCount > 0 || Boolean(data.MediaUrl0);
    const bodyText = typeof data.Body === "string" ? data.Body : "";
    const providerStatus = data.MessageStatus ?? data.SmsStatus;

    // Callback de estado: llega sin cuerpo ni media.
    if (providerStatus && !bodyText && !hasMedia) {
        return {
            kind: "status",
            channel: CHANNEL,
            messageId: String(data.MessageSid ?? data.SmsSid ?? ""),
            status: String(providerStatus).toLowerCase(),
            errorMessage: data.ErrorMessage ? String(data.ErrorMessage) : null,
            raw: data,
        };
    }

    const messageId = typeof data.MessageSid === "string" ? data.MessageSid.trim() : "";
    if (!messageId) {
        return { kind: "ignored", channel: CHANNEL, reason: "missing_message_id" };
    }

    const fromRaw = typeof data.From === "string" ? data.From : "";
    const from = canonicalE164(fromRaw);
    if (!from) {
        return { kind: "ignored", channel: CHANNEL, reason: "invalid_phone" };
    }

    const media: InboundMedia[] = [];
    for (let i = 0; i < mediaCount; i++) {
        const url = data[`MediaUrl${i}`];
        if (typeof url !== "string" || !url) continue;

        const contentTypeRaw = data[`MediaContentType${i}`];
        const contentType = typeof contentTypeRaw === "string" ? contentTypeRaw : null;

        media.push({
            index: media.length,
            kind: mediaKind(contentType ?? ""),
            contentType,
            url,
            providerRef: null,
        });
    }

    const envelope: InboundEnvelope = {
        kind: "message",
        channel: CHANNEL,
        messageId,
        from,
        fromRaw,
        profileName: typeof data.ProfileName === "string" && data.ProfileName.trim()
            ? data.ProfileName.trim()
            : null,
        text: bodyText,
        media,
        timestamp: null,
        raw: data,
    };

    return envelope;
}
