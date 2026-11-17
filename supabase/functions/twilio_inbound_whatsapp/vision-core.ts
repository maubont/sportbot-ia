import { formatCop, parseCopAmount } from "./payments-core.ts";

/**
 * Parte pura de la modalidad de imagen: tipos, normalización y formato.
 *
 * Vive aparte de `vision.ts` para poder probarla sin red ni credenciales.
 */

export type ImageKind = "receipt" | "product" | "screenshot" | "document" | "other";

export type ImageReading = {
    kind: ImageKind;
    looks_like_receipt: boolean | null;
    description: string;
    amount_cop: number | null;
    date: string | null;
    bank: string | null;
    reference: string | null;
    holder: string | null;
};

export const IMAGE_KINDS: ImageKind[] = ["receipt", "product", "screenshot", "document", "other"];

export const MAX_IMAGE_BYTES = 4_000_000;

/** Guardas baratas antes de gastar tokens con una imagen. */
export function validateImageInput(byteLength: number, contentType: string): string | null {
    if (!String(contentType).toLowerCase().startsWith("image/")) {
        return `tipo no soportado: ${contentType}`;
    }
    if (byteLength > MAX_IMAGE_BYTES) {
        return "imagen demasiado grande";
    }
    return null;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;

    try {
        const parsed = JSON.parse(trimmed.slice(start, end + 1));
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export function toNumberOrNull(value: unknown): number | null {
    return parseCopAmount(value);
}

export function toStringOrNull(value: unknown): string | null {
    if (value == null) return null;
    const trimmed = String(value).trim();
    return trimmed && trimmed.toLowerCase() !== "null" ? trimmed.slice(0, 120) : null;
}

/** Normaliza `26/10/2026` a `2026-10-26`; si no se entiende, lo deja tal cual. */
export function normalizeDate(value: unknown): string | null {
    const raw = toStringOrNull(value);
    if (!raw) return null;

    const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
    if (dmy) {
        const day = dmy[1].padStart(2, "0");
        const month = dmy[2].padStart(2, "0");
        const year = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
        return `${year}-${month}-${day}`;
    }

    const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

    return raw;
}

export function normalizeKind(value: unknown, looksLikeReceipt: boolean | null): ImageKind {
    const raw = String(value ?? "").trim().toLowerCase();
    if (IMAGE_KINDS.includes(raw as ImageKind)) return raw as ImageKind;
    return looksLikeReceipt ? "receipt" : "other";
}

/** Convierte el JSON crudo del modelo en una lectura tipada y acotada. */
export function buildImageReading(parsed: Record<string, unknown>): ImageReading {
    const amount = toNumberOrNull(parsed.amount_cop);
    const looksLikeReceipt = typeof parsed.looks_like_receipt === "boolean"
        ? parsed.looks_like_receipt
        : null;

    return {
        kind: normalizeKind(parsed.kind, looksLikeReceipt),
        looks_like_receipt: looksLikeReceipt,
        description: toStringOrNull(parsed.description) || "El cliente envió una imagen.",
        amount_cop: amount,
        date: normalizeDate(parsed.date),
        bank: toStringOrNull(parsed.bank),
        reference: toStringOrNull(parsed.reference),
        holder: toStringOrNull(parsed.holder),
    };
}

/**
 * Línea que entra al turno del agente, igual que `[Nota de voz]: ...`.
 *
 * Para un comprobante se arma con los campos leídos (aritmética, no prosa del
 * modelo). Para el resto se usa la descripción corta.
 */
export function formatImageReadingForAgent(reading: ImageReading): string {
    if (reading.looks_like_receipt === true) {
        const parts = [
            `Comprobante de pago${reading.bank ? ` de ${reading.bank}` : ""}`,
            reading.amount_cop != null ? `por ${formatCop(reading.amount_cop * 100)} COP` : null,
            reading.date ? `del ${reading.date}` : null,
            reading.reference ? `con referencia ${reading.reference}` : null,
            reading.holder ? `titular ${reading.holder}` : null,
        ].filter(Boolean);

        return `${parts.join(", ")}.`;
    }

    return reading.description;
}

/** Resumen corto para eventos y logs (sin PII innecesaria). */
export function summarizeImageReading(reading: ImageReading) {
    return {
        kind: reading.kind,
        looks_like_receipt: reading.looks_like_receipt,
        has_amount: reading.amount_cop != null,
        bank: reading.bank,
        has_date: Boolean(reading.date),
        has_reference: Boolean(reading.reference),
    };
}
