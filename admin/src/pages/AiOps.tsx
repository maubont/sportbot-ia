import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
    Bot,
    CheckCircle2,
    ChevronDown,
    ClipboardCheck,
    FileCheck2,
    Link2,
    LockKeyhole,
    LineChart,
    ListChecks,
    MessageSquareText,
    Package,
    Send,
    ShieldCheck,
    Sparkles,
    Truck,
    XCircle,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { actionEffectSummary, actionExecutorLink, actionStateExplanation, agentActionStageLabel, type AgentActionStatus } from "../lib/agentActionPresentation";

type DashboardSnapshot = {
    generated_at?: string;
    executive?: {
        revenue_cents?: number;
        contribution_margin_cents?: number;
        contribution_margin_bps?: number;
        paid_orders_count?: number;
    };
    logistics?: {
        paid_pending_dispatch_count?: number;
        paid_over_sla_count?: number;
        active_shipments_count?: number;
        missing_tracking_count?: number;
        failed_notification_count?: number;
    };
    finance?: {
        missing_cogs_order_count?: number;
        missing_shipping_real_cost_order_count?: number;
        negative_margin_order_count?: number;
    };
    inventory?: {
        low_stock_variants_count?: number;
        sold_out_variants_count?: number;
    };
    queues?: {
        paid_to_dispatch?: PaidToDispatchItem[];
        inventory_alerts?: InventoryAlertItem[];
        data_quality_alerts?: DataQualityAlertItem[];
    };
    agent_context?: {
        mode?: string;
        top_priorities?: PriorityItem[];
    };
};

type LogisticsSnapshot = {
    generated_at?: string;
    summary?: {
        paid_pending_dispatch_count?: number;
        paid_over_sla_count?: number;
        active_shipments_count?: number;
        shipped_over_sla_count?: number;
        missing_tracking_count?: number;
        failed_notification_count?: number;
    };
    timing?: {
        payment_to_dispatch_p50_hours?: number;
        payment_to_dispatch_p90_hours?: number;
        dispatch_to_delivery_p50_hours?: number;
        dispatch_to_delivery_p90_hours?: number;
    };
    queues?: {
        paid_to_dispatch?: PaidToDispatchItem[];
        active_shipments?: ActiveShipmentItem[];
        failed_notifications?: FailedNotificationItem[];
    };
    agent_context?: {
        mode?: string;
        recommended_focus?: string;
        allowed_actions?: string[];
    };
};

type PaidToDispatchItem = {
    order_id: string;
    customer_name?: string | null;
    shipping_city?: string | null;
    total_cents?: number;
    hours_waiting?: number;
    over_sla?: boolean;
};

type ActiveShipmentItem = {
    shipment_id: string;
    order_id: string;
    customer_name?: string | null;
    carrier_name?: string | null;
    tracking_number?: string | null;
    hours_in_transit?: number;
    over_sla?: boolean;
    missing_tracking?: boolean;
};

type FailedNotificationItem = {
    notification_id: string;
    order_id: string;
    purpose?: string;
    status?: string;
    error_message?: string | null;
};

type InventoryAlertItem = {
    variant_id: string;
    brand?: string | null;
    model?: string | null;
    size?: number | string | null;
    available?: number;
};

type DataQualityAlertItem = {
    order_id: string;
    flags?: string[];
    total_cents?: number;
};

type PriorityItem = {
    key: string;
    count?: number;
    severity?: string;
};

type AgentAction = {
    id: string;
    channel: string;
    action_type: string;
    target_type?: string | null;
    target_id?: string | null;
    target_ref?: string | null;
    status: AgentActionStatus;
    risk_level: RiskLevel;
    summary: string;
    evidence?: unknown[];
    input_context?: Record<string, unknown>;
    proposed_payload?: Record<string, unknown>;
    approval_required: boolean;
    created_at: string;
    approved_at?: string | null;
    executed_at?: string | null;
    execution_result?: Record<string, unknown> | null;
    error_message?: string | null;
};

type StorefrontConversationEvent = {
    id: string;
    event_type: string;
    intent?: string | null;
    funnel_stage?: string | null;
    product_id?: string | null;
    size_requested?: number | null;
    direction?: string | null;
    actor_type: string;
    source: string;
    metadata?: Record<string, unknown> | null;
    occurred_at: string;
    created_at: string;
};

type IdentityBridgeSnapshot = {
    generated_at?: string;
    summary?: {
        total_count?: number;
        linked_count?: number;
        active_pending_count?: number;
        unresolved_count?: number;
        opened_whatsapp_count?: number;
    };
    handoffs?: StorefrontHandoffEvidence[];
    agent_context?: {
        mode?: string;
        recommended_focus?: string;
        guardrails?: string[];
    };
};

type StorefrontHandoffEvidence = {
    id?: string | null;
    handoff_id?: string | null;
    handoff_code?: string | null;
    status?: string | null;
    identity_status?: string | null;
    review_flag?: string | null;
    storefront_session_id?: string | null;
    source_surface?: string | null;
    product_brand?: string | null;
    product_model?: string | null;
    size_requested?: string | number | null;
    intent?: string | null;
    funnel_stage?: string | null;
    observed_product?: {
        brand?: string | null;
        model?: string | null;
        display_name?: string | null;
        size_requested?: string | number | null;
        intent?: string | null;
        funnel_stage?: string | null;
    } | null;
    linked_customer_id?: string | null;
    linked_customer_name?: string | null;
    linked_phone_e164?: string | null;
    linked_conversation_id?: string | null;
    linked_message_id?: string | null;
    created_at?: string | null;
    linked_at?: string | null;
    expires_at?: string | null;
    metadata?: Record<string, unknown> | null;
};

type RiskLevel = "low" | "medium" | "high" | "critical";

type Proposal = {
    id: string;
    label: string;
    prompt: string;
    actionType: string;
    targetType?: string;
    targetId?: string;
    targetRef?: string;
    riskLevel: RiskLevel;
    summary: string;
    response: string;
    evidence: Array<Record<string, unknown>>;
    inputContext?: Record<string, unknown>;
    proposedPayload: Record<string, unknown>;
    approvalRequired: boolean;
    icon: ReactNode;
};

type StorefrontOpportunity = {
    sessionId: string;
    sessionRef: string;
    product: string;
    size: string;
    funnelStage: string;
    intent: string;
    eventType: string;
    source: string;
    surface: string;
    lastEventAt: string;
    eventCount: number;
    score: number;
    hasHandoff: boolean;
    hasStockValidated: boolean;
    hasReadyToOrder: boolean;
};

function describeSupabaseError(label: string, error: unknown) {
    if (!error || typeof error !== "object") return label;

    const candidate = error as { message?: string; code?: string };
    const message = candidate.message ? `: ${candidate.message}` : "";
    const code = candidate.code ? ` (${candidate.code})` : "";

    return `${label}${message}${code}`;
}

const COMMANDS = [
    "resumen operativo",
    "oportunidad storefront",
    "puente storefront",
    "logistica atrasada",
    "margen y calidad",
    "notificaciones fallidas",
    "inventario critico",
    "acciones del dia",
];

async function loadStorefrontHandoffEvidence(from: Date, to: Date): Promise<{ data: IdentityBridgeSnapshot | null; error: unknown | null }> {
    const rpcResult = await supabase.rpc("admin_storefront_handoff_evidence", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_timezone: "America/Bogota",
        p_limit: 50,
    });

    if (!rpcResult.error) {
        return { data: (rpcResult.data || null) as IdentityBridgeSnapshot | null, error: null };
    }

    console.warn("Falling back to storefront_handoffs table read:", rpcResult.error);

    const tableResult = await supabase
        .from("storefront_handoffs")
        .select("id, handoff_code, status, storefront_session_id, source_surface, product_brand, product_model, size_requested, intent, funnel_stage, linked_customer_id, linked_conversation_id, linked_message_id, created_at, linked_at, expires_at, metadata")
        .gte("created_at", from.toISOString())
        .lt("created_at", to.toISOString())
        .order("created_at", { ascending: false })
        .limit(50);

    if (tableResult.error) {
        return { data: null, error: tableResult.error };
    }

    return {
        data: buildIdentityBridgeSnapshotFromRows((tableResult.data || []) as StorefrontHandoffEvidence[]),
        error: null,
    };
}

function buildIdentityBridgeSnapshotFromRows(rows: StorefrontHandoffEvidence[]): IdentityBridgeSnapshot {
    const now = Date.now();
    const linked = rows.filter((row) => row.status === "linked").length;
    const activePending = rows.filter((row) =>
        ["created", "opened_whatsapp"].includes(row.status || "") &&
        (!row.expires_at || Date.parse(row.expires_at) >= now)
    ).length;
    const unresolved = rows.filter((row) =>
        ["expired", "unresolved"].includes(row.status || "") ||
        (["created", "opened_whatsapp"].includes(row.status || "") && Boolean(row.expires_at) && Date.parse(row.expires_at || "") < now)
    ).length;
    const openedWhatsapp = rows.filter((row) => row.status === "opened_whatsapp").length;

    return {
        generated_at: new Date().toISOString(),
        summary: {
            total_count: rows.length,
            linked_count: linked,
            active_pending_count: activePending,
            unresolved_count: unresolved,
            opened_whatsapp_count: openedWhatsapp,
        },
        handoffs: rows.map((row) => ({
            ...row,
            handoff_id: row.handoff_id || row.id,
            identity_status: handoffIdentityStatus(row),
            review_flag: unresolvedHandoff(row) ? "needs_review" : null,
            observed_product: {
                brand: row.product_brand || null,
                model: row.product_model || null,
                display_name: storefrontHandoffProductLabel(row),
                size_requested: row.size_requested || null,
                intent: row.intent || null,
                funnel_stage: row.funnel_stage || null,
            },
        })),
        agent_context: {
            mode: "suggest_only",
            recommended_focus: unresolved > 0
                ? "review_unresolved_storefront_handoffs"
                : activePending > 0
                  ? "monitor_pending_storefront_handoffs"
                  : "monitor",
            guardrails: [
                "handoff_code_is_correlation_not_authentication",
                "do_not_merge_customer_360_without_whatsapp_identity",
                "do_not_create_order_payment_or_dispatch_from_handoff_only",
            ],
        },
    };
}

