import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
    AlertTriangle,
    Bot,
    CheckCircle2,
    Clock3,
    MapPin,
    MessageSquareWarning,
    PackageCheck,
    Route,
    Truck,
} from "lucide-react";
import { supabase } from "../lib/supabase";

type RangeOption = 7 | 30 | 90;

type LogisticsSummary = {
    paid_pending_dispatch_count?: number;
    paid_over_sla_count?: number;
    active_shipments_count?: number;
    shipped_over_sla_count?: number;
    delivered_count?: number;
    perfect_order_count?: number;
    perfect_order_bps?: number;
    missing_tracking_count?: number;
    failed_notification_count?: number;
    skipped_notification_count?: number;
};

type LogisticsTiming = {
    payment_to_dispatch_avg_hours?: number;
    payment_to_dispatch_p50_hours?: number;
    payment_to_dispatch_p90_hours?: number;
    dispatch_to_delivery_avg_hours?: number;
    dispatch_to_delivery_p50_hours?: number;
    dispatch_to_delivery_p90_hours?: number;
};

type LogisticsDataQuality = {
    paid_without_paid_at_count?: number;
    shipped_without_shipped_at_count?: number;
    delivered_without_delivered_at_count?: number;
    active_without_tracking_count?: number;
};

type PaidToDispatchRow = {
    order_id: string;
    customer_name?: string | null;
    shipping_city?: string | null;
    total_cents?: number;
    paid_at?: string | null;
    hours_waiting?: number;
    over_sla?: boolean;
};

type ActiveShipmentRow = {
    shipment_id: string;
    order_id: string;
    status?: string;
    customer_name?: string | null;
    shipping_city?: string | null;
    carrier_name?: string | null;
    tracking_number?: string | null;
    shipped_at?: string | null;
    hours_in_transit?: number;
    over_sla?: boolean;
    missing_tracking?: boolean;
};

type FailedNotificationRow = {
    notification_id: string;
    order_id: string;
    shipment_id?: string | null;
    purpose?: string;
    status?: string;
    recipient_phone?: string | null;
    error_message?: string | null;
    created_at?: string;
};

type RecentEventRow = {
    event_id: string;
    shipment_id: string;
    order_id: string;
    event_type?: string;
    status?: string | null;
    source?: string;
    description?: string | null;
    occurred_at?: string;
};

type LogisticsSnapshot = {
    generated_at?: string;
    window?: {
        from?: string;
        to?: string;
        timezone?: string;
        fulfillment_sla_hours?: number;
        delivery_sla_hours?: number;
    };
    summary?: LogisticsSummary;
    timing?: LogisticsTiming;
    data_quality?: LogisticsDataQuality;
    queues?: {
        paid_to_dispatch?: PaidToDispatchRow[];
        active_shipments?: ActiveShipmentRow[];
        failed_notifications?: FailedNotificationRow[];
        recent_events?: RecentEventRow[];
    };
    agent_context?: {
        mode?: string;
        recommended_focus?: string;
        allowed_actions?: string[];
    };
};

const RANGE_OPTIONS: RangeOption[] = [7, 30, 90];

const STATUS_LABELS: Record<string, string> = {
    shipped: "Enviado",
    in_transit: "En tránsito",
    out_for_delivery: "En reparto",
    delivered: "Entregado",
    ready_to_fulfill: "Listo",
    notification_failed: "Notif. fallida",
    notification_delivered: "Notif. entregada",
    notification_read: "Notif. leída",
    notification_unknown: "Notif. incierta",
};

const EVENT_LABELS: Record<string, string> = {
    created: "Creado",
    ready_to_fulfill: "Listo",
    shipped: "Despachado",
    delivered: "Entregado",
    exception: "Excepción",
    notification_sent: "Notificación enviada",
    notification_delivered: "Notificación entregada",
    notification_failed: "Notificación fallida",
    notification_read: "Notificación leída",
    notification_unknown: "Notificación incierta · verificar WhatsApp",
    note: "Nota",
};

