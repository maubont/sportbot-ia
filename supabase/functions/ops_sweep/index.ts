import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendOutbound } from "../_shared/channels/index.ts";
import type { ChannelName } from "../_shared/channels/types.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import { recordConversationEvent } from "../twilio_inbound_whatsapp/events.ts";
import { buildExpiredNotice } from "../twilio_inbound_whatsapp/payments-core.ts";

/**
 * E4 - Latido de operacion.
 *
 * Corre por cron (cada hora) y hace tres cosas:
 *
 *   1. Vence los pedidos que pasaron la ventana sin pago y libera su stock.
 *      La regla vive en la RPC `expire_stale_payment_orders`: no vence nada con
 *      comprobante esperando revision humana ni nada ya cobrado.
 *   2. Avisa al cliente que la reserva vencio. Es idempotente: el evento
 *      `payment_expired_notified` evita el segundo mensaje.
 *   3. Deja el resumen en el log para que el panel y el dueno sepan que paso.
 *
 * No aprueba pagos ni mueve dinero. Solo expira reservas sin pago.
 *
 * Auth: `Bearer ${CLEANUP_JOB_SECRET}` (cron) o la service role key.
 */

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function evolutionConfig(): EvolutionConfig | null {
    const baseUrl = Deno.env.get("EVOLUTION_API_URL") ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY") ?? "";
    const instance = Deno.env.get("EVOLUTION_INSTANCE") ?? "";

    if (!baseUrl || !apiKey || !instance) return null;
    return { baseUrl, apiKey, instance };
}

type ExpiredOrder = {
    order_id: string;
    payment_reference: string | null;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    conversation_id: string | null;
    total_cents: number;
    hours_waiting: number;
    expired_now: boolean;
    should_notify: boolean;
};

