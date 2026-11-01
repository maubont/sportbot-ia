import test from "node:test";
import assert from "node:assert/strict";
import {
    requireInboundMessageId,
    resolveInboundClaimResult,
} from "./inbound-claim.ts";

test("normaliza el ID estable del proveedor", () => {
    assert.equal(requireInboundMessageId("  msg-123  "), "msg-123");
});

test("no procesa mensajes sin ID del proveedor", () => {
    assert.throws(() => requireInboundMessageId(null), /INBOUND_CLAIM_UNAVAILABLE/);
    assert.throws(() => requireInboundMessageId("  "), /INBOUND_CLAIM_UNAVAILABLE/);
});

test("permite continuar únicamente cuando el claim fue adquirido", () => {
    assert.equal(resolveInboundClaimResult(true, null), "claimed");
});

test("trata un mensaje previamente reclamado como duplicado", () => {
    assert.equal(resolveInboundClaimResult(false, null), "duplicate");
});

test("falla cerrado ante error RPC o respuesta no booleana", () => {
    assert.throws(() => resolveInboundClaimResult(null, { message: "db unavailable" }), /INBOUND_CLAIM_UNAVAILABLE/);
    assert.throws(() => resolveInboundClaimResult(null, null), /INBOUND_CLAIM_UNAVAILABLE/);
    assert.throws(() => resolveInboundClaimResult("false", null), /INBOUND_CLAIM_UNAVAILABLE/);
});
