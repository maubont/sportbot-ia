import { mapEvolutionDeliveryStatus } from "./channels/delivery-status.ts";

export type LogisticsSendOutcome = "sent" | "failed" | "unknown";
export type LogisticsNotificationStatus =
    | "pending" | "queued" | "sent" | "delivered" | "read"
    | "failed" | "undelivered" | "skipped" | "unknown";

/** A timeout/network break is ambiguous: the provider may have accepted it. */
export function classifyLogisticsSend(result: { success: boolean; error?: string }): {
    status: LogisticsSendOutcome;
    error: string | null;
} {
    if (result.success) return { status: "sent", error: null };
    const error = String(result.error || "provider_send_failed").slice(0, 500);
    if (/(timeout|network_error|fetch failed|provider_exception|crashed|http_5\d\d)/i.test(error)) {
        return { status: "unknown", error };
    }
    return { status: "failed", error };
}

/** Unknown/pending attempts must be reconciled before a human retries. */
export function canRetryLogisticsNotification(status: unknown): boolean {
    return status === "failed" || status === "undelivered";
}

/** Allowed status moves for one provider attempt; late callbacks cannot regress it. */
export function canAdvanceLogisticsNotificationStatus(current: unknown, next: LogisticsNotificationStatus): boolean {
    const from = String(current ?? "").trim().toLowerCase();
    if (!from || from === "pending" || from === "queued" || from === "unknown") {
        return ["sent", "delivered", "read", "failed", "undelivered", "unknown"].includes(next);
    }
    if (from === "read" || from === "skipped" || from === next) return false;
    if (from === "delivered") return next === "read";
    if (from === "failed" || from === "undelivered") return next === "delivered" || next === "read";
    if (from === "sent") return next === "delivered" || next === "read" || next === "failed" || next === "undelivered";
    return false;
}

export function logisticsStatusToMessageDeliveryStatus(status: LogisticsNotificationStatus):
    | "accepted" | "delivered" | "read" | "failed" | "unknown" {
    if (status === "sent") return "accepted";
    if (status === "delivered" || status === "read" || status === "failed" || status === "unknown") return status;
    return "unknown";
}

export function evolutionStatusToLogisticsStatus(value: unknown): LogisticsNotificationStatus | null {
    const mapped = mapEvolutionDeliveryStatus(value);
    if (mapped === "accepted") return "sent";
    if (mapped === "delivered" || mapped === "read" || mapped === "failed") return mapped;
    return null;
}
