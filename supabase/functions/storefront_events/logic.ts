export type StorefrontEvent = {
    eventType: string;
    intent: string | null;
    funnelStage: string | null;
    productId: string | null;
    sizeRequested: number | null;
    direction: "inbound" | "internal";
    dedupeKey: string | null;
    occurredAt: string | null;
    storefrontSessionId: string | null;
    eventId: string | null;
    metadata: Record<string, unknown>;
};

export type StorefrontHandoff = {
    storefrontSessionId: string;
    sourceSurface: string;
    productId: string | null;
    productBrand: string | null;
    productModel: string | null;
    sizeRequested: number | null;
    intent: string;
    funnelStage: string;
    dedupeKey: string;
    metadata: Record<string, unknown>;
};

type ParseSuccess = {
    ok: true;
    events: StorefrontEvent[];
};

type HandoffParseSuccess = {
    ok: true;
    handoff: StorefrontHandoff;
};

type ParseFailure = {
    ok: false;
    status: number;
    error: string;
};

const ALLOWED_EVENT_TYPES = new Set([
    "customer_greeted",
    "message_inbound_received",
    "product_search_requested",
    "product_search_results",
    "product_image_requested",
    "stock_check_requested",
    "stock_available",
    "stock_unavailable",
    "customer_support_requested",
    "handoff_suggested",
    "storefront_handoff_created",
    "storefront_handoff_opened",
    "storefront_handoff_linked",
    "storefront_handoff_unresolved",
    "customer_profile_refresh_requested",
]);

const ALLOWED_INTENTS = new Set([
    "greeting",
    "product_search",
    "product_image",
    "size_availability",
    "price_question",
    "buy_intent",
    "shipping_status",
    "support",
    "unknown",
]);

const ALLOWED_FUNNEL_STAGES = new Set([
    "new",
    "exploring",
    "interested",
    "stock_validated",
    "blocked_stock",
    "ready_to_order",
    "support",
    "lost",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENSITIVE_KEY_PATTERN = /(authorization|apikey|api_key|password|secret|signature|token|checkout_url|mediaurl|phone|email)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cleanText(value: unknown, maxLength = 500) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function cleanOptionalText(value: unknown, maxLength = 120) {
    const clean = cleanText(value, maxLength);
    return clean || null;
}

function cleanUuid(value: unknown) {
    const clean = cleanText(value, 64);
    return UUID_PATTERN.test(clean) ? clean : null;
}

function cleanNumber(value: unknown) {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function cleanTimestamp(value: unknown, now = new Date()) {
    const clean = cleanText(value, 64);
    if (!clean) return null;

    const timestamp = new Date(clean).getTime();
    if (!Number.isFinite(timestamp)) return null;

    const nowMs = now.getTime();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const fiveMinutes = 5 * 60 * 1000;
    if (timestamp < nowMs - sevenDays || timestamp > nowMs + fiveMinutes) return null;

    return new Date(timestamp).toISOString();
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return cleanText(value, 200);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeMetadataValue(item, depth + 1));
    if (isRecord(value) && depth < 1) return sanitizeMetadata(value, depth + 1);
    return String(value).slice(0, 120);
}

function sanitizeMetadata(metadata: unknown, depth = 0) {
    if (!isRecord(metadata)) return {};

    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata).slice(0, 20)) {
        const cleanKey = cleanText(key, 48).replace(/[^a-zA-Z0-9_.:-]/g, "_");
        if (!cleanKey || SENSITIVE_KEY_PATTERN.test(cleanKey)) continue;
        output[cleanKey] = sanitizeMetadataValue(value, depth);
    }

    const serialized = JSON.stringify(output);
    if (serialized.length <= 2500) return output;

    return {
        truncated: true,
        original_size: serialized.length,
        keys: Object.keys(output).slice(0, 20),
    };
}

