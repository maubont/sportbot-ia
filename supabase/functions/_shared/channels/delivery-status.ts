/** Provider lifecycle → operator-facing status, independent of provider SDKs. */
export type EvolutionMessageDelivery = "accepted" | "delivered" | "read" | "failed" | null;

export function mapEvolutionDeliveryStatus(value: unknown): EvolutionMessageDelivery {
    const status = String(value ?? "").trim().toLowerCase();
    if (["server_ack", "2", "accepted"].includes(status)) return "accepted";
    if (["delivery_ack", "3", "delivered"].includes(status)) return "delivered";
    if (["read", "played", "4", "5"].includes(status)) return "read";
    if (["error", "0", "failed"].includes(status)) return "failed";
    return null;
}

/** Avoid late/out-of-order callbacks moving a message back to an earlier state. */
export function canAdvanceEvolutionDeliveryStatus(current: unknown, next: EvolutionMessageDelivery): boolean {
    if (!next) return false;
    const status = String(current ?? "").toLowerCase();
    if (status === next || status === "read") return false;
    if (status === "delivered") return next === "read";
    if (status === "failed") return next === "delivered" || next === "read";
    if (["sending", "unknown", "accepted", ""].includes(status)) return true;
    return false;
}
