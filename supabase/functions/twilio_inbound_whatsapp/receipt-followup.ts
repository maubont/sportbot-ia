/**
 * Segundo mensaje del comprobante: el resultado del filtro de monto.
 *
 * El acuse inmediato lo manda el webhook; este modulo manda el mensaje que si
 * depende de leer el comprobante ("faltan $X" o "cubre el pedido"). Corre en
 * segundo plano, respeta la pausa humana y es idempotente por `dedupeKey`: si
 * el mismo comprobante se procesa dos veces, el cliente recibe un solo aviso.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { sendOutbound } from "../_shared/channels/index.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import type { ChannelName } from "../_shared/channels/types.ts";
import { recordConversationEvent } from "./events.ts";

function evolutionConfig(): EvolutionConfig | null {
    const baseUrl = Deno.env.get("EVOLUTION_API_URL") ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY") ?? "";
    const instance = Deno.env.get("EVOLUTION_INSTANCE") ?? "";
    if (!baseUrl || !apiKey || !instance) return null;
    return { baseUrl, apiKey, instance };
}

/** La conversacion manda: si un humano tomo el chat, no le escribimos encima. */
async function isHumanHandled(supabase: SupabaseClient, conversationId: string): Promise<boolean> {
    const { data } = await supabase
        .from("conversation_state")
        .select("stage, bot_paused_until")
        .eq("conversation_id", conversationId)
        .maybeSingle();

    if (!data) return false;
    if (data.stage === "human_takeover") return true;

    const pausedUntil = data.bot_paused_until ? Date.parse(data.bot_paused_until) : Number.NaN;
    return Number.isFinite(pausedUntil) && pausedUntil > Date.now();
}

async function lastChannel(supabase: SupabaseClient, conversationId: string): Promise<ChannelName> {
    const { data } = await supabase
        .from("messages")
        .select("channel")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    return data?.channel === "twilio" ? "twilio" : "evolution";
}

async function eventExists(supabase: SupabaseClient, dedupeKey: string): Promise<boolean> {
    const { data, error } = await supabase
        .from("conversation_events")
        .select("id")
        .eq("dedupe_key", dedupeKey)
        .limit(1)
        .maybeSingle();

    if (error) {
        console.warn("[payments] no se pudo comprobar el aviso previo:", error.message);
        // Ante la duda no se manda: un aviso de plata duplicado confunde mas
        // que uno que falta, y el humano ve el pedido en /payments igual.
        return true;
    }

    return Boolean(data?.id);
}

export type ReceiptFollowup = {
    conversationId: string;
    customerId: string;
    orderId: string;
    paymentReference: string;
    text: string;
    /** Clave estable por comprobante + resultado. */
    dedupeKey: string;
    eventType: string;
    amountCents?: number | null;
    metadata?: Record<string, unknown>;
};

/**
 * Envia el aviso y lo deja auditado. Nunca lanza: un fallo de envio no puede
 * tumbar la pre-validacion que ya quedo guardada.
 */
export async function sendReceiptFollowup(
    supabase: SupabaseClient,
    followup: ReceiptFollowup,
): Promise<{ sent: boolean; skipped?: string }> {
    try {
        if (await eventExists(supabase, followup.dedupeKey)) {
            return { sent: false, skipped: "already_sent" };
        }

        const channel = await lastChannel(supabase, followup.conversationId);

        if (await isHumanHandled(supabase, followup.conversationId)) {
            await recordConversationEvent(supabase, {
                eventType: "payment_receipt_notice_skipped",
                conversationId: followup.conversationId,
                customerId: followup.customerId,
                orderId: followup.orderId,
                actorType: "system",
                direction: "internal",
                funnelStage: "payment_review",
                intent: "payment",
                source: "whatsapp_inbound_receipt",
                dedupeKey: followup.dedupeKey,
                metadata: {
                    ...followup.metadata,
                    followup_event: followup.eventType,
                    payment_reference: followup.paymentReference,
                    skipped: "human_pause",
                },
            });
            return { sent: false, skipped: "human_pause" };
        }

        const { data: customer } = await supabase
            .from("customers")
            .select("phone_e164")
            .eq("id", followup.customerId)
            .maybeSingle();

        const phone = String(customer?.phone_e164 ?? "").trim();
        if (!phone) {
            await recordConversationEvent(supabase, {
                eventType: "payment_receipt_notice_skipped",
                conversationId: followup.conversationId,
                customerId: followup.customerId,
                orderId: followup.orderId,
                actorType: "system",
                direction: "internal",
                funnelStage: "payment_review",
                intent: "payment",
                source: "whatsapp_inbound_receipt",
                dedupeKey: followup.dedupeKey,
                metadata: {
                    ...followup.metadata,
                    followup_event: followup.eventType,
                    payment_reference: followup.paymentReference,
                    skipped: "customer_without_phone",
                },
            });
            return { sent: false, skipped: "customer_without_phone" };
        }

        const result = await sendOutbound({
            channel,
            to: phone,
            text: followup.text,
            evolution: channel === "evolution" ? evolutionConfig() : null,
        });

        if (!result.success) {
            // Sin marca estable: si el comprobante se re-procesa, se reintenta.
            await recordConversationEvent(supabase, {
                eventType: "payment_receipt_notice_failed",
                conversationId: followup.conversationId,
                customerId: followup.customerId,
                orderId: followup.orderId,
                actorType: "system",
                direction: "internal",
                funnelStage: "payment_review",
                intent: "payment",
                source: "whatsapp_inbound_receipt",
                dedupeKey: `${followup.dedupeKey}:failed:${Math.floor(Date.now() / 3_600_000)}`,
                metadata: {
                    ...followup.metadata,
                    followup_event: followup.eventType,
                    payment_reference: followup.paymentReference,
                    channel,
                    error: result.error ?? "send_failed",
                },
            });
            return { sent: false, skipped: "send_failed" };
        }

        const { data: outbound } = await supabase
            .from("messages")
            .insert({
                conversation_id: followup.conversationId,
                role: "assistant",
                direction: "outbound",
                channel,
                body: followup.text,
                provider_message_id: result.providerMessageId ?? null,
            })
            .select("id")
            .single();

        await recordConversationEvent(supabase, {
            eventType: followup.eventType,
            conversationId: followup.conversationId,
            customerId: followup.customerId,
            messageId: outbound?.id ?? null,
            orderId: followup.orderId,
            actorType: "bot",
            direction: "outbound",
            funnelStage: "payment_review",
            intent: "payment",
            amountCents: followup.amountCents ?? null,
            source: "whatsapp_inbound_receipt",
            dedupeKey: followup.dedupeKey,
            metadata: {
                ...followup.metadata,
                payment_reference: followup.paymentReference,
                channel,
            },
        });

        return { sent: true };
    } catch (err: any) {
        console.error("[payments] no se pudo enviar el aviso del comprobante:", err?.message ?? err);
        return { sent: false, skipped: "error" };
    }
}
