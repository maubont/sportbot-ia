import {
    canAdvanceLogisticsNotificationStatus,
    evolutionStatusToLogisticsStatus,
    type LogisticsNotificationStatus,
} from "./logistics_notifications_core.ts";

type SupabaseClient = any;

export type LogisticsNotificationPurpose = "dispatch" | "delivery";
export type { LogisticsNotificationStatus };
export type LogisticsProvider = "twilio" | "evolution";

type RecordNotificationParams = {
    supabase: SupabaseClient;
    orderId: string;
    shipmentId?: string | null;
    purpose: LogisticsNotificationPurpose;
    recipientPhone?: string | null;
    messageBody?: string | null;
    status: LogisticsNotificationStatus;
    providerMessageSid?: string | null;
    provider?: LogisticsProvider;
    attemptNumber?: number;
    retryOfNotificationId?: string | null;
    retryRequestId?: string | null;
    errorMessage?: string | null;
    rawPayload?: Record<string, unknown>;
    createdBy?: string | null;
};

export type LogisticsNotificationTraceResult = {
    id: string | null;
    error: string | null;
};

type ShipmentEventParams = {
    supabase: SupabaseClient;
    orderId: string;
    shipmentId?: string | null;
    eventType: "notification_sent" | "notification_delivered" | "notification_failed" | "notification_read" | "notification_unknown";
    description: string;
    actorUserId?: string | null;
    source?: "admin" | "system" | "twilio" | "evolution" | "carrier" | "wompi" | "migration";
    rawPayload?: Record<string, unknown>;
    eventKey?: string | null;
};

function nowIf(condition: boolean) {
    return condition ? new Date().toISOString() : null;
}

export function normalizeTwilioStatus(status: string): LogisticsNotificationStatus {
    const normalized = status.trim().toLowerCase();

    if (["queued", "accepted", "scheduled", "sending"].includes(normalized)) return "queued";
    if (["sent"].includes(normalized)) return "sent";
    if (["delivered"].includes(normalized)) return "delivered";
    if (["read"].includes(normalized)) return "read";
    if (["undelivered"].includes(normalized)) return "undelivered";
    if (["failed", "canceled"].includes(normalized)) return "failed";

    return "pending";
}

export async function recordShipmentNotificationEvent(params: ShipmentEventParams) {
    if (!params.shipmentId) return null;

    const { data, error } = await params.supabase
        .from("shipment_events")
        .insert({
            shipment_id: params.shipmentId,
            order_id: params.orderId,
            event_type: params.eventType,
            occurred_at: new Date().toISOString(),
            source: params.source || "twilio",
            actor_user_id: params.actorUserId || null,
            description: params.description,
            raw_payload: params.rawPayload || {},
            event_key: params.eventKey || null,
        })
        .select("id")
        .maybeSingle();

    if (error?.code !== "23505" && error) {
        console.error("Failed to record shipment notification event:", error);
        return null;
    }

    return data;
}

export async function recordLogisticsNotification(params: RecordNotificationParams) {
    const status = params.status;
    const providerMessageSid = params.providerMessageSid?.trim() || null;
    const provider = params.provider || "twilio";
    const payload = {
        order_id: params.orderId,
        shipment_id: params.shipmentId || null,
        purpose: params.purpose,
        channel: "whatsapp",
        recipient_phone: params.recipientPhone || null,
        message_body: params.messageBody || null,
        status,
        provider,
        provider_message_sid: providerMessageSid,
        attempt_number: params.attemptNumber || 1,
        retry_of_notification_id: params.retryOfNotificationId || null,
        retry_request_id: params.retryRequestId || null,
        error_message: params.errorMessage || null,
        sent_at: nowIf(status === "sent"),
        delivered_at: nowIf(status === "delivered"),
        read_at: nowIf(status === "read"),
        failed_at: nowIf(status === "failed" || status === "undelivered"),
        raw_payload: params.rawPayload || {},
        created_by: params.createdBy || null,
    };

    const query = params.supabase
        .from("logistics_notifications");

    const { data, error } = providerMessageSid
        ? await query
            .upsert(payload, {
                onConflict: "provider,provider_message_sid",
                ignoreDuplicates: false,
            })
            .select("id, order_id, shipment_id, purpose, status, provider_message_sid")
            .maybeSingle()
        : await query
            .insert(payload)
            .select("id, order_id, shipment_id, purpose, status, provider_message_sid")
            .maybeSingle();

    if (error) {
        console.error("Failed to record logistics notification:", error);
        return {
            id: null,
            error: error.message || "Failed to record logistics notification.",
        };
    }

    const eventType = notificationEventType(status);

    if (eventType) {
        await recordShipmentNotificationEvent({
            supabase: params.supabase,
            orderId: params.orderId,
            shipmentId: params.shipmentId,
            eventType,
            actorUserId: params.createdBy || null,
            description: `${params.purpose} WhatsApp notification ${status} via ${provider}.`,
            rawPayload: {
                notification_id: data?.id,
                provider_message_sid: providerMessageSid,
                error_message: params.errorMessage,
                ...(params.rawPayload || {}),
            },
            source: provider === "evolution" ? "evolution" : "twilio",
            eventKey: `${params.shipmentId || params.orderId}:notification:${data?.id || providerMessageSid || "attempt"}:${eventType}`,
        });
    }

    return {
        id: data?.id || null,
        error: null,
    };
}