/** La conversacion manda: si un humano tomo el chat, no le escribimos encima. */
async function isHumanHandled(supabase: any, conversationId: string) {
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

async function lastChannel(supabase: any, conversationId: string): Promise<ChannelName> {
    const { data } = await supabase
        .from("messages")
        .select("channel")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    return data?.channel === "twilio" ? "twilio" : "evolution";
}

async function markNotified(
    supabase: any,
    order: ExpiredOrder,
    metadata: Record<string, unknown>,
) {
    await recordConversationEvent(supabase, {
        eventType: "payment_expired_notified",
        conversationId: order.conversation_id,
        customerId: order.customer_id,
        orderId: order.order_id,
        actorType: "bot",
        direction: metadata.skipped ? "internal" : "outbound",
        funnelStage: "payment_failed",
        intent: "payment",
        amountCents: order.total_cents,
        source: "ops_sweep",
        // La misma marca tanto si se aviso como si se decidio no avisar:
        // evita reintentos eternos cada hora.
        dedupeKey: `order:${order.order_id}:expired_notified`,
        metadata: {
            payment_reference: order.payment_reference,
            ...metadata,
        },
    });
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const cleanupSecret = Deno.env.get("CLEANUP_JOB_SECRET");
        const authHeader = req.headers.get("authorization") || "";

        const isServiceRole = Boolean(supabaseKey && authHeader === `Bearer ${supabaseKey}`);
        const isCron = Boolean(cleanupSecret && authHeader === `Bearer ${cleanupSecret}`);

        if (!supabaseKey || (!isServiceRole && !isCron)) {
            return jsonResponse({ error: "Unauthorized" }, 401);
        }

        const supabase: any = createClient(supabaseUrl, supabaseKey);

        const body = await req.json().catch(() => ({}));
        const limit = Number(body?.limit ?? 50);
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50;

        const { data, error } = await supabase.rpc("expire_stale_payment_orders", {
            p_limit: safeLimit,
        });

        if (error) throw new Error(`No se pudo barrer los pedidos: ${error.message}`);

        const orders = (data ?? []) as ExpiredOrder[];
        const summary = {
            expired_now: orders.filter((o) => o.expired_now).length,
            notified: 0,
            skipped: 0,
            failed: 0,
            units_note: "el stock se libera dentro de la RPC",
            errors: [] as string[],
        };

        for (const order of orders) {
            if (!order.should_notify) {
                summary.skipped++;
                continue;
            }

            if (!order.conversation_id) {
                // Sin conversacion no hay donde responder; queda auditado.
                await recordConversationEvent(supabase, {
                    eventType: "payment_expired_notify_skipped",
                    customerId: order.customer_id,
                    orderId: order.order_id,
                    actorType: "system",
                    direction: "internal",
                    funnelStage: "payment_failed",
                    intent: "payment",
                    source: "ops_sweep",
                    dedupeKey: `order:${order.order_id}:expired_notified`,
                    metadata: {
                        payment_reference: order.payment_reference,
                        skipped: "no_conversation",
                    },
                });
                summary.skipped++;
                continue;
            }

            if (!order.customer_phone) {
                await markNotified(supabase, order, { skipped: "customer_without_phone" });
                summary.skipped++;
                continue;
            }

            if (await isHumanHandled(supabase, order.conversation_id)) {
                await markNotified(supabase, order, { skipped: "human_pause" });
                summary.skipped++;
                continue;
            }

            // Idempotencia: si ya enviamos una notificacion de vencimiento para
            // este orden, no reenviar aunque el pedido siga vencido.
            const { data: alreadyNotified } = await supabase
                .from("conversation_events")
                .select("id")
                .eq("dedupe_key", `order:${order.order_id}:expired_notified`)
                .eq("event_type", "payment_expired_notified")
                .maybeSingle();

            if (alreadyNotified) {
                summary.skipped++;
                continue;
            }

            const channel = await lastChannel(supabase, order.conversation_id);
            const text = buildExpiredNotice(
                {
                    id: order.order_id,
                    paymentReference: order.payment_reference ?? "",
                    totalCents: order.total_cents,
                },
                order.customer_name,
            );

            const result = await sendOutbound({
                channel,
                to: order.customer_phone,
                text,
                evolution: channel === "evolution" ? evolutionConfig() : null,
            });

            if (!result.success) {
                summary.failed++;
                summary.errors.push(`${order.order_id}: ${result.error ?? "send_failed"}`);

                // Sin marca de "notificado": la proxima corrida lo reintenta
                // mientras el pedido siga dentro de la ventana de aviso.
                await recordConversationEvent(supabase, {
                    eventType: "payment_expired_notify_failed",
                    conversationId: order.conversation_id,
                    customerId: order.customer_id,
                    orderId: order.order_id,
                    actorType: "system",
                    direction: "internal",
                    funnelStage: "payment_failed",
                    intent: "payment",
                    source: "ops_sweep",
                    dedupeKey:
                        `order:${order.order_id}:expired_notify_failed:` +
                        Math.floor(Date.now() / 3_600_000),
                    metadata: {
                        payment_reference: order.payment_reference,
                        channel,
                        error: result.error ?? "unknown",
                    },
                });
                continue;
            }

            const { data: outbound } = await supabase
                .from("messages")
                .insert({
                    conversation_id: order.conversation_id,
                    role: "assistant",
                    direction: "outbound",
                    channel,
                    body: text,
                    provider_message_id: result.providerMessageId ?? null,
                })
                .select("id")
                .single();

            await recordConversationEvent(supabase, {
                eventType: "payment_expired_notified",
                conversationId: order.conversation_id,
                customerId: order.customer_id,
                messageId: outbound?.id ?? null,
                orderId: order.order_id,
                actorType: "bot",
                direction: "outbound",
                funnelStage: "payment_failed",
                intent: "payment",
                amountCents: order.total_cents,
                source: "ops_sweep",
                dedupeKey: `order:${order.order_id}:expired_notified`,
                metadata: {
                    payment_reference: order.payment_reference,
                    channel,
                    hours_waiting: order.hours_waiting,
                },
            });

            summary.notified++;
        }

        console.log("[ops_sweep]", JSON.stringify(summary));

        return jsonResponse({ success: true, ...summary });
    } catch (err: any) {
        console.error("[ops_sweep] fallo:", err?.message ?? err);
        return jsonResponse({ success: false, error: err?.message ?? "ops_sweep fallo" }, 500);
    }
});
