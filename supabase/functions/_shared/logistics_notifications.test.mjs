import test from "node:test";
import assert from "node:assert/strict";
import {
    canAdvanceLogisticsNotificationStatus,
    canRetryLogisticsNotification,
    classifyLogisticsSend,
    evolutionStatusToLogisticsStatus,
    logisticsStatusToMessageDeliveryStatus,
} from "./logistics_notifications_core.ts";

test("a provider acceptance is sent but not yet delivered", () => {
    assert.deepEqual(classifyLogisticsSend({ success: true }), { status: "sent", error: null });
    assert.equal(evolutionStatusToLogisticsStatus("server_ack"), "sent");
});

test("timeout/network/5xx stay uncertain so they are never auto-retried", () => {
    for (const error of ["evolution_timeout", "evolution_network_error:reset", "evolution_http_503:busy"]) {
        const outcome = classifyLogisticsSend({ success: false, error });
        assert.equal(outcome.status, "unknown", error);
        assert.equal(canRetryLogisticsNotification(outcome.status), false);
    }
});

test("definitive provider rejection can be retried explicitly", () => {
    const outcome = classifyLogisticsSend({ success: false, error: "evolution_http_400:invalid number" });
    assert.equal(outcome.status, "failed");
    assert.equal(canRetryLogisticsNotification(outcome.status), true);
    assert.equal(canRetryLogisticsNotification("undelivered"), true);
});

test("Evolution statuses update logistics trace with delivery and read receipts", () => {
    assert.equal(evolutionStatusToLogisticsStatus("server_ack"), "sent");
    assert.equal(evolutionStatusToLogisticsStatus("delivery_ack"), "delivered");
    assert.equal(evolutionStatusToLogisticsStatus("read"), "read");
    assert.equal(evolutionStatusToLogisticsStatus("error"), "failed");
    assert.equal(evolutionStatusToLogisticsStatus("pending"), null);
});

test("logistics status transitions are monotonic under late/out-of-order responses", () => {
    assert.equal(canAdvanceLogisticsNotificationStatus("pending", "sent"), true);
    assert.equal(canAdvanceLogisticsNotificationStatus("sent", "delivered"), true);
    assert.equal(canAdvanceLogisticsNotificationStatus("delivered", "read"), true);
    assert.equal(canAdvanceLogisticsNotificationStatus("read", "sent"), false);
    assert.equal(canAdvanceLogisticsNotificationStatus("delivered", "unknown"), false);
    assert.equal(canAdvanceLogisticsNotificationStatus("failed", "sent"), false);
    assert.equal(canAdvanceLogisticsNotificationStatus("failed", "read"), true);
});

test("logistics states map to the messages delivery contract", () => {
    assert.equal(logisticsStatusToMessageDeliveryStatus("sent"), "accepted");
    assert.equal(logisticsStatusToMessageDeliveryStatus("delivered"), "delivered");
    assert.equal(logisticsStatusToMessageDeliveryStatus("read"), "read");
    assert.equal(logisticsStatusToMessageDeliveryStatus("unknown"), "unknown");
});
