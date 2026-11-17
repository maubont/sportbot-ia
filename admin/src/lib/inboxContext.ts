type ActiveContextResolutionLike = {
    id?: string | null;
    active_context?: string | null;
    status?: string | null;
    source_action_id?: string | null;
    resolution_reason?: string | null;
    dispatch_order_id?: string | null;
    dispatch_payment_reference?: string | null;
    dispatch_product_name?: string | null;
    dispatch_size?: string | number | null;
    storefront_handoff_id?: string | null;
    storefront_handoff_code?: string | null;
    storefront_product_name?: string | null;
    storefront_size?: string | number | null;
    guardrails?: Record<string, unknown> | null;
    resolved_at?: string | null;
};

export type InboxMessageLoadStatus = "idle" | "loading" | "loaded" | "error";

export function canSendWithLoadedInboxMessages(status: InboxMessageLoadStatus): boolean {
    return status === "loaded";
}

export type InboxMessageRequestResult<T> =
    | { status: "loaded"; data: T }
    | { status: "error"; error: unknown }
    | { status: "timeout" }
    | { status: "aborted" };

export type InboxMessageTimeoutScheduler = (callback: () => void, delayMs: number) => () => void;

const scheduleInboxMessageTimeout: InboxMessageTimeoutScheduler = (callback, delayMs) => {
    const timeoutId = globalThis.setTimeout(callback, delayMs);
    return () => globalThis.clearTimeout(timeoutId);
};

export async function runInboxMessageRequest<T>(
    fetcher: (signal: AbortSignal) => Promise<T>,
    controller: AbortController,
    timeoutMs: number,
    scheduleTimeout: InboxMessageTimeoutScheduler = scheduleInboxMessageTimeout,
): Promise<InboxMessageRequestResult<T>> {
    if (controller.signal.aborted) return { status: "aborted" };

    let timedOut = false;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<InboxMessageRequestResult<T>>((resolve) => {
        onAbort = () => resolve(timedOut ? { status: "timeout" } : { status: "aborted" });
        controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const request = Promise.resolve()
        .then(() => fetcher(controller.signal))
        .then<InboxMessageRequestResult<T>, InboxMessageRequestResult<T>>(
            (data) => ({ status: "loaded", data }),
            (error: unknown) => ({ status: "error", error }),
        );
    const cancelTimeout = scheduleTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);

    try {
        return await Promise.race([request, aborted]);
    } finally {
        cancelTimeout();
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
    }
}

export function isCurrentInboxMessageRequest(input: {
    conversationId: string;
    requestId: number;
    selectedConversationId: string | null;
    currentRequestId: number;
    cancelled?: boolean;
}): boolean {
    return !input.cancelled &&
        input.selectedConversationId === input.conversationId &&
        input.currentRequestId === input.requestId;
}

type StorefrontIdentityBridgeLike = {
    product_brand?: string | null;
    product_model?: string | null;
    size_requested?: string | number | null;
};

type InboxConversationLike = {
    customer_name?: string | null;
    active_product?: {
        display_name?: string | null;
        size?: string | number | null;
    } | null;
    order?: {
        payment_reference?: string | null;
    } | null;
};

function storefrontObservedProductLabel(bridge?: StorefrontIdentityBridgeLike | null) {
    if (!bridge) return "";

    return [bridge.product_brand, bridge.product_model]
        .filter(Boolean)
        .join(" ")
        .trim();
}

function defaultGreeting(item: InboxConversationLike) {
    const customerName = item.customer_name?.split(" ")[0] || "";
    return customerName ? `Hola ${customerName}, ` : "Hola, ";
}

export function buildActiveContextResolutionAudit(
    activeContextResolution?: ActiveContextResolutionLike | null
): Record<string, unknown> | null {
    if (!activeContextResolution) return null;

    return {
        id: activeContextResolution.id,
        active_context: activeContextResolution.active_context,
        status: activeContextResolution.status,
        source_action_id: activeContextResolution.source_action_id,
        resolution_reason: activeContextResolution.resolution_reason,
        dispatch: {
            order_id: activeContextResolution.dispatch_order_id,
            payment_reference: activeContextResolution.dispatch_payment_reference,
            product_name: activeContextResolution.dispatch_product_name,
            size: activeContextResolution.dispatch_size,
        },
        storefront: {
            handoff_id: activeContextResolution.storefront_handoff_id,
            handoff_code: activeContextResolution.storefront_handoff_code,
            product_name: activeContextResolution.storefront_product_name,
            size: activeContextResolution.storefront_size,
        },
        guardrails: activeContextResolution.guardrails,
        resolved_at: activeContextResolution.resolved_at,
    };
}

export function buildActiveContextSuggestedReply(
    item: InboxConversationLike,
    identityBridge?: StorefrontIdentityBridgeLike | null,
    activeContextResolution?: ActiveContextResolutionLike | null,
    greeting = defaultGreeting(item)
) {
    if (!activeContextResolution || activeContextResolution.status !== "active") return null;

    const storefrontProduct =
        activeContextResolution.storefront_product_name ||
        storefrontObservedProductLabel(identityBridge);
    const storefrontSize = activeContextResolution.storefront_size || identityBridge?.size_requested;
    const storefrontLabel = storefrontProduct
        ? `${storefrontProduct}${storefrontSize ? ` talla ${storefrontSize}` : ""}`
        : "";
    const dispatchProduct =
        activeContextResolution.dispatch_product_name ||
        item.active_product?.display_name ||
        "";
    const dispatchSize = activeContextResolution.dispatch_size || item.active_product?.size;
    const dispatchReference =
        activeContextResolution.dispatch_payment_reference ||
        item.order?.payment_reference ||
        "";
    const dispatchLabel = dispatchProduct
        ? `${dispatchProduct}${dispatchSize ? ` talla ${dispatchSize}` : ""}`
        : "";

    if (activeContextResolution.active_context === "dispatch_pending_order") {
        const referenceText = dispatchReference ? ` ${dispatchReference}` : "";
        const productText = dispatchLabel ? ` de ${dispatchLabel}` : "";
        const storefrontAside = storefrontLabel
            ? ` Dejo separada la consulta web por ${storefrontLabel} para no mezclarla con este despacho.`
            : "";

        return `${greeting}voy a revisar primero el pedido ya pagado${referenceText}${productText}. Lo tengo como pendiente de despacho; te confirmo por este medio la guía o novedad logística apenas quede validada.${storefrontAside}`;
    }

    if (activeContextResolution.active_context === "new_storefront_purchase") {
        const storefrontText = storefrontLabel ? ` por ${storefrontLabel}` : "";
        const dispatchAside = dispatchReference
            ? ` Mantengo separado el pedido anterior ${dispatchReference} para no mezclarlo con esta compra.`
            : "";

        return `${greeting}retomo la compra que abriste desde la web${storefrontText}. Confírmame si quieres avanzar con ese modelo y talla; después preparo el siguiente paso de pago sin mezclarlo con otros pedidos.${dispatchAside}`;
    }

    if (activeContextResolution.active_context === "manual_review") {
        return `${greeting}veo más de una línea activa en esta conversación. Para evitar mezclar pedidos, ¿confirmamos primero si quieres revisar despacho, pago pendiente o una nueva compra?`;
    }

    return null;
}