export default function AiOps() {
    const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
    const [logistics, setLogistics] = useState<LogisticsSnapshot | null>(null);
    const [actions, setActions] = useState<AgentAction[]>([]);
    const [storefrontEvents, setStorefrontEvents] = useState<StorefrontConversationEvent[]>([]);
    const [identityBridge, setIdentityBridge] = useState<IdentityBridgeSnapshot | null>(null);
    const [selectedProposalId, setSelectedProposalId] = useState("daily-summary");
    const [command, setCommand] = useState(COMMANDS[0]);
    const [loading, setLoading] = useState(true);
    const [isCreating, setIsCreating] = useState(false);
    const [reviewingActionId, setReviewingActionId] = useState<string | null>(null);
    const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const fetchSnapshots = useCallback(async () => {
        const to = new Date();
        const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

        try {
            const [dashboardResult, logisticsResult, actionsResult, storefrontEventsResult, identityBridgeResult] = await Promise.all([
                supabase.rpc("admin_dashboard_snapshot", {
                    p_from: from.toISOString(),
                    p_to: to.toISOString(),
                    p_timezone: "America/Bogota",
                    p_fulfillment_sla_hours: 24,
                }),
                supabase.rpc("admin_logistics_operations_snapshot", {
                    p_from: from.toISOString(),
                    p_to: to.toISOString(),
                    p_timezone: "America/Bogota",
                }),
                supabase
                    .from("agent_actions")
                    .select("id, channel, action_type, target_type, target_id, target_ref, status, risk_level, summary, evidence, input_context, proposed_payload, approval_required, created_at, approved_at, executed_at, execution_result, error_message")
                    .order("created_at", { ascending: false })
                    .limit(20),
                supabase
                    .from("conversation_events")
                    .select("id, event_type, intent, funnel_stage, product_id, size_requested, direction, actor_type, source, metadata, occurred_at, created_at")
                    .eq("channel", "storefront_webchat")
                    .order("occurred_at", { ascending: false })
                    .limit(30),
                loadStorefrontHandoffEvidence(from, to),
            ]);

            const loadErrors = [
                dashboardResult.error ? describeSupabaseError("dashboard", dashboardResult.error) : null,
                logisticsResult.error ? describeSupabaseError("logística", logisticsResult.error) : null,
                actionsResult.error ? describeSupabaseError("acciones", actionsResult.error) : null,
                storefrontEventsResult.error ? describeSupabaseError("eventos storefront", storefrontEventsResult.error) : null,
                identityBridgeResult.error ? describeSupabaseError("puente storefront", identityBridgeResult.error) : null,
            ].filter(Boolean);

            if (dashboardResult.error) {
                console.error("AI Ops dashboard snapshot error:", dashboardResult.error);
                setDashboard(null);
            } else {
                setDashboard((dashboardResult.data || null) as DashboardSnapshot | null);
            }

            if (logisticsResult.error) {
                console.error("AI Ops logistics snapshot error:", logisticsResult.error);
                setLogistics(null);
            } else {
                setLogistics((logisticsResult.data || null) as LogisticsSnapshot | null);
            }

            if (actionsResult.error) {
                console.error("AI Ops actions load error:", actionsResult.error);
                setActions([]);
            } else {
                setActions(((actionsResult.data || []) as AgentAction[]) || []);
            }

            if (storefrontEventsResult.error) {
                console.error("AI Ops storefront events load error:", storefrontEventsResult.error);
                setStorefrontEvents([]);
            } else {
                setStorefrontEvents(((storefrontEventsResult.data || []) as StorefrontConversationEvent[]) || []);
            }

            if (identityBridgeResult.error) {
                console.error("AI Ops storefront handoff evidence load error:", identityBridgeResult.error);
                setIdentityBridge(null);
            } else {
                setIdentityBridge(identityBridgeResult.data);
            }

            setError(
                loadErrors.length
                    ? `AI Ops cargó parcialmente. Revisa: ${loadErrors.join(", ")}.`
                    : null
            );
        } catch (fetchError) {
            console.error("Error loading AI Ops:", fetchError);
            setError("No se pudo cargar AI Ops.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        setLoading(true);
        fetchSnapshots();
    }, [fetchSnapshots]);

    const proposals = useMemo(
        () => buildProposals(dashboard, logistics, storefrontEvents, identityBridge),
        [dashboard, logistics, storefrontEvents, identityBridge]
    );
    const storefrontSummary = useMemo(
        () => summarizeStorefrontEvents(storefrontEvents, identityBridge),
        [storefrontEvents, identityBridge]
    );

    useEffect(() => {
        const normalized = command.toLowerCase();
        const match = proposals.find((proposal) =>
            proposal.label.toLowerCase().includes(normalized) ||
            proposal.prompt.toLowerCase().includes(normalized) ||
            proposal.actionType.toLowerCase().includes(normalized)
        );

        if (match) {
            setSelectedProposalId(match.id);
        }
    }, [command, proposals]);

    const selectedProposal = proposals.find((proposal) => proposal.id === selectedProposalId) || proposals[0];
    const pendingActions = actions.filter((action) => ["suggested", "pending_approval", "approved"].includes(action.status));
    const activeExpandedActionId = expandedActionId ?? actions[0]?.id ?? null;

    async function createAgentAction(proposal: Proposal) {
        setIsCreating(true);
        setError(null);
        setSuccess(null);

        try {
            const { data, error: rpcError } = await supabase.rpc("create_agent_action", {
                p_agent_name: "openclaw",
                p_channel: "admin",
                p_action_type: proposal.actionType,
                p_target_type: proposal.targetType || null,
                p_target_id: proposal.targetId || null,
                p_target_ref: proposal.targetRef || null,
                p_risk_level: proposal.riskLevel,
                p_summary: proposal.summary,
                p_evidence: proposal.evidence,
                p_input_context: {
                    source: "admin_ai_ops",
                    command,
                    generated_at: new Date().toISOString(),
                    ...(proposal.inputContext || {}),
                },
                p_proposed_payload: proposal.proposedPayload,
                p_approval_required: proposal.approvalRequired,
                p_expires_at: null,
            });

            if (rpcError) throw rpcError;

            setSuccess(`Propuesta creada: ${String(data).slice(0, 8)}... Pendiente de aprobación; no se ejecutó nada.`);
            setExpandedActionId(String(data));
            await fetchSnapshots();
        } catch (createError) {
            console.error("Error creating agent action:", createError);
            setError(createError instanceof Error ? createError.message : "No se pudo crear la acción.");
        } finally {
            setIsCreating(false);
        }
    }

    async function reviewAction(actionId: string, decision: "approved" | "rejected") {
        const action = actions.find((item) => item.id === actionId) || null;

        setReviewingActionId(actionId);
        setError(null);
        setSuccess(null);

        try {
            const { error: rpcError } = await supabase.rpc("review_agent_action", {
                p_action_id: actionId,
                p_decision: decision,
                p_review_note: decision === "approved" ? "Aprobado desde AI Ops Admin." : "Rechazado desde AI Ops Admin.",
            });

            if (rpcError) throw rpcError;

            if (decision === "approved" && action?.action_type === "resolve_active_context") {
                await applyApprovedContextResolution(actionId, action);
                setSuccess("Contexto activo fijado. La acción quedó ejecutada como estado interno auditado.");
            } else {
                setSuccess(decision === "approved" ? "Propuesta aprobada. Aún no se ejecutó; ve a la pantalla operativa para realizar el paso." : "Propuesta rechazada. No se ejecutó nada.");
            }

            await fetchSnapshots();
        } catch (reviewError) {
            console.error("Error reviewing agent action:", reviewError);
            await fetchSnapshots();
            setError(`${reviewError instanceof Error ? reviewError.message : "No se pudo revisar la acción."} Verifica el estado antes de intentar de nuevo.`);
        } finally {
            setReviewingActionId(null);
        }
    }

    if (loading) {
        return <div className="p-10 text-center text-sm text-slate-500">Cargando AI Ops...</div>;
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                    <div className="flex items-center gap-3">
                        <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg bg-cyan-50 text-cyan-700 ring-1 ring-cyan-100">
                            <Bot className="h-5 w-5" />
                        </span>
                        <div>
                            <h1 className="text-3xl font-bold tracking-tight">AI Ops</h1>
                            <p className="mt-1 text-sm text-slate-500">Copiloto interno suggest-only sobre snapshots canónicos</p>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone="emerald">suggest-only</StatusPill>
                    <StatusPill tone="slate">{pendingActions.length} acciones abiertas</StatusPill>
                    <button
                        type="button"
                        onClick={fetchSnapshots}
                        className="rounded-md border bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                        Actualizar
                    </button>
                </div>
            </div>

            {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                </div>
            )}
            {success && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
                    {success}
                </div>
            )}

            <div className="grid gap-4 xl:grid-cols-[1fr_0.9fr]">
                <section className="rounded-lg border bg-white shadow-sm">
                    <div className="border-b px-5 py-4">
                        <div className="flex items-center gap-2">
                            <Sparkles className="h-4 w-4 text-cyan-700" />
                            <h2 className="text-sm font-semibold text-slate-950">Command Palette</h2>
                        </div>
                        <div className="mt-4">
                            <input
                                type="text"
                                value={command}
                                onChange={(event) => setCommand(event.target.value)}
                                placeholder="Ej: resumen operativo, logística atrasada, margen..."
                                className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm outline-none ring-cyan-200 transition focus:ring-4"
                            />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {COMMANDS.map((item) => (
                                <button
                                    key={item}
                                    type="button"
                                    onClick={() => setCommand(item)}
                                    className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                                >
                                    {item}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="p-5">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                            <div className="flex items-start gap-3">
                                <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-cyan-50 text-cyan-700">
                                    {selectedProposal.icon}
                                </span>
                                <div>
                                    <h3 className="text-lg font-semibold text-slate-950">{selectedProposal.label}</h3>
                                    <p className="mt-1 text-sm text-slate-500">{selectedProposal.prompt}</p>
                                </div>
                            </div>
                            <StatusPill tone={riskTone(selectedProposal.riskLevel)}>
                                {riskLabel(selectedProposal.riskLevel)}
                            </StatusPill>
                        </div>

                        <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                            <p className="whitespace-pre-line text-sm leading-6 text-slate-700">
                                {selectedProposal.response}
                            </p>
                        </div>

                        <div className="mt-5 grid gap-3 md:grid-cols-3">
                            <EvidenceCard label="Snapshot" value={dashboard?.generated_at ? "Dashboard" : "Pendiente"} />
                            <EvidenceCard label="Logística" value={logistics?.generated_at ? "Operations" : "Pendiente"} />
                            <EvidenceCard label="Acción" value={humanizeActionType(selectedProposal.actionType)} />
                        </div>

                        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                            <div className="flex items-start gap-2">
                                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                                <p className="text-sm text-amber-800">
                                    Crear esta acción solo la deja pendiente en auditoría. No despacha, no cobra, no cambia stock y no envía mensajes.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => createAgentAction(selectedProposal)}
                                disabled={isCreating}
                                className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <Send className="h-4 w-4" />
                                {isCreating ? "Creando..." : "Crear propuesta"}
                            </button>
                        </div>
                    </div>
                </section>

                <section className="rounded-lg border bg-white shadow-sm">
                    <div className="flex items-center justify-between border-b px-5 py-4">
                        <div className="flex items-center gap-2">
                            <ListChecks className="h-4 w-4 text-slate-500" />
                            <h2 className="text-sm font-semibold text-slate-950">Propuestas y ejecuciones</h2>
                        </div>
                        <StatusPill tone="slate">{actions.length}</StatusPill>
                    </div>
                    <div className="border-b bg-slate-50 px-5 py-3 text-xs leading-5 text-slate-600">
                        <strong className="text-slate-800">Cómo leer esta lista:</strong> 1) una propuesta no ejecuta nada;
                        2) tú la apruebas o rechazas; 3) la ejecución ocurre en su pantalla operativa (logística,
                        pedidos o inventario). Solo el estado <strong className="text-slate-800">Ejecutada</strong> indica
                        que algo cambió.
                    </div>
                    <div className="divide-y">
                        {actions.map((action) => (
                            <AgentActionCard
                                key={action.id}
                                action={action}
                                isExpanded={activeExpandedActionId === action.id}
                                reviewingActionId={reviewingActionId}
                                onReview={reviewAction}
                                onToggleAudit={() => setExpandedActionId(activeExpandedActionId === action.id ? "" : action.id)}
                            />
                        ))}
                        {actions.length === 0 && (
                            <div className="p-8 text-center text-sm text-slate-500">
                                Aún no hay acciones creadas.
                            </div>
                        )}
                    </div>
                </section>
            </div>

            <section className="rounded-lg border bg-white shadow-sm">
                <div className="flex flex-col gap-3 border-b px-5 py-4 md:flex-row md:items-center md:justify-between">
                    <div className="flex items-center gap-2">
                        <MessageSquareText className="h-4 w-4 text-cyan-700" />
                        <div>
                            <h2 className="text-sm font-semibold text-slate-950">Telemetría Storefront</h2>
                            <p className="mt-1 text-xs text-slate-500">
                                Eventos `storefront_webchat` recibidos por Conversation OS.
                            </p>
                        </div>
                    </div>
                    <StatusPill tone={storefrontEvents.length ? "emerald" : "slate"}>
                        {storefrontEvents.length} eventos recientes
                    </StatusPill>
                </div>

                <div className="grid gap-3 border-b bg-slate-50 p-5 md:grid-cols-5">
                    <EvidenceCard label="Sesiones" value={String(storefrontSummary.sessions)} />
                    <EvidenceCard label="WEB-*" value={String(storefrontSummary.handoffs)} />
                    <EvidenceCard label="Enlazados" value={String(storefrontSummary.linkedHandoffs)} />
                    <EvidenceCard label="No resueltos" value={String(storefrontSummary.unresolvedHandoffs)} />
                    <EvidenceCard label="Interés compra" value={String(storefrontSummary.buyIntent)} />
                </div>

                {storefrontSummary.opportunities.length ? (
                    <div className="border-b p-5">
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                            <div>
                                <h3 className="text-sm font-semibold text-slate-950">Oportunidades accionables</h3>
                                <p className="mt-1 text-xs leading-5 text-slate-500">
                                    Sesiones web con señales de compra. Se revisan como anónimas hasta que WhatsApp, orden o pago confirmen identidad.
                                </p>
                            </div>
                            <StatusPill tone="amber">no fusionar sin identidad</StatusPill>
                        </div>
                        <div className="mt-4 grid gap-3 lg:grid-cols-3">
                            {storefrontSummary.opportunities.slice(0, 3).map((opportunity) => (
                                <div key={opportunity.sessionId} className="rounded-lg border bg-white p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold text-slate-950">
                                                {opportunity.product || "Producto por confirmar"}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {opportunity.size ? `Talla ${opportunity.size}` : "Sin talla"} · {formatEventType(opportunity.funnelStage || opportunity.intent || opportunity.eventType)}
                                            </p>
                                        </div>
                                        <StatusPill tone={opportunity.hasReadyToOrder || opportunity.hasHandoff ? "amber" : "slate"}>
                                            {opportunity.sessionRef}
                                        </StatusPill>
                                    </div>
                                    <p className="mt-3 text-xs leading-5 text-slate-600">
                                        {opportunity.eventCount} evento(s), último {formatDateTime(opportunity.lastEventAt)}. Siguiente paso: revisar handoff o capturar identidad.
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                {storefrontSummary.identityBridge?.handoffs?.length ? (
                    <div className="border-b p-5">
                        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                            <div>
                                <h3 className="text-sm font-semibold text-slate-950">Evidencia de puente WEB-*</h3>
                                <p className="mt-1 text-xs leading-5 text-slate-500">
                                    Correlación storefront→WhatsApp. El código no autentica ni autoriza acciones operativas.
                                </p>
                            </div>
                            <StatusPill tone={storefrontSummary.unresolvedHandoffs > 0 ? "amber" : "emerald"}>
                                {storefrontSummary.unresolvedHandoffs > 0 ? "revisar no resueltos" : "evidencia trazable"}
                            </StatusPill>
                        </div>
                        <div className="mt-4 grid gap-3 lg:grid-cols-3">
                            {storefrontSummary.identityBridge.handoffs.slice(0, 3).map((handoff) => (
                                <div key={handoff.handoff_id || handoff.id || handoff.handoff_code || handoff.created_at} className="rounded-lg border bg-white p-3">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold text-slate-950">
                                                {handoff.handoff_code || "WEB-*"}
                                            </p>
                                            <p className="mt-1 text-xs text-slate-500">
                                                {storefrontHandoffProductLabel(handoff) || "Sin producto"}{handoffSizeLabel(handoff) ? ` · talla ${handoffSizeLabel(handoff)}` : ""}
                                            </p>
                                        </div>
                                        <StatusPill tone={handoff.status === "linked" ? "emerald" : unresolvedHandoff(handoff) ? "amber" : "slate"}>
                                            {humanizeHandoffStatus(handoff.status)}
                                        </StatusPill>
                                    </div>
                                    <p className="mt-3 text-xs leading-5 text-slate-600">
                                        {handoff.identity_status || handoffIdentityStatus(handoff)} · {handoff.linked_at ? `enlazado ${formatDateTime(handoff.linked_at)}` : `creado ${formatDateTime(handoff.created_at)}`}.
                                    </p>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : null}

                <div className="divide-y">
                    {storefrontEvents.map((event) => (
                        <div key={event.id} className="grid gap-3 p-4 lg:grid-cols-[1fr_0.8fr_auto] lg:items-center">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                    <StatusPill tone="slate">{formatEventType(event.event_type)}</StatusPill>
                                    {event.intent ? <StatusPill tone="emerald">{formatEventType(event.intent)}</StatusPill> : null}
                                    {event.funnel_stage ? <StatusPill tone="amber">{formatEventType(event.funnel_stage)}</StatusPill> : null}
                                </div>
                                <p className="mt-2 text-sm font-semibold text-slate-950">
                                    {eventLabel(event)}
                                </p>
                                <p className="mt-1 text-xs text-slate-500">
                                    {event.source} · {event.actor_type} · {event.direction || "internal"}
                                </p>
                            </div>
                            <div className="min-w-0 text-sm text-slate-600">
                                {metadataLine(event)}
                            </div>
                            <p className="text-xs text-slate-500 lg:text-right">{formatDateTime(event.occurred_at)}</p>
                        </div>
                    ))}
                    {storefrontEvents.length === 0 && (
                        <div className="p-8 text-center text-sm text-slate-500">
                            Aún no hay eventos recientes del storefront. Prueba el asesor web o un CTA de WhatsApp y actualiza.
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}

async function applyApprovedContextResolution(actionId: string, action: AgentAction) {
    const rpcArgs = buildActiveContextResolutionRpcArgs(actionId, action);

    if (!rpcArgs) {
        const message = "No se pudo construir la resolución: faltan conversación o contexto activo.";
        await markAgentActionExecutionFailed(actionId, message);
        throw new Error(message);
    }

    const { data, error: resolveError } = await supabase.rpc("resolve_conversation_active_context", rpcArgs);

    if (resolveError) {
        const message = describeSupabaseError("No se pudo fijar el contexto activo", resolveError);
        await markAgentActionExecutionFailed(actionId, message);
        throw resolveError;
    }

    const resolution = recordValue(data);
    const { error: executionError } = await supabase.rpc("record_agent_action_execution", {
        p_action_id: actionId,
        p_status: "executed",
        p_execution_result: {
            internal_state: "conversation_context_resolution",
            resolution_id: stringValue(resolution.id),
            active_context: stringValue(resolution.active_context) || rpcArgs.p_active_context,
            persisted_at: new Date().toISOString(),
            customer_facing_effect: "none",
            guardrails: rpcArgs.p_guardrails,
        },
        p_error_message: null,
    });

    if (executionError) {
        throw executionError;
    }
}

async function markAgentActionExecutionFailed(actionId: string, message: string) {
    const { error } = await supabase.rpc("record_agent_action_execution", {
        p_action_id: actionId,
        p_status: "failed",
        p_execution_result: {
            internal_state: "conversation_context_resolution",
            failed_at: new Date().toISOString(),
        },
        p_error_message: message,
    });

    if (error) {
        console.error("Error marking context resolution action as failed:", error);
    }
}

function buildActiveContextResolutionRpcArgs(actionId: string, action: AgentAction) {
    const context = recordValue(action.input_context);
    const payload = recordValue(action.proposed_payload);
    const decision = recordValue(context.active_context_decision);
    const dispatchContext = recordValue(decision.dispatch_context);
    const storefrontContext = recordValue(decision.storefront_context);
    const orderContext = recordValue(context.order);
    const productContext = recordValue(context.product);
    const customerContext = recordValue(context.customer);
    const conversationContext = recordValue(context.conversation);

    const selectedContext = stringValue(decision.selected_context) || stringValue(payload.selected_context);
    const conversationId =
        stringValue(payload.conversation_id) ||
        stringValue(conversationContext.id) ||
        stringValue(action.target_id);

    if (!selectedContext || !conversationId) return null;

    const dispatchOrderId = stringValue(dispatchContext.order_id) || stringValue(orderContext.id);
    const dispatchPaymentReference = stringValue(dispatchContext.payment_reference) || stringValue(orderContext.reference);
    const dispatchProductName =
        stringValue(payload.dispatch_product_name) ||
        stringValue(dispatchContext.product_name) ||
        stringValue(orderContext.product_name);
    const dispatchSize =
        stringValue(payload.dispatch_size) ||
        stringValue(dispatchContext.size) ||
        stringValue(orderContext.size);
    const storefrontHandoffCode = stringValue(payload.handoff_code) || stringValue(storefrontContext.handoff_code);
    const storefrontProductName =
        stringValue(payload.storefront_product_name) ||
        stringValue(storefrontContext.product_name) ||
        stringValue(productContext.name);
    const storefrontSize =
        stringValue(payload.storefront_size) ||
        stringValue(storefrontContext.size) ||
        stringValue(productContext.size);

    return {
        p_conversation_id: conversationId,
        p_active_context: selectedContext,
        p_source_action_id: actionId,
        p_resolution_reason: stringValue(payload.next_operator_step) || action.summary,
        p_customer_id: stringValue(payload.customer_id) || stringValue(customerContext.id) || null,
        p_dispatch_order_id: dispatchOrderId || null,
        p_dispatch_payment_reference: dispatchPaymentReference || null,
        p_dispatch_product_name: dispatchProductName || null,
        p_dispatch_size: dispatchSize || null,
        p_storefront_handoff_code: storefrontHandoffCode || null,
        p_storefront_product_name: storefrontProductName || null,
        p_storefront_size: storefrontSize || null,
        p_guardrails: {
            source: "ai_ops_admin",
            mode: "internal_state_only",
            no_auto_send: true,
            no_customer_message: true,
            no_stock_mutation: true,
            no_payment_or_dispatch_execution: true,
            requires_operator_confirmation: true,
            source_action_id: actionId,
            approved_from: "ai_ops",
        },
        p_evidence: {
            action_summary: action.summary,
            selected_context: selectedContext,
            customer_name: stringValue(payload.customer_name) || stringValue(customerContext.name),
            dispatch_context: {
                order_id: dispatchOrderId || null,
                payment_reference: dispatchPaymentReference || null,
                product_name: dispatchProductName || null,
                size: dispatchSize || null,
                payment_status: stringValue(dispatchContext.payment_status) || stringValue(orderContext.status) || null,
                fulfillment_status: stringValue(dispatchContext.fulfillment_status) || null,
                paid_over_sla: dispatchContext.paid_over_sla ?? null,
            },
            storefront_context: {
                handoff_code: storefrontHandoffCode || null,
                product_name: storefrontProductName || null,
                size: storefrontSize || null,
                funnel_stage: stringValue(storefrontContext.funnel_stage) || null,
                intent: stringValue(storefrontContext.intent) || null,
            },
            product_snapshot: {
                name: stringValue(productContext.name) || null,
                size: stringValue(productContext.size) || null,
                context_source: stringValue(productContext.context_source) || null,
            },
        },
    };
}

type AgentActionCardProps = {
    action: AgentAction;
    isExpanded: boolean;
    reviewingActionId: string | null;
    onToggleAudit: () => void;
    onReview: (actionId: string, decision: "approved" | "rejected") => void;
};

function AgentActionCard({
    action,
    isExpanded,
    reviewingActionId,
    onToggleAudit,
    onReview,
}: AgentActionCardProps) {
    const isReviewable = action.status === "pending_approval" || action.status === "suggested";
    const executor = actionExecutorLink(action.action_type);

    return (
        <div className="p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={statusTone(action.status)}>
                            {statusLabel(action.status)}
                        </StatusPill>
                        <StatusPill tone={riskTone(action.risk_level)}>
                            {riskLabel(action.risk_level)}
                        </StatusPill>
                    </div>
                    <p className="mt-2 text-sm font-semibold text-slate-950">{action.summary}</p>
                    <p className="mt-1 text-xs text-slate-500">
                        {humanizeActionType(action.action_type)} · {formatDateTime(action.created_at)}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{actionStateExplanation(action.status, action.action_type)}</p>
                    {action.error_message && <p role="alert" className="mt-2 text-xs font-medium text-red-700">Error: {action.error_message}</p>}
                    {executor && (
                        <Link to={executor.to} className="mt-2 inline-block text-xs font-semibold text-cyan-700 hover:underline">
                            {executor.label} →
                        </Link>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onToggleAudit}
                    aria-expanded={isExpanded}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                    <ClipboardCheck className="h-3.5 w-3.5" />
                    Auditoría
                    <ChevronDown className={`h-3.5 w-3.5 transition ${isExpanded ? "rotate-180" : ""}`} />
                </button>
            </div>

            {isExpanded ? <ActionAuditPanel action={action} /> : null}

            {isReviewable ? (
                <div className="mt-3 flex gap-2">
                    <button
                        type="button"
                        disabled={reviewingActionId === action.id}
                        onClick={() => onReview(action.id, "approved")}
                        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-60"
                    >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {action.action_type === "resolve_active_context" ? "Aprobar y fijar contexto" : "Aprobar"}
                    </button>
                    <button
                        type="button"
                        disabled={reviewingActionId === action.id}
                        onClick={() => onReview(action.id, "rejected")}
                        className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-60"
                    >
                        <XCircle className="h-3.5 w-3.5" />
                        Rechazar
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function ActionAuditPanel({ action }: { action: AgentAction }) {
    const context = recordValue(action.input_context);
    const payload = recordValue(action.proposed_payload);
    const contextGuardrails = recordValue(context.guardrails);
    const conversation = recordValue(context.conversation);
    const customer = recordValue(context.customer);
    const commercial = recordValue(context.commercial);
    const product = recordValue(context.product);
    const order = recordValue(context.order);
    const fulfillment = recordValue(context.fulfillment);
    const evidence = Array.isArray(action.evidence) ? action.evidence : [];
    const recentMessages = arrayValue(conversation.recent_messages);
    const productSourceLabel = humanizeContextSource(stringValue(product.context_source));
    const orderSourceLabel = humanizeContextSource(stringValue(order.context_source));
    const productOrderSeparation = actionProductOrderSeparationCheck(product, order);
    const auditMessages = buildAuditMessages(conversation, recentMessages);
    const checks = [
        ...actionGuardrailChecks(action, payload, context, contextGuardrails),
        actionContextCoherenceCheck(product, recentMessages, conversation),
        productOrderSeparation,
    ];

    return (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-start gap-2">
                <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white text-cyan-700 ring-1 ring-slate-200">
                    <LockKeyhole className="h-4 w-4" />
                </span>
                <div>
                    <p className="text-sm font-semibold text-slate-950">Auditoría previa</p>
                    <p className="mt-1 text-xs leading-5 text-slate-600">
                        Revisa alcance, datos usados y límites antes de aprobar. Esta vista no ejecuta cambios.
                    </p>
                </div>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {checks.map((check) => (
                    <div key={check.label} className="rounded-md border bg-white px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-slate-700">{check.label}</span>
                            <StatusPill tone={check.ok ? "emerald" : "amber"}>{check.ok ? "OK" : "Revisar"}</StatusPill>
                        </div>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{check.detail}</p>
                    </div>
                ))}
            </div>

            <div className="mt-3 rounded-md border bg-white px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-700">Qué ocurrió realmente</span>
                    <StatusPill tone={statusTone(action.status)}>{agentActionStageLabel(action.status)}</StatusPill>
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-600">{actionStateExplanation(action.status, action.action_type)}</p>
                <p className="mt-1 text-xs font-medium leading-5 text-slate-700">Efecto: {actionEffectSummary(action.status, action.execution_result)}</p>
                {action.executed_at && <p className="mt-1 text-xs text-slate-500">Ejecutada: {formatDateTime(action.executed_at)}</p>}
                {action.error_message && <p role="alert" className="mt-1 text-xs font-medium text-red-700">Error: {action.error_message}</p>}
            </div>

            <div className="mt-3 grid gap-3 xl:grid-cols-3">
                <AuditSection
                    icon={<MessageSquareText className="h-4 w-4" />}
                    title="Conversacion"
                    subtitle="Cliente y canal que originan la accion."
                >
                    <AuditFact label="Cliente" value={stringValue(customer.name) || "-"} />
                    <AuditFact label="Canal" value={action.channel || stringValue(conversation.channel) || "-"} />
                </AuditSection>

                <AuditSection
                    icon={<Package className="h-4 w-4" />}
                    title="Decision comercial"
                    subtitle="Producto, talla y respuesta sugerida para el hilo actual."
                    source={productSourceLabel}
                >
                    <AuditFact label="Producto" value={stringValue(product.name) || "-"} />
                    <AuditFact label="Talla / stock" value={formatSizeStock(product)} />
                    <AuditFact label="Etapa comercial" value={stringValue(commercial.stage) || "-"} />
                    <AuditFact label="Accion sugerida" value={stringValue(payload.action) || humanizeActionType(action.action_type)} />
                </AuditSection>

                <AuditSection
                    icon={<Truck className="h-4 w-4" />}
                    title="Contexto logistico"
                    subtitle="Pedido, pago y despacho visibles para operar sin mezclar decisiones."
                    source={orderSourceLabel}
                    warning={!productOrderSeparation.ok ? productOrderSeparation.detail : undefined}
                >
                    <AuditFact label="Pedido" value={stringValue(order.reference) || shortId(stringValue(order.id))} />
                    <AuditFact label="Pago / logistica" value={formatPaymentFulfillment(order, fulfillment)} />
                </AuditSection>
            </div>

            {auditMessages.length ? (
                <div className="mt-3 rounded-md border bg-white p-3">
                    <p className="text-xs font-semibold uppercase text-slate-500">Últimos mensajes usados</p>
                    <div className="mt-2 max-h-36 space-y-2 overflow-y-auto pr-1">
                        {auditMessages.map((message, index) => {
                            const item = recordValue(message);
                            const label = stringValue(item.audit_label) || stringValue(item.direction) || stringValue(item.role) || "mensaje";
                            return (
                                <div key={`${stringValue(item.created_at)}-${index}`} className="rounded-md bg-slate-50 px-2 py-1.5">
                                    <p className="text-[11px] font-semibold uppercase text-slate-500">
                                        {label} · {formatDateTime(stringValue(item.created_at))}
                                    </p>
                                    <p className="mt-1 text-xs leading-5 text-slate-700">{stringValue(item.preview) || "-"}</p>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            <div className="mt-3 grid gap-2 md:grid-cols-2">
                <details className="rounded-md border bg-white p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-500">Evidencia</summary>
                    <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                        {safeJson({ evidence })}
                    </pre>
                </details>
                <details className="rounded-md border bg-white p-3">
                    <summary className="cursor-pointer text-xs font-semibold uppercase text-slate-500">Payload saneado</summary>
                    <pre className="mt-2 max-h-44 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-[11px] leading-5 text-slate-100">
                        {safeJson({ input_context: context, proposed_payload: payload })}
                    </pre>
                </details>
            </div>
        </div>
    );
}

function AuditFact({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-md border bg-white px-3 py-2">
            <p className="text-[11px] font-semibold uppercase text-slate-500">{label}</p>
            <p className="mt-1 break-words text-xs font-semibold text-slate-800">{value || "-"}</p>
        </div>
    );
}

function AuditSection({
    icon,
    title,
    subtitle,
    source,
    warning,
    children,
}: {
    icon: ReactNode;
    title: string;
    subtitle: string;
    source?: string;
    warning?: string;
    children: ReactNode;
}) {
    const visibleSource = source && source !== "-" ? source : "";

    return (
        <section className={`rounded-lg border bg-white p-3 ${warning ? "border-amber-200 bg-amber-50/40" : "border-slate-200"}`}>
            <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-start gap-2">
                    <span className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md ring-1 ${warning ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-slate-50 text-cyan-700 ring-slate-200"}`}>
                        {icon}
                    </span>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-950">{title}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-500">{subtitle}</p>
                    </div>
                </div>
                {visibleSource ? <StatusPill tone={warning ? "amber" : "slate"}>{visibleSource}</StatusPill> : null}
            </div>

            {warning ? (
                <p className="mt-3 rounded-md border border-amber-200 bg-white px-3 py-2 text-xs leading-5 text-amber-800">
                    {warning}
                </p>
            ) : null}

            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                {children}
            </div>
        </section>
    );
}

function actionGuardrailChecks(
    action: AgentAction,
    payload: Record<string, unknown>,
    context: Record<string, unknown>,
    contextGuardrails: Record<string, unknown>
) {
    const mode = stringValue(payload.mode) || stringValue(context.mode);
    const sendMode = stringValue(payload.send_mode);
    const payloadAction = stringValue(payload.action);
    const noAutoSend =
        booleanValue(payload.no_auto_send) ||
        booleanValue(payload.no_customer_message) ||
        booleanValue(contextGuardrails.no_auto_send) ||
        sendMode === "operator_manual_send";
    const manualReview =
        action.approval_required ||
        booleanValue(payload.manual_review_required) ||
        booleanValue(payload.requires_operator_copy_or_send) ||
        booleanValue(contextGuardrails.operator_approval_required);
    const noDirectExecution =
        booleanValue(contextGuardrails.no_payment_or_dispatch_execution) ||
        booleanValue(payload.no_payment_or_dispatch_execution) ||
        Boolean(stringValue(payload.safe_next_step)) ||
        payloadAction.includes("review") ||
        payloadAction.includes("prepare") ||
        payloadAction.includes("assign") ||
        payloadAction.includes("prioritize") ||
        payloadAction.includes("resolve");

    return [
        {
            label: "Modo sugerencia",
            ok: mode === "suggest_only",
            detail: mode ? `Modo registrado: ${mode}.` : "No se encontró modo explícito en contexto/payload.",
        },
        {
            label: "Aprobación humana",
            ok: manualReview,
            detail: manualReview ? "Requiere revisión del operador antes de avanzar." : "No declara revisión humana obligatoria.",
        },
        {
            label: "Sin envío automático",
            ok: noAutoSend,
            detail: noAutoSend ? "No envía mensajes al cliente desde AI Ops." : "No declara bloqueo explícito de auto-envío.",
        },
        {
            label: "Sin ejecución directa",
            ok: noDirectExecution,
            detail: noDirectExecution ? "No cobra, despacha ni cambia stock desde esta acción." : "Revisar si el payload propone ejecución operativa.",
        },
    ];
}

function actionContextCoherenceCheck(
    product: Record<string, unknown>,
    recentMessages: unknown[],
    conversation: Record<string, unknown>
) {
    const productName = stringValue(product.name);
    const savedThreadCoherence = recordValue(product.thread_coherence);
    const savedReason = stringValue(savedThreadCoherence.reason);
    const savedOk = typeof savedThreadCoherence.ok === "boolean" ? savedThreadCoherence.ok : null;
    const recentText = recentMessages
        .map((message) => stringValue(recordValue(message).preview))
        .concat(stringValue(conversation.last_message_preview))
        .filter(Boolean)
        .map((message) => message.toLowerCase())
        .join(" ");
    const productTokens = productName
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4 && !["black", "white", "light", "infrared"].includes(token));
    const matchedToken = [...productTokens].sort((left, right) => right.length - left.length).find((token) => recentText.includes(token));
    const ok = !productName || !recentText || Boolean(matchedToken) || savedOk === true;

    return {
        label: "Coherencia producto/hilo",
        ok,
        detail: ok
            ? matchedToken
                ? `El hilo reciente menciona "${matchedToken}" del producto activo.`
                : "No hay producto activo o mensajes recientes suficientes para contrastar."
            : savedReason || "El producto activo no aparece en los últimos mensajes; validar antes de aprobar o responder.",
    };
}

function buildAuditMessages(conversation: Record<string, unknown>, recentMessages: unknown[]) {
    const messages = recentMessages.map((message) => recordValue(message));
    const lastPreview = stringValue(conversation.last_message_preview);
    const lastMessageAt = stringValue(conversation.last_message_at);
    const alreadyShown = Boolean(lastPreview) && messages.some((message) => stringValue(message.preview) === lastPreview);

    if (!lastPreview || alreadyShown) return messages;

    return [
        {
            audit_label: "ultimo mensaje snapshot",
            direction: "snapshot",
            preview: lastPreview,
            created_at: lastMessageAt,
        },
        ...messages,
    ];
}

function actionProductOrderSeparationCheck(product: Record<string, unknown>, order: Record<string, unknown>) {
    const productName = stringValue(product.name);
    const orderReference = stringValue(order.reference) || shortId(stringValue(order.id));
    const productSource = stringValue(product.context_source);
    const orderSource = stringValue(order.context_source);

    if (!productName || !orderReference) {
        return {
            label: "Separacion producto/pedido",
            ok: true,
            detail: "No hay producto y pedido simultaneos para contrastar.",
        };
    }

    const productFromRecentIntent = ["recent_message_match", "conversation_event", "conversation_size_only"].includes(productSource);
    const orderFromSameThread = ["conversation_order", "conversation_payment_reference"].includes(orderSource);
    const ok = !productFromRecentIntent || orderFromSameThread;

    return {
        label: "Separacion producto/pedido",
        ok,
        detail: ok
            ? `Producto (${humanizeContextSource(productSource)}) y pedido (${humanizeContextSource(orderSource)}) no muestran conflicto operativo.`
            : `Producto viene de ${humanizeContextSource(productSource)} y pedido de ${humanizeContextSource(orderSource)}; tratar el pedido como contexto logistico separado, no como prueba de compra del producto actual.`,
    };
}

function formatSizeStock(product: Record<string, unknown>) {
    const size = stringValue(product.size);
    const available = product.available_units;
    const availableText = typeof available === "number" ? `${available} disponibles` : "";
    return [size ? `Talla ${size}` : "", availableText].filter(Boolean).join(" · ") || "-";
}

function formatPaymentFulfillment(order: Record<string, unknown>, fulfillment: Record<string, unknown>) {
    const orderStatus = stringValue(order.status);
    const total = typeof order.total_cents === "number" ? formatCents(order.total_cents) : "";
    const fulfillmentStatus = stringValue(fulfillment.status);
    const overSla = booleanValue(fulfillment.paid_over_sla) ? "SLA vencido" : "";

    return [orderStatus, total, fulfillmentStatus, overSla].filter(Boolean).join(" · ") || "-";
}

function humanizeContextSource(source: string) {
    const labels: Record<string, string> = {
        recent_message_match: "Mensaje reciente",
        conversation_event: "Evento de conversacion",
        conversation_size_only: "Talla reciente",
        conversation_order: "Orden del hilo",
        conversation_payment_reference: "Referencia de pago del hilo",
        conversation_product_match: "Producto coincidente",
        customer_fallback: "Historial del cliente",
        inferred_from_recent_messages: "Inferido del hilo",
        direct: "Directo",
        order_linked: "Orden vinculada",
    };

    if (!source) return "-";
    return labels[source] || source.replace(/_/g, " ");
}

function recordValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
}

function arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    return "";
}

function booleanValue(value: unknown): boolean {
    return value === true || value === "true";
}

const SENSITIVE_AUDIT_KEY = /(authorization|bearer|password|secret|service_role|token|api[_-]?key|auth[_-]?token)/i;

function safeJson(value: unknown) {
    try {
        return JSON.stringify(sanitizeAuditValue(value), null, 2);
    } catch {
        return JSON.stringify({ error: "No se pudo serializar la evidencia." }, null, 2);
    }
}

function sanitizeAuditValue(value: unknown, key = ""): unknown {
    if (SENSITIVE_AUDIT_KEY.test(key)) return "[redacted]";
    if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
            entryKey,
            sanitizeAuditValue(entryValue, entryKey),
        ])
    );
}

function buildProposals(
    dashboard: DashboardSnapshot | null,
    logistics: LogisticsSnapshot | null,
    storefrontEvents: StorefrontConversationEvent[] = [],
    identityBridge: IdentityBridgeSnapshot | null = null
): Proposal[] {
    const executive = dashboard?.executive || {};
    const dashLogistics = dashboard?.logistics || {};
    const finance = dashboard?.finance || {};
    const inventory = dashboard?.inventory || {};
    const queues = dashboard?.queues || {};
    const ops = logistics?.summary || {};
    const opsQueues = logistics?.queues || {};
    const timing = logistics?.timing || {};

    const firstDispatch = queues.paid_to_dispatch?.[0] || opsQueues.paid_to_dispatch?.[0];
    const failedNotification = opsQueues.failed_notifications?.[0];
    const inventoryAlert = queues.inventory_alerts?.[0];
    const dataQuality = queues.data_quality_alerts?.[0];
    const storefrontProposal = buildStorefrontProposal(storefrontEvents);
    const identityBridgeProposal = buildIdentityBridgeProposal(identityBridge);

    const dailySummary = [
        `Ventas aprobadas: ${formatCents(executive.revenue_cents)} en ${num(executive.paid_orders_count)} pedidos.`,
        `Margen contribución: ${formatCents(executive.contribution_margin_cents)} (${formatBps(executive.contribution_margin_bps)}).`,
        `Logística: ${num(dashLogistics.paid_pending_dispatch_count)} pagadas por despachar, ${num(dashLogistics.paid_over_sla_count)} fuera de SLA.`,
        `Calidad financiera: ${num(finance.missing_cogs_order_count)} órdenes sin costo y ${num(finance.negative_margin_order_count)} con margen negativo.`,
        "Sugerencia: crear una acción del día para revisar prioridades antes de ejecutar cambios.",
    ].join("\n");

    return [
        {
            id: "daily-summary",
            label: "Resumen operativo",
            prompt: "OpenClaw, dame el resumen de hoy y qué debo resolver primero.",
            actionType: "daily_ops_summary",
            targetType: "operations",
            riskLevel: "medium",
            summary: `Resumen AI Ops: ${num(dashLogistics.paid_pending_dispatch_count)} por despachar, ${num(finance.missing_cogs_order_count)} costos faltantes.`,
            response: dailySummary,
            evidence: [
                { source: "admin_dashboard_snapshot", metric: "revenue_cents", value: executive.revenue_cents },
                { source: "admin_dashboard_snapshot", metric: "paid_pending_dispatch_count", value: dashLogistics.paid_pending_dispatch_count },
                { source: "admin_dashboard_snapshot", metric: "missing_cogs_order_count", value: finance.missing_cogs_order_count },
            ],
            proposedPayload: {
                recommended_focus: dashboard?.agent_context?.top_priorities || [],
                mode: "suggest_only",
            },
            approvalRequired: true,
            icon: <Sparkles className="h-4 w-4" />,
        },
        ...(storefrontProposal ? [storefrontProposal] : []),
        ...(identityBridgeProposal ? [identityBridgeProposal] : []),
        {
            id: "dispatch-review",
            label: "Logística atrasada",
            prompt: "OpenClaw, dime qué pedidos pagados debo mirar primero.",
            actionType: "dispatch_review",
            targetType: "order",
            targetId: firstDispatch?.order_id,
            targetRef: firstDispatch ? shortId(firstDispatch.order_id) : undefined,
            riskLevel: num(ops.paid_over_sla_count) > 0 ? "high" : "medium",
            summary: firstDispatch
                ? `Revisar despacho de ${shortId(firstDispatch.order_id)}: ${num(firstDispatch.hours_waiting)}h esperando.`
                : "No hay pedidos pagados pendientes de despacho.",
            response: firstDispatch
                ? [
                    `Primer pedido sugerido: ${shortId(firstDispatch.order_id)}.`,
                    `Cliente: ${firstDispatch.customer_name || "sin nombre"} · Ciudad: ${firstDispatch.shipping_city || "sin ciudad"}.`,
                    `Tiempo esperando: ${num(firstDispatch.hours_waiting)}h.`,
                    `P50 pago→despacho: ${num(timing.payment_to_dispatch_p50_hours)}h · P90: ${num(timing.payment_to_dispatch_p90_hours)}h.`,
                    "Acción segura: crear revisión de despacho. No se marca como enviado desde AI Ops.",
                ].join("\n")
                : "La cola de pagadas por despachar está vacía. Mantener monitoreo.",
            evidence: [
                { source: "admin_logistics_operations_snapshot", metric: "paid_over_sla_count", value: ops.paid_over_sla_count },
                { source: "admin_logistics_operations_snapshot", queue: "paid_to_dispatch", first_order_id: firstDispatch?.order_id },
            ],
            proposedPayload: {
                order_id: firstDispatch?.order_id,
                safe_next_step: "review_dispatch_in_orders",
            },
            approvalRequired: true,
            icon: <Truck className="h-4 w-4" />,
        },
        {
            id: "margin-quality",
            label: "Margen y calidad",
            prompt: "OpenClaw, explícame si el margen es confiable.",
            actionType: "margin_data_review",
            targetType: dataQuality ? "order" : "finance",
            targetId: dataQuality?.order_id,
            targetRef: dataQuality ? shortId(dataQuality.order_id) : undefined,
            riskLevel: num(finance.negative_margin_order_count) > 0 ? "high" : "medium",
            summary: `Revisar margen: ${num(finance.missing_cogs_order_count)} sin costo, ${num(finance.negative_margin_order_count)} con margen negativo.`,
            response: [
                `Margen contribución reportado: ${formatCents(executive.contribution_margin_cents)} (${formatBps(executive.contribution_margin_bps)}).`,
                `Calidad: ${num(finance.missing_cogs_order_count)} órdenes sin costo producto, ${num(finance.missing_shipping_real_cost_order_count)} sin costo real de envío.`,
                `Riesgo: tomar decisiones por ventas brutas si el margen está incompleto.`,
                dataQuality ? `Primera orden a revisar: ${shortId(dataQuality.order_id)} (${(dataQuality.flags || []).join(", ")}).` : "No hay alerta puntual de calidad en la cola.",
            ].join("\n"),
            evidence: [
                { source: "admin_dashboard_snapshot", metric: "contribution_margin_cents", value: executive.contribution_margin_cents },
                { source: "admin_dashboard_snapshot", metric: "missing_cogs_order_count", value: finance.missing_cogs_order_count },
                { source: "admin_dashboard_snapshot", queue: "data_quality_alerts", first_order_id: dataQuality?.order_id },
            ],
            proposedPayload: {
                order_id: dataQuality?.order_id,
                flags: dataQuality?.flags || [],
                safe_next_step: "complete_cost_data",
            },
            approvalRequired: true,
            icon: <LineChart className="h-4 w-4" />,
        },
        {
            id: "notification-retry",
            label: "Notificaciones fallidas",
            prompt: "OpenClaw, dime si hay mensajes logísticos fallidos.",
            actionType: "notification_retry_review",
            targetType: failedNotification ? "logistics_notification" : "logistics",
            targetId: failedNotification?.notification_id,
            targetRef: failedNotification ? shortId(failedNotification.order_id) : undefined,
            riskLevel: num(ops.failed_notification_count) > 0 ? "high" : "low",
            summary: `${num(ops.failed_notification_count)} notificaciones logísticas fallidas para revisar.`,
            response: failedNotification
                ? [
                    `Hay ${num(ops.failed_notification_count)} notificaciones fallidas.`,
                    `Primera: orden ${shortId(failedNotification.order_id)} · ${failedNotification.purpose || "logística"} · estado ${failedNotification.status || "failed"}.`,
                    `Error: ${failedNotification.error_message || "sin detalle del proveedor"}.`,
                    "Acción segura: crear revisión de reintento. AI Ops no reenvía mensajes automáticamente.",
                ].join("\n")
                : "No hay notificaciones fallidas en la ventana actual.",
            evidence: [
                { source: "admin_logistics_operations_snapshot", metric: "failed_notification_count", value: ops.failed_notification_count },
                { source: "admin_logistics_operations_snapshot", queue: "failed_notifications", first_notification_id: failedNotification?.notification_id },
            ],
            proposedPayload: {
                notification_id: failedNotification?.notification_id,
                order_id: failedNotification?.order_id,
                safe_next_step: "review_failed_notification",
            },
            approvalRequired: true,
            icon: <MessageSquareText className="h-4 w-4" />,
        },
        {
            id: "inventory-risk",
            label: "Inventario crítico",
            prompt: "OpenClaw, dime qué stock debo revisar.",
            actionType: "inventory_alert_review",
            targetType: inventoryAlert ? "product_variant" : "inventory",
            targetId: inventoryAlert?.variant_id,
            targetRef: inventoryAlert ? `${inventoryAlert.brand || ""} ${inventoryAlert.model || ""}`.trim() : undefined,
            riskLevel: num(inventory.sold_out_variants_count) > 0 ? "medium" : "low",
            summary: `Inventario: ${num(inventory.low_stock_variants_count)} bajos, ${num(inventory.sold_out_variants_count)} agotados.`,
            response: [
                `Bajo stock: ${num(inventory.low_stock_variants_count)} variantes.`,
                `Agotadas: ${num(inventory.sold_out_variants_count)} variantes.`,
                inventoryAlert
                    ? `Primera alerta: ${inventoryAlert.brand || ""} ${inventoryAlert.model || ""}, talla ${inventoryAlert.size}, disponibles ${num(inventoryAlert.available)}.`
                    : "No hay alerta puntual de inventario en la cola.",
                "Acción segura: revisar reposición; no cambia inventario ni costos.",
            ].join("\n"),
            evidence: [
                { source: "admin_dashboard_snapshot", metric: "low_stock_variants_count", value: inventory.low_stock_variants_count },
                { source: "admin_dashboard_snapshot", metric: "sold_out_variants_count", value: inventory.sold_out_variants_count },
                { source: "admin_dashboard_snapshot", queue: "inventory_alerts", first_variant_id: inventoryAlert?.variant_id },
            ],
            proposedPayload: {
                variant_id: inventoryAlert?.variant_id,
                safe_next_step: "review_inventory_restock",
            },
            approvalRequired: true,
            icon: <Package className="h-4 w-4" />,
        },
        {
            id: "day-actions",
            label: "Acciones del día",
            prompt: "OpenClaw, prepara una lista de acciones sin ejecutar nada.",
            actionType: "ops_action_plan",
            targetType: "operations",
            riskLevel: "medium",
            summary: "Preparar plan de acciones del día desde Dashboard y Logistics.",
            response: [
                "Plan sugerido:",
                `1. Despacho: revisar ${num(dashLogistics.paid_pending_dispatch_count)} pagadas pendientes.`,
                `2. Tracking: completar ${num(ops.missing_tracking_count)} guías faltantes.`,
                `3. Notificaciones: investigar ${num(ops.failed_notification_count)} fallos.`,
                `4. Margen: corregir ${num(finance.missing_cogs_order_count)} costos faltantes.`,
                "Todas las acciones quedan en revisión humana.",
            ].join("\n"),
            evidence: [
                { source: "admin_dashboard_snapshot", metric: "paid_pending_dispatch_count", value: dashLogistics.paid_pending_dispatch_count },
                { source: "admin_logistics_operations_snapshot", metric: "missing_tracking_count", value: ops.missing_tracking_count },
                { source: "admin_logistics_operations_snapshot", metric: "failed_notification_count", value: ops.failed_notification_count },
            ],
            proposedPayload: {
                checklist: [
                    "review_paid_to_dispatch",
                    "complete_missing_tracking",
                    "recover_failed_notifications",
                    "complete_missing_costs",
                ],
            },
            approvalRequired: true,
            icon: <FileCheck2 className="h-4 w-4" />,
        },
    ];
}

function buildStorefrontProposal(events: StorefrontConversationEvent[]): Proposal | null {
    const opportunities = buildStorefrontOpportunities(events);
    const first = opportunities[0];
    if (!first) return null;

    const sessionEvents = events
        .filter((event) => storefrontSessionId(event) === first.sessionId)
        .slice(0, 5);
    const anchorEvent = sessionEvents[0] || events[0];
    const product = first.product || "producto por confirmar";
    const sizeText = first.size ? `, talla ${first.size}` : "";
    const stage = first.funnelStage || first.intent || first.eventType;

    return {
        id: "storefront-opportunity",
        label: "Oportunidad storefront",
        prompt: "OpenClaw, revisa las señales del chat web y dime si hay una oportunidad comercial accionable.",
        actionType: "storefront_opportunity_review",
        targetType: "storefront_session",
        targetRef: first.sessionRef,
        riskLevel: first.hasReadyToOrder || first.hasHandoff ? "medium" : "low",
        summary: `Revisar oportunidad web ${first.sessionRef}: ${product}${sizeText}.`,
        response: [
            `Hay ${opportunities.length} sesión(es) web con señales accionables.`,
            `Primera oportunidad: ${product}${sizeText}.`,
            `Etapa: ${formatEventType(stage)} · ${first.eventCount} evento(s) recientes.`,
            "Lectura profesional: tratarla como sesión anónima hasta capturar identidad por WhatsApp, orden o pago.",
            "Acción segura: crear revisión AI Ops. No se envía mensaje, no se fusiona Customer 360 y no se crea orden desde aquí.",
        ].join("\n"),
        evidence: [
            {
                source: "conversation_events",
                channel: "storefront_webchat",
                session_ref: first.sessionRef,
                product: first.product || null,
                size_requested: first.size || null,
                funnel_stage: first.funnelStage || null,
                intent: first.intent || null,
                event_count: first.eventCount,
                last_event_at: first.lastEventAt,
            },
            ...opportunities.slice(1, 3).map((opportunity) => ({
                source: "conversation_events",
                channel: "storefront_webchat",
                session_ref: opportunity.sessionRef,
                product: opportunity.product || null,
                size_requested: opportunity.size || null,
                funnel_stage: opportunity.funnelStage || null,
                event_count: opportunity.eventCount,
            })),
        ],
        inputContext: {
            mode: "suggest_only",
            event_source: "storefront_webchat",
            storefront_session: {
                session_id: first.sessionId,
                session_ref: first.sessionRef,
                product: first.product || null,
                size_requested: first.size || null,
                stage,
                event_count: first.eventCount,
                last_event_at: first.lastEventAt,
            },
            opportunity_count: opportunities.length,
            guardrails: {
                no_auto_send: true,
                no_payment_or_dispatch_execution: true,
                operator_approval_required: true,
                no_customer_profile_merge_without_identity: true,
            },
            customer: {
                name: "Sesión storefront anónima",
                identity_status: "anonymous_until_whatsapp_order_or_payment",
            },
            conversation: {
                channel: "storefront_webchat",
                last_message_preview: anchorEvent ? eventLabel(anchorEvent) : "",
                last_message_at: sessionEvents[0]?.occurred_at || first.lastEventAt,
                recent_messages: sessionEvents.map((event) => ({
                    audit_label: formatEventType(event.event_type),
                    direction: event.direction || "internal",
                    preview: eventLabel(event),
                    created_at: event.occurred_at,
                })),
            },
            commercial: {
                stage,
                intent: first.intent || null,
            },
            product: {
                name: first.product || null,
                size: first.size || null,
                context_source: "storefront_webchat",
            },
        },
        proposedPayload: {
            mode: "suggest_only",
            action: "review_storefront_opportunity",
            storefront_session_id: first.sessionId,
            session_ref: first.sessionRef,
            product: first.product || null,
            size_requested: first.size || null,
            safe_next_step: "review_storefront_handoff_or_request_identity",
            no_auto_send: true,
            no_customer_message: true,
            customer_profile_write_allowed: false,
            requires_identity_resolution: true,
        },
        approvalRequired: true,
        icon: <MessageSquareText className="h-4 w-4" />,
    };
}

function buildIdentityBridgeProposal(identityBridge: IdentityBridgeSnapshot | null): Proposal | null {
    const handoffs = identityBridge?.handoffs || [];
    const summary = identityBridge?.summary || {};
    const firstReview = handoffs.find(unresolvedHandoff) || handoffs.find((handoff) => handoff.status !== "linked") || handoffs[0];

    if (!firstReview) return null;

    const product = storefrontHandoffProductLabel(firstReview) || "producto por confirmar";
    const code = firstReview.handoff_code || "sin código";
    const size = handoffSizeLabel(firstReview);

    return {
        id: "storefront-identity-bridge",
        label: "Puente storefront",
        prompt: "OpenClaw, revisa los códigos WEB-* y dime si hay handoffs no resueltos o listos para auditar.",
        actionType: "storefront_identity_bridge_review",
        targetType: firstReview.linked_conversation_id ? "conversation" : "storefront_handoff",
        targetId: firstReview.linked_conversation_id || firstReview.handoff_id || firstReview.id || undefined,
        targetRef: code,
        riskLevel: num(summary.unresolved_count) > 0 ? "high" : num(summary.active_pending_count) > 0 ? "medium" : "low",
        summary: `Revisar puente WEB: ${num(summary.linked_count)} enlazado(s), ${num(summary.unresolved_count)} no resuelto(s).`,
        response: [
            `Handoffs WEB-* en ventana: ${num(summary.total_count)}.`,
            `Enlazados a WhatsApp: ${num(summary.linked_count)} · Pendientes: ${num(summary.active_pending_count)} · No resueltos: ${num(summary.unresolved_count)}.`,
            `Primer caso a revisar: ${code} · ${humanizeHandoffStatus(firstReview.status)} · ${product}${size ? `, talla ${size}` : ""}.`,
            "Lectura profesional: el código es correlación auditada, no autenticación. Customer 360 solo se enriquece cuando WhatsApp confirma conversación/cliente.",
            "Acción segura: crear revisión. No fusiona perfiles, no crea orden, no cobra y no despacha.",
        ].join("\n"),
        evidence: [
            {
                source: "storefront_handoffs",
                handoff_code: code,
                status: firstReview.status,
                identity_status: firstReview.identity_status,
                review_flag: firstReview.review_flag || null,
                storefront_session_ref: firstReview.storefront_session_id ? shortId(firstReview.storefront_session_id) : null,
                product,
                size_requested: size || null,
                linked_conversation_id: firstReview.linked_conversation_id || null,
                linked_customer_id: firstReview.linked_customer_id || null,
            },
        ],
        inputContext: {
            mode: "suggest_only",
            event_source: "storefront_handoffs",
            identity_bridge: {
                summary,
                first_handoff: sanitizeHandoffEvidence(firstReview),
            },
            guardrails: {
                no_auto_send: true,
                no_payment_or_dispatch_execution: true,
                operator_approval_required: true,
                no_customer_profile_merge_without_verified_whatsapp_identity: firstReview.status !== "linked",
            },
            customer: {
                name: firstReview.linked_customer_name || "Sesión storefront",
                identity_status: firstReview.identity_status || handoffIdentityStatus(firstReview),
            },
            conversation: {
                channel: firstReview.linked_conversation_id ? "whatsapp" : "storefront_webchat",
                last_message_preview: `${code} · ${humanizeHandoffStatus(firstReview.status)} · ${product}`,
                last_message_at: firstReview.linked_at || firstReview.created_at || identityBridge?.generated_at,
                recent_messages: handoffs.slice(0, 5).map((handoff) => ({
                    audit_label: "handoff web",
                    direction: "system",
                    preview: `${handoff.handoff_code || "-"} · ${humanizeHandoffStatus(handoff.status)} · ${storefrontHandoffProductLabel(handoff) || "sin producto"}`,
                    created_at: handoff.linked_at || handoff.created_at,
                })),
            },
            product: {
                name: product,
                size,
                context_source: "storefront_handoff",
            },
        },
        proposedPayload: {
            mode: "suggest_only",
            action: "review_storefront_identity_bridge",
            handoff_code: code,
            handoff_id: firstReview.handoff_id || firstReview.id || null,
            safe_next_step: "review_bridge_evidence_in_inbox_or_ai_ops",
            no_auto_send: true,
            no_customer_message: true,
            customer_profile_write_allowed: firstReview.status === "linked",
            requires_identity_resolution: firstReview.status !== "linked",
        },
        approvalRequired: true,
        icon: <Link2 className="h-4 w-4" />,
    };
}

function summarizeStorefrontEvents(events: StorefrontConversationEvent[], identityBridge: IdentityBridgeSnapshot | null = null) {
    const sessions = new Set<string>();

    for (const event of events) {
        const sessionId = storefrontSessionId(event);
        if (sessionId) sessions.add(sessionId);
    }

    return {
        sessions: sessions.size,
        handoffs: num(identityBridge?.summary?.total_count) || events.filter((event) => event.event_type === "handoff_suggested").length,
        linkedHandoffs: num(identityBridge?.summary?.linked_count),
        unresolvedHandoffs: num(identityBridge?.summary?.unresolved_count),
        buyIntent: events.filter((event) => event.intent === "buy_intent" || event.funnel_stage === "ready_to_order").length,
        lastEventAt: events[0]?.occurred_at ? formatDateTime(events[0].occurred_at) : "-",
        opportunities: buildStorefrontOpportunities(events),
        identityBridge,
    };
}

function buildStorefrontOpportunities(events: StorefrontConversationEvent[]) {
    const opportunities = new Map<string, StorefrontOpportunity>();

    for (const event of events) {
        const sessionId = storefrontSessionId(event);
        if (!sessionId) continue;

        const product = storefrontProductLabel(event.metadata);
        const size = storefrontSizeLabel(event);
        const score = storefrontIntentScore(event);
        const current = opportunities.get(sessionId);
        const eventTime = Date.parse(event.occurred_at);
        const currentTime = current ? Date.parse(current.lastEventAt) : 0;
        const next: StorefrontOpportunity = current || {
            sessionId,
            sessionRef: shortId(sessionId),
            product: "",
            size: "",
            funnelStage: "",
            intent: "",
            eventType: "",
            source: event.source,
            surface: "",
            lastEventAt: event.occurred_at,
            eventCount: 0,
            score: 0,
            hasHandoff: false,
            hasStockValidated: false,
            hasReadyToOrder: false,
        };
        const previousScore = next.score;
        const shouldPromoteSignal = score >= previousScore || !next.eventType;

        next.eventCount += 1;
        next.score = Math.max(next.score, score);
        next.product = product || next.product;
        next.size = size || next.size;
        if (shouldPromoteSignal) {
            next.funnelStage = event.funnel_stage || next.funnelStage;
            next.intent = event.intent || next.intent;
            next.eventType = event.event_type || next.eventType;
        }
        next.surface = stringMetadata(event.metadata, "surface") || next.surface;
        next.hasHandoff = next.hasHandoff || event.event_type === "handoff_suggested";
        next.hasStockValidated = next.hasStockValidated || event.funnel_stage === "stock_validated" || event.event_type === "stock_available";
        next.hasReadyToOrder = next.hasReadyToOrder || event.funnel_stage === "ready_to_order" || event.intent === "buy_intent";

        if (Number.isFinite(eventTime) && eventTime >= currentTime) {
            next.lastEventAt = event.occurred_at;
            next.source = event.source || next.source;
        }

        opportunities.set(sessionId, next);
    }

    return Array.from(opportunities.values())
        .filter((opportunity) =>
            opportunity.score >= 45 ||
            opportunity.hasHandoff ||
            opportunity.hasStockValidated ||
            opportunity.hasReadyToOrder
        )
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            return Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt);
        });
}

function storefrontHandoffProductLabel(handoff?: StorefrontHandoffEvidence | null) {
    if (!handoff) return "";

    const observed = handoff.observed_product;

    return (
        observed?.display_name ||
        [observed?.brand || handoff.product_brand, observed?.model || handoff.product_model].filter(Boolean).join(" ").trim()
    );
}

function handoffSizeLabel(handoff?: StorefrontHandoffEvidence | null) {
    const observedSize = handoff?.observed_product?.size_requested;
    const size = observedSize || handoff?.size_requested;

    if (typeof size === "number" && Number.isFinite(size)) return String(size);
    if (typeof size === "string" && size.trim()) return size.trim();
    return "";
}

function handoffIdentityStatus(handoff: StorefrontHandoffEvidence) {
    if (handoff.identity_status) return handoff.identity_status;
    if (handoff.status === "linked") return "verified_whatsapp";
    if (unresolvedHandoff(handoff)) return "unresolved";
    if (handoff.status === "created" || handoff.status === "opened_whatsapp") return "anonymous_pending_whatsapp";
    return handoff.status || "unknown";
}

function unresolvedHandoff(handoff: StorefrontHandoffEvidence) {
    if (handoff.status === "expired" || handoff.status === "unresolved") return true;
    if (handoff.status !== "created" && handoff.status !== "opened_whatsapp") return false;
    if (!handoff.expires_at) return false;

    return Date.parse(handoff.expires_at) < Date.now();
}

function humanizeHandoffStatus(status?: string | null) {
    const labels: Record<string, string> = {
        linked: "Enlazado",
        created: "Creado",
        opened_whatsapp: "WhatsApp abierto",
        expired: "Vencido",
        unresolved: "No resuelto",
        discarded: "Descartado",
    };

    if (!status) return "-";
    return labels[status] || status.replaceAll("_", " ");
}

function sanitizeHandoffEvidence(handoff: StorefrontHandoffEvidence) {
    return {
        handoff_id: handoff.handoff_id || handoff.id || null,
        handoff_code: handoff.handoff_code || null,
        status: handoff.status || null,
        identity_status: handoffIdentityStatus(handoff),
        storefront_session_ref: handoff.storefront_session_id ? shortId(handoff.storefront_session_id) : null,
        source_surface: handoff.source_surface || null,
        product: storefrontHandoffProductLabel(handoff) || null,
        size_requested: handoffSizeLabel(handoff) || null,
        linked_customer_id: handoff.linked_customer_id || null,
        linked_conversation_id: handoff.linked_conversation_id || null,
        linked_message_id: handoff.linked_message_id || null,
        created_at: handoff.created_at || null,
        linked_at: handoff.linked_at || null,
        expires_at: handoff.expires_at || null,
        guardrail: "correlation_not_authentication",
    };
}

function storefrontIntentScore(event: StorefrontConversationEvent) {
    const stageScores: Record<string, number> = {
        ready_to_order: 100,
        stock_validated: 85,
        blocked_stock: 70,
        interested: 50,
        exploring: 25,
        lost: 10,
    };
    const intentScores: Record<string, number> = {
        buy_intent: 95,
        size_availability: 70,
        product_image: 55,
        price_question: 55,
        product_search: 40,
        support: 30,
        greeting: 10,
    };
    const eventScores: Record<string, number> = {
        handoff_suggested: 95,
        stock_available: 90,
        stock_check_requested: 75,
        product_image_requested: 60,
        product_search_requested: 45,
        message_inbound_received: 20,
    };

    return Math.max(
        stageScores[event.funnel_stage || ""] || 0,
        intentScores[event.intent || ""] || 0,
        eventScores[event.event_type || ""] || 0
    );
}

function storefrontSessionId(event: StorefrontConversationEvent) {
    return stringMetadata(event.metadata, "storefront_session_id") || stringMetadata(event.metadata, "session_id");
}

function eventLabel(event: StorefrontConversationEvent) {
    const product = storefrontProductLabel(event.metadata);
    const size = storefrontSizeLabel(event);
    const surface = stringMetadata(event.metadata, "surface");

    const pieces = [
        formatEventType(event.event_type),
        product ? product : null,
        size ? `talla ${size}` : null,
        surface ? `desde ${formatEventType(surface)}` : null,
    ].filter(Boolean);

    return pieces.join(" · ");
}

function metadataLine(event: StorefrontConversationEvent) {
    const metadata = event.metadata;
    if (!metadata) return "Sin metadata adicional.";

    const sessionId = stringMetadata(metadata, "storefront_session_id");
    const values = [
        ["Producto", storefrontProductLabel(metadata)],
        ["Talla", storefrontSizeLabel(event)],
        ["Origen", stringMetadata(metadata, "surface")],
        ["Sesión", sessionId ? shortId(sessionId) : ""],
    ].filter(([, value]) => value);

    if (values.length === 0) return "Metadata saneada sin campos de negocio.";

    return values.map(([label, value]) => `${label}: ${value}`).join(" · ");
}

function storefrontProductLabel(metadata?: Record<string, unknown> | null) {
    if (!metadata) return "";

    return (
        [stringMetadata(metadata, "product_brand"), stringMetadata(metadata, "product_model")].filter(Boolean).join(" ").trim() ||
        stringMetadata(metadata, "product") ||
        stringMetadata(metadata, "product_name")
    );
}

function storefrontSizeLabel(event: StorefrontConversationEvent) {
    return stringMetadata(event.metadata, "size") || (event.size_requested ? String(event.size_requested) : "");
}

function stringMetadata(metadata: Record<string, unknown> | null | undefined, key: string) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return "";
}

function EvidenceCard({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg border bg-white px-3 py-2">
            <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
            <p className="mt-1 truncate text-sm font-semibold text-slate-900">{value}</p>
        </div>
    );
}

function StatusPill({ tone, children }: {
    tone: "slate" | "emerald" | "amber" | "red";
    children: ReactNode;
}) {
    const classes = {
        slate: "bg-slate-50 text-slate-700 ring-slate-200",
        emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        amber: "bg-amber-50 text-amber-700 ring-amber-200",
        red: "bg-red-50 text-red-700 ring-red-200",
    };

    return (
        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${classes[tone]}`}>
            {children}
        </span>
    );
}

function statusTone(status: AgentActionStatus): "slate" | "emerald" | "amber" | "red" {
    if (status === "executed") return "emerald";
    if (status === "rejected" || status === "failed" || status === "cancelled") return "red";
    if (status === "pending_approval" || status === "approved") return "amber";
    return "slate";
}

function riskTone(risk: RiskLevel): "slate" | "emerald" | "amber" | "red" {
    if (risk === "critical" || risk === "high") return "red";
    if (risk === "medium") return "amber";
    return "emerald";
}

function statusLabel(status: AgentActionStatus) {
    return agentActionStageLabel(status);
}

function riskLabel(risk: RiskLevel) {
    const labels: Record<RiskLevel, string> = {
        low: "Riesgo bajo",
        medium: "Riesgo medio",
        high: "Riesgo alto",
        critical: "Riesgo crítico",
    };

    return labels[risk];
}

function humanizeActionType(actionType: string) {
    const labels: Record<string, string> = {
        daily_ops_summary: "Resumen operativo",
        dispatch_review: "Revisión despacho",
        margin_data_review: "Revisión margen",
        notification_retry_review: "Revisión notificación",
        inventory_alert_review: "Revisión inventario",
        ops_action_plan: "Plan de acciones",
        commercial_follow_up: "Seguimiento comercial",
        storefront_identity_bridge_review: "Revisión puente web",
        storefront_opportunity_review: "Oportunidad storefront",
        draft_customer_reply: "Borrador de respuesta",
        take_human_handoff: "Toma humana",
        assign_human_owner: "Asignación humana",
    };

    return labels[actionType] || actionType;
}

function formatEventType(value?: string | null) {
    if (!value) return "-";
    return value
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}

function num(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatCents(value: unknown) {
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(num(value) / 100);
}

function formatBps(value: unknown) {
    return `${(num(value) / 100).toFixed(1)}%`;
}

function formatDateTime(value?: string | null) {
    if (!value) return "-";
    return new Intl.DateTimeFormat("es-CO", {
        dateStyle: "short",
        timeStyle: "short",
    }).format(new Date(value));
}

function shortId(value?: string | null) {
    if (!value) return "-";
    return `${value.slice(0, 8)}...`;
}
