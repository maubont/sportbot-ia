/**
 * Nucleo puro del camino del dinero (sin I/O, sin Deno).
 *
 * Todo lo que decide "que se le dice al cliente" y "que tan bien pinta el
 * comprobante" vive aqui para poder probarlo con Node. Nada de este archivo
 * cambia estados ni aprueba pagos: eso solo ocurre en la RPC `approve_payment`
 * llamada por un humano.
 */

export type PaymentConfig = {
    nequiNumber: string | null;
    nequiHolder: string | null;
    brebKey: string | null;
    brebHolder: string | null;
    customInstructions: string | null;
    receiptWindowHours: number;
};

export type PaymentOrder = {
    id: string;
    paymentReference: string;
    totalCents: number;
    rejectionReason?: string | null;
};

export type PaymentInstructions = {
    text: string;
    /** true cuando hay al menos una cuenta de recaudo configurada. */
    complete: boolean;
    /** Se guarda con el evento para auditar que se le dijo al cliente. */
    snapshot: {
        method: string | null;
        nequi_number: string | null;
        breb_key: string | null;
        reference: string;
        total_cents: number;
    };
};

export type ReceiptExtraction = {
    amount_cop?: number | null;
    reference?: string | null;
    holder?: string | null;
    date?: string | null;
    bank?: string | null;
    looks_like_receipt?: boolean | null;
};

export type ReceiptEvidence = {
    kind: string;
    detail: string;
    source: "caption" | "vision";
};

export type ReceiptVerdict = {
    verdict: "match" | "mismatch" | "uncertain";
    confidence: number;
    evidence: ReceiptEvidence[];
};

