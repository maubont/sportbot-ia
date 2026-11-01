import test from "node:test";
import assert from "node:assert/strict";
import {
    buildKeyPayload,
    buildOrderIdempotencyKey,
    canonicalizeItems,
    normalizeText,
} from "./idempotency.ts";

const base = {
    customerId: "cust-1",
    conversationId: "conv-1",
    messageSid: "SM-1",
};

test("el mismo evento entrante produce la misma clave", async () => {
    const first = await buildOrderIdempotencyKey(base);
    const retry = await buildOrderIdempotencyKey(structuredClone(base));
    assert.equal(first, retry);
    assert.equal(first.length, 64);
});

test("un reintento del modelo conserva la clave aunque cambie el payload de la herramienta", async () => {
    const first = await buildOrderIdempotencyKey(base);
    const retryWithChangedPayload = await buildOrderIdempotencyKey({
        ...base,
        items: [{ product_id: "different-product", size: 43, quantity: 2 }],
        shipping: { name: "Otra persona", city: "Cali", address: "Otra dirección" },
    });
    assert.equal(first, retryWithChangedPayload);
});

test("un mensaje nuevo tiene clave distinta; la RPC decide si la recompra sigue bloqueada", async () => {
    const original = await buildOrderIdempotencyKey(base);
    const newMessage = await buildOrderIdempotencyKey({ ...base, messageSid: "SM-2" });
    assert.notEqual(original, newMessage);
});

test("cliente o conversación distintos cambian la clave", async () => {
    const original = await buildOrderIdempotencyKey(base);
    const otherCustomer = await buildOrderIdempotencyKey({ ...base, customerId: "cust-2" });
    const otherConversation = await buildOrderIdempotencyKey({ ...base, conversationId: "conv-2" });
    assert.notEqual(original, otherCustomer);
    assert.notEqual(original, otherConversation);
});

test("el identificador opaco del proveedor conserva mayúsculas", async () => {
    const upper = await buildOrderIdempotencyKey(base);
    const lower = await buildOrderIdempotencyKey({ ...base, messageSid: "sm-1" });
    assert.notEqual(upper, lower);
});

test("canonicalizeItems normaliza cantidades inválidas a 1", () => {
    const items = canonicalizeItems([
        { product_id: "p", size: "42", quantity: 0 },
        { product_id: "q", size: 41, quantity: "3" },
        { product_id: "r", size: 40, quantity: null },
    ]);

    assert.deepEqual(
        items.map((item) => item.quantity),
        [1, 3, 1],
    );
});

test("normalizeText colapsa espacios y unifica mayúsculas", () => {
    assert.equal(normalizeText("  Calle   1 # 2-3 "), "calle 1 # 2-3");
});

test("rechaza identidad incompleta", async () => {
    await assert.rejects(
        () => buildOrderIdempotencyKey({ ...base, customerId: "" }),
        /INVALID_IDENTITY/,
    );
    await assert.rejects(
        () => buildOrderIdempotencyKey({ ...base, conversationId: "" }),
        /INVALID_IDENTITY/,
    );
    await assert.rejects(
        () => buildOrderIdempotencyKey({ ...base, messageSid: " " }),
        /INVALID_IDENTITY/,
    );
});

test("el payload firmado contiene solo identidad del evento", () => {
    const payload = buildKeyPayload(base);
    assert.deepEqual(payload, {
        v: 2,
        customer: "cust-1",
        conversation: "conv-1",
        message_sid: "SM-1",
    });
});
