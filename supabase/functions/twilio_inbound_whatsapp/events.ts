import { SupabaseClient } from "npm:@supabase/supabase-js@2";

type ActorType = "customer" | "bot" | "human_admin" | "system" | "agent";
type Direction = "inbound" | "outbound" | "internal";

type ConversationEventInput = {
    channel?: string | null;
    eventType: string;
    conversationId?: string | null;
    customerId?: string | null;
    messageId?: string | null;
    orderId?: string | null;
    paymentId?: string | null;
    shipmentId?: string | null;
    productId?: string | null;
    variantId?: string | null;
    actorType?: ActorType;
    direction?: Direction | null;
    funnelStage?: string | null;
    intent?: string | null;
    sentiment?: string | null;
    revenueRisk?: string | null;
    handoffRequired?: boolean;
    handoffReason?: string | null;
    sizeRequested?: number | string | null;
    quantityRequested?: number | null;
    amountCents?: number | null;
    source?: string;
    confidence?: number | null;
    costCents?: number | null;
    latencyMs?: number | null;
    dedupeKey?: string | null;
    occurredAt?: string | null;
    metadata?: Record<string, unknown>;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_PATTERN = /(authorization|apikey|api_key|password|secret|signature|token|checkout_url|mediaurl)/i;

export function safeUuid(value: unknown) {
    if (typeof value !== "string") return null;
    return UUID_PATTERN.test(value) ? value : null;
}

function cleanString(value: string) {
    return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function cleanShortString(value: unknown, fallback: string) {
    if (typeof value !== "string") return fallback;
    const clean = value.replace(/\s+/g, " ").trim().slice(0, 120);
    return clean || fallback;
}

function safeIsoTimestamp(value: unknown) {
    if (typeof value !== "string") return null;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return null;

    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const fiveMinutes = 5 * 60 * 1000;
    if (timestamp < now - sevenDays || timestamp > now + fiveMinutes) return null;

    return new Date(timestamp).toISOString();
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return cleanString(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadataValue(item, depth + 1));
    if (typeof value === "object" && depth < 2) {
        return sanitizeMetadata(value as Record<string, unknown>, depth + 1);
    }
    return String(value).slice(0, 200);
}

function sanitizeMetadata(metadata: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata).slice(0, 30)) {
        if (SENSITIVE_KEY_PATTERN.test(key)) continue;
        output[key] = sanitizeMetadataValue(value, depth);
    }

    const serialized = JSON.stringify(output);
    if (serialized.length <= 4000) return output;

    return {
        truncated: true,
        original_size: serialized.length,
        keys: Object.keys(output).slice(0, 30),
    };
}

export async function recordConversationEvent(
    supabase: SupabaseClient,
    input: ConversationEventInput,
) {
    const sizeRequested = input.sizeRequested == null ? null : Number(input.sizeRequested);
    const occurredAt = safeIsoTimestamp(input.occurredAt);
    const payload = {
        conversation_id: safeUuid(input.conversationId),
        customer_id: safeUuid(input.customerId),
        message_id: safeUuid(input.messageId),
        order_id: safeUuid(input.orderId),
        payment_id: safeUuid(input.paymentId),
        shipment_id: safeUuid(input.shipmentId),
        product_id: safeUuid(input.productId),
        variant_id: safeUuid(input.variantId),
        channel: cleanShortString(input.channel, "whatsapp"),
        actor_type: input.actorType || "system",
        direction: input.direction || null,
        event_type: input.eventType,
        funnel_stage: input.funnelStage || null,
        intent: input.intent || null,
        sentiment: input.sentiment || null,
        revenue_risk: input.revenueRisk || null,
        handoff_required: Boolean(input.handoffRequired),
        handoff_reason: input.handoffReason || null,
        size_requested: Number.isFinite(sizeRequested) ? sizeRequested : null,
        quantity_requested: input.quantityRequested || null,
        amount_cents: input.amountCents || null,
        currency: "COP",
        source: input.source || "twilio_inbound_whatsapp",
        confidence: input.confidence ?? null,
        cost_cents: input.costCents || 0,
        latency_ms: input.latencyMs ?? null,
        dedupe_key: input.dedupeKey || null,
        ...(occurredAt ? { occurred_at: occurredAt } : {}),
        metadata: sanitizeMetadata(input.metadata),
    };

    const { error } = await supabase.from("conversation_events").insert(payload);
    if (error) {
        if (error.code === "23505") return { ok: true, duplicate: true };

        console.warn("[Conversation OS] event insert skipped", {
            event_type: input.eventType,
            code: error.code,
            message: error.message,
        });
        return { ok: false, error };
    }

    return { ok: true };
}

export async function refreshCustomerProfileBestEffort(
    supabase: SupabaseClient,
    customerId?: string | null,
) {
    const safeCustomerId = safeUuid(customerId);
    if (!safeCustomerId) return { ok: false, skipped: true };

    const { error } = await supabase.rpc("refresh_customer_profile", {
        p_customer_id: safeCustomerId,
    });

    if (error) {
        console.warn("[Conversation OS] profile refresh skipped", {
            customer_id: safeCustomerId,
            code: error.code,
            message: error.message,
        });
        return { ok: false, error };
    }

    return { ok: true };
}
