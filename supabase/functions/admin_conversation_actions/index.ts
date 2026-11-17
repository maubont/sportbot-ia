import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { sendOutbound } from "../_shared/channels/index.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import { requireStaff } from "../_shared/admin_auth.ts";
import { classifyOperatorSendResult, validUuid, type DeliveryStatus } from "./operator-messaging-core.ts";

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

function evolutionConfig(): EvolutionConfig | null {
    const baseUrl = Deno.env.get("EVOLUTION_API_URL")?.trim() ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY")?.trim() ?? "";
    const instance = Deno.env.get("EVOLUTION_INSTANCE")?.trim() ?? "";
    return baseUrl && apiKey && instance ? { baseUrl, apiKey, instance, timeoutMs: 10_000 } : null;
}

function asObject(value: unknown): Record<string, any> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, any>
        : {};
}

async function conversationStatus(supabase: any, conversationId: string) {
    const staleBefore = new Date(Date.now() - 90_000).toISOString();
    const { data: staleSends } = await supabase.from("messages").update({
        delivery_status: "unknown",
        delivery_error: "send_attempt_stale: verify WhatsApp before retrying",
        delivery_updated_at: new Date().toISOString(),
    }).eq("conversation_id", conversationId)
        .eq("delivery_status", "sending")
        .lt("created_at", staleBefore)
        .select("id, channel");

    for (const stale of staleSends ?? []) {
        await supabase.from("conversation_operator_events").insert({
            conversation_id: conversationId,
            event_type: "message_send_unknown",
            message_id: stale.id,
            channel: stale.channel,
            details: { reason: "stale_send_reconciled" },
        });
    }

    const [{ data: assignment }, { data: state }, { data: pendingSends }, { data: recentUnknown }, { data: events }] = await Promise.all([
        supabase.from("conversation_operator_assignments")
            .select("status, owner_user_id, claimed_at, released_at, updated_at")
            .eq("conversation_id", conversationId).maybeSingle(),
        supabase.from("conversation_state")
            .select("handoff_status, bot_paused_until")
            .eq("conversation_id", conversationId).maybeSingle(),
        supabase.from("messages")
            .select("id, body, delivery_status, created_at")
            .eq("conversation_id", conversationId).eq("delivery_status", "sending")
            .order("created_at", { ascending: false }).limit(3),
        supabase.from("messages")
            .select("id, body, delivery_status, delivery_error, created_at")
            .eq("conversation_id", conversationId).eq("delivery_status", "unknown")
            .order("created_at", { ascending: false }).limit(3),
        supabase.from("conversation_operator_events")
            .select("id, event_type, actor_user_id, created_at, details")
            .eq("conversation_id", conversationId)
            .order("created_at", { ascending: false }).limit(12),
    ]);

    const userIds = [...new Set([
        assignment?.owner_user_id,
        ...(events ?? []).map((event: Record<string, unknown>) => event.actor_user_id),
    ].filter((id): id is string => typeof id === "string"))];
    const { data: users } = userIds.length
        ? await supabase.from("admin_users").select("user_id, email").in("user_id", userIds)
        : { data: [] };
    const emailByUserId = new Map((users ?? []).map((item: Record<string, string>) => [item.user_id, item.email]));
    const ownerId = assignment?.owner_user_id ?? null;

    const handoff = assignment?.status === "human"
        ? "human"
        : state?.handoff_status === "waiting_human" ? "waiting_human" : "bot";
    return {
        success: true,
        status: handoff,
        owner_user_id: ownerId,
        owner_email: ownerId ? emailByUserId.get(ownerId) ?? null : null,
        claimed_at: assignment?.claimed_at ?? null,
        bot_paused_until: state?.bot_paused_until ?? null,
        pending_sends: (pendingSends ?? []).map((row: Record<string, unknown>) => ({
            id: row.id, preview: String(row.body ?? "").slice(0, 120), created_at: row.created_at,
        })),
        uncertain_sends: (recentUnknown ?? []).map((row: Record<string, unknown>) => ({
            id: row.id, preview: String(row.body ?? "").slice(0, 120),
            error: row.delivery_error ?? null, created_at: row.created_at,
        })),
        events: (events ?? []).map((event: Record<string, unknown>) => ({
            id: event.id,
            event_type: event.event_type,
            actor_email: typeof event.actor_user_id === "string" ? emailByUserId.get(event.actor_user_id) ?? null : null,
            created_at: event.created_at,
            details: asObject(event.details),
        })),
    };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") return json({ success: false, code: "method_not_allowed" }, 405);

    try {
        const auth = await requireStaff(req, corsHeaders);
        if (auth instanceof Response) return auth;

        const body = asObject(await req.json().catch(() => null));
        const action = String(body.action ?? "");
        const conversationId = String(body.conversation_id ?? "");
        if (!validUuid(conversationId)) return json({ success: false, code: "invalid_conversation_id" }, 400);

        if (action === "status") {
            return json(await conversationStatus(auth.supabase, conversationId));
        }

        if (action === "claim" || action === "release") {
            const rpc = action === "claim" ? "admin_claim_conversation" : "admin_release_conversation";
            const { data, error } = await auth.supabase.rpc(rpc, {
                p_conversation_id: conversationId,
                p_actor_user_id: auth.userId,
            });
            if (error) {
                console.error(`[human messaging] ${action} RPC failed`, error.message);
                return json({ success: false, code: "handoff_update_failed" }, 500);
            }
            const result = asObject(data);
            if (!result.success) {
                const status = result.code === "claimed_by_another_operator" ? 409
                    : result.code === "send_in_progress" ? 409
                    : result.code === "conversation_not_open" ? 409
                    : 400;
                return json(result, status);
            }
            return json({ ...result, ...(await conversationStatus(auth.supabase, conversationId)) });
        }

        if (action !== "send_message") return json({ success: false, code: "unsupported_action" }, 400);

        const clientSendId = String(body.client_send_id ?? "");
        const text = typeof body.content === "string" ? body.content.trim() : "";
        if (!validUuid(clientSendId) || !text || text.length > 4096) {
            return json({ success: false, code: "invalid_message" }, 400);
        }

        const { data: preparedData, error: prepareError } = await auth.supabase.rpc("admin_prepare_operator_message", {
            p_conversation_id: conversationId,
            p_actor_user_id: auth.userId,
            p_client_send_id: clientSendId,
            p_body: text,
        });
        if (prepareError) {
            console.error("[human messaging] prepare RPC failed", prepareError.message);
            return json({ success: false, code: "send_prepare_failed" }, 500);
        }

        const prepared = asObject(preparedData);
        if (!prepared.success) {
            const status = prepared.code === "send_in_progress" ? 409
                : prepared.code === "conversation_not_owned" ? 409
                : prepared.code === "channel_not_identified" ? 409
                : 400;
            return json(prepared, status);
        }

        // Idempotent retry: the same client key is never sent to the provider twice.
        if (prepared.existing || prepared.delivery_status !== "sending") {
            return json({
                success: true,
                message_id: prepared.message_id,
                delivery_status: prepared.delivery_status,
                replay: true,
            });
        }

        let providerResult: { success: boolean; providerMessageId?: string; error?: string };
        try {
            providerResult = await sendOutbound({
                channel: prepared.channel,
                to: prepared.to,
                text: prepared.body,
                ...(prepared.channel === "evolution" ? { evolution: evolutionConfig() } : {}),
            });
        } catch (sendError) {
            providerResult = {
                success: false,
                error: `provider_exception:${sendError instanceof Error ? sendError.message : String(sendError)}`,
            };
        }

        const delivery = classifyOperatorSendResult(providerResult);
        const { data: finishedData, error: finishError } = await auth.supabase.rpc("admin_finish_operator_message", {
            p_conversation_id: conversationId,
            p_message_id: prepared.message_id,
            p_actor_user_id: auth.userId,
            p_delivery_status: delivery.status,
            p_provider_message_id: providerResult.providerMessageId ?? null,
            p_delivery_error: delivery.error,
        });

        if (finishError || !asObject(finishedData).success) {
            console.error("[human messaging] finish RPC failed", finishError?.message ?? finishedData);
            // Fail safe: never claim delivery if recording the provider outcome failed.
            await auth.supabase.from("messages").update({
                delivery_status: "unknown" as DeliveryStatus,
                delivery_error: "provider_result_not_persisted: verify WhatsApp before retrying",
                delivery_updated_at: new Date().toISOString(),
            }).eq("id", prepared.message_id).eq("delivery_status", "sending");
            return json({
                success: true,
                message_id: prepared.message_id,
                delivery_status: "unknown",
                warning: "provider_result_not_persisted",
            });
        }

        const finished = asObject(finishedData);
        return json({
            success: true,
            message_id: prepared.message_id,
            delivery_status: finished.delivery_status || delivery.status,
            provider_message_id: providerResult.providerMessageId ?? null,
            error: finished.delivery_status && finished.delivery_status !== delivery.status
                ? null
                : delivery.error,
        });
    } catch (error) {
        console.error("[human messaging] action failed", error);
        return json({ success: false, code: "internal_error" }, 500);
    }
});
