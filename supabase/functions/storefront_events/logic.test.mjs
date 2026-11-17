import test from "node:test";
import assert from "node:assert/strict";

import { parseStorefrontEvents, parseStorefrontHandoffRequest } from "./logic.ts";

const now = new Date("2026-05-20T12:00:00.000Z");

test("accepts safe storefront event batches", () => {
    const parsed = parseStorefrontEvents({
        events: [{
            event_type: "handoff_suggested",
            intent: "buy_intent",
            funnel_stage: "ready_to_order",
            product_id: "11111111-1111-4111-8111-111111111111",
            size_requested: "42",
            dedupe_key: "session:event",
            occurred_at: "2026-05-20T11:59:00.000Z",
            storefront_session_id: "session-1",
            event_id: "event-1",
            metadata: {
                surface: "product_primary_cta",
                product: "Nike Air Max 90",
            },
        }],
    }, now);

    assert.equal(parsed.ok, true);
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].eventType, "handoff_suggested");
    assert.equal(parsed.events[0].sizeRequested, 42);
    assert.equal(parsed.events[0].productId, "11111111-1111-4111-8111-111111111111");
});

test("rejects unsupported event types instead of broad public writes", () => {
    const parsed = parseStorefrontEvents({
        event_type: "payment_approved",
        intent: "payment",
    }, now);

    assert.equal(parsed.ok, false);
    assert.equal(parsed.status, 400);
});

test("strips sensitive metadata and bounds batches", () => {
    const parsed = parseStorefrontEvents({
        events: [{
            event_type: "message_inbound_received",
            intent: "product_search",
            funnel_stage: "interested",
            metadata: {
                token: "secret",
                text_preview: "quiero nike",
                email: "cliente@example.com",
            },
        }],
    }, now);

    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.events[0].metadata, { text_preview: "quiero nike" });

    const tooMany = parseStorefrontEvents({
        events: Array.from({ length: 11 }, () => ({ event_type: "customer_greeted" })),
    }, now);

    assert.equal(tooMany.ok, false);
    assert.equal(tooMany.status, 413);
});

test("accepts safe storefront handoff requests", () => {
    const parsed = parseStorefrontHandoffRequest({
        handoff: {
            storefront_session_id: "session-1",
            source_surface: "product_primary_cta",
            product_id: "11111111-1111-4111-8111-111111111111",
            product_brand: "Nike",
            product_model: "Air Max 90",
            size_requested: "42",
            intent: "buy_intent",
            funnel_stage: "ready_to_order",
            dedupe_key: "session-1:product:11111111-1111-4111-8111-111111111111:42",
            metadata: {
                product: "Nike Air Max 90",
                phone: "+12025550101",
                source: "catalog",
            },
        },
    });

    assert.equal(parsed.ok, true);
    assert.equal(parsed.handoff.storefrontSessionId, "session-1");
    assert.equal(parsed.handoff.productBrand, "Nike");
    assert.equal(parsed.handoff.sizeRequested, 42);
    assert.deepEqual(parsed.handoff.metadata, {
        product: "Nike Air Max 90",
        source: "catalog",
    });
});

test("rejects handoff requests without stable session or dedupe key", () => {
    const missingSession = parseStorefrontHandoffRequest({
        handoff: {
            source_surface: "nav_whatsapp",
            dedupe_key: "x",
        },
    });
    assert.equal(missingSession.ok, false);
    assert.equal(missingSession.status, 400);

    const missingDedupe = parseStorefrontHandoffRequest({
        handoff: {
            storefront_session_id: "session-1",
            source_surface: "nav_whatsapp",
        },
    });
    assert.equal(missingDedupe.ok, false);
    assert.equal(missingDedupe.status, 400);
});