function notificationEventType(status: LogisticsNotificationStatus) {
    if (status === "read") return "notification_read" as const;
    if (status === "delivered") return "notification_delivered" as const;
    if (status === "failed" || status === "undelivered") return "notification_failed" as const;
    if (status === "unknown") return "notification_unknown" as const;
    if (status === "sent") return "notification_sent" as const;
    return null;
}

export async function updateLogisticsNotificationAttempt(params: {
    supabase: SupabaseClient;
    notificationId: string;
    status: LogisticsNotificationStatus;
    provider: LogisticsProvider;
    providerMessageSid?: string | null;
    errorMessage?: string | null;
    rawPayload?: Record<string, unknown>;
    actorUserId?: string | null;
}) {
    const { supabase } = params;
    const { data: current, error: readError } = await supabase
        .from("logistics_notifications")
        .select("id, order_id, shipment_id, purpose, status, provider_message_sid, raw_payload")
        .eq("id", params.notificationId)
        .maybeSingle();
    if (readError || !current) return { id: null, error: readError?.message || "Notification attempt not found." };

    // Compare-and-swap against every state from which this transition is legal.
    // If a callback wins the race, the HTTP response cannot write an older state.
    const knownStatuses: LogisticsNotificationStatus[] = [
        "pending", "queued", "sent", "delivered", "read", "failed", "undelivered", "skipped", "unknown",
    ];
    const eligibleStatuses = knownStatuses.filter((status) => canAdvanceLogisticsNotificationStatus(status, params.status));
    if (eligibleStatuses.length === 0 || !canAdvanceLogisticsNotificationStatus(current.status, params.status)) {
        return { id: current.id, error: null, status: current.status };
    }

    const timestamp = new Date().toISOString();
    const updates: Record<string, unknown> = {
        status: params.status,
        provider: params.provider,
        provider_message_sid: params.providerMessageSid?.trim() || current.provider_message_sid || null,
        error_message: params.status === "failed" || params.status === "undelivered" || params.status === "unknown"
            ? params.errorMessage || null
            : null,
        raw_payload: {
            ...(current.raw_payload && typeof current.raw_payload === "object" ? current.raw_payload : {}),
            ...(params.rawPayload || {}),
        },
        sent_at: params.status === "sent" ? timestamp : undefined,
        delivered_at: params.status === "delivered" ? timestamp : undefined,
        read_at: params.status === "read" ? timestamp : undefined,
        failed_at: params.status === "failed" || params.status === "undelivered" ? timestamp : undefined,
        unknown_at: params.status === "unknown" ? timestamp : undefined,
    };
    Object.keys(updates).forEach((key) => updates[key] === undefined && delete updates[key]);

    const { data: updated, error } = await supabase
        .from("logistics_notifications")
        .update(updates)
        .eq("id", params.notificationId)
        .in("status", eligibleStatuses)
        .select("id, order_id, shipment_id, purpose, status, provider_message_sid")
        .maybeSingle();
    if (error) return { id: null, error: error.message || "Notification attempt update failed." };
    if (!updated) {
        const { data: latest, error: latestError } = await supabase
            .from("logistics_notifications")
            .select("id, status")
            .eq("id", params.notificationId)
            .maybeSingle();
        if (latestError || !latest) return { id: null, error: latestError?.message || "Notification attempt update failed." };
        return { id: latest.id, error: null, status: latest.status };
    }

    const eventType = notificationEventType(params.status);
    if (eventType) {
        await recordShipmentNotificationEvent({
            supabase,
            orderId: updated.order_id,
            shipmentId: updated.shipment_id,
            eventType,
            actorUserId: params.actorUserId || null,
            source: params.provider === "evolution" ? "evolution" : "twilio",
            description: `${updated.purpose} WhatsApp notification ${params.status} via ${params.provider}.`,
            rawPayload: {
                notification_id: updated.id,
                provider_message_id: updated.provider_message_sid,
                error_message: params.errorMessage || null,
                ...(params.rawPayload || {}),
            },
            eventKey: `${updated.shipment_id || updated.order_id}:notification:${updated.id}:${eventType}`,
        });
    }

    return { id: updated.id, error: null, status: updated.status };
}

