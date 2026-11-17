import test from "node:test";
import assert from "node:assert/strict";

const {
    formatImageReadingForAgent,
    summarizeImageReading,
    validateImageInput,
    buildImageReading,
    normalizeDate,
    parseJsonObject,
} = await import("./vision-core.ts");

const receipt = {
    kind: "receipt",
    looks_like_receipt: true,
    description: "Comprobante de Nequi.",
    amount_cop: 100000,
    date: "2026-10-26",
    bank: "Nequi",
    reference: "123456789",
    holder: "Juan Pérez",
};

test("un comprobante entra al turno con monto, fecha, banco y referencia", () => {
    const line = formatImageReadingForAgent(receipt);

    assert.match(line, /\$100\.000/);
    assert.match(line, /2026-10-26/);
    assert.match(line, /Nequi/);
    assert.match(line, /123456789/);
    assert.match(line, /Juan Pérez/);
});

test("una foto de producto usa la descripción y no inventa monto", () => {
    const line = formatImageReadingForAgent({
        ...receipt,
        kind: "product",
        looks_like_receipt: false,
        description: "Un par de tenis Nike Air Max 90 blancos sobre una mesa.",
        amount_cop: null,
        date: null,
        bank: null,
        reference: null,
        holder: null,
    });

    assert.match(line, /Nike Air Max 90/);
    assert.doesNotMatch(line, /\$/);
});

test("un comprobante sin banco ni fecha no inventa esos campos", () => {
    const line = formatImageReadingForAgent({
        ...receipt,
        date: null,
        bank: null,
        reference: null,
        holder: null,
    });

    assert.match(line, /\$100\.000/);
    assert.doesNotMatch(line, /Nequi|del |referencia|titular/);
});

test("normaliza fechas colombianas a ISO", () => {
    assert.equal(normalizeDate("26/10/2026"), "2026-10-26");
    assert.equal(normalizeDate("26-10-26"), "2026-10-26");
    assert.equal(normalizeDate("2026-10-26T15:00:00Z"), "2026-10-26");
    assert.equal(normalizeDate("ayer"), "ayer");
    assert.equal(normalizeDate(null), null);
});

test("convierte el JSON del modelo en una lectura tipada", () => {
    const reading = buildImageReading({
        kind: "receipt",
        looks_like_receipt: true,
        description: "Transferencia Bancolombia",
        amount_cop: "$ 100.000",
        date: "26/10/2026",
        bank: "Bancolombia",
        reference: " 998877 ",
        holder: "Ana",
    });

    assert.equal(reading.amount_cop, 100000);
    assert.equal(reading.date, "2026-10-26");
    assert.equal(reading.reference, "998877");
    assert.equal(reading.kind, "receipt");
});

test("un monto sin clasificación no confirma que sea un comprobante", () => {
    const reading = buildImageReading({ amount_cop: 450000, description: "Pago" });

    assert.equal(reading.looks_like_receipt, null);
    assert.equal(reading.kind, "other");
    assert.equal(formatImageReadingForAgent(reading), "Pago");
});

test("si falta la clasificación y el monto, se conserva la duda", () => {
    const reading = buildImageReading({ description: "Una captura poco clara" });
    assert.equal(reading.looks_like_receipt, null);
    assert.notEqual(reading.looks_like_receipt, false);
});

test("un precio en una foto clasificada como producto no la convierte en comprobante", () => {
    const reading = buildImageReading({
        kind: "product", looks_like_receipt: false,
        description: "Tenis con precio visible", amount_cop: 100000,
    });
    assert.equal(reading.looks_like_receipt, false);
    assert.equal(formatImageReadingForAgent(reading), "Tenis con precio visible");
});

test("un JSON con markdown se sigue leyendo", () => {
    const parsed = parseJsonObject('```json\n{"amount_cop": 100000}\n```');

    assert.equal(parsed?.amount_cop, 100000);
});

test("un PDF no se manda a visión", () => {
    assert.match(String(validateImageInput(10, "application/pdf")), /no soportado/);
});

test("una imagen mayor a 4 MB se rechaza antes de gastar tokens", () => {
    assert.match(String(validateImageInput(4_000_001, "image/jpeg")), /demasiado grande/);
    assert.equal(validateImageInput(4_000_000, "image/jpeg"), null);
});

test("el resumen para logs no expone el monto ni el titular", () => {
    const summary = summarizeImageReading(receipt);

    assert.equal(summary.kind, "receipt");
    assert.equal(summary.bank, "Nequi");
    assert.equal(summary.has_amount, true);
    assert.equal(summary.has_reference, true);
    assert.equal("holder" in summary, false);
    assert.equal("description" in summary, false);
});
