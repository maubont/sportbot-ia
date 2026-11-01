import test from "node:test";
import assert from "node:assert/strict";
import {
    applyPatch,
    canTransition,
    defaultState,
    isBotPaused,
    rowToState,
    statePromptBlock,
    stateToRow,
} from "./state-core.ts";

test("defaultState arranca en browsing y sin producto", () => {
    const state = defaultState("conv-1");
    assert.equal(state.stage, "browsing");
    assert.equal(state.activeProductId, null);
    assert.equal(state.handoffStatus, "bot");
});

test("canTransition permite el flujo comercial y bloquea saltos ilegales", () => {
    assert.equal(canTransition("browsing", "selecting"), true);
    assert.equal(canTransition("browsing", "awaiting_payment"), true);
    assert.equal(canTransition("collecting_shipping", "awaiting_payment"), true);
    assert.equal(canTransition("awaiting_payment", "paid"), true);
    assert.equal(canTransition("paid", "browsing"), false);
    assert.equal(canTransition("closed", "browsing"), true);
    assert.equal(canTransition("browsing", "paid"), false);
});

test("applyPatch no muta el estado original y fusiona metadata", () => {
    const state = defaultState("conv-1");
    const next = applyPatch(state, {
        stage: "selecting",
        activeProductId: "prod-1",
        metadata: { source: "search" },
    });

    assert.equal(state.stage, "browsing");
    assert.equal(next.stage, "selecting");
    assert.equal(next.activeProductId, "prod-1");
    assert.deepEqual(next.metadata, { source: "search" });

    const merged = applyPatch(next, { metadata: { media: true } });
    assert.deepEqual(merged.metadata, { source: "search", media: true });
});

test("isBotPaused respeta handoff, stage y pausa temporal", () => {
    const now = Date.parse("2026-10-25T12:00:00Z");

    assert.equal(isBotPaused(defaultState("c"), now), false);
    assert.equal(
        isBotPaused({ ...defaultState("c"), handoffStatus: "human" }, now),
        true,
    );
    assert.equal(
        isBotPaused({ ...defaultState("c"), stage: "human_takeover" }, now),
        true,
    );
    assert.equal(
        isBotPaused(
            {
                ...defaultState("c"),
                botPausedUntil: "2026-10-25T12:05:00Z",
            },
            now,
        ),
        true,
    );
    assert.equal(
        isBotPaused(
            {
                ...defaultState("c"),
                botPausedUntil: "2026-10-25T11:55:00Z",
            },
            now,
        ),
        false,
    );
});

test("statePromptBlock es factual y explícito cuando no hay producto", () => {
    const empty = statePromptBlock(defaultState("c"));
    assert.match(empty, /Producto activo: ninguno/);
    assert.match(empty, /Etapa: browsing/);

    const withProduct = statePromptBlock({
        ...defaultState("c"),
        stage: "selecting",
        activeProductId: "prod-42",
        activeVariantId: "var-42",
    });
    assert.match(withProduct, /Producto activo: prod-42/);
    assert.match(withProduct, /Variante activa: var-42/);
});

test("stateToRow y rowToState hacen roundtrip", () => {
    const state = {
        ...defaultState("conv-9"),
        stage: "awaiting_payment",
        activeProductId: "prod-9",
        lastIntent: "buy_intent",
        pendingAction: { type: "payment_review" },
        metadata: { channel: "whatsapp" },
    };

    const row = stateToRow(state);
    assert.equal(row.conversation_id, "conv-9");
    assert.equal(row.active_product_id, "prod-9");
    assert.equal(row.pending_action?.type, "payment_review");

    const back = rowToState(row);
    assert.equal(back.conversationId, "conv-9");
    assert.equal(back.stage, "awaiting_payment");
    assert.equal(back.activeProductId, "prod-9");
    assert.deepEqual(back.pendingAction, { type: "payment_review" });
});
