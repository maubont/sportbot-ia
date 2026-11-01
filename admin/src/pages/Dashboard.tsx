import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
    AlertTriangle,
    Bot,
    CheckCircle2,
    Clock3,
    DollarSign,
    LineChart,
    MessageSquare,
    Package,
    ShoppingBag,
    Truck,
} from "lucide-react";
import { supabase } from "../lib/supabase";

type DashboardRange = 7 | 30 | 90;

type OpsAlert = {
    key: string;
    severity: "high" | "medium" | "low";
    count: number;
    message: string;
};

type OpsWatchdog = {
    generated_at?: string;
    today?: {
        orders_created?: number;
        orders_paid?: number;
        revenue_cents?: number;
    };
    payments?: {
        awaiting_count?: number;
        expiring_within_6h_count?: number;
        receipts_pending_count?: number;
        receipts_pending_oldest_hours?: number;
        receipts_stale_count?: number;
    };
    alerts?: OpsAlert[];
};

const ALERT_LINKS: Record<string, { to: string; label: string }> = {
    receipts_stale: { to: "/payments", label: "Revisar pagos" },
    receipts_pending: { to: "/payments", label: "Revisar pagos" },
    expiring_soon: { to: "/payments", label: "Ver pedidos" },
    paid_over_sla: { to: "/logistics", label: "Despachar" },
    failed_notifications: { to: "/logistics", label: "Ver envios" },
    low_stock: { to: "/inventory", label: "Ver inventario" },
};

type ExecutiveSnapshot = {
    revenue_cents?: number;
    previous_revenue_cents?: number;
    revenue_delta_bps?: number | null;
    paid_orders_count?: number;
    average_order_value_cents?: number;
    contribution_margin_cents?: number;
    contribution_margin_bps?: number;
    gross_margin_cents?: number;
    gross_margin_bps?: number;
    open_conversations_count?: number;
};

type CommercialSnapshot = {
    open_conversations_count?: number;
    inbound_messages_count?: number;
    outbound_messages_count?: number;
    orders_created_count?: number;
    payment_links_count?: number;
    payments_approved_count?: number;
    payments_rejected_count?: number;
    link_to_approved_bps?: number;
};

type LogisticsSnapshot = {
    paid_pending_dispatch_count?: number;
    paid_over_sla_count?: number;
    active_shipments_count?: number;
    delivered_count?: number;
    missing_tracking_count?: number;
    failed_notification_count?: number;
    avg_payment_to_dispatch_hours?: number;
    avg_dispatch_to_delivery_hours?: number;
};

type FinanceSnapshot = {
    revenue_cents?: number;
    cogs_cents?: number;
    payment_fee_cents?: number;
    shipping_real_cost_cents?: number;
    packaging_cost_cents?: number;
    discount_cents?: number;
    twilio_cost_cents?: number;
    ai_cost_cents?: number;
    other_variable_cost_cents?: number;
    variable_cost_cents?: number;
    gross_margin_cents?: number;
    contribution_margin_cents?: number;
    missing_cogs_order_count?: number;
    missing_payment_fee_order_count?: number;
    missing_shipping_real_cost_order_count?: number;
    negative_margin_order_count?: number;
};

type InventorySnapshot = {
    physical_units?: number;
    reserved_units?: number;
    available_units?: number;
    low_stock_variants_count?: number;
    sold_out_variants_count?: number;
};

type PaidToDispatchItem = {
    order_id: string;
    customer_name?: string | null;
    shipping_city?: string | null;
    total_cents?: number;
    paid_at?: string | null;
    hours_waiting?: number;
    over_sla?: boolean;
};

type InventoryAlertItem = {
    variant_id: string;
    product_id: string;
    brand?: string | null;
    model?: string | null;
    size?: number | string | null;
    stock?: number;
    reserved?: number;
    available?: number;
    status?: string;
};

type DataQualityAlertItem = {
    order_id: string;
    status?: string;
    total_cents?: number;
    flags?: string[];
};

