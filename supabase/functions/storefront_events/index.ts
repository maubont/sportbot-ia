import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { recordConversationEvent } from "../twilio_inbound_whatsapp/events.ts";
import { cleanText, parseStorefrontEvents, parseStorefrontHandoffRequest } from "./logic.ts";
import type { StorefrontHandoff } from "./logic.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MAX_BODY_BYTES = 32_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 90;
const requestCounts = new Map<string, { count: number; resetAt: number }>();
const HANDOFF_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

type SupabaseClient = ReturnType<typeof createClient>;
type HandoffRow = {
    id: string;
    handoff_code: string;
    storefront_session_id: string;
    status: string;
    source_surface: string;
    product_id: string | null;
    product_brand: string | null;
    product_model: string | null;
    size_requested: number | null;
    intent: string | null;
    funnel_stage: string | null;
    expires_at: string;
    created_at: string;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function textResponse(body: string, status = 200) {
    return new Response(body, {
        status,
        headers: corsHeaders,
    });
}

function requireEnv(name: string) {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`${name} is not configured`);
    return value;
}

function createServiceClient(): SupabaseClient {
    return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}

function getClientKey(req: Request) {
    const forwardedFor = req.headers.get("x-forwarded-for") || "";
    return cleanText(forwardedFor.split(",")[0], 80) || "unknown";
}

function checkRateLimit(req: Request) {
    const key = getClientKey(req);
    const now = Date.now();
    const current = requestCounts.get(key);

    if (!current || current.resetAt < now) {
        requestCounts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    current.count += 1;
    return current.count <= RATE_LIMIT_MAX_REQUESTS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(req: Request) {
    const contentLength = Number(req.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
        return { ok: false as const, status: 413, error: "Request body too large" };
    }

    try {
        return { ok: true as const, body: await req.json() as unknown };
    } catch {
        return { ok: false as const, status: 400, error: "Invalid JSON body" };
    }
}

function generateHandoffCode() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const suffix = Array.from(bytes, (byte) => HANDOFF_CODE_ALPHABET[byte % HANDOFF_CODE_ALPHABET.length]).join("");
    return `WEB-${suffix}`;
}

function handoffSelectColumns() {
    return [
        "id",
        "handoff_code",
        "storefront_session_id",
        "status",
        "source_surface",
        "product_id",
        "product_brand",
        "product_model",
        "size_requested",
        "intent",
        "funnel_stage",
        "expires_at",
        "created_at",
    ].join(", ");
}

async function findExistingHandoffByDedupeKey(supabase: SupabaseClient, dedupeKey: string) {
    return await supabase
        .from("storefront_handoffs")
        .select(handoffSelectColumns())
        .eq("dedupe_key", dedupeKey)
        .maybeSingle<HandoffRow>();
}

async function insertStorefrontHandoff(
    supabase: SupabaseClient,
    handoff: StorefrontHandoff,
    origin: string | null,
    userAgent: string | null,
) {
    const existing = await findExistingHandoffByDedupeKey(supabase, handoff.dedupeKey);
    if (existing.error) throw existing.error;
    if (existing.data) return { row: existing.data, duplicate: true };

    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS).toISOString();
    const metadata = {
        ...handoff.metadata,
        request_origin: origin,
        user_agent: userAgent,
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
        const { data, error } = await supabase
            .from("storefront_handoffs")
            .insert({
                handoff_code: generateHandoffCode(),
                storefront_session_id: handoff.storefrontSessionId,
                status: "opened_whatsapp",
                source_surface: handoff.sourceSurface,
                product_id: handoff.productId,
                product_brand: handoff.productBrand,
                product_model: handoff.productModel,
                size_requested: handoff.sizeRequested,
                intent: handoff.intent,
                funnel_stage: handoff.funnelStage,
                dedupe_key: handoff.dedupeKey,
                expires_at: expiresAt,
                metadata,
            })
            .select(handoffSelectColumns())
            .single<HandoffRow>();

        if (!error && data) return { row: data, duplicate: false };

        if (error?.code === "23505") {
            const duplicate = await findExistingHandoffByDedupeKey(supabase, handoff.dedupeKey);
            if (duplicate.error) throw duplicate.error;
            if (duplicate.data) return { row: duplicate.data, duplicate: true };
            continue;
        }

        throw error;
    }

    throw new Error("Could not allocate a unique storefront handoff code");
}

