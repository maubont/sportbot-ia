import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin } from "../_shared/admin_auth.ts";
import { sendOutbound } from "../_shared/channels/index.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import {
    recordLogisticsNotification,
    recordLogisticsOutboundMessage,
    updateLogisticsNotificationAttempt,
    type LogisticsNotificationStatus,
} from "../_shared/logistics_notifications.ts";
import {
    classifyLogisticsSend,
    logisticsStatusToMessageDeliveryStatus,
} from "../_shared/logistics_notifications_core.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function cleanText(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function evolutionConfig(): EvolutionConfig | null {
    const baseUrl = Deno.env.get("EVOLUTION_API_URL")?.trim() ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() ?? "";
    const instance = Deno.env.get("EVOLUTION_INSTANCE")?.trim() ?? "";
    return baseUrl && apiKey && instance ? { baseUrl, apiKey, instance, timeoutMs: 10_000 } : null;
}

async function recordDeliveredEvent(
    supabase: any,
    params: {
        shipmentId: string;
        orderId: string;
        userId: string;
        deliveredAt: string;
    },
) {
    const { error } = await supabase.from("shipment_events").insert({
        shipment_id: params.shipmentId,
        order_id: params.orderId,
        event_type: "delivered",
        status: "delivered",
        occurred_at: params.deliveredAt,
        source: "admin",
        actor_user_id: params.userId,
        description: "Order marked as delivered by admin.",
        raw_payload: {
            source: "mark_order_delivered",
        },
        event_key: `${params.shipmentId}:delivered`,
    });

    if (error?.code !== "23505" && error) throw error;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    try {
        const auth = await requireAdmin(req, corsHeaders);
        if (auth instanceof Response) return auth;

        const body = await req.json().catch(() => null);
        const orderId = cleanText(body?.order_id);
        if (!orderId) {
            return jsonResponse({ error: "Missing required field: order_id.", code: "missing_fields" }, 400);
        }

        const { supabase, userId } = auth;
        const { data: order, error: orderError } = await supabase
            .from("orders")
            .select(`
                id,
                status,
                delivered_at,
                customers (
                    id,
                    name,
                    phone_e164
                )
            `)
            .eq("id", orderId)
            .maybeSingle();

        if (orderError) throw orderError;
        if (!order) return jsonResponse({ error: "Order not found.", code: "order_not_found" }, 404);

        if (order.status === "delivered") {
            return jsonResponse({
                error: "Order is already delivered.",
                code: "already_delivered",
                delivered_at: order.delivered_at,
            }, 409);
        }

        if (order.status !== "shipped") {
            return jsonResponse({
                error: `Only shipped orders can be marked as delivered. Current status is "${order.status}".`,
                code: "order_not_shipped",
                order_status: order.status,
            }, 409);
        }

        const { data: shipment, error: shipmentError } = await supabase
            .from("shipments")
            .select("id, order_id, status, carrier_name, tracking_number, delivered_at")
            .eq("order_id", orderId)
            .neq("status", "cancelled")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (shipmentError) throw shipmentError;
        if (!shipment) {
            return jsonResponse({
                error: "No active shipment found for this order.",
                code: "shipment_not_found",
            }, 409);
        }

        if (shipment.status === "delivered" || shipment.delivered_at) {
            return jsonResponse({
                error: "Shipment is already delivered.",
                code: "already_delivered",
                shipment,
            }, 409);
        }

        const deliveredAt = new Date().toISOString();
        const { data: deliveredShipment, error: updateError } = await supabase
            .from("shipments")
            .update({
                status: "delivered",
                delivered_at: deliveredAt,
                delivered_by: userId,
                metadata: {
                    delivered_by: userId,
                    source: "mark_order_delivered",
                },
            })
            .eq("id", shipment.id)
            .neq("status", "delivered")
            .is("delivered_at", null)
            .select("id, order_id, status, carrier_name, tracking_number, shipped_at, delivered_at")
            .maybeSingle();

        if (updateError) throw updateError;
        if (!deliveredShipment) {
            return jsonResponse({
                error: "Shipment was already delivered by another operation. Refresh the order.",
                code: "already_delivered",
            }, 409);
        }

        await recordDeliveredEvent(supabase, {
            shipmentId: deliveredShipment.id,
            orderId,
            userId,
            deliveredAt,
        });

        let notificationStatus: LogisticsNotificationStatus | "skipped_no_phone" = "skipped_no_phone";
        let notificationError: string | null = null;
        let notificationTraceId: string | null = null;
        let notificationTraceError: string | null = null;
        const customer = Array.isArray(order.customers) ? order.customers[0] : order.customers;
        const customerName = customer?.name || "Cliente";
        const phone = customer?.phone_e164;

        if (phone) {
            const messageBody = `✅ *¡Pedido entregado!*\n\nHola ${customerName}, tu pedido ha sido entregado exitosamente.\n\n¡Gracias por tu compra en SportBot!\n\n¿Todo llegó bien? Si tienes alguna pregunta, estamos aquí para ayudarte.`;
            const started = await recordLogisticsNotification({
                supabase,
                shipmentId: deliveredShipment.id,
                orderId,
                purpose: "delivery",
                recipientPhone: phone,
                messageBody,
                status: "pending",
                provider: "evolution",
                rawPayload: { source: "mark_order_delivered", phase: "before_provider_send" },
                createdBy: userId,
            });
            notificationTraceId = started.id;
            notificationTraceError = started.error;

            if (!started.id) {
                notificationStatus = "failed";
                notificationError = "Notification trace could not be created; message was not sent.";
            } else {
                let providerResult: { success: boolean; providerMessageId?: string; error?: string };
                try {
                    providerResult = await sendOutbound({
                        channel: "evolution",
                        to: phone,
                        text: messageBody,
                        evolution: evolutionConfig(),
                    });
                } catch (sendError) {
                    providerResult = {
                        success: false,
                        error: `provider_exception:${sendError instanceof Error ? sendError.message : String(sendError)}`,
                    };
                }

                const outcome = classifyLogisticsSend(providerResult);
                notificationStatus = outcome.status;
                notificationError = outcome.error;
                const finalized = await updateLogisticsNotificationAttempt({
                    supabase,
                    notificationId: started.id,
                    status: outcome.status,
                    provider: "evolution",
                    providerMessageSid: providerResult.providerMessageId ?? null,
                    errorMessage: outcome.error,
                    rawPayload: { source: "mark_order_delivered", provider: "evolution" },
                    actorUserId: userId,
                });
                notificationTraceError = finalized.error;
                if (finalized.error) {
                    notificationStatus = "unknown";
                    notificationError = "Provider outcome could not be fully recorded; verify WhatsApp before retrying.";
                    await supabase.from("logistics_notifications").update({
                        status: "unknown",
                        unknown_at: new Date().toISOString(),
                        error_message: notificationError,
                    }).eq("id", started.id).in("status", ["pending", "queued", "unknown"]);
                } else {
                    notificationStatus = finalized.status || outcome.status;
                }

                const messageTrace = await recordLogisticsOutboundMessage({
                    supabase,
                    customerId: customer?.id ?? null,
                    notificationId: started.id,
                    body: messageBody,
                    providerMessageId: providerResult.providerMessageId ?? null,
                    deliveryStatus: logisticsStatusToMessageDeliveryStatus(notificationStatus as LogisticsNotificationStatus),
                    deliveryError: notificationError,
                });
                if (messageTrace.error) {
                    notificationTraceError = notificationTraceError || messageTrace.error;
                }
            }
        } else {
            const trace = await recordLogisticsNotification({
                supabase,
                orderId,
                shipmentId: deliveredShipment.id,
                purpose: "delivery",
                status: "skipped",
                provider: "evolution",
                errorMessage: "Customer has no phone number.",
                rawPayload: { source: "mark_order_delivered" },
                createdBy: userId,
            });
            notificationTraceId = trace.id;
            notificationTraceError = trace.error;
        }

        return jsonResponse({
            success: true,
            message: "Order marked as delivered.",
            order_status: "delivered",
            shipment: deliveredShipment,
            notification_status: notificationStatus,
            notification_error: notificationError,
            notification_trace_id: notificationTraceId,
            notification_trace_error: notificationTraceError,
        });
    } catch (err: any) {
        console.error("Delivery error:", err);
        return jsonResponse({
            error: err.message || "Delivery update failed.",
            code: "delivery_failed",
        }, 400);
    }
});
