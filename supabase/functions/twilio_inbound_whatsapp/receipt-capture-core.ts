import { buildReceiptAck, type PaymentOrder } from "./payments-core.ts";

/** Resultado real de la asociación; leer el archivo no equivale a registrarlo. */
export type ReceiptOrderLookup =
    | { kind: "selected"; order: PaymentOrder }
    | { kind: "no_pending_order" }
    | { kind: "reference_required" }
    | { kind: "reference_not_found" }
    | { kind: "invalid_reference" };

export type ReceiptCaptureResult =
    | Exclude<ReceiptOrderLookup, { kind: "selected" }>
    | { kind: "failed" }
    | { kind: "captured"; order: PaymentOrder; receiptIds: string[]; missingCount: number };

/** Solo ORD-* escrito por el cliente identifica el pedido, no la referencia bancaria. */
export function parseOrderReference(caption: string):
    | { kind: "absent" }
    | { kind: "invalid" }
    | { kind: "valid"; reference: string } {
    const text = String(caption ?? "");
    const matches = Array.from(text.matchAll(/\bORD(?=[\s:\-\d]|$)(?:\s*[-:]\s*[A-Z0-9]+(?:\s*-\s*[A-Z0-9]+)*)?/gi));
    if (matches.some((match) => /[-A-Z0-9]/i.test(text[(match.index ?? 0) + match[0].length] ?? ""))) {
        return { kind: "invalid" };
    }
    const candidates = matches.map((match) => match[0].replace(/\s+/g, "").toUpperCase());
    if (candidates.length === 0) return { kind: "absent" };
    if (candidates.some((candidate) => !/^ORD-\d{14}-[A-F0-9]{6}$/.test(candidate))) {
        return { kind: "invalid" };
    }
    const distinct = [...new Set(candidates)];
    return distinct.length === 1
        ? { kind: "valid", reference: distinct[0] }
        : { kind: "invalid" };
}

/** Orquesta consultas e inserciones inyectadas para probar también los fallos. */
export async function captureReceipts<T>(params: {
    media: T[];
    maxReceipts: number;
    findOrder: () => Promise<ReceiptOrderLookup>;
    saveReceipt: (order: PaymentOrder, media: T) => Promise<string | null>;
    onError?: (error: unknown) => void;
}): Promise<ReceiptCaptureResult> {
    if (params.media.length === 0) return { kind: "failed" };

    let lookup: ReceiptOrderLookup;
    try {
        lookup = await params.findOrder();
    } catch (error) {
        params.onError?.(error);
        return { kind: "failed" };
    }
    if (lookup.kind !== "selected") return lookup;
    const order = lookup.order;

    const receiptIds: string[] = [];
    for (const media of params.media.slice(0, params.maxReceipts)) {
        try {
            const id = await params.saveReceipt(order, media);
            if (id) receiptIds.push(id);
        } catch (error) {
            params.onError?.(error);
        }
    }

    if (receiptIds.length === 0) return { kind: "failed" };
    return { kind: "captured", order, receiptIds, missingCount: params.media.length - receiptIds.length };
}

/** Nunca promete revisión cuando no se pudo registrar o asociar el archivo. */
export function receiptCaptureReply(result: ReceiptCaptureResult, mediaFailures = 0, observedReceipt?: string | null): string {
    if (result.kind === "no_pending_order") {
        const observation = observedReceipt ? `La lectura de la imagen indica: ${observedReceipt}\n\n` : "";
        const failure = mediaFailures > 0 ? "Además, no pude procesar todos los archivos. " : "";
        return `${observation}${failure}No encontré un pedido pendiente de pago para asociar el archivo. Si es un comprobante, compárteme la referencia del pedido (ORD-...) para orientarte.`;
    }
    if (result.kind === "reference_required" || result.kind === "reference_not_found" || result.kind === "invalid_reference") {
        const reason = result.kind === "reference_required"
            ? "Tienes más de un pedido pendiente y no sé a cuál corresponde el archivo."
            : result.kind === "reference_not_found"
            ? "No encontré un pedido pendiente a tu nombre con esa referencia."
            : "No pude identificar una referencia de pedido única y completa.";
        const observation = observedReceipt ? `La lectura de la imagen indica: ${observedReceipt}\n\n` : "";
        const failure = mediaFailures > 0 ? " Además, no pude procesar todos los archivos." : "";
        return `${observation}${reason} No lo asocié a ningún pedido.${failure} Por favor, vuelve a enviar el comprobante con una sola referencia ORD-* completa en el pie de foto.`;
    }
    if (result.kind === "failed") {
        return "No pude registrar el archivo para revisión. Por favor, vuelve a enviarlo; si son varios, envíalos por separado. Indica la referencia del pedido (ORD-...). No he confirmado ningún pago.";
    }
    const reply = buildReceiptAck(result.order, result.receiptIds.length);
    if (result.missingCount + mediaFailures > 0) {
        return `${reply}\n\nNo pude registrar todos los archivos. Por favor, envía de nuevo los que faltan.`;
    }
    return reply;
}

/**
 * Una misma imagen enviada a dos pedidos distintos es la señal más clara de un
 * comprobante reutilizado. La consulta es inyectable para poder probar los
 * fallos: un error de lectura nunca acusa al cliente.
 */
export async function detectReceiptReuse(params: {
    receipt: { order_id: unknown; sha256: unknown };
    /** Devuelve las filas cuyo sha256 coincide en otro pedido (vacío = sin reutilización). */
    query: (sha256: string, orderId: string) => Promise<Array<unknown> | null>;
    onError?: (error: unknown) => void;
}): Promise<boolean> {
    const digest = String(params.receipt.sha256 ?? "").trim();
    const orderId = String(params.receipt.order_id ?? "").trim();
    if (!digest || !orderId) return false;

    try {
        const rows = await params.query(digest, orderId);
        return Boolean(Array.isArray(rows) && rows.length > 0);
    } catch (error) {
        params.onError?.(error);
        return false;
    }
}