export async function recordEvolutionLogisticsNotificationStatus(
    supabase: SupabaseClient,
    params: { providerMessageId: string; status: string; errorMessage?: string | null; rawPayload?: Record<string, unknown> },
) {
    const status = evolutionStatusToLogisticsStatus(params.status);
    if (!status) return null;

    const { data: notification, error } = await supabase
        .from("logistics_notifications")
        .select("id, status")
        .eq("provider", "evolution")
        .eq("provider_message_sid", params.providerMessageId)
        .maybeSingle();
    if (error) return { id: null, error: error.message || "Evolution notification callback lookup failed." };
    if (!notification) return null;

    if (!canAdvanceLogisticsNotificationStatus(notification.status, status)) return null;

    return await updateLogisticsNotificationAttempt({
        supabase,
        notificationId: notification.id,
        status,
        provider: "evolution",
        providerMessageSid: params.providerMessageId,
        errorMessage: params.errorMessage || null,
        rawPayload: params.rawPayload || {},
    });
}

export async function recordLogisticsOutboundMessage(params: {
    supabase: SupabaseClient;
    customerId?: string | null;
    notificationId: string;
    body: string;
    providerMessageId?: string | null;
    deliveryStatus: "accepted" | "delivered" | "read" | "failed" | "unknown";
    deliveryError?: string | null;
}) {
    if (!params.customerId) return { id: null, error: null };
    const { data: conversation, error: conversationError } = await params.supabase
        .from("conversations")
        .select("id")
        .eq("customer_id", params.customerId)
        .order("last_message_at", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
    if (conversationError || !conversation) return { id: null, error: conversationError?.message || null };

    const { data, error } = await params.supabase.from("messages").insert({
        conversation_id: conversation.id,
        role: "assistant",
        direction: "outbound",
        channel: "evolution",
        body: params.body,
        client_send_id: params.notificationId,
        provider_message_id: params.providerMessageId || null,
        delivery_status: params.deliveryStatus,
        delivery_error: params.deliveryError || null,
        delivery_updated_at: new Date().toISOString(),
    }).select("id").maybeSingle();
    if (error?.code === "23505") return { id: null, error: null };
    if (error) return { id: null, error: error.message };

    await params.supabase.from("conversations").update({
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }).eq("id", conversation.id);
    return { id: data?.id || null, error: null };
}

export async function updateLogisticsNotificationFromTwilioStatus(
    supabase: SupabaseClient,
    params: {
        providerMessageSid: string;
        twilioStatus: string;
        rawPayload?: Record<string, unknown>;
        errorMessage?: string | null;
    },
) {
    const status = normalizeTwilioStatus(params.twilioStatus);
    const timestamp = new Date().toISOString();
    const updates: Record<string, unknown> = {
        status,
        raw_payload: params.rawPayload || {},
    };

    if (status === "sent") updates.sent_at = timestamp;
    if (status === "delivered") updates.delivered_at = timestamp;
    if (status === "read") updates.read_at = timestamp;
    if (status === "failed" || status === "undelivered") {
        updates.failed_at = timestamp;
        updates.error_message = params.errorMessage || null;
    }

    const { data, error } = await supabase
        .from("logistics_notifications")
        .update(updates)
        .eq("provider", "twilio")
        .eq("provider_message_sid", params.providerMessageSid)
        .select("id, order_id, shipment_id, purpose, status, provider_message_sid")
        .maybeSingle();

    if (error) {
        console.error("Failed to update logistics notification from Twilio status:", error);
        return null;
    }

    if (!data) return null;

    if (status === "read" || status === "failed" || status === "undelivered") {
        await recordShipmentNotificationEvent({
            supabase,
            orderId: data.order_id,
            shipmentId: data.shipment_id,
            eventType: status === "read" ? "notification_read" : "notification_failed",
            description: `${data.purpose} WhatsApp notification ${status} by Twilio callback.`,
            rawPayload: {
                notification_id: data.id,
                provider_message_sid: params.providerMessageSid,
                ...(params.rawPayload || {}),
            },
            eventKey: `${data.shipment_id || data.order_id}:notification:${params.providerMessageSid}:${status}`,
        });
    }

    return data;
}
