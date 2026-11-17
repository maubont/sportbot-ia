import test from "node:test";
import assert from "node:assert/strict";

import {
    classifyStorefrontHandoff,
    extractStorefrontHandoffCode,
    extractStorefrontHandoffCodes,
    linkStorefrontHandoff,
    stripStorefrontHandoffCode,
} from "./handoff.ts";

const identity = {
    customerId: "customer-1",
    conversationId: "conversation-1",
    messageId: "message-1",
};

function row(overrides = {}) {
    return {
        id: "handoff-1",
        handoff_code: "WEB-ABC12345",
        storefront_session_id: "session-1",
        status: "opened_whatsapp",
        product_id: "11111111-1111-4111-8111-111111111111",
        product_brand: "Nike",
        product_model: "Air Max 90",
        size_requested: 42,
        intent: "buy_intent",
        funnel_stage: "ready_to_order",
        source_surface: "product_primary_cta",
        expires_at: "2026-05-23T13:00:00.000Z",
        linked_customer_id: null,
        linked_conversation_id: null,
        linked_message_id: null,
        linked_at: null,
        metadata: {},
        ...overrides,
    };
}

function makeSupabaseMock(initialRow, options = {}) {
    const state = { row: initialRow };
    const calls = {
        selects: [],
        updates: [],
        filters: [],
    };

    const client = {
        calls,
        from(table) {
            assert.equal(table, "storefront_handoffs");

            return {
                select(columns) {
                    return {
                        eq(column, value) {
                            calls.selects.push({ columns, column, value });
                            return {
                                async maybeSingle() {
                                    return { data: state.row, error: null };
                                },
                            };
                        },
                    };
                },
                update(payload) {
                    calls.updates.push(payload);
                    state.row = state.row ? { ...state.row, ...payload } : state.row;

                    const chain = {
                        eq(column, value) {
                            calls.filters.push({ op: "eq", column, value });
                            return chain;
                        },
                        in(column, values) {
                            calls.filters.push({ op: "in", column, values });
                            return chain;
                        },
                        is(column, value) {
                            calls.filters.push({ op: "is", column, value });
                            return chain;
                        },
                        select(columns) {
                            calls.selects.push({ columns, update: true });
                            return {
                                async maybeSingle() {
                                    if (options.updateReturnsNull) return { data: null, error: null };
                                    return { data: state.row, error: null };
                                },
                            };
                        },
                    };

                    return chain;
                },
            };
        },
    };

    return client;
}

test("extracts storefront handoff code from WhatsApp body", () => {
    assert.equal(
        extractStorefrontHandoffCode("Hola, quiero estas zapatillas\nCodigo web: WEB-HV8JELY6"),
        "WEB-HV8JELY6"
    );
    assert.equal(extractStorefrontHandoffCode("codigo web: web-abcd2345"), "WEB-ABCD2345");
    assert.equal(extractStorefrontHandoffCode("WEB-123"), null);
    assert.deepEqual(
        extractStorefrontHandoffCodes("WEB-HV8JELY6 y luego web-abcd2345"),
        ["WEB-HV8JELY6", "WEB-ABCD2345"]
    );
    assert.equal(extractStorefrontHandoffCode("WEB-HV8JELY6 y luego WEB-ABCD2345"), null);
});

test("strips handoff code before sending text to the selling assistant", () => {
    const text = stripStorefrontHandoffCode("Hola SportBot, vi Nike Air Max.\nCodigo web: WEB-HV8JELY6");

    assert.equal(text, "Hola SportBot, vi Nike Air Max.");
});

test("classifies active handoffs as linkable", () => {
    const disposition = classifyStorefrontHandoff(row(), identity, new Date("2026-05-23T12:00:00.000Z"));

    assert.equal(disposition.status, "linkable");
    assert.equal(disposition.reason, "active");
});

test("does not relink expired or foreign handoffs", () => {
    const expired = classifyStorefrontHandoff(
        row({ expires_at: "2026-05-23T11:59:00.000Z" }),
        identity,
        new Date("2026-05-23T12:00:00.000Z")
    );
    const foreign = classifyStorefrontHandoff(
        row({
            status: "linked",
            linked_customer_id: "other-customer",
            linked_conversation_id: "other-conversation",
        }),
        identity,
        new Date("2026-05-23T12:00:00.000Z")
    );

    assert.deepEqual(expired, { status: "unresolved", reason: "expired" });
    assert.deepEqual(foreign, { status: "unresolved", reason: "already_linked_to_other_identity" });
});

