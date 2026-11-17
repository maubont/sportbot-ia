import { test } from "node:test";
import assert from "node:assert/strict";
import {
    captureReceipts,
    detectReceiptReuse,
    parseOrderReference,
    receiptCaptureReply,
} from "./receipt-capture-core.ts";

const order = { id: "order-1", paymentReference: "ORD-TEST", totalCents: 45000000 };
const defaults = { media: ["image"], maxReceipts: 3, findOrder: async () => ({ kind: "selected", order }), saveReceipt: async () => "receipt-1" };

test("solo confirma recepción cuando existe un comprobante registrado", async () => {
    const result = await captureReceipts(defaults);
    assert.equal(result.kind, "captured");
    assert.deepEqual(result.receiptIds, ["receipt-1"]);
    assert.match(receiptCaptureReply(result), /ORD-TEST/);
    assert.doesNotMatch(receiptCaptureReply(result), /pago aprobad|pago confirmad/i);
});

test("sin pedido no inserta ni promete registro o revisión", async () => {
    let writes = 0;
    const result = await captureReceipts({ ...defaults, findOrder: async () => ({ kind: "no_pending_order" }), saveReceipt: async () => { writes++; return "id"; } });
    assert.deepEqual(result, { kind: "no_pending_order" });
    assert.equal(writes, 0);
    const reply = receiptCaptureReply(result);
    assert.match(reply, /no encontré un pedido pendiente/i);
    assert.match(reply, /ORD-/);
    assert.doesNotMatch(reply, /quedó registrado|una persona lo revisa|pago aprobado/i);
});

test("sin pedido puede comunicar la lectura sin afirmar que quedó registrado", () => {
    const reply = receiptCaptureReply({ kind: "no_pending_order" }, 0, "Comprobante de pago de Nequi, por $100.000 COP, del 2026-10-19, con referencia 1234.");
    assert.match(reply, /Nequi.*\$100\.000.*2026-10-19.*1234/);
    assert.match(reply, /No encontré un pedido pendiente/);
    assert.doesNotMatch(reply, /quedó registrado|pago aprobado/i);
});

test("error buscando pedido es fallo, no ausencia de pedido", async () => {
    const result = await captureReceipts({ ...defaults, findOrder: async () => { throw new Error("db"); } });
    assert.deepEqual(result, { kind: "failed" });
    assert.match(receiptCaptureReply(result), /no pude registrar/i);
    assert.doesNotMatch(receiptCaptureReply(result), /no encontré un pedido/i);
});

test("error de escritura o duplicado no recuperable no confirma registro", async () => {
    for (const saveReceipt of [async () => null, async () => { throw new Error("storage"); }]) {
        const result = await captureReceipts({ ...defaults, saveReceipt });
        assert.deepEqual(result, { kind: "failed" });
        assert.match(receiptCaptureReply(result), /vuelve a enviarlo/i);
    }
});

test("registro parcial comunica que faltan archivos", async () => {
    const result = await captureReceipts({ ...defaults, media: ["a", "b"], saveReceipt: async (_order, item) => item === "a" ? "receipt-1" : null });
    assert.equal(result.kind, "captured");
    assert.equal(result.missingCount, 1);
    assert.match(receiptCaptureReply(result), /no pude registrar todos los archivos/i);
});

test("el límite de archivos y un fallo de descarga no se ocultan", async () => {
    const result = await captureReceipts({ ...defaults, media: ["a", "b", "c", "d"], saveReceipt: async (_order, item) => item });
    assert.equal(result.kind, "captured");
    assert.equal(result.missingCount, 1);
    assert.match(receiptCaptureReply(result, 1), /no pude registrar todos los archivos/i);
});

test("sin archivos no consulta ni afirma un registro", async () => {
    const result = await captureReceipts({ ...defaults, media: [], findOrder: async () => { throw new Error("no llamar"); } });
    assert.deepEqual(result, { kind: "failed" });
});

test("fallo de descarga con ausencia de pedido se comunica por separado", () => {
    const reply = receiptCaptureReply({ kind: "no_pending_order" }, 1);
    assert.match(reply, /no pude procesar todos los archivos/i);
    assert.match(reply, /no encontré un pedido pendiente/i);
});

test("extrae una única referencia completa del pie de foto", () => {
    assert.deepEqual(parseOrderReference("Pago ord-20261026213646-7aa5ca, gracias"), {
        kind: "valid", reference: "ORD-20261026213646-7AA5CA",
    });
    assert.deepEqual(parseOrderReference("ORD - 20261026213646 - 7AA5CA"), {
        kind: "valid", reference: "ORD-20261026213646-7AA5CA",
    });
    assert.deepEqual(parseOrderReference("Orden de pago con referencia bancaria 1688504454"), { kind: "absent" });
    assert.deepEqual(parseOrderReference("ORD-20261026213646-7AA5CA y ORD-20261026213646-7AA5CA"), {
        kind: "valid", reference: "ORD-20261026213646-7AA5CA",
    });
});

test("no ignora referencias incompletas, múltiples o alteradas", () => {
    for (const caption of [
        "ORD-20261026213646-7AA5CA y ORD-20261026215040-7CCB8B",
        "ORD-20261026213646-7AA5CA-", "ORD-20261026213646-7AA5CAX",
        "ORD-20261026213646", "ORD-", "ORD123", "ORD:20261026213646-7AA5CA",
    ]) assert.equal(parseOrderReference(caption).kind, "invalid", caption);
});

test("ambigüedad y referencia inválida no guardan ni prometen revisión", async () => {
    for (const kind of ["reference_required", "reference_not_found", "invalid_reference"]) {
        let writes = 0;
        const result = await captureReceipts({ ...defaults, findOrder: async () => ({ kind }), saveReceipt: async () => { writes++; return "id"; } });
        assert.equal(result.kind, kind);
        assert.equal(writes, 0);
        assert.match(receiptCaptureReply(result), /no lo asocié a ningún pedido/i);
        assert.match(receiptCaptureReply(result), /pie de foto/i);
        assert.doesNotMatch(receiptCaptureReply(result), /pago aprobad|quedó registrado/i);
    }
});

test("la misma imagen usada en otro pedido se marca para el humano", async () => {
    const reused = await detectReceiptReuse({
        receipt: { order_id: "order-1", sha256: "abc123" },
        query: async () => [{ id: "other-receipt" }],
    });
    assert.equal(reused, true);
});

test("una imagen solo usada en su pedido no se acusa", async () => {
    const reused = await detectReceiptReuse({
        receipt: { order_id: "order-1", sha256: "abc123" },
        query: async () => [],
    });
    assert.equal(reused, false);
});

test("sin huella sha256 no consulta y no acusa", async () => {
    let consulted = 0;
    const reused = await detectReceiptReuse({
        receipt: { order_id: "order-1", sha256: "   " },
        query: async () => { consulted++; return []; },
    });
    assert.equal(reused, false);
    assert.equal(consulted, 0);
});

test("un error de consulta nunca acusa al cliente", async () => {
    const errors = [];
    const reused = await detectReceiptReuse({
        receipt: { order_id: "order-1", sha256: "abc123" },
        query: async () => { throw new Error("conexión caída"); },
        onError: (error) => errors.push(error),
    });
    assert.equal(reused, false);
    assert.equal(errors.length, 1);
});
