/**
 * Camino del dinero: lo que se le dice al cliente y como se lee un comprobante.
 *
 * Estas pruebas son la red de seguridad de la regla mas importante del MVP:
 * la IA no aprueba pagos, no inventa cuentas y no inventa montos.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
    buildExpiredNotice,
    buildPaymentInstructions,
    buildReceiptAck,
    buildReceiptCompleteNotice,
    buildReceiptUnreadableNotice,
    buildShortfallNotice,
    computePaymentProgress,
    evaluateReceiptEvidence,
    extractAmountsCop,
    formatCop,
    formatDeadline,
    normalizeReference,
    parseCopAmount,
    sumReceiptAmountsCents,
} from "./payments-core.ts";

const ORDER = {
    id: "order-1",
    paymentReference: "ORD-20261027120000-ABC123",
    totalCents: 450_000_00,
};

const CONFIG = {
    nequiNumber: "2025550102",
    nequiHolder: "Usuario de prueba Perez",
    brebKey: "sportbot@bre-b",
    brebHolder: "SportBot SAS",
    customInstructions: null,
    receiptWindowHours: 24,
};

describe("formatCop", () => {
    it("agrupa miles como pesos colombianos", () => {
        assert.equal(formatCop(450_000_00), "$450.000");
        assert.equal(formatCop(52_000_000), "$520.000");
        assert.equal(formatCop(0), "$0");
    });

    it("no rompe con valores invalidos", () => {
        assert.equal(formatCop(Number.NaN), "$0");
        assert.equal(formatCop(-500), "$0");
    });
});

describe("buildPaymentInstructions", () => {
    it("incluye Nequi, Bre-B, monto, referencia y titular", () => {
        const result = buildPaymentInstructions(CONFIG, ORDER);

        assert.equal(result.complete, true);
        assert.match(result.text, /ORD-20261027120000-ABC123/);
        assert.match(result.text, /\$450\.000 COP/);
        assert.match(result.text, /2025550102/);
        assert.match(result.text, /sportbot@bre-b/);
        assert.match(result.text, /Usuario de prueba Perez/);
        assert.match(result.text, /SportBot SAS/);
        assert.match(result.text, /comprobante/);
    });

    it("nunca dice que el pago esta aprobado", () => {
        const result = buildPaymentInstructions(CONFIG, ORDER);

        assert.doesNotMatch(result.text, /aprobad/i);
        assert.doesNotMatch(result.text, /confirmad[oa] el pago/i);
        assert.match(result.text, /una persona lo revisa/i);
    });

    it("solo con Nequi elige ese metodo y no inventa Bre-B", () => {
        const result = buildPaymentInstructions(
            { ...CONFIG, brebKey: null, brebHolder: null },
            ORDER,
        );

        assert.equal(result.complete, true);
        assert.equal(result.snapshot.method, "nequi");
        assert.match(result.text, /Nequi/);
        assert.doesNotMatch(result.text, /Bre-B/);
    });

    it("solo con Bre-B elige ese metodo y no inventa Nequi", () => {
        const result = buildPaymentInstructions(
            { ...CONFIG, nequiNumber: null, nequiHolder: null },
            ORDER,
        );

        assert.equal(result.complete, true);
        assert.equal(result.snapshot.method, "bre_b");
        assert.match(result.text, /Bre-B/);
        assert.doesNotMatch(result.text, /Nequi/);
    });

    it("sin cuentas configuradas pausa y pide un asesor", () => {
        const result = buildPaymentInstructions(
            {
                nequiNumber: null,
                nequiHolder: null,
                brebKey: null,
                brebHolder: null,
                customInstructions: null,
                receiptWindowHours: 24,
            },
            ORDER,
        );

        assert.equal(result.complete, false);
        assert.equal(result.snapshot.method, null);
        assert.match(result.text, /asesor/i);
        assert.match(result.text, /reservado/i);
        assert.match(result.text, /ORD-20261027120000-ABC123/);
    });

    it("los espacios en blanco no cuentan como cuenta configurada", () => {
        const result = buildPaymentInstructions(
            { ...CONFIG, nequiNumber: "   ", brebKey: "" },
            ORDER,
        );

        assert.equal(result.complete, false);
    });

    it("agrega las instrucciones extra del negocio sin reemplazar las cuentas", () => {
        const result = buildPaymentInstructions(
            { ...CONFIG, customInstructions: "Escribe tu nombre en la descripcion." },
            ORDER,
        );

        assert.match(result.text, /Escribe tu nombre en la descripcion\./);
        assert.match(result.text, /2025550102/);
    });

    it("el snapshot guarda exactamente lo que se le dijo al cliente", () => {
        const result = buildPaymentInstructions(CONFIG, ORDER);

        assert.deepEqual(result.snapshot, {
            method: "nequi",
            nequi_number: "2025550102",
            breb_key: "sportbot@bre-b",
            reference: ORDER.paymentReference,
            total_cents: 450_000_00,
        });
    });
});

describe("buildReceiptAck", () => {
    const order = {
        id: "order-1",
        paymentReference: ORDER.paymentReference,
        totalCents: ORDER.totalCents,
    };

    it("acusa recibo y promete el resultado de la revision", () => {
        const text = buildReceiptAck(order, 1);

        assert.match(text, /Recibí tu comprobante/);
        assert.match(text, /ORD-20261027120000-ABC123/);
        assert.match(text, /\$450\.000 COP/);
        assert.match(text, /Lo estoy verificando/);
        assert.match(text, /te escribo por aquí con el resultado/i);
    });

    it("nunca confirma el pago en el acuse", () => {
        const text = buildReceiptAck(order, 1);

        assert.doesNotMatch(text, /aprobad/i);
        assert.doesNotMatch(text, /pago confirmado/i);
        assert.doesNotMatch(text, /gracias por tu pago/i);
    });

    it("en un reintento reconoce el comprobante nuevo", () => {
        const text = buildReceiptAck({ ...order, rejectionReason: "Monto distinto" }, 1);

        assert.match(text, /comprobante nuevo/i);
    });

    it("pluraliza cuando llegan varios archivos", () => {
        assert.match(buildReceiptAck(order, 3), /tus 3 comprobantes/);
    });
});

describe("buildExpiredNotice", () => {
    it("avisa que la reserva vencio sin reprochar", () => {
        const text = buildExpiredNotice(ORDER, "Usuario de prueba");

        assert.match(text, /reserva venció/i);
        assert.match(text, /ORD-20261027120000-ABC123/);
        assert.match(text, /\$450\.000 COP/);
        assert.match(text, /Usuario de prueba/);
    });

    it("no promete stock ni pago", () => {
        const text = buildExpiredNotice(ORDER, null);

        assert.doesNotMatch(text, /aprobad|confirmad|pagaste|reservado para ti/i);
        assert.match(text, /si sigue disponible/i);
    });

    it("no deja un saludo vacio cuando no hay nombre", () => {
        const text = buildExpiredNotice(ORDER, "   ");

        assert.match(text, /Hola, el pedido/);
    });
});

describe("normalizeReference", () => {
    it("ignora guiones, espacios y minusculas", () => {
        assert.equal(
            normalizeReference("ord-20261027120000-abc123"),
            "ORD20261027120000ABC123",
        );
    });

    it("devuelve vacio para nulos", () => {
        assert.equal(normalizeReference(null), "");
        assert.equal(normalizeReference(undefined), "");
    });
});

describe("extractAmountsCop", () => {
    it("lee montos con puntos y con espacios", () => {
        assert.deepEqual(extractAmountsCop("pague 450.000"), [450000]);
        assert.deepEqual(extractAmountsCop("transferi 450 000 pesos"), [450000]);
        assert.deepEqual(extractAmountsCop("$1.250.000"), [1250000]);
    });

    it("ignora tallas y cantidades pequeñas", () => {
        assert.deepEqual(extractAmountsCop("talla 42, 3 pares"), []);
    });

    it("devuelve unicos y no duplica el mismo monto", () => {
        assert.deepEqual(extractAmountsCop("450.000 ... 450000"), [450000]);
    });

    it("no explota con texto vacio", () => {
        assert.deepEqual(extractAmountsCop(""), []);
    });
});

describe("evaluateReceiptEvidence", () => {
    const base = {
        totalCents: ORDER.totalCents,
        reference: ORDER.paymentReference,
    };

    it("marca match cuando monto y referencia coinciden por vision", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: {
                amount_cop: 450000,
                reference: "ORD-20261027120000-ABC123",
                looks_like_receipt: true,
            },
        });

        assert.equal(verdict.verdict, "match");
        assert.equal(verdict.confidence, 0.95);
        assert.ok(verdict.evidence.some((item) => item.kind === "amount_in_receipt"));
        assert.ok(verdict.evidence.some((item) => item.kind === "reference_in_receipt"));
    });

    it("marca match cuando el cliente escribe monto y referencia", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: { looks_like_receipt: true },
            caption: "Pague 450.000 con la referencia ORD-20261027120000-ABC123",
        });

        assert.equal(verdict.verdict, "match");
    });

    it("marca mismatch si el comprobante muestra otro monto", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: { amount_cop: 400000, looks_like_receipt: true },
        });

        assert.equal(verdict.verdict, "mismatch");
        assert.ok(verdict.evidence.some((item) => item.kind === "amount_mismatch"));
    });

    it("marca mismatch si la imagen no parece comprobante", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: { looks_like_receipt: false },
        });

        assert.equal(verdict.verdict, "mismatch");
        assert.ok(verdict.evidence.some((item) => item.kind === "not_a_receipt"));
    });

    it("queda incierto con una sola señal", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: { amount_cop: 450000, looks_like_receipt: true },
        });

        assert.equal(verdict.verdict, "uncertain");
        assert.equal(verdict.confidence, 0.5);
    });

    it("queda incierto sin señales y aun asi trae titular y fecha", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: { holder: "Usuario de prueba Perez", date: "27/10/2026" },
        });

        assert.equal(verdict.verdict, "uncertain");
        assert.equal(verdict.confidence, 0.3);
        assert.ok(verdict.evidence.some((item) => item.kind === "holder"));
        assert.ok(verdict.evidence.some((item) => item.kind === "date"));
    });

    it("acepta un monto con un peso de diferencia por redondeo", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: { amount_cop: 450000 },
            caption: "ORD-20261027120000-ABC123",
        });

        assert.ok(verdict.evidence.some((item) => item.kind === "amount_in_receipt"));
    });

    it("no deja que el modelo convierta un monto distinto en match", () => {
        const verdict = evaluateReceiptEvidence({
            ...base,
            extracted: {
                amount_cop: 100000,
                reference: ORDER.paymentReference,
                looks_like_receipt: true,
            },
        });

        assert.equal(verdict.verdict, "mismatch");
    });
});

describe("computePaymentProgress", () => {
    it("calcula el faltante exacto de un abono parcial", () => {
        const progress = computePaymentProgress({
            totalCents: 550_000_00,
            receivedCents: 100_000_00,
        });

        assert.equal(progress.receivedCents, 100_000_00);
        assert.equal(progress.shortfallCents, 450_000_00);
        assert.equal(progress.overpaidCents, 0);
        assert.equal(progress.complete, false);
    });

    it("marca completo cuando el comprobante cubre el pedido", () => {
        const progress = computePaymentProgress({
            totalCents: 550_000_00,
            receivedCents: 550_000_00,
        });

        assert.equal(progress.shortfallCents, 0);
        assert.equal(progress.complete, true);
    });

    it("separa el excedente cuando el cliente paga de mas", () => {
        const progress = computePaymentProgress({
            totalCents: 550_000_00,
            receivedCents: 600_000_00,
        });

        assert.equal(progress.shortfallCents, 0);
        assert.equal(progress.overpaidCents, 50_000_00);
        assert.equal(progress.complete, true);
    });

    it("nunca devuelve faltantes negativos ni montos invalidos", () => {
        assert.equal(
            computePaymentProgress({ totalCents: 550_000_00, receivedCents: -1000 }).shortfallCents,
            550_000_00,
        );
        assert.equal(
            computePaymentProgress({ totalCents: 0, receivedCents: 0 }).complete,
            true,
        );
    });
});

describe("sumReceiptAmountsCents", () => {
    it("suma comprobantes distintos del mismo pedido", () => {
        const total = sumReceiptAmountsCents([
            { sha256: "a", status: "prevalidated", ai_extracted: { amount_cop: 100000 } },
            { sha256: "b", status: "prevalidated", ai_extracted: { amount_cop: 450000 } },
        ]);

        assert.equal(total, 550_000_00);
    });

    it("no cuenta dos veces la misma imagen reenviada", () => {
        const total = sumReceiptAmountsCents([
            { sha256: "misma", status: "prevalidated", ai_extracted: { amount_cop: 100000 } },
            { sha256: "misma", status: "received", ai_extracted: { amount_cop: 100000 } },
        ]);

        assert.equal(total, 100_000_00);
    });

    it("ignora comprobantes rechazados por una persona", () => {
        const total = sumReceiptAmountsCents([
            { sha256: "a", status: "rejected", ai_extracted: { amount_cop: 550000 } },
            { sha256: "b", status: "prevalidated", ai_extracted: { amount_cop: 100000 } },
        ]);

        assert.equal(total, 100_000_00);
    });

    it("ignora comprobantes sin monto legible", () => {
        const total = sumReceiptAmountsCents([
            { sha256: "a", status: "prevalidated", ai_extracted: { amount_cop: null } },
            { sha256: "b", status: "prevalidated", ai_extracted: {} },
            { sha256: "c", status: "received", ai_extracted: null },
        ]);

        assert.equal(total, 0);
    });

    it("sin comprobantes el avance es cero", () => {
        assert.equal(sumReceiptAmountsCents([]), 0);
    });
});

describe("buildShortfallNotice", () => {
    const text = buildShortfallNotice({
        order: ORDER,
        receivedCents: 100_000_00,
        shortfallCents: 350_000_00,
        windowHours: 24,
        now: new Date("2026-10-27T02:30:00.000Z"),
    });

    it("dice cuanto llego y cuanto falta", () => {
        assert.match(text, /\$100\.000 COP/);
        assert.match(text, /\$350\.000 COP/);
        assert.match(text, /\$450\.000 COP/);
        assert.match(text, /Te faltan/);
    });

    it("da el plazo real y avisa que la reserva se libera", () => {
        assert.match(text, /27 de octubre/);
        assert.match(text, /24 horas/);
        assert.match(text, /libero la reserva/i);
    });

    it("no aprueba ni promete que el pedido sigue reservado", () => {
        assert.doesNotMatch(text, /aprobad/i);
        assert.doesNotMatch(text, /pago confirmado/i);
        assert.doesNotMatch(text, /reservado para ti/i);
    });

    it("pide el saldo sin cambiar de cuenta", () => {
        assert.match(text, /misma cuenta/i);
        assert.match(text, /comprobante por aquí/i);
    });
});

describe("buildReceiptCompleteNotice", () => {
    it("avisa que el comprobante cubre el pedido sin aprobarlo", () => {
        const text = buildReceiptCompleteNotice({
            order: ORDER,
            receivedCents: 450_000_00,
        });

        assert.match(text, /cubre el valor/);
        assert.match(text, /\$450\.000 COP/);
        assert.match(text, /revisión final/i);
        assert.doesNotMatch(text, /aprobad/i);
        assert.doesNotMatch(text, /pago confirmado/i);
    });

    it("menciona el excedente cuando el cliente paga de mas", () => {
        const text = buildReceiptCompleteNotice({
            order: ORDER,
            receivedCents: 500_000_00,
        });

        assert.match(text, /excedente/);
        assert.match(text, /\$50\.000 COP/);
    });

    it("no inventa excedente cuando el monto es exacto", () => {
        const text = buildReceiptCompleteNotice({
            order: ORDER,
            receivedCents: 450_000_00,
        });

        assert.doesNotMatch(text, /excedente/);
    });
});

describe("buildReceiptUnreadableNotice", () => {
    it("no inventa faltante cuando no pudo leer el monto", () => {
        const text = buildReceiptUnreadableNotice(ORDER);

        assert.match(text, /No pude leer el monto/);
        assert.match(text, /ORD-20261027120000-ABC123/);
        assert.match(text, /Una persona lo revisa/);
        assert.doesNotMatch(text, /Te faltan/);
    });
});

describe("formatDeadline", () => {
    it("usa la hora de Colombia, no la del servidor", () => {
        const label = formatDeadline(new Date("2026-10-27T02:30:00.000Z"));

        assert.match(label, /26 de octubre/);
        assert.match(label, /9:30/);
    });
});

describe("parseCopAmount", () => {
    it("lee el monto colombiano sin convertirlo en cientos", () => {
        assert.equal(parseCopAmount("$100.000"), 100000);
        assert.equal(parseCopAmount("100.000"), 100000);
        assert.equal(parseCopAmount("4.400.000"), 4400000);
        assert.equal(parseCopAmount(100000), 100000);
    });

    it("no inventa un monto cuando no hay dato", () => {
        assert.equal(parseCopAmount(null), null);
        assert.equal(parseCopAmount(""), null);
        assert.equal(parseCopAmount("no se lee"), null);
    });
});