type RecentOrderItem = {
    order_id: string;
    status?: string;
    total_cents?: number;
    created_at?: string;
    paid_at?: string | null;
    customer_name?: string | null;
    contribution_margin_cents?: number | null;
    contribution_margin_bps?: number | null;
};

type PriorityItem = {
    key: string;
    count?: number;
    severity?: "ok" | "medium" | "high" | string;
};

type DashboardSnapshot = {
    generated_at?: string;
    window?: {
        from?: string;
        to?: string;
        timezone?: string;
        fulfillment_sla_hours?: number;
    };
    executive?: ExecutiveSnapshot;
    commercial?: CommercialSnapshot;
    logistics?: LogisticsSnapshot;
    finance?: FinanceSnapshot;
    inventory?: InventorySnapshot;
    queues?: {
        paid_to_dispatch?: PaidToDispatchItem[];
        inventory_alerts?: InventoryAlertItem[];
        data_quality_alerts?: DataQualityAlertItem[];
        recent_orders?: RecentOrderItem[];
    };
    agent_context?: {
        mode?: string;
        top_priorities?: PriorityItem[];
    };
};

const RANGE_OPTIONS: DashboardRange[] = [7, 30, 90];

const PRIORITY_LABELS: Record<string, string> = {
    paid_over_sla: "Despachos atrasados",
    missing_costs: "Costos faltantes",
    negative_margin: "Margen negativo",
    failed_logistics_notifications: "Notificaciones fallidas",
};

const FLAG_LABELS: Record<string, string> = {
    missing_items: "Sin items",
    missing_cogs: "Sin costo",
    missing_payment_fee: "Sin fee de recaudo registrado",
    missing_shipping_real_cost: "Sin costo envío",
    negative_contribution_margin: "Margen negativo",
};

