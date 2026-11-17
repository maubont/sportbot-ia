import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin } from "../_shared/admin_auth.ts";
import { sendOutbound } from "../_shared/channels/index.ts";
import type { ChannelName } from "../_shared/channels/types.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import { recordConversationEvent } from "../twilio_inbound_whatsapp/events.ts";
import { formatCop } from "../twilio_inbound_whatsapp/payments-core.ts";

/**
 * Aviso de la decision de pago al cliente.
 *
 * La aprueba o el rechazo ya ocurrieron en la RPC (`approve_payment` /
 * `reject_payment`). Esta funcion solo comunica la decision ya auditada.
 * Es idempotente: un segundo llamado para la misma decision no reenvia nada.
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

function buildApprovedText(params: {
    customerName: string | null;
    reference: string;
    amountCents: number;
}) {
    const name = params.customerName?.trim() || "Hola";

    return [
        `✅ *Pago confirmado*`,
        "",
        `${name}, recibimos el pago del pedido *${params.reference}* por *${formatCop(params.amountCents)} COP*.`,
        "",
        "Ya empezamos a preparar tu envío. Te avisamos por aquí cuando salga. 👟",
    ].join("\n");
}

function buildRejectedText(params: {
    customerName: string | null;
    reference: string;
    amountCents: number;
    reason: string | null;
}) {
    const name = params.customerName?.trim() || "Hola";
    const reason = params.reason?.trim();

    return [
        `⚠️ *No pudimos validar el comprobante*`,
        "",
        `${name}, el comprobante del pedido *${params.reference}* por *${formatCop(params.amountCents)} COP* no coincide con el pago recibido.`,
        ...(reason ? ["", `Motivo: ${reason}`] : []),
        "",
        "Tu pedido sigue reservado. Envía otro comprobante por aquí o escríbenos si necesitas ayuda.",
    ].join("\n");
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    try {
        const auth = await requireAdmin(req, corsHeaders);
        if (auth instanceof Response) return auth;

        const body = await req.json().catch(() => null);
        const orderId = typeof body?.order_id === "string" ? body.order_id.trim() : "";

        if (!orderId) {
            return jsonResponse({ error: "order_id es obligatorio", code: "missing_order_id" }, 400);
        }

        const { supabase: authClient } = auth;
        // El cliente se tipa sin esquema generado; el resto de funciones hace lo mismo.
        const supabase: any = authClient;

        const { data: order, error: orderError } = await supabase
            .from("orders")
            .select(`
                id,
                status,
                payment_reference,
                total_cents,
                payment_rejection_reason,
                customers (
                    id,
                    name,
                    phone_e164
                )
            `)
            .eq("id", orderId)
            .maybeSingle();

        if (orderError) throw orderError;
        if (!order) return jsonResponse({ error: "Pedido no encontrado", code: "order_not_found" }, 404);

        const { data: decision, error: decisionError } = await supabase
            .from("payment_decisions")
            .select("id, decision, note, amount_cents, created_at")
            .eq("order_id", orderId)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (decisionError) throw decisionError;

        if (!decision) {
            return jsonResponse(
                { error: "El pedido no tiene una decision de pago registrada", code: "no_decision" },
                409,
            );
        }

        if (decision.decision === "approved" && order.status !== "paid") {
            return jsonResponse(
                { error: "La decision dice aprobado pero el pedido no está pagado", code: "state_mismatch" },
                409,
            );
        }

        const dedupeKey = `payment_decision:${decision.id}:notified`;
        const { data: alreadyNotified } = await supabase
            .from("conversation_events")
            .select("id")
            .eq("dedupe_key", dedupeKey)
            .limit(1)
            .maybeSingle();

        if (alreadyNotified) {
            return jsonResponse({
                success: true,
                already_notified: true,
                decision: decision.decision,
                decision_id: decision.id,
            });
        }

        const customer = Array.isArray(order.customers) ? order.customers[0] : order.customers;
        const phone = customer?.phone_e164 as string | null | undefined;

        if (!phone) {
            return jsonResponse({
                success: false,
                skipped: "customer_without_phone",
                decision: decision.decision,
            });
        }

        if (!order.payment_reference) {
            return jsonResponse(
                { error: "El pedido no tiene referencia de pago", code: "missing_reference" },
                409,
            );
        }

        const { data: conversation } = await supabase
            .from("conversations")
            .select("id")
            .eq("customer_id", customer.id)
            .order("last_message_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!conversation) {
            return jsonResponse({
                success: false,
                skipped: "no_conversation",
                decision: decision.decision,
            });
        }

        const { data: lastMessage } = await supabase
            .from("messages")
            .select("channel")
            .eq("conversation_id", conversation.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        const channel: ChannelName = lastMessage?.channel === "twilio" ? "twilio" : "evolution";
        const amountCents = Number(order.total_cents ?? decision.amount_cents ?? 0);

        const text = decision.decision === "approved"
            ? buildApprovedText({
                customerName: customer.name,
                reference: order.payment_reference,
                amountCents,
            })
            : buildRejectedText({
                customerName: customer.name,
                reference: order.payment_reference,
                amountCents,
                reason: decision.note ?? order.payment_rejection_reason,
            });

        const result = await sendOutbound({
            channel,
            to: phone,
            text,
            evolution: channel === "evolution" ? evolutionConfig() : null,
        });

        if (!result.success) {
            await recordConversationEvent(supabase, {
                eventType: "payment_decision_notification_failed",
                conversationId: conversation.id,
                customerId: customer.id,
                orderId: order.id,
                actorType: "system",
                direction: "internal",
                funnelStage: decision.decision === "approved" ? "paid" : "payment_failed",
                intent: "payment",
                source: "payment_decision_notify",
                dedupeKey: `payment_decision:${decision.id}:notify_failed:${Date.now()}`,
                metadata: {
                    decision: decision.decision,
                    channel,
                    error: result.error ?? "unknown",
                },
            });

            return jsonResponse({
                success: false,
                decision: decision.decision,
                error: result.error ?? "No se pudo enviar el aviso",
                code: "send_failed",
            }, 502);
        }

        const { data: outbound } = await supabase.from("messages").insert({
            conversation_id: conversation.id,
            role: "assistant",
            direction: "outbound",
            channel,
            body: text,
            provider_message_id: result.providerMessageId ?? null,
        }).select("id").single();

        await recordConversationEvent(supabase, {
            eventType: "payment_decision_notified",
            conversationId: conversation.id,
            customerId: customer.id,
            messageId: outbound?.id ?? null,
            orderId: order.id,
            actorType: "bot",
            direction: "outbound",
            funnelStage: decision.decision === "approved" ? "paid" : "payment_failed",
            intent: "payment",
            amountCents,
            source: "payment_decision_notify",
            dedupeKey,
            metadata: {
                decision: decision.decision,
                decision_id: decision.id,
                payment_reference: order.payment_reference,
                channel,
            },
        });

        return jsonResponse({
            success: true,
            decision: decision.decision,
            decision_id: decision.id,
            channel,
            message_id: outbound?.id ?? null,
        });
    } catch (err: any) {
        console.error("Payment decision notification error:", err);
        return jsonResponse({ error: err?.message || "No se pudo enviar el aviso" }, 400);
    }
});
