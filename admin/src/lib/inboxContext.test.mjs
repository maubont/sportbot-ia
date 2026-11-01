import test from "node:test";
import assert from "node:assert/strict";

import {
    buildActiveContextResolutionAudit,
    buildActiveContextSuggestedReply,
    canSendWithLoadedInboxMessages,
    isCurrentInboxMessageRequest,
    runInboxMessageRequest,
} from "./inboxContext.ts";

test("reply is enabled only after the inbox thread has loaded successfully", () => {
    assert.equal(canSendWithLoadedInboxMessages("loaded"), true);
    assert.equal(canSendWithLoadedInboxMessages("idle"), false);
    assert.equal(canSendWithLoadedInboxMessages("loading"), false);
    assert.equal(canSendWithLoadedInboxMessages("error"), false);
});

test("a failed inbox request is reported as error and a subsequent request succeeds", async () => {
    const failed = await runInboxMessageRequest(async () => {
        throw new Error("temporary network failure");
    }, new AbortController(), 5_000);

    assert.equal(failed.status, "error");
    if (failed.status === "error") assert.match(failed.error.message, /temporary network failure/);

    const retried = await runInboxMessageRequest(async () => [{ id: "message-1" }], new AbortController(), 5_000);
    assert.deepEqual(retried, { status: "loaded", data: [{ id: "message-1" }] });
    assert.equal(canSendWithLoadedInboxMessages(retried.status), true);
});

test("timeout aborts the request and resolves even when the fetcher ignores AbortSignal", async () => {
    let triggerTimeout;
    let timeoutCancelled = false;
    let fetchStarted = false;
    const controller = new AbortController();
    const neverSettles = new Promise(() => {});
    const resultPromise = runInboxMessageRequest(
        () => {
            fetchStarted = true;
            return neverSettles;
        },
        controller,
        15_000,
        (callback) => {
            triggerTimeout = callback;
            return () => { timeoutCancelled = true; };
        },
    );

    await Promise.resolve();
    assert.equal(fetchStarted, true);
    triggerTimeout();

    assert.deepEqual(await resultPromise, { status: "timeout" });
    assert.equal(controller.signal.aborted, true);
    assert.equal(timeoutCancelled, true);
});

test("conversation cancellation is reported as aborted, not as a fetch error", async () => {
    const controller = new AbortController();
    const resultPromise = runInboxMessageRequest(() => new Promise(() => {}), controller, 5_000);
    await Promise.resolve();
    controller.abort();

    assert.deepEqual(await resultPromise, { status: "aborted" });
});

test("conversation changes discard late results from the previously selected thread", () => {
    const oldConversationRequest = {
        conversationId: "conversation-a",
        requestId: 11,
        selectedConversationId: "conversation-b",
        currentRequestId: 12,
    };

    assert.equal(isCurrentInboxMessageRequest(oldConversationRequest), false);
    assert.equal(isCurrentInboxMessageRequest({
        ...oldConversationRequest,
        conversationId: "conversation-b",
        requestId: 12,
    }), true);
    assert.equal(isCurrentInboxMessageRequest({
        ...oldConversationRequest,
        selectedConversationId: "conversation-a",
        currentRequestId: 12,
    }), false);
    assert.equal(isCurrentInboxMessageRequest({
        ...oldConversationRequest,
        cancelled: true,
    }), false);
});

const conversation = {
    customer_name: "Usuario de prueba Bonilla",
    active_product: {
        display_name: "Adidas Ultraboost Light Core Black",
        size: 39,
    },
    order: {
        payment_reference: "ORD-1779249225497",
    },
};

const bridge = {
    product_brand: "Nike",
    product_model: "Air Max 90",
    size_requested: 39,
};

test("context-aware draft prioritizes paid dispatch without closing a new purchase", () => {
    const draft = buildActiveContextSuggestedReply(conversation, bridge, {
        id: "resolution-1",
        active_context: "dispatch_pending_order",
        status: "active",
        dispatch_payment_reference: "ORD-1779249225497",
        dispatch_product_name: "Adidas Ultraboost Light Core Black",
        dispatch_size: 39,
        storefront_product_name: "Nike Air Max 90",
        storefront_size: 39,
    });

    assert.match(draft ?? "", /revisar primero el pedido ya pagado/);
    assert.match(draft ?? "", /ORD-1779249225497/);
    assert.match(draft ?? "", /Adidas Ultraboost Light Core Black talla 39/);
    assert.match(draft ?? "", /Dejo separada la consulta web por Nike Air Max 90 talla 39/);
    assert.doesNotMatch(draft ?? "", /preparo el siguiente paso de pago/i);
    assert.doesNotMatch(draft ?? "", /confirmar los datos de envío/i);
});

test("context-aware draft can prioritize the storefront purchase separately", () => {
    const draft = buildActiveContextSuggestedReply(conversation, bridge, {
        id: "resolution-2",
        active_context: "new_storefront_purchase",
        status: "active",
        dispatch_payment_reference: "ORD-1779249225497",
        storefront_product_name: "Nike Air Max 90",
        storefront_size: 39,
    });

    assert.match(draft ?? "", /retomo la compra que abriste desde la web por Nike Air Max 90 talla 39/);
    assert.match(draft ?? "", /Mantengo separado el pedido anterior ORD-1779249225497/);
    assert.doesNotMatch(draft ?? "", /pendiente de despacho/i);
});

test("inactive context does not override the live inbox draft", () => {
    const draft = buildActiveContextSuggestedReply(conversation, bridge, {
        id: "resolution-3",
        active_context: "dispatch_pending_order",
        status: "replaced",
    });

    assert.equal(draft, null);
});

test("active context audit keeps decision evidence structured", () => {
    const audit = buildActiveContextResolutionAudit({
        id: "resolution-1",
        active_context: "dispatch_pending_order",
        status: "active",
        source_action_id: "action-1",
        dispatch_payment_reference: "ORD-1779249225497",
        storefront_handoff_code: "WEB-RXTWVAT8",
    });

    assert.equal(audit?.active_context, "dispatch_pending_order");
    assert.deepEqual(audit?.dispatch, {
        order_id: undefined,
        payment_reference: "ORD-1779249225497",
        product_name: undefined,
        size: undefined,
    });
    assert.deepEqual(audit?.storefront, {
        handoff_id: undefined,
        handoff_code: "WEB-RXTWVAT8",
        product_name: undefined,
        size: undefined,
    });
});