export default function Dashboard() {
    const [range, setRange] = useState<DashboardRange>(30);
    const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
    const [watchdog, setWatchdog] = useState<OpsWatchdog | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [firstResponsePendingCount, setFirstResponsePendingCount] = useState<number>(0);

    const fetchDashboardData = useCallback(async () => {
        const to = new Date();
        const from = new Date(to.getTime() - range * 24 * 60 * 60 * 1000);

        try {
            const { data, error: rpcError } = await supabase.rpc("admin_dashboard_snapshot", {
                p_from: from.toISOString(),
                p_to: to.toISOString(),
                p_timezone: "America/Bogota",
                p_fulfillment_sla_hours: 24,
            });

            if (rpcError) throw rpcError;

            setSnapshot((data || null) as DashboardSnapshot | null);

            // La vigilancia es informativa: si falla, el dashboard sigue vivo.
            const { data: watchdogData } = await supabase.rpc("admin_ops_watchdog", {
                p_stale_receipt_hours: 2,
                p_timezone: "America/Bogota",
            });
            setWatchdog((watchdogData || null) as OpsWatchdog | null);

            // Primera respuesta pendiente: conversaciones abiertas esperando respuesta del operador.
            const { data: frpData } = await supabase
                .from("inbox_first_response_pending")
                .select("conversation_id");
            setFirstResponsePendingCount((frpData || []).length);

            setError(null);
        } catch (fetchError) {
            console.error("Error loading dashboard snapshot:", fetchError);
            setError("No se pudo cargar el snapshot operativo.");
        } finally {
            setLoading(false);
        }
    }, [range]);

    useEffect(() => {
        setLoading(true);
        fetchDashboardData();
    }, [fetchDashboardData]);

    useEffect(() => {
        const channel = supabase
            .channel("admin-dashboard-snapshot")
            .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, fetchDashboardData)
            .on("postgres_changes", { event: "*", schema: "public", table: "payments" }, fetchDashboardData)
            .on("postgres_changes", { event: "*", schema: "public", table: "shipments" }, fetchDashboardData)
            .on("postgres_changes", { event: "*", schema: "public", table: "shipment_events" }, fetchDashboardData)
            .on("postgres_changes", { event: "*", schema: "public", table: "logistics_notifications" }, fetchDashboardData)
            .on("postgres_changes", { event: "*", schema: "public", table: "order_economics" }, fetchDashboardData)
            .on("postgres_changes", { event: "*", schema: "public", table: "product_variants" }, fetchDashboardData)
            .subscribe();

        const interval = window.setInterval(fetchDashboardData, 60_000);

        return () => {
            window.clearInterval(interval);
            supabase.removeChannel(channel);
        };
    }, [fetchDashboardData]);

    const executive = snapshot?.executive || {};
    const commercial = snapshot?.commercial || {};
    const logistics = snapshot?.logistics || {};
    const finance = snapshot?.finance || {};
    const inventory = snapshot?.inventory || {};
    const queues = snapshot?.queues || {};
    const priorities = snapshot?.agent_context?.top_priorities || [];

    const healthSignals = useMemo(() => {
        const issues =
            number(logistics.paid_over_sla_count) +
            number(logistics.failed_notification_count) +
            number(finance.negative_margin_order_count) +
            number(finance.missing_cogs_order_count);

        if (issues === 0) return { label: "Normal", tone: "emerald" as const };
        if (issues <= 3) return { label: "Atención", tone: "amber" as const };
        return { label: "Crítico", tone: "red" as const };
    }, [
        finance.missing_cogs_order_count,
        finance.negative_margin_order_count,
        logistics.failed_notification_count,
        logistics.paid_over_sla_count,
    ]);

    if (loading && !snapshot) {
        return <div className="p-10 text-center text-sm text-slate-500">Cargando métricas...</div>;
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <h1 className="text-3xl font-bold">Dashboard</h1>
                    <p className="mt-1 text-sm text-slate-500">
                        {formatDateTime(snapshot?.generated_at)} · {range} días
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
                    <StatusPill tone={healthSignals.tone}>{healthSignals.label}</StatusPill>
                    <div className="flex items-center gap-2 text-sm text-slate-500">
                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                        En vivo
                    </div>
                </div>
            </div>

            {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                    {error}
                </div>
            )}

            <OpsWatchdogCard watchdog={watchdog} />

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <MetricCard
                    title="Ventas Aprobadas"
                    value={formatCents(executive.revenue_cents)}
                    icon={<DollarSign className="h-4 w-4" />}
                    subtext={formatDelta(executive.revenue_delta_bps)}
                    tone="emerald"
                />
                <MetricCard
                    title="Margen Contribución"
                    value={formatCents(executive.contribution_margin_cents)}
                    icon={<LineChart className="h-4 w-4" />}
                    subtext={formatBps(executive.contribution_margin_bps)}
                    tone={number(executive.contribution_margin_cents) < 0 ? "red" : "cyan"}
                />
                <MetricCard
                    title="Pedidos Pagados"
                    value={number(executive.paid_orders_count).toString()}
                    icon={<ShoppingBag className="h-4 w-4" />}
                    subtext={`Ticket ${formatCents(executive.average_order_value_cents)}`}
                    tone="slate"
                />
                <MetricCard
                    title="Por Despachar"
                    value={number(logistics.paid_pending_dispatch_count).toString()}
                    icon={<Truck className="h-4 w-4" />}
                    subtext={`${number(logistics.paid_over_sla_count)} fuera SLA`}
                    tone={number(logistics.paid_over_sla_count) > 0 ? "amber" : "slate"}
                />
                <MetricCard
                    title="1ª Respuesta"
                    value={number(firstResponsePendingCount).toString()}
                    icon={<MessageSquare className="h-4 w-4" />}
                    subtext="Conversaciones esperando respuesta"
                    tone={number(firstResponsePendingCount) > 0 ? "cyan" : "slate"}
                />
            </div>

            <div className="grid gap-4 xl:grid-cols-3">
                <Panel title="Embudo Comercial" icon={<MessageSquare className="h-4 w-4" />}>
                    <KpiRow label="Conversaciones abiertas" value={commercial.open_conversations_count} />
                    <KpiRow label="Mensajes entrantes" value={commercial.inbound_messages_count} />
                    <KpiRow label="Órdenes creadas" value={commercial.orders_created_count} />
                    <KpiRow label="Pedidos con ref. de pago" value={commercial.payment_links_count} />
                    <KpiRow label="Pagos aprobados" value={commercial.payments_approved_count} />
                    <KpiRow label="Aprobados / pedidos con ref." value={formatBps(commercial.link_to_approved_bps)} />
                </Panel>

                <Panel title="Logística" icon={<Truck className="h-4 w-4" />}>
                    <KpiRow label="Activos en transporte" value={logistics.active_shipments_count} />
                    <KpiRow label="Entregados" value={logistics.delivered_count} />
                    <KpiRow label="Tracking faltante" value={logistics.missing_tracking_count} tone={number(logistics.missing_tracking_count) > 0 ? "amber" : "slate"} />
                    <KpiRow label="Notificación fallida" value={logistics.failed_notification_count} tone={number(logistics.failed_notification_count) > 0 ? "red" : "slate"} />
                    <KpiRow label="Pago → despacho" value={`${number(logistics.avg_payment_to_dispatch_hours)}h`} />
                    <KpiRow label="Despacho → entrega" value={`${number(logistics.avg_dispatch_to_delivery_hours)}h`} />
                </Panel>

                <Panel title="Rentabilidad" icon={<DollarSign className="h-4 w-4" />}>
                    <KpiRow label="COGS" value={formatCents(finance.cogs_cents)} />
                    <KpiRow label="Costos variables" value={formatCents(finance.variable_cost_cents)} />
                    <KpiRow label="Costo envío" value={formatCents(finance.shipping_real_cost_cents)} />
                    <KpiRow label="Órdenes sin costo" value={finance.missing_cogs_order_count} tone={number(finance.missing_cogs_order_count) > 0 ? "amber" : "slate"} />
                    <KpiRow label="Margen negativo" value={finance.negative_margin_order_count} tone={number(finance.negative_margin_order_count) > 0 ? "red" : "slate"} />
                </Panel>
            </div>

            <div className="grid gap-4 xl:grid-cols-[1.2fr_0.9fr_0.9fr]">
                <Panel
                    title="Cola Operativa"
                    icon={<Clock3 className="h-4 w-4" />}
                    action={<Link className="text-sm font-medium text-cyan-700 hover:text-cyan-900" to="/orders">Ver órdenes</Link>}
                >
                    <div className="space-y-3">
                        {(queues.paid_to_dispatch || []).map((item) => (
                            <div key={item.order_id} className="flex items-center justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-semibold text-slate-900">
                                        {item.customer_name || "Cliente"} · {shortId(item.order_id)}
                                    </p>
                                    <p className="text-xs text-slate-500">
                                        {item.shipping_city || "Sin ciudad"} · {number(item.hours_waiting)}h
                                    </p>
                                </div>
                                <div className="text-right">
                                    <p className="text-sm font-semibold text-slate-900">{formatCents(item.total_cents)}</p>
                                    {item.over_sla && <StatusPill tone="amber">SLA</StatusPill>}
                                </div>
                            </div>
                        ))}
                        {emptyState(queues.paid_to_dispatch, "Sin despachos pendientes.")}
                    </div>
                </Panel>

                <Panel title="Inventario" icon={<Package className="h-4 w-4" />}>
                    <KpiRow label="Físico" value={inventory.physical_units} />
                    <KpiRow label="Reservado" value={inventory.reserved_units} />
                    <KpiRow label="Disponible" value={inventory.available_units} />
                    <KpiRow label="Bajo stock" value={inventory.low_stock_variants_count} tone={number(inventory.low_stock_variants_count) > 0 ? "amber" : "slate"} />
                    <KpiRow label="Agotado" value={inventory.sold_out_variants_count} tone={number(inventory.sold_out_variants_count) > 0 ? "red" : "slate"} />
                    <div className="mt-4 space-y-3 border-t pt-4">
                        {(queues.inventory_alerts || []).slice(0, 4).map((item) => (
                            <div key={item.variant_id} className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{item.brand} {item.model}</p>
                                    <p className="text-xs text-slate-500">Talla {item.size}</p>
                                </div>
                                <StatusPill tone={number(item.available) <= 0 ? "red" : "amber"}>
                                    {number(item.available)}
                                </StatusPill>
                            </div>
                        ))}
                    </div>
                </Panel>

                <Panel title="AI Ops" icon={<Bot className="h-4 w-4" />} action={<Link to="/ai-ops" className="text-sm font-medium text-cyan-700 hover:text-cyan-900">Abrir AI Ops</Link>}>
                    <div className="space-y-3">
                        {priorities.map((item) => (
                            <div key={item.key} className="flex items-center justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-slate-900">
                                        {PRIORITY_LABELS[item.key] || item.key}
                                    </p>
                                    <p className="text-xs text-slate-500">Prioridad sugerida · no ejecutada</p>
                                </div>
                                <StatusPill tone={priorityTone(item)}>{number(item.count)}</StatusPill>
                            </div>
                        ))}
                    </div>
                </Panel>
            </div>

            <div className="grid gap-4 xl:grid-cols-2">
                <Panel title="Actividad Reciente" icon={<CheckCircle2 className="h-4 w-4" />}>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="border-b text-left text-xs uppercase text-slate-500">
                                    <th className="py-3 font-medium">Orden</th>
                                    <th className="py-3 font-medium">Estado</th>
                                    <th className="py-3 text-right font-medium">Venta</th>
                                    <th className="py-3 text-right font-medium">CM</th>
                                </tr>
                            </thead>
                            <tbody>
                                {(queues.recent_orders || []).map((order) => (
                                    <tr key={order.order_id} className="border-b last:border-0">
                                        <td className="py-3 font-medium text-slate-900">{shortId(order.order_id)}</td>
                                        <td className="py-3"><StatusBadge status={order.status || "draft"} /></td>
                                        <td className="py-3 text-right">{formatCents(order.total_cents)}</td>
                                        <td className={`py-3 text-right ${number(order.contribution_margin_cents) < 0 ? "text-red-600" : "text-slate-700"}`}>
                                            {formatCents(order.contribution_margin_cents)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </Panel>

                <Panel title="Calidad De Datos" icon={<AlertTriangle className="h-4 w-4" />}>
                    <div className="space-y-3">
                        {(queues.data_quality_alerts || []).map((item) => (
                            <div key={item.order_id} className="flex items-start justify-between gap-4 border-b pb-3 last:border-0 last:pb-0">
                                <div className="min-w-0">
                                    <p className="text-sm font-semibold text-slate-900">{shortId(item.order_id)}</p>
                                    <div className="mt-1 flex flex-wrap gap-1.5">
                                        {(item.flags || []).map((flag) => (
                                            <span key={flag} className="rounded-md bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-100">
                                                {FLAG_LABELS[flag] || flag}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                                <p className="text-sm font-semibold">{formatCents(item.total_cents)}</p>
                            </div>
                        ))}
                        {emptyState(queues.data_quality_alerts, "Sin alertas de calidad.")}
                    </div>
                </Panel>
            </div>
        </div>
    );
}

function OpsWatchdogCard({ watchdog }: { watchdog: OpsWatchdog | null }) {
    if (!watchdog) return null;

    const alerts = watchdog.alerts || [];
    const today = watchdog.today || {};
    const payments = watchdog.payments || {};

    return (
        <div className="rounded-xl border bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    <Clock3 className="h-4 w-4 text-slate-500" />
                    <h2 className="text-sm font-semibold">Hoy y vigilancia</h2>
                    {alerts.length === 0 ? (
                        <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                            Todo al dia
                        </span>
                    ) : (
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                            {alerts.length} {alerts.length === 1 ? "aviso" : "avisos"}
                        </span>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
                    <span>Pedidos hoy: <strong className="text-slate-700">{number(today.orders_created)}</strong></span>
                    <span>Pagados hoy: <strong className="text-slate-700">{number(today.orders_paid)}</strong></span>
                    <span>Recaudado hoy: <strong className="text-slate-700">{formatCents(today.revenue_cents)}</strong></span>
                    <span>Por revisar: <strong className="text-slate-700">{number(payments.receipts_pending_count)}</strong></span>
                </div>
            </div>

            {alerts.length > 0 && (
                <ul className="mt-3 space-y-2">
                    {alerts.map((alert) => {
                        const link = ALERT_LINKS[alert.key];
                        return (
                            <li
                                key={alert.key}
                                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-sm"
                            >
                                <span className="flex items-center gap-2">
                                    <span
                                        className={`h-2 w-2 rounded-full ${alert.severity === "high"
                                            ? "bg-red-500"
                                            : alert.severity === "medium"
                                                ? "bg-amber-500"
                                                : "bg-slate-400"
                                            }`}
                                    />
                                    {alert.message}
                                </span>
                                {link && (
                                    <Link
                                        to={link.to}
                                        className="text-xs font-medium text-slate-600 underline-offset-2 hover:underline"
                                    >
                                        {link.label}
                                    </Link>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

function MetricCard({ title, value, icon, subtext, tone }: {
    title: string;
    value: string;
    icon: ReactNode;
    subtext: string;
    tone: "slate" | "cyan" | "emerald" | "amber" | "red";
}) {
    return (
        <div className="rounded-lg border bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-600">{title}</h3>
                <div className={`rounded-md p-2 ${toneClasses(tone).soft}`}>
                    {icon}
                </div>
            </div>
            <p className="mt-4 text-2xl font-bold text-slate-950">{value}</p>
            <p className="mt-1 text-sm text-slate-500">{subtext}</p>
        </div>
    );
}

function Panel({ title, icon, action, children }: {
    title: string;
    icon: ReactNode;
    action?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="rounded-lg border bg-white shadow-sm">
            <div className="flex items-center justify-between border-b px-5 py-4">
                <div className="flex items-center gap-2">
                    <div className="text-slate-500">{icon}</div>
                    <h2 className="text-sm font-semibold text-slate-950">{title}</h2>
                </div>
                {action}
            </div>
            <div className="p-5">{children}</div>
        </section>
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
                {typeof value === "number" ? number(value) : value}
            </span>
        </div>
    );
}

function StatusPill({ tone, children }: {
    tone: "slate" | "emerald" | "amber" | "red";
    children: ReactNode;
}) {
    return (
        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${toneClasses(tone).pill}`}>
            {children}
        </span>
    );
}

function StatusBadge({ status }: { status: string }) {
    const label: Record<string, string> = {
        draft: "Borrador",
        pending: "Pendiente",
        awaiting_payment: "Por pagar",
        paid: "Pagado",
        shipped: "Enviado",
        delivered: "Entregado",
        cancelled: "Cancelado",
    };

    const tone = status === "delivered"
        ? "emerald"
        : status === "paid"
            ? "cyan"
            : status === "shipped"
                ? "slate"
                : status === "cancelled"
                    ? "red"
                    : "amber";

    return (
        <span className={`inline-flex items-center rounded-md px-2 py-1 text-xs font-semibold ring-1 ${toneClasses(tone).pill}`}>
            {label[status] || status}
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

function priorityTone(item: PriorityItem): "slate" | "emerald" | "amber" | "red" {
    if (item.severity === "high") return "red";
    if (item.severity === "medium") return "amber";
    if (number(item.count) === 0) return "emerald";
    return "slate";
}

function emptyState<T>(items: T[] | undefined, label: string) {
    if (items && items.length > 0) return null;
    return <p className="py-4 text-center text-sm text-slate-500">{label}</p>;
}

function number(value: unknown) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function formatCents(value: unknown) {
    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(number(value) / 100);
}

function formatBps(value: unknown) {
    return `${(number(value) / 100).toFixed(1)}%`;
}

function formatDelta(value: unknown) {
    if (value === null || value === undefined) return "Sin histórico comparable";
    const parsed = number(value);
    const prefix = parsed > 0 ? "+" : "";
    return `${prefix}${(parsed / 100).toFixed(1)}% vs periodo previo`;
}

function formatDateTime(value?: string) {
    if (!value) return "Actualizando";
    return new Intl.DateTimeFormat("es-CO", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(value));
}

function shortId(value: string) {
    return `${value.slice(0, 8)}...`;
}
