/**
 * Punto único de entrada/salida del canal.
 *
 * El webhook pregunta "¿de qué canal es esto?" y "mándale esto al cliente".
 * Nunca pregunta "¿es Twilio?".
 */

import type { ChannelName, SendResult } from "./types.ts";
import { evolutionSendMedia, evolutionSendText } from "./evolution.ts";
import type { EvolutionConfig } from "./evolution.ts";
import { toTwilioAddress } from "./phone.ts";
import { sendWhatsApp } from "../twilio.ts";

/**
 * Qué proveedor habla en esta petición.
 *
 * Evolution es el canal operativo y el default. Twilio sigue disponible solo
 * cuando la petición lo marca explícitamente (`?channel=twilio` o cabecera
 * `x-sportbot-channel: twilio`), para no romper el webhook heredado mientras
 * se retira. Sin marca, un evento se trata como Evolution (fail-closed por
 * secreto), nunca como Twilio.
 */
export function detectChannel(req: Request): ChannelName {
    let url: URL;
    try {
        url = new URL(req.url);
    } catch {
        return "evolution";
    }

    const explicit = (url.searchParams.get("channel") ?? "").trim().toLowerCase();
    if (explicit === "evolution" || explicit === "twilio") return explicit;

    const header = (req.headers.get("x-sportbot-channel") ?? "").trim().toLowerCase();
    if (header === "evolution" || header === "twilio") return header;

    // Evolution permite cabeceras personalizadas en el webhook.
    if (req.headers.get("x-evolution-event") || req.headers.get("x-evolution-instance")) {
        return "evolution";
    }

    if (/\/evolution\/?$/i.test(url.pathname)) return "evolution";

    return "evolution";
}

function safeEqual(left: string, right: string): boolean {
    const a = new TextEncoder().encode(left);
    const b = new TextEncoder().encode(right);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

/**
 * Secreto compartido del webhook de Evolution (header o query).
 *
 * Fail-closed: sin `EVOLUTION_WEBHOOK_SECRET` configurado se rechaza. Un webhook
 * abierto permite a cualquiera inyectar mensajes y, con ellos, pedidos.
 */
export function verifyWebhookSecret(req: Request, expected: string | null | undefined): boolean {
    const secret = (expected ?? "").trim();
    if (!secret) return false;

    let url: URL | null = null;
    try {
        url = new URL(req.url);
    } catch {
        url = null;
    }

    const provided = req.headers.get("x-evolution-secret")
        ?? url?.searchParams.get("token")
        ?? url?.searchParams.get("secret")
        ?? "";

    if (!provided) return false;
    return safeEqual(provided, secret);
}

export interface OutboundMessage {
    channel: ChannelName;
    /** E.164 canónico. */
    to: string;
    text: string;
    mediaUrls?: string[];
    /** Requerido cuando `channel` es `evolution`. */
    evolution?: EvolutionConfig | null;
}

/**
 * Envía un mensaje por el canal indicado.
 *
 * Devuelve siempre un resultado explícito: el llamador decide si eso es fatal.
 * Nunca lanza por un fallo de red del proveedor.
 */
export async function sendOutbound(message: OutboundMessage): Promise<SendResult> {
    const mediaUrls = message.mediaUrls ?? [];

    if (message.channel === "evolution") {
        if (mediaUrls.length > 0) {
            return await evolutionSendMedia(
                message.evolution,
                {
                    to: message.to,
                    mediaUrl: mediaUrls[0],
                    caption: message.text,
                },
            );
        }
        return await evolutionSendText(message.evolution, {
            to: message.to,
            text: message.text,
        });
    }

    const address = toTwilioAddress(message.to);
    if (!address) return { success: false, error: "twilio_invalid_recipient" };

    try {
        const result = await sendWhatsApp({
            to: address,
            body: message.text,
            mediaUrls,
            timeout: 10_000,
        });
        return {
            success: result.success,
            providerMessageId: result.sid,
            error: result.error,
        };
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { success: false, error: `twilio_send_crashed:${detail}` };
    }
}