const FOCUS_LABELS: Record<string, string> = {
    dispatch_overdue_paid_orders: "Despachar pagadas atrasadas",
    follow_up_late_shipments: "Revisar envíos atrasados",
    complete_tracking: "Completar guías",
    recover_failed_notifications: "Recuperar notificaciones",
    monitor: "Monitorear operación",
};

export default function Logistics() {
    const [range, setRange] = useState<RangeOption>(30);
    const [snapshot, setSnapshot] = useState<LogisticsSnapshot | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const fetchSnapshot = useCallback(async () => {
        const to = new Date();
        const from = new Date(to.getTime() - range * 24 * 60 * 60 * 1000);

        try {
            const { data, error: rpcError } = await supabase.rpc("admin_logistics_operations_snapshot", {
                p_from: from.toISOString(),
                p_to: to.toISOString(),
                p_timezone: "America/Bogota",
            });

            if (rpcError) throw rpcError;

            setSnapshot((data || null) as LogisticsSnapshot | null);
            setError(null);
        } catch (fetchError) {
            console.error("Error loading logistics snapshot:", fetchError);
            setError("No se pudo cargar logística.");
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => {
        setLoading(true);
        fetchSnapshot();
    }, [fetchSnapshot]);

    useEffect(() => {
        const channel = supabase
            .channel("logistics-operations")
            .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, fetchSnapshot)
            .on("postgres_changes", { event: "*", schema: "public", table: "shipments" }, fetchSnapshot)
            .on("postgres_changes", { event: "*", schema: "public", table: "shipment_events" }, fetchSnapshot)
            .on("postgres_changes", { event: "*", schema: "public", table: "logistics_notifications" }, fetchSnapshot)
            .subscribe();

        const interval = window.setInterval(fetchSnapshot, 60_000);

        return () => {
            window.clearInterval(interval);
            supabase.removeChannel(channel);
        };
    }, [fetchSnapshot]);

    const summary = snapshot?.summary || {};
    const timing = snapshot?.timing || {};
    const dataQuality = snapshot?.data_quality || {};
    const queues = snapshot?.queues || {};
    const focus = snapshot?.agent_context?.recommended_focus || "monitor";
    const health = useMemo(() => {
        const issues =
            num(summary.paid_over_sla_count) +
            num(summary.shipped_over_sla_count) +
            num(summary.missing_tracking_count) +
            num(summary.failed_notification_count);

        if (issues === 0) return { tone: "emerald" as const, label: "Controlada" };
        if (issues <= 3) return { tone: "amber" as const, label: "Atención" };
        return { tone: "red" as const, label: "Crítica" };
    }, [
        summary.failed_notification_count,
        summary.missing_tracking_count,
        summary.paid_over_sla_count,
        summary.shipped_over_sla_count,
    ]);

    if (loading && !snapshot) {
        return <div className="p-10 text-center text-sm text-slate-500">Cargando logística...</div>;
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Logistics</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        {formatDateTime(snapshot?.generated_at)} · SLA {num(snapshot?.window?.fulfillment_sla_hours)}h / {num(snapshot?.window?.delivery_sla_hours)}h
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <div className="inline-flex rounded-lg border bg-white p-1">
                        {RANGE_OPTIONS.map((option) => (
                            <button
                                key={option}
                                type="button"
                                onClick={() => setRange(option)}
                                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${range === option
                                    ? "bg-slate-900 text-white"
                                    : "text-slate-500 hover:bg-slate-100 hover:text-slate-900"
                                    }`}
                            >
                                {option}d
                            </button>
                        ))}
                    </div>
                    <StatusPill tone={health.tone}>{health.label}</StatusPill>
                    <button
                        type="button"
                        onClick={fetchSnapshot}
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

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
                <MetricCard
                    title="Por Despachar"
                    value={num(summary.paid_pending_dispatch_count).toString()}
                    subtext={`${num(summary.paid_over_sla_count)} sobre SLA`}
                    icon={<PackageCheck className="h-4 w-4" />}
                    tone={num(summary.paid_over_sla_count) > 0 ? "amber" : "slate"}
                />
                <MetricCard
                    title="En Transporte"
                    value={num(summary.active_shipments_count).toString()}
                    subtext={`${num(summary.shipped_over_sla_count)} atrasados`}
                    icon={<Truck className="h-4 w-4" />}
                    tone={num(summary.shipped_over_sla_count) > 0 ? "amber" : "cyan"}
                />
                <MetricCard
                    title="Entregadas"
                    value={num(summary.delivered_count).toString()}
                    subtext={`${formatBps(summary.perfect_order_bps)} perfect order`}
                    icon={<CheckCircle2 className="h-4 w-4" />}
                    tone="emerald"
                />
                <MetricCard
                    title="Tracking Faltante"
                    value={num(summary.missing_tracking_count).toString()}
                    subtext="envíos activos"
                    icon={<Route className="h-4 w-4" />}
                    tone={num(summary.missing_tracking_count) > 0 ? "red" : "slate"}
                />
                <MetricCard
                    title="Notif. Fallidas"
                    value={num(summary.failed_notification_count).toString()}
                    subtext={`${num(summary.skipped_notification_count)} omitidas`}
                    icon={<MessageSquareWarning className="h-4 w-4" />}
                    tone={num(summary.failed_notification_count) > 0 ? "red" : "slate"}
                />
            </div>

            <div className="grid gap-4 xl:grid-cols-[1fr_1fr_0.85fr]">
                <Panel title="Pago A Despacho" icon={<Clock3 className="h-4 w-4" />}>
                    <TimingGrid
                        avg={timing.payment_to_dispatch_avg_hours}
                        p50={timing.payment_to_dispatch_p50_hours}
                        p90={timing.payment_to_dispatch_p90_hours}
                    />
                </Panel>
                <Panel title="Despacho A Entrega" icon={<Truck className="h-4 w-4" />}>
                    <TimingGrid
                        avg={timing.dispatch_to_delivery_avg_hours}
                        p50={timing.dispatch_to_delivery_p50_hours}
                        p90={timing.dispatch_to_delivery_p90_hours}
                    />
                </Panel>
                <Panel title="AI Ops" icon={<Bot className="h-4 w-4" />}>
                    <div className="flex items-start gap-3">
                        <StatusPill tone={health.tone}>{FOCUS_LABELS[focus] || focus}</StatusPill>
                    </div>
                    <div className="mt-4 space-y-2">
                        {(snapshot?.agent_context?.allowed_actions || []).map((action) => (
                            <div key={action} className="flex items-center gap-2 text-sm text-slate-600">
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                                {humanizeAction(action)}
                            </div>
                        ))}
                    </div>
                </Panel>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <Panel title="Pagadas Por Despachar" icon={<PackageCheck className="h-4 w-4" />}>
                    <div className="space-y-3">
                        {(queues.paid_to_dispatch || []).map((item) => (
                            <QueueRow
                                key={item.order_id}
                                title={`${item.customer_name || "Cliente"} · ${shortId(item.order_id)}`}
                                meta={`${item.shipping_city || "Sin ciudad"} · ${num(item.hours_waiting)}h esperando`}
                                value={formatCents(item.total_cents)}
                                tone={item.over_sla ? "amber" : "slate"}
                                badge={item.over_sla ? "SLA" : "OK"}
                            />
                        ))}
                        {emptyState(queues.paid_to_dispatch, "Sin pagadas pendientes.")}
                    </div>
                </Panel>

                <Panel title="Envíos Activos" icon={<Truck className="h-4 w-4" />}>
                    <div className="space-y-3">
                        {(queues.active_shipments || []).map((item) => (
                            <QueueRow
                                key={item.shipment_id}
                                title={`${item.customer_name || "Cliente"} · ${shortId(item.order_id)}`}
                                meta={`${STATUS_LABELS[item.status || ""] || item.status || "Envío"} · ${item.carrier_name || "Sin carrier"} · ${item.tracking_number || "Sin guía"}`}
                                value={`${num(item.hours_in_transit)}h`}
                                tone={item.over_sla || item.missing_tracking ? "amber" : "slate"}
                                badge={item.over_sla ? "SLA" : item.missing_tracking ? "Guía" : "OK"}
                            />
                        ))}
                        {emptyState(queues.active_shipments, "Sin envíos activos.")}
                    </div>
                </Panel>
            </div>

            <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr_1fr]">
                <Panel title="Calidad De Datos" icon={<AlertTriangle className="h-4 w-4" />}>
                    <KpiRow label="Pagadas sin paid_at" value={dataQuality.paid_without_paid_at_count} tone={num(dataQuality.paid_without_paid_at_count) > 0 ? "red" : "slate"} />
                    <KpiRow label="Enviadas sin shipped_at" value={dataQuality.shipped_without_shipped_at_count} tone={num(dataQuality.shipped_without_shipped_at_count) > 0 ? "red" : "slate"} />
                    <KpiRow label="Entregadas sin delivered_at" value={dataQuality.delivered_without_delivered_at_count} tone={num(dataQuality.delivered_without_delivered_at_count) > 0 ? "red" : "slate"} />
                    <KpiRow label="Activas sin tracking" value={dataQuality.active_without_tracking_count} tone={num(dataQuality.active_without_tracking_count) > 0 ? "amber" : "slate"} />
                </Panel>

                <Panel title="Notificaciones Fallidas" icon={<MessageSquareWarning className="h-4 w-4" />}>
                    <div className="space-y-3">
                        {(queues.failed_notifications || []).map((item) => (
                            <QueueRow
                                key={item.notification_id}
                                title={`${item.purpose || "notificación"} · ${shortId(item.order_id)}`}
                                meta={`${item.status || "failed"} · ${item.recipient_phone || "sin teléfono"}`}
                                value={formatDateTime(item.created_at)}
                                tone="red"
                                badge="Retry"
                            />
                        ))}
                        {emptyState(queues.failed_notifications, "Sin fallos de notificación.")}
                    </div>
                </Panel>

                <Panel title="Timeline" icon={<MapPin className="h-4 w-4" />}>
                    <div className="space-y-3">
                        {(queues.recent_events || []).map((event) => (
                            <div key={event.event_id} className="border-b pb-3 last:border-0 last:pb-0">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="truncate text-sm font-semibold text-slate-900">
                                        {EVENT_LABELS[event.event_type || ""] || event.event_type || "Evento"}
                                    </p>
                                    <span className="text-xs text-slate-500">{formatTime(event.occurred_at)}</span>
                                </div>
                                <p className="mt-1 truncate text-xs text-slate-500">
                                    {shortId(event.order_id)} · {event.source || "system"}
                                </p>
                            </div>
                        ))}
                        {emptyState(queues.recent_events, "Sin eventos recientes.")}
                    </div>
                </Panel>
            </div>
        </div>
    );
}

function MetricCard({ title, value, subtext, icon, tone }: {
    title: string;
    value: string;
    subtext: string;
    icon: ReactNode;
    tone: "slate" | "cyan" | "emerald" | "amber" | "red";
}) {
    return (
        <section className="rounded-lg border bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-slate-600">{title}</h2>
                <div className={`rounded-md p-2 ${toneClasses(tone).soft}`}>{icon}</div>
            </div>
            <p className="mt-4 text-2xl font-bold text-slate-950">{value}</p>
            <p className="mt-1 text-sm text-slate-500">{subtext}</p>
        </section>
    );
}

function Panel({ title, icon, children }: {
    title: string;
    icon: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="rounded-lg border bg-white shadow-sm">
            <div className="flex items-center gap-2 border-b px-5 py-4">
                <div className="text-slate-500">{icon}</div>
                <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
            </div>
            <div className="p-5">{children}</div>
        </section>
    );
}

function TimingGrid({ avg, p50, p90 }: {
    avg?: number;
    p50?: number;
    p90?: number;
}) {
    return (
        <div className="grid grid-cols-3 divide-x rounded-lg border bg-slate-50">
            <TimingCell label="AVG" value={avg} />
            <TimingCell label="P50" value={p50} />
            <TimingCell label="P90" value={p90} />
        </div>
    );
}

function TimingCell({ label, value }: { label: string; value?: number }) {
    return (
        <div className="px-4 py-5 text-center">
            <p className="text-xs font-medium text-slate-500">{label}</p>
            <p className="mt-2 text-xl font-bold text-slate-950">{num(value)}h</p>
        </div>
    );
}

function QueueRow({ title, meta, value, tone, badge }: {
    title: string;
    meta: string;
    value: string;
    tone: "slate" | "amber" | "red";
    badge: string;
}) {
    return (
        <div className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
            <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-900">{title}</p>
                <p className="mt-1 truncate text-xs text-slate-500">{meta}</p>
            </div>
            <div className="shrink-0 text-right">
                <p className="text-sm font-semibold text-slate-900">{value}</p>
                <div className="mt-1">
                    <StatusPill tone={tone}>{badge}</StatusPill>
                </div>
            </div>
        </div>
    );
}

function KpiRow({ label, value, tone = "slate" }: {
    label: string;
    value: ReactNode;
    tone?: "slate" | "amber" | "red";
}) {
    return (
        <div className="flex items-center justify-between border-b py-2.5 last:border-0">
            <span className="text-sm text-slate-500">{label}</span>
            <span className={`text-sm font-semibold ${tone === "red" ? "text-red-600" : tone === "amber" ? "text-amber-700" : "text-slate-900"}`}>
                {typeof value === "number" ? num(value) : value}
            </span>
        </div>
    );
}

function StatusPill({ tone, children }: {
    tone: "slate" | "cyan" | "emerald" | "amber" | "red";
    children: ReactNode;
}) {
    return (
        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${toneClasses(tone).pill}`}>
            {children}
        </span>
    );
}

function toneClasses(tone: "slate" | "cyan" | "emerald" | "amber" | "red") {
    const classes = {
        slate: {
            soft: "bg-slate-100 text-slate-600",
            pill: "bg-slate-50 text-slate-700 ring-slate-200",
        },
        cyan: {
            soft: "bg-cyan-50 text-cyan-700",
            pill: "bg-cyan-50 text-cyan-700 ring-cyan-200",
        },
        emerald: {
            soft: "bg-emerald-50 text-emerald-700",
            pill: "bg-emerald-50 text-emerald-700 ring-emerald-200",
        },
        amber: {
            soft: "bg-amber-50 text-amber-700",
            pill: "bg-amber-50 text-amber-700 ring-amber-200",
        },
        red: {
            soft: "bg-red-50 text-red-700",
            pill: "bg-red-50 text-red-700 ring-red-200",
        },
    };

    return classes[tone];
}

function emptyState<T>(items: T[] | undefined, label: string) {
    if (items && items.length > 0) return null;
    return <p className="py-4 text-center text-sm text-slate-500">{label}</p>;
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

function formatTime(value?: string | null) {
    if (!value) return "-";
    return new Intl.DateTimeFormat("es-CO", {
        hour: "2-digit",
        minute: "2-digit",
    }).format(new Date(value));
}

function shortId(value?: string | null) {
    if (!value) return "-";
    return `${value.slice(0, 8)}...`;
}

function humanizeAction(action: string) {
    const labels: Record<string, string> = {
        explain_priorities: "Explicar prioridades",
        draft_customer_message: "Preparar mensaje",
        prepare_dispatch_checklist: "Preparar checklist",
        summarize_logistics_health: "Resumir salud logística",
    };

    return labels[action] || action;
}
