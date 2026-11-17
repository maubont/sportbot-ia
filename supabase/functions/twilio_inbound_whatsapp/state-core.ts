/**
 * Núcleo puro del estado de conversación (sin I/O).
 * Se separa de `state.ts` para poder probarlo sin Supabase ni Deno.
 */

export type ConversationStage =
    | "browsing"
    | "selecting"
    | "collecting_shipping"
    | "awaiting_payment"
    | "receipt_received"
    | "under_review"
    | "paid"
    | "human_takeover"
    | "closed";

export type HandoffStatus = "bot" | "waiting_human" | "human";

export type ConversationState = {
    conversationId: string;
    stage: ConversationStage;
    activeProductId: string | null;
    activeVariantId: string | null;
    lastIntent: string | null;
    pendingAction: Record<string, unknown> | null;
    handoffStatus: HandoffStatus;
    botPausedUntil: string | null;
    summary: string | null;
    metadata: Record<string, unknown>;
    updatedAt: string;
};

export type ConversationStatePatch = Partial<
    Omit<ConversationState, "conversationId" | "updatedAt">
>;

const TRANSITIONS: Record<ConversationStage, ConversationStage[]> = {
    // El cliente puede dar todos los datos de una vez; permitimos el salto
    // directo a pago sin obligar al modelo a pasar por cada etapa.
    browsing: [
        "selecting",
        "collecting_shipping",
        "awaiting_payment",
        "human_takeover",
        "closed",
    ],
    selecting: [
        "browsing",
        "collecting_shipping",
        "awaiting_payment",
        "human_takeover",
        "closed",
    ],
    collecting_shipping: [
        "selecting",
        "awaiting_payment",
        "human_takeover",
        "closed",
    ],
    awaiting_payment: [
        "receipt_received",
        "under_review",
        "paid",
        "human_takeover",
        "closed",
    ],
    receipt_received: ["under_review", "awaiting_payment", "human_takeover"],
    under_review: ["paid", "awaiting_payment", "human_takeover"],
    paid: ["closed", "human_takeover"],
    human_takeover: [
        "browsing",
        "selecting",
        "collecting_shipping",
        "awaiting_payment",
        "closed",
    ],
    closed: ["browsing"],
};

export function defaultState(conversationId: string): ConversationState {
    return {
        conversationId,
        stage: "browsing",
        activeProductId: null,
        activeVariantId: null,
        lastIntent: null,
        pendingAction: null,
        handoffStatus: "bot",
        botPausedUntil: null,
        summary: null,
        metadata: {},
        updatedAt: new Date(0).toISOString(),
    };
}

export function canTransition(
    from: ConversationStage,
    to: ConversationStage,
): boolean {
    return from === to || TRANSITIONS[from]?.includes(to) === true;
}

export function applyPatch(
    state: ConversationState,
    patch: ConversationStatePatch,
): ConversationState {
    const next: ConversationState = { ...state, metadata: { ...state.metadata } };

    if (patch.stage !== undefined) next.stage = patch.stage;
    if (patch.activeProductId !== undefined) {
        next.activeProductId = patch.activeProductId;
    }
    if (patch.activeVariantId !== undefined) {
        next.activeVariantId = patch.activeVariantId;
    }
    if (patch.lastIntent !== undefined) next.lastIntent = patch.lastIntent;
    if (patch.pendingAction !== undefined) {
        next.pendingAction = patch.pendingAction;
    }
    if (patch.handoffStatus !== undefined) {
        next.handoffStatus = patch.handoffStatus;
    }
    if (patch.botPausedUntil !== undefined) {
        next.botPausedUntil = patch.botPausedUntil;
    }
    if (patch.summary !== undefined) next.summary = patch.summary;
    if (patch.metadata !== undefined) {
        next.metadata = { ...next.metadata, ...patch.metadata };
    }

    return next;
}

/**
 * El bot no responde si un humano tomó la conversación o si existe una pausa
 * temporal vigente (por ejemplo, mientras se revisa un pago).
 */
export function isBotPaused(
    state: ConversationState,
    now: number = Date.now(),
): boolean {
    if (state.handoffStatus === "human") return true;
    if (state.stage === "human_takeover") return true;

    if (state.botPausedUntil) {
        const until = Date.parse(state.botPausedUntil);
        if (Number.isFinite(until) && until > now) return true;
    }

    return false;
}

/**
 * Bloque compacto y factual que se inyecta al modelo.
 * No reemplaza al historial: lo ancla a hechos verificables.
 */
export function statePromptBlock(state: ConversationState): string {
    const lines = [
        "=== ESTADO DE LA CONVERSACIÓN ===",
        `Etapa: ${state.stage}`,
        `Producto activo: ${state.activeProductId ?? "ninguno"}`,
        `Variante activa: ${state.activeVariantId ?? "ninguna"}`,
        `Intención: ${state.lastIntent ?? "desconocida"}`,
        `Handoff: ${state.handoffStatus}`,
    ];

    if (state.pendingAction) {
        lines.push(`Acción pendiente: ${JSON.stringify(state.pendingAction)}`);
    }

    lines.push(
        "Usa estos datos como hechos. Si no hay producto activo, búscalo con search_products.",
    );

    return lines.join("\n");
}

/** Mapea el estado al row de Postgres (snake_case). */
export function stateToRow(state: ConversationState) {
    return {
        conversation_id: state.conversationId,
        stage: state.stage,
        active_product_id: state.activeProductId,
        active_variant_id: state.activeVariantId,
        last_intent: state.lastIntent,
        pending_action: state.pendingAction,
        handoff_status: state.handoffStatus,
        bot_paused_until: state.botPausedUntil,
        summary: state.summary,
        metadata: state.metadata,
        updated_at: new Date().toISOString(),
    };
}

/** Mapea el row de Postgres al estado tipado. */
export function rowToState(row: Record<string, unknown>): ConversationState {
    return {
        conversationId: String(row.conversation_id),
        stage: (row.stage as ConversationStage) ?? "browsing",
        activeProductId: (row.active_product_id as string | null) ?? null,
        activeVariantId: (row.active_variant_id as string | null) ?? null,
        lastIntent: (row.last_intent as string | null) ?? null,
        pendingAction:
            (row.pending_action as Record<string, unknown> | null) ?? null,
        handoffStatus: (row.handoff_status as HandoffStatus) ?? "bot",
        botPausedUntil: (row.bot_paused_until as string | null) ?? null,
        summary: (row.summary as string | null) ?? null,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        updatedAt: String(row.updated_at ?? new Date().toISOString()),
    };
}