test("links a valid handoff without mutating observed product, size or stock context", async () => {
    const supabase = makeSupabaseMock(row());
    const result = await linkStorefrontHandoff(supabase, {
        ...identity,
        code: "Codigo web: WEB-ABC12345",
        twilioMessageSid: "SM123",
        now: new Date("2026-05-23T12:00:00.000Z"),
    });

    assert.equal(result.status, "linked");
    assert.equal(result.reason, "active");
    assert.equal(result.row.linked_customer_id, identity.customerId);
    assert.equal(result.row.linked_conversation_id, identity.conversationId);
    assert.equal(result.row.linked_message_id, identity.messageId);
    assert.equal(result.row.product_model, "Air Max 90");
    assert.equal(result.row.size_requested, 42);

    const updatePayload = supabase.calls.updates[0];
    assert.equal(updatePayload.status, "linked");
    assert.equal("product_id" in updatePayload, false);
    assert.equal("product_model" in updatePayload, false);
    assert.equal("size_requested" in updatePayload, false);
    assert.equal("stock" in updatePayload, false);
});

test("does not query or link when the WhatsApp body has no handoff code", async () => {
    const supabase = makeSupabaseMock(row());
    const result = await linkStorefrontHandoff(supabase, {
        ...identity,
        code: "Hola, quiero comprar las Nike Air Max talla 42",
    });

    assert.equal(result.status, "unresolved");
    assert.equal(result.reason, "not_found");
    assert.equal(supabase.calls.selects.length, 0);
    assert.equal(supabase.calls.updates.length, 0);
});

test("blocks ambiguous handoff codes instead of choosing one silently", async () => {
    const supabase = makeSupabaseMock(row());
    const result = await linkStorefrontHandoff(supabase, {
        ...identity,
        code: "Tengo WEB-ABC12345 y WEB-ZYX98765, cual era?",
    });

    assert.equal(result.status, "unresolved");
    assert.equal(result.reason, "ambiguous");
    assert.equal(supabase.calls.selects.length, 0);
    assert.equal(supabase.calls.updates.length, 0);
});

test("expires stale handoffs and avoids linking them to Customer 360", async () => {
    const supabase = makeSupabaseMock(row({ expires_at: "2026-05-23T11:59:00.000Z" }));
    const result = await linkStorefrontHandoff(supabase, {
        ...identity,
        code: "WEB-ABC12345",
        now: new Date("2026-05-23T12:00:00.000Z"),
    });

    assert.equal(result.status, "unresolved");
    assert.equal(result.reason, "expired");
    assert.deepEqual(supabase.calls.updates[0], { status: "expired" });
});

test("prevents weak merge when a handoff is already linked to another customer", async () => {
    const supabase = makeSupabaseMock(row({
        status: "linked",
        linked_customer_id: "other-customer",
        linked_conversation_id: "other-conversation",
        linked_message_id: "other-message",
    }));
    const result = await linkStorefrontHandoff(supabase, {
        ...identity,
        code: "WEB-ABC12345",
        now: new Date("2026-05-23T12:00:00.000Z"),
    });

    assert.equal(result.status, "unresolved");
    assert.equal(result.reason, "already_linked_to_other_identity");
    assert.equal(supabase.calls.updates.length, 0);
});

test("treats already linked same identity as idempotent", async () => {
    const supabase = makeSupabaseMock(row({
        status: "linked",
        linked_customer_id: identity.customerId,
        linked_conversation_id: identity.conversationId,
        linked_message_id: identity.messageId,
    }));
    const result = await linkStorefrontHandoff(supabase, {
        ...identity,
        code: "WEB-ABC12345",
        now: new Date("2026-05-23T12:00:00.000Z"),
    });

    assert.equal(result.status, "already_linked");
    assert.equal(result.reason, "same_identity");
    assert.equal(supabase.calls.updates.length, 0);
});
