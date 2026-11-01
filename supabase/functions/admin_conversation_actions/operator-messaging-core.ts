export type DeliveryStatus = "accepted" | "failed" | "unknown";

export function validUuid(value: unknown): value is string {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function classifyOperatorSendResult(result: {
    success: boolean;
    error?: string;
}): { status: DeliveryStatus; error: string | null } {
    if (result.success) return { status: "accepted", error: null };

    const error = String(result.error || "provider_send_failed").slice(0, 500);
    // A timeout/network break can happen after WhatsApp accepted the message.
    // Never retry automatically or tell the operator it definitely failed.
    if (/(timeout|network_error|fetch failed|provider_exception|crashed|http_5\d\d)/i.test(error)) {
        return { status: "unknown", error };
    }
    return { status: "failed", error };
}

export function validateOperatorText(value: unknown): { ok: true; text: string } | { ok: false; code: string } {
    if (typeof value !== "string") return { ok: false, code: "message_required" };
    const text = value.trim();
    if (!text) return { ok: false, code: "message_required" };
    if (text.length > 4096) return { ok: false, code: "message_too_long" };
    return { ok: true, text };
}