async function recordStorefrontHandoffEvents(
    supabase: SupabaseClient,
    handoff: StorefrontHandoff,
    row: HandoffRow,
) {
    const metadata = {
        handoff_id: row.id,
        handoff_code: row.handoff_code,
        storefront_session_id: row.storefront_session_id,
        source_surface: row.source_surface,
        product_brand: row.product_brand,
        product_model: row.product_model,
        size_requested: row.size_requested,
    };

    await recordConversationEvent(supabase, {
        channel: "storefront_webchat",
        eventType: "storefront_handoff_created",
        actorType: "customer",
        direction: "inbound",
        funnelStage: handoff.funnelStage,
        intent: handoff.intent,
        productId: handoff.productId,
        sizeRequested: handoff.sizeRequested,
        source: "storefront_native_chat_v1",
        dedupeKey: `${handoff.dedupeKey}:created`,
        metadata,
    });

    await recordConversationEvent(supabase, {
        channel: "storefront_webchat",
        eventType: "storefront_handoff_opened",
        actorType: "customer",
        direction: "inbound",
        funnelStage: handoff.funnelStage,
        intent: handoff.intent,
        productId: handoff.productId,
        sizeRequested: handoff.sizeRequested,
        source: "storefront_native_chat_v1",
        dedupeKey: `${handoff.dedupeKey}:opened`,
        metadata,
    });
}

serve(async (req) => {
    if (req.method === "OPTIONS") return textResponse("ok");
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
    if (!checkRateLimit(req)) return jsonResponse({ error: "Too many requests" }, 429);

    const json = await readJson(req);
    if (!json.ok) return jsonResponse({ error: json.error }, json.status);

    if (isRecord(json.body) && "handoff" in json.body) {
        const parsedHandoff = parseStorefrontHandoffRequest(json.body);
        if (!parsedHandoff.ok) return jsonResponse({ error: parsedHandoff.error }, parsedHandoff.status);

        try {
            const supabase = createServiceClient();
            const origin = cleanText(req.headers.get("origin"), 180) || null;
            const userAgent = cleanText(req.headers.get("user-agent"), 180) || null;
            const result = await insertStorefrontHandoff(supabase, parsedHandoff.handoff, origin, userAgent);

            await recordStorefrontHandoffEvents(supabase, parsedHandoff.handoff, result.row);

            return jsonResponse({
                ok: true,
                handoff_code: result.row.handoff_code,
                handoff_id: result.row.id,
                storefront_session_id: result.row.storefront_session_id,
                status: result.row.status,
                expires_at: result.row.expires_at,
                duplicate: result.duplicate,
                source: "storefront_native_chat_v1",
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Unexpected error";
            console.error("[storefront_events] handoff failed", message);
            return jsonResponse({ error: "Storefront handoff creation failed" }, 500);
        }
    }

    const parsed = parseStorefrontEvents(json.body);
    if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);

    try {
        const supabase = createServiceClient();
        const origin = cleanText(req.headers.get("origin"), 180) || null;
        const userAgent = cleanText(req.headers.get("user-agent"), 180) || null;
        let accepted = 0;
        let duplicates = 0;

        for (const event of parsed.events) {
            const result = await recordConversationEvent(supabase, {
                channel: "storefront_webchat",
                eventType: event.eventType,
                actorType: "customer",
                direction: event.direction,
                funnelStage: event.funnelStage,
                intent: event.intent,
                productId: event.productId,
                sizeRequested: event.sizeRequested,
                source: "storefront_native_chat_v1",
                dedupeKey: event.dedupeKey,
                occurredAt: event.occurredAt,
                metadata: {
                    ...event.metadata,
                    storefront_session_id: event.storefrontSessionId,
                    event_id: event.eventId,
                    request_origin: origin,
                    user_agent: userAgent,
                },
            });

            if (result.ok) accepted += 1;
            if ("duplicate" in result && result.duplicate) duplicates += 1;
        }

        return jsonResponse({
            ok: true,
            accepted,
            duplicates,
            source: "storefront_native_chat_v1",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        console.error("[storefront_events] failed", message);
        return jsonResponse({ error: "Storefront event ingestion failed" }, 500);
    }
});