export function normalizeStorefrontEvent(raw: unknown, now = new Date()): ParseSuccess | ParseFailure {
    if (!isRecord(raw)) {
        return { ok: false, status: 400, error: "Invalid storefront event" };
    }

    const eventType = cleanText(raw.event_type, 80);
    if (!ALLOWED_EVENT_TYPES.has(eventType)) {
        return { ok: false, status: 400, error: "Unsupported storefront event_type" };
    }

    const intent = cleanOptionalText(raw.intent, 80);
    if (intent && !ALLOWED_INTENTS.has(intent)) {
        return { ok: false, status: 400, error: "Unsupported storefront intent" };
    }

    const funnelStage = cleanOptionalText(raw.funnel_stage, 80);
    if (funnelStage && !ALLOWED_FUNNEL_STAGES.has(funnelStage)) {
        return { ok: false, status: 400, error: "Unsupported storefront funnel_stage" };
    }

    const sizeRequested = cleanNumber(raw.size_requested);
    const direction = cleanText(raw.direction, 20) === "internal" ? "internal" : "inbound";
    const metadata = sanitizeMetadata(raw.metadata);

    return {
        ok: true,
        events: [{
            eventType,
            intent,
            funnelStage,
            productId: cleanUuid(raw.product_id),
            sizeRequested: sizeRequested && sizeRequested >= 20 && sizeRequested <= 60 ? sizeRequested : null,
            direction,
            dedupeKey: cleanOptionalText(raw.dedupe_key, 140),
            occurredAt: cleanTimestamp(raw.occurred_at, now),
            storefrontSessionId: cleanOptionalText(raw.storefront_session_id, 140),
            eventId: cleanOptionalText(raw.event_id, 140),
            metadata,
        }],
    };
}

export function parseStorefrontEvents(body: unknown, now = new Date(), maxEvents = 10): ParseSuccess | ParseFailure {
    if (!isRecord(body)) return { ok: false, status: 400, error: "Invalid JSON body" };

    const rawEvents = Array.isArray(body.events) ? body.events : [body];
    if (rawEvents.length === 0) return { ok: false, status: 400, error: "No storefront events provided" };
    if (rawEvents.length > maxEvents) return { ok: false, status: 413, error: "Too many storefront events" };

    const events: StorefrontEvent[] = [];
    for (const rawEvent of rawEvents) {
        const parsed = normalizeStorefrontEvent(rawEvent, now);
        if (!parsed.ok) return parsed;
        events.push(...parsed.events);
    }

    return { ok: true, events };
}

export function parseStorefrontHandoffRequest(body: unknown): HandoffParseSuccess | ParseFailure {
    if (!isRecord(body) || !isRecord(body.handoff)) {
        return { ok: false, status: 400, error: "Invalid storefront handoff request" };
    }

    const handoff = body.handoff;
    const storefrontSessionId = cleanOptionalText(handoff.storefront_session_id, 140);
    const sourceSurface = cleanText(handoff.source_surface, 64) || "unknown";
    const intent = cleanText(handoff.intent, 80) || "buy_intent";
    const funnelStage = cleanText(handoff.funnel_stage, 80) || "ready_to_order";
    const dedupeKey = cleanOptionalText(handoff.dedupe_key, 160);
    const sizeRequested = cleanNumber(handoff.size_requested);

    if (!storefrontSessionId) {
        return { ok: false, status: 400, error: "Missing storefront_session_id" };
    }

    if (!dedupeKey) {
        return { ok: false, status: 400, error: "Missing handoff dedupe_key" };
    }

    if (!ALLOWED_INTENTS.has(intent)) {
        return { ok: false, status: 400, error: "Unsupported storefront handoff intent" };
    }

    if (!ALLOWED_FUNNEL_STAGES.has(funnelStage)) {
        return { ok: false, status: 400, error: "Unsupported storefront handoff funnel_stage" };
    }

    return {
        ok: true,
        handoff: {
            storefrontSessionId,
            sourceSurface,
            productId: cleanUuid(handoff.product_id),
            productBrand: cleanOptionalText(handoff.product_brand, 80),
            productModel: cleanOptionalText(handoff.product_model, 120),
            sizeRequested: sizeRequested && sizeRequested >= 20 && sizeRequested <= 60 ? sizeRequested : null,
            intent,
            funnelStage,
            dedupeKey,
            metadata: sanitizeMetadata(handoff.metadata),
        },
    };
}
