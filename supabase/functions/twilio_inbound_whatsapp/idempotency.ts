/**
 * Clave de idempotencia para pedidos.
 *
 * Regla: una clave identifica un evento entrante, no el contenido variable del
 * carrito: cliente + conversación + ID estable del mensaje del proveedor.
 * Nunca depende del reloj.
 *
 * - Redelivery/reintentos del mismo ID de mensaje → misma clave, aunque el modelo
 *   intente variar argumentos; la RPC no puede crear un segundo pedido.
 * - Una nueva intención llega en un mensaje nuevo → clave distinta.
 */

export type OrderItemInput = {
    product_id: string;
    size: number | string;
    quantity?: number | string | null;
};

export type OrderIdentityInput = {
    customerId: string;
    conversationId: string;
    messageSid: string;
};

/** Normaliza espacios, recorta y pasa a minúsculas para comparar de forma estable. */
export function normalizeText(value: unknown): string {
    return String(value ?? "")
        .normalize("NFC")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

/**
 * Canoniza los ítems: orden estable por producto+talla, cantidades enteras y
 * tallas numéricas normalizadas (42 y "42" son la misma talla).
 */
export function canonicalizeItems(items: OrderItemInput[]): Array<{
    product_id: string;
    size: number;
    quantity: number;
}> {
    return items
        .map((item) => {
            const quantity = Math.trunc(Number(item.quantity ?? 1));
            return {
                product_id: normalizeText(item.product_id),
                size: Number(item.size),
                quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
            };
        })
        .sort(
            (a, b) =>
                a.product_id.localeCompare(b.product_id) || a.size - b.size,
        );
}

/** Cuerpo determinista que se firma. Exportado para poder auditarlo. */
export function buildKeyPayload(input: OrderIdentityInput) {
    return {
        v: 2,
        customer: normalizeText(input.customerId),
        conversation: normalizeText(input.conversationId),
        // Provider IDs are opaque and may be case-sensitive; trim but do not lowercase.
        message_sid: String(input.messageSid ?? "").trim(),
    };
}

async function sha256Hex(text: string): Promise<string> {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/** Devuelve una clave estable de 64 caracteres hexadecimales. */
export async function buildOrderIdempotencyKey(
    input: OrderIdentityInput,
): Promise<string> {
    if (!normalizeText(input.customerId) || !normalizeText(input.conversationId) || !String(input.messageSid ?? "").trim()) {
        throw new Error("INVALID_IDENTITY: customerId, conversationId y messageSid son obligatorios");
    }
    const payload = JSON.stringify(buildKeyPayload(input));
    return sha256Hex(payload);
}
