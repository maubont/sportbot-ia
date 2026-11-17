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
import { validateTrackingUrl } from "../_shared/tracking_url.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type JsonBody = Record<string, unknown>;

function jsonResponse(body: JsonBody, status = 200) {
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

function isMissingLogisticsSchema(error: { message?: string; code?: string } | null) {
    if (!error) return false;
    const message = error.message || "";
    return error.code === "42P01" || message.includes("shipments") || message.includes("shipment_events");
}

async function findActiveShipment(supabase: any, orderId: string) {
    const { data, error } = await supabase
        .from("shipments")
        .select("id, order_id, status, carrier_name, tracking_number, shipped_at, delivered_at")
        .eq("order_id", orderId)
        .neq("status", "cancelled")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

    if (isMissingLogisticsSchema(error)) {
        throw new Error("Logistics schema is not applied. Run the shipments migration before dispatching orders.");
    }

    if (error) throw error;
    return data;
}

function isAlreadyDispatched(order: any, shipment: any) {
    if (["shipped", "delivered"].includes(order.status)) return true;
    if (order.shipped_at || order.delivered_at || order.tracking_number || order.carrier_name) return true;
    if (!shipment) return false;

    return Boolean(
        shipment.shipped_at ||
        shipment.delivered_at ||
        shipment.tracking_number ||
        shipment.carrier_name ||
        ["shipped", "in_transit", "out_for_delivery", "delivered"].includes(shipment.status),
    );
}

async function createOrShipShipment(
    supabase: any,
    params: {
        orderId: string;
        shipmentId?: string;
        carrierName: string;
        trackingNumber: string;
        trackingUrl: string;
        shippedAt: string;
        userId: string;
    },
) {
    const payload = {
        status: "shipped",
        carrier_name: params.carrierName,
        tracking_number: params.trackingNumber,
        tracking_url: params.trackingUrl || null,
        shipped_at: params.shippedAt,
        created_by: params.userId,
        metadata: {
            dispatched_by: params.userId,
            source: "dispatch_order",
        },
    };

    if (params.shipmentId) {
        const { data, error } = await supabase
            .from("shipments")
            .update(payload)
            .eq("id", params.shipmentId)
            .in("status", ["ready_to_fulfill", "picking", "packed", "label_created"])
            .is("shipped_at", null)
            .select("id, order_id, status, carrier_name, tracking_number, tracking_url, shipped_at, delivered_at")
            .maybeSingle();

        if (error) throw error;
        if (!data) {
            return { data: null, duplicate: true };
        }

        return { data, duplicate: false };
    }

    const { data, error } = await supabase
        .from("shipments")
        .insert({
            ...payload,
            order_id: params.orderId,
            shipment_number: 1,
        })
        .select("id, order_id, status, carrier_name, tracking_number, tracking_url, shipped_at, delivered_at")
        .single();

    if (error?.code === "23505") {
        return { data: null, duplicate: true };
    }

    if (error) throw error;
    return { data, duplicate: false };
}

async function recordShipmentEvent(
    supabase: any,
    params: {
        shipmentId: string;
        orderId: string;
        userId: string;
        carrierName: string;
        trackingNumber: string;
        trackingUrl: string;
        shippedAt: string;
    },
) {
    const { error } = await supabase.from("shipment_events").insert({
        shipment_id: params.shipmentId,
        order_id: params.orderId,
        event_type: "shipped",
        status: "shipped",
        occurred_at: params.shippedAt,
        source: "admin",
        actor_user_id: params.userId,
        carrier_name: params.carrierName,
        tracking_number: params.trackingNumber,
        description: "Order dispatched by admin.",
        raw_payload: {
            source: "dispatch_order",
            ...(params.trackingUrl ? { tracking_url: params.trackingUrl } : {}),
        },
        event_key: `${params.shipmentId}:shipped`,
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
        const carrierName = cleanText(body?.carrier_name);
        const trackingNumber = cleanText(body?.tracking_number);
        const trackingUrlCheck = validateTrackingUrl(body?.tracking_url);

        if (!orderId || !carrierName || !trackingNumber) {
            return jsonResponse({
                error: "Missing required fields: order_id, carrier_name and tracking_number are required.",
                code: "missing_fields",
            }, 400);
        }

        if (!trackingUrlCheck.ok) {
            return jsonResponse({
                error: trackingUrlCheck.error,
                code: "invalid_tracking_url",
            }, 400);
        }
        const trackingUrl = trackingUrlCheck.url;

        const { supabase, userId } = auth;

        const { data: order, error: orderError } = await supabase
            .from("orders")
            .select(`
                id,
                status,
                carrier_name,
                tracking_number,
                shipped_at,
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
        if (!order) {
            return jsonResponse({ error: "Order not found.", code: "order_not_found" }, 404);
        }

        const activeShipment = await findActiveShipment(supabase, orderId);

        if (isAlreadyDispatched(order, activeShipment)) {
            return jsonResponse({
                error: "Order is already dispatched. Create an explicit new shipment before dispatching it again.",
                code: "already_dispatched",
                shipment: activeShipment,
            }, 409);
        }

        if (order.status !== "paid") {
            return jsonResponse({
                error: `Only paid orders can be dispatched. Current status is "${order.status}".`,
                code: "order_not_paid",
                order_status: order.status,
            }, 409);
        }

        const shippedAt = new Date().toISOString();
        const { data: shipment, duplicate } = await createOrShipShipment(supabase, {
            orderId,
            shipmentId: activeShipment?.id,
            carrierName,
            trackingNumber,
            trackingUrl,
            shippedAt,
            userId,
        });

        if (duplicate || !shipment) {
            return jsonResponse({
                error: "Order was dispatched by another operation. Refresh the order before trying again.",
                code: "already_dispatched",
            }, 409);
        }

        await recordShipmentEvent(supabase, {
            shipmentId: shipment.id,
            orderId,
            userId,
            carrierName,
            trackingNumber,
            trackingUrl,
            shippedAt,
        });

        let notificationStatus: LogisticsNotificationStatus | "skipped_no_phone" = "skipped_no_phone";
        let notificationError: string | null = null;
        let notificationTraceId: string | null = null;
        let notificationTraceError: string | null = null;
        const customer = Array.isArray(order.customers) ? order.customers[0] : order.customers;
        const customerName = customer?.name || "Cliente";
        const phone = customer?.phone_e164;

        if (phone) {
            const messageBody = `📦 *¡Tu paquete va en camino!*\n\nHola ${customerName}, tu orden ha sido despachada con la transportadora *${carrierName}*.\n\n📝 *Número de Guía:* ${trackingNumber}\n\nPuedes rastrear tu envío en la página oficial de ${carrierName}.\n\n¡Gracias por tu compra! 👟`;
            const started = await recordLogisticsNotification({
                supabase,
                shipmentId: shipment.id,
                orderId,
                purpose: "dispatch",
                recipientPhone: phone,
                messageBody,
                status: "pending",
                provider: "evolution",
                rawPayload: { source: "dispatch_order", phase: "before_provider_send" },
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
                    rawPayload: { source: "dispatch_order", provider: "evolution" },
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
                shipmentId: shipment.id,
                orderId,
                purpose: "dispatch",
                status: "skipped",
                provider: "evolution",
                errorMessage: "Customer has no phone number.",
                rawPayload: { source: "dispatch_order" },
                createdBy: userId,
            });
            notificationTraceId = trace.id;
            notificationTraceError = trace.error;
        }

        return jsonResponse({
            success: true,
            message: "Order dispatched.",
            order_status: "shipped",
            shipment,
            notification_status: notificationStatus,
            notification_error: notificationError,
            notification_trace_id: notificationTraceId,
            notification_trace_error: notificationTraceError,
        });
    } catch (err: any) {
        console.error("Dispatch error:", err);
        return jsonResponse({
            error: err.message || "Dispatch failed.",
            code: "dispatch_failed",
        }, 400);
    }
});