/** Formatea centavos como pesos colombianos sin depender del locale del runtime. */
export function formatCop(cents: number): string {
    const pesos = Math.round(Number(cents || 0) / 100);
    const grouped = String(Math.max(pesos, 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return `$${grouped}`;
}

/**
 * Convierte el monto que devuelve el modelo a pesos enteros.
 *
 * El modelo a veces responde `100000` y a veces `$100.000`. Si se leyera a la
 * ligera, `$100.000` se convertiría en 100 pesos y el sistema diría que faltan
 * casi cuatro millones. Los puntos de miles se quitan; una coma decimal corta
 * se respeta.
 */
export function parseCopAmount(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;

    let raw = String(value).trim().replace(/[^\d.,-]/g, "");
    if (!raw) return null;

    if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) {
        raw = raw.replace(/\./g, "");
    } else if (!raw.includes(".") && /,\d{1,2}$/.test(raw)) {
        raw = raw.replace(",", ".");
    }

    raw = raw.replace(/,/g, "");
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? Math.round(numeric) : null;
}

function clean(value: string | null | undefined): string | null {
    const trimmed = String(value ?? "").trim();
    return trimmed ? trimmed : null;
}

/**
 * Mensaje de pago. Es determinista a proposito: ningun modelo escribe numeros
 * de cuenta ni montos. Si falta configuracion, lo dice y el pedido queda
 * reservado para que un humano comparta los datos.
 */
export function buildPaymentInstructions(
    config: PaymentConfig,
    order: PaymentOrder,
): PaymentInstructions {
    const reference = order.paymentReference;
    const total = formatCop(order.totalCents);
    const nequi = clean(config.nequiNumber);
    const breb = clean(config.brebKey);
    const lines: string[] = [];

    lines.push(`Pedido *${reference}* por *${total} COP*.`);

    if (nequi) {
        lines.push("");
        lines.push("Paga por *Nequi*:");
        lines.push(`Número: *${nequi}*`);
        if (clean(config.nequiHolder)) lines.push(`Titular: ${config.nequiHolder!.trim()}`);
    }

    if (breb) {
        lines.push("");
        lines.push("O por *Bre-B*:");
        lines.push(`Llave: *${breb}*`);
        if (clean(config.brebHolder)) lines.push(`Titular: ${config.brebHolder!.trim()}`);
    }

    if (!nequi && !breb) {
        lines.push("");
        lines.push("Un asesor te comparte los datos de pago por este mismo chat.");
        lines.push("Tu pedido queda reservado mientras tanto.");
    }

    const extra = clean(config.customInstructions);
    if (extra) {
        lines.push("");
        lines.push(extra);
    }

    if (nequi || breb) {
        lines.push("");
        lines.push(`Cuando pagues, envía la foto del comprobante por aquí.`);
        lines.push(
            `Una persona lo revisa contra el banco y te confirma. Usa la referencia *${reference}*.`,
        );
    }

    return {
        text: lines.join("\n"),
        complete: Boolean(nequi || breb),
        snapshot: {
            method: nequi ? "nequi" : breb ? "bre_b" : null,
            nequi_number: nequi,
            breb_key: breb,
            reference,
            total_cents: order.totalCents,
        },
    };
}

/**
 * Acuse al recibir un comprobante. Nunca dice "aprobado".
 *
 * Promete un segundo mensaje porque el filtro de monto corre en segundo plano:
 * el cliente no queda esperando sin saber si su pago alcanzo.
 */
export function buildReceiptAck(order: PaymentOrder, receiptCount: number): string {
    const files = receiptCount === 1 ? "tu comprobante" : `tus ${receiptCount} comprobantes`;
    const retry = order.rejectionReason
        ? "Recibí el comprobante nuevo. "
        : "";

    return [
        `${retry}Recibí ${files} del pedido *${order.paymentReference}* por *${formatCop(order.totalCents)} COP*.`,
        "",
        "Lo estoy verificando. En un momento te escribo por aquí con el resultado.",
    ].join("\n");
}

export type PaymentProgress = {
    receivedCents: number;
    shortfallCents: number;
    overpaidCents: number;
    complete: boolean;
};

/**
 * Cuanto lleva pagado el cliente y cuanto le falta.
 *
 * Es aritmetica pura sobre el total del pedido: el modelo solo lee el monto del
 * comprobante, nunca decide este numero.
 */
export function computePaymentProgress(params: {
    totalCents: number;
    receivedCents: number;
}): PaymentProgress {
    const total = Math.max(Math.round(Number(params.totalCents) || 0), 0);
    const received = Math.max(Math.round(Number(params.receivedCents) || 0), 0);
    const shortfall = Math.max(total - received, 0);

    return {
        receivedCents: received,
        shortfallCents: shortfall,
        overpaidCents: Math.max(received - total, 0),
        complete: shortfall === 0,
    };
}

export type ReceiptAmountRow = {
    sha256?: string | null;
    status?: string | null;
    ai_extracted?: { amount_cop?: number | null } | null;
};

/**
 * Suma los montos leidos de los comprobantes de un pedido.
 *
 * Reglas:
 * - El mismo archivo (mismo sha256) cuenta una sola vez: reenviar la misma foto
 *   no duplica el abono.
 * - Un comprobante rechazado por una persona no cuenta.
 * - Un comprobante sin monto legible no suma (tampoco resta).
 */
export function sumReceiptAmountsCents(rows: ReceiptAmountRow[]): number {
    const seen = new Set<string>();
    let total = 0;

    rows.forEach((row, index) => {
        if (row.status === "rejected") return;

        const amount = Number(row.ai_extracted?.amount_cop);
        if (!Number.isFinite(amount) || amount <= 0) return;

        const digest = String(row.sha256 ?? "").trim();
        const key = digest || `row:${index}`;
        if (seen.has(key)) return;
        seen.add(key);

        total += Math.round(amount) * 100;
    });

    return total;
}

/** Fecha limite en hora de Colombia, sin depender del locale del servidor. */
export function formatDeadline(at: Date): string {
    try {
        return new Intl.DateTimeFormat("es-CO", {
            timeZone: "America/Bogota",
            day: "numeric",
            month: "long",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
        }).format(at);
    } catch {
        return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
    }
}

/**
 * Primer filtro: el comprobante no cubre el pedido.
 *
 * Le dice al cliente el monto leido, cuanto falta y hasta cuando tiene para
 * completarlo. No acusa recibo de un pago completo y no libera nada: el barrido
 * de `ops_sweep` es el que libera si el plazo vence.
 */
export function buildShortfallNotice(params: {
    order: PaymentOrder;
    receivedCents: number;
    shortfallCents: number;
    windowHours: number;
    now?: Date;
}): string {
    const hours = Math.max(Math.round(Number(params.windowHours) || 0), 1);
    const now = params.now ?? new Date();
    const deadline = new Date(now.getTime() + hours * 3_600_000);

    return [
        `El comprobante que enviaste es por *${formatCop(params.receivedCents)} COP* y el pedido *${params.order.paymentReference}* vale *${formatCop(params.order.totalCents)} COP*.`,
        "",
        `Te faltan *${formatCop(params.shortfallCents)} COP* para completar el pago.`,
        "",
        "Transfiere el saldo a la misma cuenta y envíame el comprobante por aquí.",
        `Tienes hasta el *${formatDeadline(deadline)}* (${hours} horas) para completarlo; si no llega, libero la reserva.`,
    ].join("\n");
}

/** El comprobante cubre el pedido. Sigue en revision humana, no es una aprobacion. */
export function buildReceiptCompleteNotice(params: {
    order: PaymentOrder;
    receivedCents: number;
}): string {
    const overpaid = params.receivedCents - params.order.totalCents;

    const lines = [
        `El comprobante del pedido *${params.order.paymentReference}* es por *${formatCop(params.receivedCents)} COP* y cubre el valor de *${formatCop(params.order.totalCents)} COP*.`,
        "",
        "Queda en revisión final: una persona lo revisa contra el banco y te escribe por aquí.",
    ];

    if (overpaid > 0) {
        lines.push(`El excedente de *${formatCop(overpaid)} COP* lo revisa una persona contigo.`);
    }

    return lines.join("\n");
}

/** La vision no pudo leer el monto: no se inventa un faltante. */
export function buildReceiptUnreadableNotice(order: PaymentOrder): string {
    return [
        `No pude leer el monto del comprobante del pedido *${order.paymentReference}* automáticamente.`,
        "",
        "Una persona lo revisa a mano contra el banco y te confirma por aquí.",
    ].join("\n");
}

/**
 * Aviso cuando la reserva venció sin pago.
 *
 * No reprocha, no inventa stock y no promete nada: solo cuenta lo que pasó y
 * deja la puerta abierta. La ventana y el barrido viven en el job `ops_sweep`.
 */
export function buildExpiredNotice(
    order: PaymentOrder,
    customerName?: string | null,
): string {
    const name = customerName?.trim() || "Hola";

    return [
        "*Tu reserva venció*",
        "",
        `${name}, el pedido *${order.paymentReference}* por *${formatCop(order.totalCents)} COP* quedó sin pago y liberé la reserva.`,
        "",
        "Si aún lo quieres, escríbeme por aquí y te lo aparto otra vez si sigue disponible.",
    ].join("\n");
}

export function normalizeReference(value: string | null | undefined): string {
    return String(value ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
}

/**
 * Extrae montos en pesos de un texto libre. Devuelve enteros de pesos, no
 * centavos. Ignora cifras que parecen tallas o cantidades (menores a 1000).
 */
export function extractAmountsCop(text: string): number[] {
    const found = new Set<number>();
    // Acepta "450.000", "450 000" y "450000", pero nunca fusiona dos montos
    // separados por puntos suspensivos o texto.
    const matches = String(text ?? "").match(/\d{1,3}(?:[.\s]\d{3})+|\d{4,9}/g) ?? [];

    for (const raw of matches) {
        const digits = raw.replace(/[^\d]/g, "");
        if (!digits) continue;
        const value = Number(digits);
        if (Number.isFinite(value) && value >= 1000 && value <= 50000000) {
            found.add(value);
        }
    }

    return [...found];
}

function referencesMatch(candidate: string | null | undefined, reference: string): boolean {
    const left = normalizeReference(candidate);
    const right = normalizeReference(reference);
    if (!left || !right) return false;
    return left.includes(right) || right.includes(left);
}

function amountMatches(amountCop: number | null | undefined, totalCents: number): boolean {
    if (amountCop === null || amountCop === undefined) return false;
    const totalPesos = Math.round(totalCents / 100);
    return Math.abs(Number(amountCop) - totalPesos) <= 1;
}

/**
 * Combina lo que se ve en el comprobante con lo que el cliente escribio.
 * Devuelve un veredicto para el humano, nunca una decision.
 */
export function evaluateReceiptEvidence(params: {
    extracted?: ReceiptExtraction | null;
    caption?: string | null;
    totalCents: number;
    reference: string;
}): ReceiptVerdict {
    const extracted = params.extracted ?? {};
    const caption = params.caption ?? "";
    const evidence: ReceiptEvidence[] = [];

    const captionRef = referencesMatch(caption, params.reference);
    const visionRef = referencesMatch(extracted.reference, params.reference);
    const captionAmounts = extractAmountsCop(caption);
    const captionAmountMatch = captionAmounts.some((amount) =>
        amountMatches(amount, params.totalCents)
    );
    const visionAmountMatch = amountMatches(extracted.amount_cop, params.totalCents);
    const visionAmountPresent = extracted.amount_cop !== null && extracted.amount_cop !== undefined;

    if (captionRef) {
        evidence.push({
            kind: "reference_in_caption",
            detail: "El texto del cliente incluye la referencia del pedido.",
            source: "caption",
        });
    }

    if (visionRef) {
        evidence.push({
            kind: "reference_in_receipt",
            detail: `La referencia leida en el comprobante coincide: ${extracted.reference}.`,
            source: "vision",
        });
    }

    if (captionAmountMatch) {
        evidence.push({
            kind: "amount_in_caption",
            detail: "El texto del cliente incluye el monto exacto del pedido.",
            source: "caption",
        });
    }

    if (visionAmountMatch) {
        evidence.push({
            kind: "amount_in_receipt",
            detail: `El monto leido coincide: ${formatCop(params.totalCents)} COP.`,
            source: "vision",
        });
    }

    if (visionAmountPresent && !visionAmountMatch) {
        evidence.push({
            kind: "amount_mismatch",
            detail: `El comprobante muestra ${Number(extracted.amount_cop).toLocaleString("es-CO")} COP y el pedido vale ${Math.round(params.totalCents / 100).toLocaleString("es-CO")} COP.`,
            source: "vision",
        });

        return { verdict: "mismatch", confidence: 0.9, evidence };
    }

    if (extracted.looks_like_receipt === false) {
        evidence.push({
            kind: "not_a_receipt",
            detail: "La imagen no parece un comprobante de pago.",
            source: "vision",
        });

        return { verdict: "mismatch", confidence: 0.7, evidence };
    }

    if (extracted.holder) {
        evidence.push({
            kind: "holder",
            detail: `Titular leido: ${extracted.holder}.`,
            source: "vision",
        });
    }

    if (extracted.date) {
        evidence.push({
            kind: "date",
            detail: `Fecha leida: ${extracted.date}.`,
            source: "vision",
        });
    }

    const amountSignal = captionAmountMatch || visionAmountMatch;
    const referenceSignal = captionRef || visionRef;

    if (amountSignal && referenceSignal) {
        return { verdict: "match", confidence: 0.95, evidence };
    }

    if (amountSignal || referenceSignal) {
        return { verdict: "uncertain", confidence: 0.5, evidence };
    }

    return { verdict: "uncertain", confidence: 0.3, evidence };
}
