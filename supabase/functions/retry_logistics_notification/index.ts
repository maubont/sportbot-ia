import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin } from "../_shared/admin_auth.ts";
import { sendOutbound } from "../_shared/channels/index.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import {
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

function json(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function asObject(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, any>
        : {};
}

function isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function evolutionConfig(): EvolutionConfig | null {
    const baseUrl = Deno.env.get("EVOLUTION_API_URL")?.trim() ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() ?? "";
    const instance = Deno.env.get("EVOLUTION_INSTANCE")?.trim() ?? "";
    return baseUrl && apiKey && instance ? { baseUrl, apiKey, instance, timeoutMs: 10_000 } : null;
}

function rpcErrorStatus(code: string) {
    if (code === "admin_required") return 403;
    if (code === "notification_not_found") return 404;
    if ([
        "notification_outcome_unknown", "notification_not_retryable", "retry_already_attempted",
        "shipment_not_active", "dispatch_notification_stale", "delivery_not_confirmed",
    ].includes(code)) return 409;
    return 400;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ success: false, code: "method_not_allowed" }, 405);

    try {
        const auth = await requireAdmin(req, corsHeaders);
        if (auth instanceof Response) return auth;

        const body = asObject(await req.json().catch(() => null));
        const notificationId = String(body.notification_id ?? "");
        const retryRequestId = String(body.retry_request_id ?? "");
        if (!isUuid(notificationId) || !isUuid(retryRequestId)) {
            return json({ success: false, code: "invalid_retry_request" }, 400);
        }

        const { data, error } = await auth.supabase.rpc("begin_logistics_notification_retry", {
            p_notification_id: notificationId,
            p_actor_user_id: auth.userId,
            p_retry_request_id: retryRequestId,
        });
        if (error) {
            console.error("[logistics retry] preparation RPC failed:", error.message);
            return json({ success: false, code: "retry_prepare_failed" }, 500);
        }

        const prepared = asObject(data);
        if (!prepared.success) {
            const code = String(prepared.code ?? "retry_not_allowed");
            return json(prepared, rpcErrorStatus(code));
        }

        // Replaying an idempotency key returns its durable attempt, never sends again.
        if (prepared.existing) {
            return json({
                success: true,
                replay: true,
                notification_id: prepared.notification_id,
                status: prepared.status,
            });
        }

        let providerResult: { success: boolean; providerMessageId?: string; error?: string };
        try {
            providerResult = await sendOutbound({
                channel: "evolution",
                to: String(prepared.recipient_phone ?? ""),
                text: String(prepared.message_body ?? ""),
                evolution: evolutionConfig(),
            });
        } catch (sendError) {
            providerResult = {
                success: false,
                error: `provider_exception:${sendError instanceof Error ? sendError.message : String(sendError)}`,
            };
        }

        const outcome = classifyLogisticsSend(providerResult);
        let status: LogisticsNotificationStatus = outcome.status;
        let traceError: string | null = null;
        const finalized = await updateLogisticsNotificationAttempt({
            supabase: auth.supabase,
            notificationId: prepared.notification_id,
            status: outcome.status,
            provider: "evolution",
            providerMessageSid: providerResult.providerMessageId ?? null,
            errorMessage: outcome.error,
            rawPayload: { source: "retry_logistics_notification", provider: "evolution" },
            actorUserId: auth.userId,
        });

        traceError = finalized.error;
        if (finalized.error) {
            // The request may have reached WhatsApp. Best effort only, and only
            // while the durable row is still pre-delivery; never downgrade a receipt.
            status = "unknown";
            await auth.supabase.from("logistics_notifications").update({
                status: "unknown",
                unknown_at: new Date().toISOString(),
                error_message: "Provider outcome could not be fully recorded; verify WhatsApp before retrying.",
                provider_message_sid: providerResult.providerMessageId ?? null,
            }).eq("id", prepared.notification_id).in("status", ["pending", "queued", "unknown"]);
        } else {
            status = finalized.status || outcome.status;
        }

        const { data: order } = await auth.supabase
            .from("orders")
            .select("customer_id")
            .eq("id", prepared.order_id)
            .maybeSingle();
        const messageTrace = await recordLogisticsOutboundMessage({
            supabase: auth.supabase,
            customerId: order?.customer_id ?? null,
            notificationId: prepared.notification_id,
            body: String(prepared.message_body ?? ""),
            providerMessageId: providerResult.providerMessageId ?? null,
            deliveryStatus: logisticsStatusToMessageDeliveryStatus(status),
            deliveryError: status === "unknown"
                ? "Provider outcome is uncertain; verify WhatsApp before retrying."
                : outcome.error,
        });
        if (messageTrace.error) traceError = traceError || messageTrace.error;

        return json({
            success: true,
            attempted: true,
            notification_id: prepared.notification_id,
            status,
            provider_message_id: providerResult.providerMessageId ?? null,
            error: status === "failed" ? outcome.error : null,
            trace_error: traceError,
        });
    } catch (error) {
        console.error("[logistics retry] request failed:", error);
        return json({ success: false, code: "internal_error" }, 500);
    }
});
