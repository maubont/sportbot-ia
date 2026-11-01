import test from "node:test";
import assert from "node:assert/strict";
import { classifyOperatorSendResult, validUuid, validateOperatorText } from "./operator-messaging-core.ts";
import { canAdvanceEvolutionDeliveryStatus, mapEvolutionDeliveryStatus } from "../_shared/channels/delivery-status.ts";

test("accepts only a provider-accepted message as accepted", () => {
    assert.deepEqual(classifyOperatorSendResult({ success: true }), { status: "accepted", error: null });
});

test("timeouts and network failures are uncertain, never retried as definite failures", () => {
    for (const error of ["evolution_timeout", "evolution_network_error:connection reset", "provider_exception:fetch failed", "twilio_http_503"]) {
        assert.equal(classifyOperatorSendResult({ success: false, error }).status, "unknown", error);
    }
});

test("definitive provider rejection is a failure", () => {
    for (const error of ["evolution_http_400:invalid number", "evolution_invalid_recipient", "evolution_not_configured"]) {
        assert.equal(classifyOperatorSendResult({ success: false, error }).status, "failed", error);
    }
});

test("validates UUID idempotency keys", () => {
    assert.equal(validUuid("b5caa38c-0b33-41aa-8c3e-0d91f2e4f22e"), true);
    assert.equal(validUuid("message-1"), false);
    assert.equal(validUuid(null), false);
});

test("trims outgoing text and bounds its length", () => {
    assert.deepEqual(validateOperatorText("  Hola  "), { ok: true, text: "Hola" });
    assert.equal(validateOperatorText("   ").ok, false);
    assert.equal(validateOperatorText("x".repeat(4097)).code, "message_too_long");
});

test("maps Evolution acknowledgements to monotonic operator delivery labels", () => {
    assert.equal(mapEvolutionDeliveryStatus("server_ack"), "accepted");
    assert.equal(mapEvolutionDeliveryStatus("delivery_ack"), "delivered");
    assert.equal(mapEvolutionDeliveryStatus("played"), "read");
    assert.equal(mapEvolutionDeliveryStatus("error"), "failed");
    assert.equal(mapEvolutionDeliveryStatus("pending"), null);
    assert.equal(mapEvolutionDeliveryStatus("unknown"), null);
    assert.equal(canAdvanceEvolutionDeliveryStatus("sending", "accepted"), true);
    assert.equal(canAdvanceEvolutionDeliveryStatus("accepted", "delivered"), true);
    assert.equal(canAdvanceEvolutionDeliveryStatus("delivered", "read"), true);
    assert.equal(canAdvanceEvolutionDeliveryStatus("read", "delivered"), false);
    assert.equal(canAdvanceEvolutionDeliveryStatus("failed", "accepted"), false);
    assert.equal(canAdvanceEvolutionDeliveryStatus("failed", "read"), true);
});
