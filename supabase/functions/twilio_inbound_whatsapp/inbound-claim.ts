const INBOUND_CLAIM_UNAVAILABLE = "INBOUND_CLAIM_UNAVAILABLE";

export function requireInboundMessageId(value: unknown): string {
    const messageId = typeof value === "string" ? value.trim() : "";
    if (!messageId) throw new Error(INBOUND_CLAIM_UNAVAILABLE);
    return messageId;
}

export function resolveInboundClaimResult(
    data: unknown,
    error: unknown,
): "claimed" | "duplicate" {
    if (error || typeof data !== "boolean") {
        throw new Error(INBOUND_CLAIM_UNAVAILABLE);
    }
    return data ? "claimed" : "duplicate";
}
