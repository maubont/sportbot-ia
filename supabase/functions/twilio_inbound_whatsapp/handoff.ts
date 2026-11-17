export type StorefrontHandoffRow = {
    id: string;
    handoff_code: string;
    storefront_session_id: string;
    status: string;
    product_id: string | null;
    product_brand: string | null;
    product_model: string | null;
    size_requested: number | null;
    intent: string | null;
    funnel_stage: string | null;
    source_surface: string | null;
    expires_at: string;
    linked_customer_id: string | null;
    linked_conversation_id: string | null;
    linked_message_id: string | null;
    linked_at: string | null;
    metadata: Record<string, unknown> | null;
};

type Identity = {
    customerId: string;
    conversationId: string;
    messageId: string;
};

export type HandoffDisposition =
    | { status: "linkable"; reason: "active" }
    | { status: "already_linked"; reason: "same_identity" }
    | { status: "unresolved"; reason: "not_found" | "expired" | "inactive" | "already_linked_to_other_identity" };

export type HandoffLinkResult = {
    code: string;
    status: "linked" | "already_linked" | "unresolved" | "error";
    reason: string;
    row: StorefrontHandoffRow | null;
};

type SupabaseLike = {
    from: (table: string) => unknown;
};

const HANDOFF_CODE_PATTERN = /\bWEB-[A-Z0-9]{6,10}\b/i;
const ACTIVE_HANDOFF_STATUSES = new Set(["created", "opened_whatsapp"]);
const HANDOFF_COLUMNS = [
    "id",
    "handoff_code",
    "storefront_session_id",
    "status",
    "product_id",
    "product_brand",
    "product_model",
    "size_requested",
    "intent",
    "funnel_stage",
    "source_surface",
    "expires_at",
    "linked_customer_id",
    "linked_conversation_id",
    "linked_message_id",
    "linked_at",
    "metadata",
].join(", ");

type HandoffSelectQuery = {
    eq: (column: string, value: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
};

type HandoffUpdateQuery = {
    eq: (column: string, value: string | null) => HandoffUpdateQuery;
    in: (column: string, values: string[]) => HandoffUpdateQuery;
    is: (column: string, value: null) => HandoffUpdateQuery;
    select: (columns: string) => {
        maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
};

type HandoffQueryBuilder = {
    select: (columns: string) => HandoffSelectQuery;
    update: (payload: Record<string, unknown>) => HandoffUpdateQuery;
};

function isQueryBuilder(value: unknown): value is HandoffQueryBuilder {
    return value !== null && typeof value === "object" && "select" in value && "update" in value;
}

function handoffQueryBuilder(supabase: SupabaseLike) {
    const builder = supabase.from("storefront_handoffs");
    if (!isQueryBuilder(builder)) throw new Error("Invalid Supabase client");
    return builder;
}

export function extractStorefrontHandoffCode(text: unknown) {
    const codes = extractStorefrontHandoffCodes(text);
    return codes.length === 1 ? codes[0] : null;
}

export function extractStorefrontHandoffCodes(text: unknown) {
    if (typeof text !== "string") return [];
    const matches = text.match(/\bWEB-[A-Z0-9]{6,10}\b/gi) || [];
    return Array.from(new Set(matches.map((code) => code.toUpperCase())));
}

export function stripStorefrontHandoffCode(text: string) {
    return text
        .replace(/(?:c[oó]digo\s+web\s*:?\s*)?\bWEB-[A-Z0-9]{6,10}\b/gi, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
}

export function classifyStorefrontHandoff(
    row: StorefrontHandoffRow | null,
    identity: Identity,
    now = new Date(),
): HandoffDisposition {
    if (!row) return { status: "unresolved", reason: "not_found" };

    if (row.status === "linked") {
        const sameIdentity = row.linked_customer_id === identity.customerId
            && row.linked_conversation_id === identity.conversationId;
        return sameIdentity
            ? { status: "already_linked", reason: "same_identity" }
            : { status: "unresolved", reason: "already_linked_to_other_identity" };
    }

    const expiresAt = new Date(row.expires_at).getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
        return { status: "unresolved", reason: "expired" };
    }

    if (!ACTIVE_HANDOFF_STATUSES.has(row.status)) {
        return { status: "unresolved", reason: "inactive" };
    }

    return { status: "linkable", reason: "active" };
}

function asHandoffRow(value: unknown): StorefrontHandoffRow | null {
    if (!value || typeof value !== "object") return null;
    return value as StorefrontHandoffRow;
}

async function findHandoffByCode(supabase: SupabaseLike, code: string) {
    const { data, error } = await handoffQueryBuilder(supabase)
        .select(HANDOFF_COLUMNS)
        .eq("handoff_code", code)
        .maybeSingle();
    if (error) throw error;
    return asHandoffRow(data);
}

export async function linkStorefrontHandoff(
    supabase: SupabaseLike,
    params: Identity & {
        code: string;
        twilioMessageSid?: string | null;
        now?: Date;
    },
): Promise<HandoffLinkResult> {
    const codes = extractStorefrontHandoffCodes(params.code);
    if (!codes || codes.length === 0) {
        return { code: params.code, status: "unresolved", reason: "not_found", row: null };
    }
    if (codes.length > 1) {
        return { code: codes.join(","), status: "unresolved", reason: "ambiguous", row: null };
    }

    const code = codes[0];

    try {
        const row = await findHandoffByCode(supabase, code);
        const disposition = classifyStorefrontHandoff(row, params, params.now || new Date());

        if (!row) {
            return { code, status: "unresolved", reason: disposition.reason, row: null };
        }

        if (disposition.status === "already_linked") {
            return { code, status: "already_linked", reason: disposition.reason, row };
        }

        if (disposition.status === "unresolved") {
            if (disposition.reason === "expired" && ACTIVE_HANDOFF_STATUSES.has(row.status)) {
                await handoffQueryBuilder(supabase).update({ status: "expired" }).eq("id", row.id);
            }

            return { code, status: "unresolved", reason: disposition.reason, row };
        }

        const linkedAt = (params.now || new Date()).toISOString();
        const metadata = {
            ...(row.metadata || {}),
            linked_from: "twilio_inbound_whatsapp",
            linked_message_sid: params.twilioMessageSid || null,
        };

        const updateQuery = handoffQueryBuilder(supabase)
            ["update"]({
                status: "linked",
                linked_customer_id: params.customerId,
                linked_conversation_id: params.conversationId,
                linked_message_id: params.messageId,
                linked_at: linkedAt,
                metadata,
            })
            ["eq"]("id", row.id)
            ["in"]("status", ["created", "opened_whatsapp"])
            ["is"]("linked_customer_id", null)
            ["select"](HANDOFF_COLUMNS);

        const { data, error } = await updateQuery.maybeSingle();
        if (error) throw error;

        const updated = asHandoffRow(data);
        if (!updated) {
            const latest = await findHandoffByCode(supabase, code);
            return { code, status: "unresolved", reason: "inactive", row: latest || row };
        }

        return { code, status: "linked", reason: "active", row: updated };
    } catch (error) {
        console.warn("[Storefront handoff] link failed", error instanceof Error ? error.message : error);
        return { code, status: "error", reason: "link_failed", row: null };
    }
}
