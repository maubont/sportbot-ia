/**
 * Contratos del canal de mensajería.
 *
 * El agente no debe saber si el mensaje llegó por Twilio, Evolution/Baileys o
 * WhatsApp Cloud API. Todo entra como `InboundEnvelope` y sale como
 * `SendMessage`. Así, cambiar de proveedor no toca el camino del dinero.
 *
 * Módulo puro: sin Deno, sin red, sin base de datos. Se puede probar con node.
 */

export type ChannelName = "twilio" | "evolution";

export type MediaKind = "audio" | "image" | "video" | "document" | "sticker" | "unknown";

export interface InboundMedia {
    index: number;
    kind: MediaKind;
    contentType: string | null;
    /** URL descargable, cuando el proveedor la entrega (Twilio). */
    url: string | null;
    /** Referencia para pedir el binario después (Evolution: id del mensaje). */
    providerRef: string | null;
}

export interface InboundEnvelope {
    kind: "message";
    channel: ChannelName;
    /** Id estable del proveedor. Es la llave de deduplicación. */
    messageId: string;
    /** Teléfono canónico E.164, con `+`. Es la identidad del cliente. */
    from: string;
    /** Dirección cruda del proveedor (`whatsapp:+57...`, `57300...@s.whatsapp.net`). */
    fromRaw: string;
    profileName: string | null;
    text: string;
    media: InboundMedia[];
    /** Milisegundos desde epoch, o null si el proveedor no lo envía. */
    timestamp: number | null;
    /** Payload original, para `messages.raw_payload` y depuración. */
    raw: Record<string, unknown>;
}

export interface InboundStatus {
    kind: "status";
    channel: ChannelName;
    messageId: string;
    status: string;
    errorMessage: string | null;
    raw: Record<string, unknown>;
}

export interface InboundIgnored {
    kind: "ignored";
    channel: ChannelName;
    reason: string;
}

export type ParsedInbound = InboundEnvelope | InboundStatus | InboundIgnored;

export interface SendResult {
    success: boolean;
    providerMessageId?: string;
    error?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
    return isRecord(value) ? value : null;
}
