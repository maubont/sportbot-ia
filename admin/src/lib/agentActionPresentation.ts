export type AgentActionStatus = "suggested" | "pending_approval" | "approved" | "rejected" | "executed" | "failed" | "cancelled";

export function actionStateExplanation(status: AgentActionStatus, actionType: string): string {
    if (status === "executed") return actionType === "resolve_active_context"
        ? "Contexto interno fijado; no envía mensajes, cobra ni despacha."
        : "Ejecución registrada. Revisa la pantalla operativa para confirmar el resultado.";
    if (status === "approved") return "Aprobada por un humano; todavía no ejecutada. Realiza el paso en su pantalla operativa.";
    if (status === "failed") return "La ejecución falló; verifica el resultado antes de volver a intentar.";
    if (status === "rejected" || status === "cancelled") return "Cerrada sin ejecutar.";
    return "Solo propuesta. No se enviaron mensajes ni se cambió el pedido.";
}

export function agentActionStageLabel(status: AgentActionStatus): string {
    const labels: Record<AgentActionStatus, string> = {
        suggested: "Propuesta",
        pending_approval: "Pendiente de aprobación",
        approved: "Aprobada · sin ejecutar",
        rejected: "Rechazada",
        executed: "Ejecutada",
        failed: "Falló",
        cancelled: "Cancelada",
    };

    return labels[status];
}

export function actionEffectSummary(
    status: AgentActionStatus,
    executionResult?: Record<string, unknown> | null,
): string {
    if (status === "executed") {
        const effect = executionResult?.customer_facing_effect;
        if (effect === "none") return "Ejecutada internamente: no cambió nada visible para el cliente.";
        return "Ejecutada: revisa el resultado en la pantalla operativa.";
    }
    if (status === "approved") return "Ninguno todavía: aprobada pero no ejecutada.";
    if (status === "failed") return "Ninguno confirmado: la ejecución falló.";
    if (status === "rejected" || status === "cancelled") return "Ninguno: cerrada sin ejecutar.";
    return "Ninguno: es solo una propuesta.";
}

export function actionExecutorLink(type: string): { to: string; label: string } | null {
    if (type === "dispatch_review" || type === "notification_retry_review" || type === "ops_action_plan") {
        return { to: "/logistics", label: "Abrir logística" };
    }
    if (type === "margin_data_review") return { to: "/orders", label: "Abrir pedidos" };
    if (type === "inventory_alert_review") return { to: "/inventory", label: "Abrir inventario" };
    if (type === "commercial_follow_up" || type === "draft_customer_reply") return { to: "/inbox", label: "Abrir Inbox" };
    if (type === "daily_ops_summary") return { to: "/", label: "Abrir tablero" };
    return null;
}
