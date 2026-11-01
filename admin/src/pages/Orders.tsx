import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
    DEFAULT_DELIVERY_SLA_HOURS,
    DEFAULT_FULFILLMENT_SLA_HOURS,
    slaOrDefault,
    validateTrackingUrl,
} from "@/lib/logistics";
import { AlertTriangle, CheckCircle2, Clock, Eye, PackageCheck, RefreshCw, Truck, X } from "lucide-react";

type Order = {
    id: string;
    customer_id?: string | null;
    created_at: string;
    paid_at?: string;
    status: string;
    total_cents: number;
    payment_reference?: string;
    shipping_name?: string | null;
    shipping_phone?: string | null;
    shipping_address?: string | null;
    shipping_city?: string | null;
    shipping_region?: string | null;
    tracking_number?: string;
    carrier_name?: string;
    shipped_at?: string;
    delivered_at?: string;
    customers: {
        name: string | null;
        phone_e164: string | null;
    };
    economics?: OrderEconomics | null;
};

type OrderEconomics = {
    order_id: string;
    revenue_cents: number;
    cogs_cents: number;
    variable_cost_cents: number;
    payment_fee_cents: number;
    shipping_real_cost_cents: number;
    packaging_cost_cents: number;
    discount_cents: number;
    twilio_cost_cents: number;
    ai_cost_cents: number;
    other_variable_cost_cents: number;
    contribution_margin_cents: number;
    contribution_margin_bps: number;
    data_quality_flags: string[];
};

type OrderVariableCost = {
    id: string;
    cost_type: string;
    amount_cents: number;
    source: string;
    occurred_at: string;
};

type OrderItemDetail = {
    id: string;
    qty: number;
    unit_price_cents: number;
    unit_cost_cents?: number;
    variant: {
        size: string;
        product: {
            brand: string;
            model: string;
            sku: string;
        }
    }
};

type OrderShipmentInfo = {
    tracking_url?: string | null;
    service_level?: string | null;
};

type OrderDetail = Order & {
    items?: OrderItemDetail[];
    variableCosts?: OrderVariableCost[];
    notificationAttempts?: LogisticsNotification[];
    shipment?: OrderShipmentInfo | null;
};

type LogisticsNotification = {
    id: string;
    purpose: "dispatch" | "delivery";
    status: string;
    provider: string;
    attempt_number: number;
    retry_of_notification_id?: string | null;
    provider_message_sid?: string | null;
    recipient_phone?: string | null;
    error_message?: string | null;
    created_at: string;
};

type LogisticsQueue = "all" | "paid" | "shipped" | "delivered" | "alerts";

const VARIABLE_COST_LABELS: Record<string, string> = {
    payment_fee: "Payment fee",
    shipping_real: "Shipping",
    packaging: "Packaging",
    discount: "Discount",
    twilio: "Twilio",
    openai: "OpenAI",
    other: "Other",
};

function hoursSince(value?: string) {
    if (!value) return 0;
    return Math.max(0, (Date.now() - new Date(value).getTime()) / (1000 * 60 * 60));
}

function formatCents(cents?: number | null) {
    if (cents == null) return "—";
    return `$${(cents / 100).toLocaleString('es-CO')}`;
}

function formatMarginBps(bps?: number | null) {
    if (bps == null) return "—";
    return `${(bps / 100).toFixed(1)}%`;
}

function formatAge(value?: string) {
    if (!value) return "—";
    const hours = hoursSince(value);
    if (hours < 1) return "<1h";
    if (hours < 48) return `${Math.floor(hours)}h`;
    return `${Math.floor(hours / 24)}d`;
}

function isFulfillmentOverdue(order: Order, fulfillmentSlaHours: number) {
    return order.status === "paid" && hoursSince(order.paid_at || order.created_at) >= fulfillmentSlaHours;
}

function isDeliveryOverdue(order: Order, deliverySlaHours: number) {
    return order.status === "shipped" && !order.delivered_at && hoursSince(order.shipped_at) >= deliverySlaHours;
}

function isMissingTracking(order: Order) {
    return order.status === "shipped" && (!order.carrier_name || !order.tracking_number);
}

function notificationStatusLabel(status: string) {
    switch (status) {
        case "pending": return "En proceso";
        case "queued": return "En cola";
        case "sent": return "Aceptado por Evolution";
        case "delivered": return "Entregado a WhatsApp";
        case "read": return "Leído";
        case "failed": return "Falló";
        case "undelivered": return "No entregado";
        case "unknown": return "Incierto · verificar WhatsApp";
        case "skipped": return "Omitido";
        default: return status;
    }
}

function notificationStatusClass(status: string) {
    if (status === "delivered" || status === "read") return "bg-emerald-100 text-emerald-800";
    if (status === "failed" || status === "undelivered") return "bg-red-100 text-red-800";
    if (status === "unknown") return "bg-amber-100 text-amber-900";
    if (status === "sent" || status === "queued") return "bg-blue-100 text-blue-800";
    return "bg-slate-100 text-slate-700";
}

type OrderSla = { fulfillment: number; delivery: number };

function hasLogisticsAlert(order: Order, sla: OrderSla) {
    return isFulfillmentOverdue(order, sla.fulfillment) || isDeliveryOverdue(order, sla.delivery) || isMissingTracking(order);
}

export default function Orders() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [ordersLoadError, setOrdersLoadError] = useState<string | null>(null);
    const [isLoadingOrders, setIsLoadingOrders] = useState(false);
    const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);
    const [activeQueue, setActiveQueue] = useState<LogisticsQueue>("all");

    // Dispatch State
    const [isDispatching, setIsDispatching] = useState(false);
    const [isSubmittingDispatch, setIsSubmittingDispatch] = useState(false);
    const [isSubmittingDelivery, setIsSubmittingDelivery] = useState(false);
    const [dispatchError, setDispatchError] = useState<string | null>(null);
    const [deliveryError, setDeliveryError] = useState<string | null>(null);
    const [trackingInfo, setTrackingInfo] = useState({ carrier: '', trackingNumber: '', trackingUrl: '' });
    const [sla, setSla] = useState<OrderSla>({ fulfillment: DEFAULT_FULFILLMENT_SLA_HOURS, delivery: DEFAULT_DELIVERY_SLA_HOURS });
    const [variableCostForm, setVariableCostForm] = useState({ costType: 'shipping_real', amount: '' });
    const [isAddingVariableCost, setIsAddingVariableCost] = useState(false);
    const [retryingNotificationId, setRetryingNotificationId] = useState<string | null>(null);
    const [notificationActionMessage, setNotificationActionMessage] = useState<string | null>(null);

    useEffect(() => {
        fetchOrders();
        fetchSlaSettings();
    }, []);

    async function fetchOrders() {
        setIsLoadingOrders(true);
        try {
            const { data, error } = await supabase.rpc("admin_list_orders");
            if (error || !data) {
                console.error("Error fetching orders:", error);
                setOrdersLoadError("No se pudo actualizar la cola de pedidos. Se conserva la última carga disponible; confirma los datos antes de operar.");
                return;
            }

            const rawOrderRows = data as unknown as Omit<Order, "customers" | "economics">[];
            const customerIds = [...new Set(rawOrderRows.map((order) => order.customer_id).filter((id): id is string => Boolean(id)))];
            const { data: customers, error: customersError } = customerIds.length
                ? await supabase.from("customers").select("id, name, phone_e164").in("id", customerIds)
                : { data: [], error: null };
            if (customersError || !customers) {
                console.error("Error fetching order customers:", customersError);
                setOrdersLoadError("Los pedidos se consultaron, pero no se pudo cargar el contexto de cliente. No operes con datos incompletos.");
                return;
            }
            const customersById = new Map(customers.map((customer) => [customer.id, customer]));
            const orderRows = rawOrderRows.map((order) => ({
                ...order,
                customers: order.customer_id
                    ? customersById.get(order.customer_id) ?? { name: null, phone_e164: null }
                    : { name: null, phone_e164: null },
            })) as Order[];
            const orderIds = orderRows.map((order) => order.id);

            if (orderIds.length === 0) {
                setOrders([]);
                setOrdersLoadError(null);
                return;
            }

            const { data: economics, error: economicsError } = await supabase
                .from("order_economics")
                .select("*")
                .in("order_id", orderIds);

            if (economicsError || !economics) {
                console.error("Error fetching order economics:", economicsError);
                setOrders(orderRows.map((order) => ({ ...order, economics: null })));
                setOrdersLoadError("Los pedidos se cargaron, pero falló la consulta de datos de margen. No uses esos márgenes para tomar decisiones.");
                return;
            }

            const economicsByOrder = new Map(
                (economics as OrderEconomics[]).map((economy) => [economy.order_id, economy])
            );

            setOrders(orderRows.map((order) => ({
                ...order,
                economics: economicsByOrder.get(order.id) || null,
            })));
            setOrdersLoadError(null);
        } catch (error) {
            console.error("Unexpected error fetching orders:", error);
            setOrdersLoadError("No se pudo actualizar la cola de pedidos. Se conserva la última carga disponible; confirma los datos antes de operar.");
        } finally {
            setIsLoadingOrders(false);
        }
    }

    // P1.2: el SLA se lee de `settings` (editable en /settings); 24/72 solo si
    // la BD no trae valor usable. Evita divergir de la configuración real.
    async function fetchSlaSettings() {
        const { data } = await supabase
            .from("settings")
            .select("fulfillment_sla_hours, delivery_sla_hours")
            .eq("id", 1)
            .maybeSingle();
        if (!data) return;
        setSla({
            fulfillment: slaOrDefault(data.fulfillment_sla_hours, DEFAULT_FULFILLMENT_SLA_HOURS),
            delivery: slaOrDefault(data.delivery_sla_hours, DEFAULT_DELIVERY_SLA_HOURS),
        });
    }

    async function viewOrder(order: Order) {
        setIsDispatching(false); // Reset form
        setIsSubmittingDispatch(false);
        setIsSubmittingDelivery(false);
        setDispatchError(null);
        setDeliveryError(null);
        setNotificationActionMessage(null);
        setTrackingInfo({ carrier: '', trackingNumber: '', trackingUrl: '' });
        setVariableCostForm({ costType: 'shipping_real', amount: '' });

        // Fetch items for this order
        const { data, error } = await supabase.rpc("admin_order_items_detail", {
            p_order_id: order.id,
        });

        const { data: economics } = await supabase
            .from("order_economics")
            .select("*")
            .eq("order_id", order.id)
            .maybeSingle();

        const { data: variableCosts } = await supabase
            .from("order_variable_costs")
            .select("id, cost_type, amount_cents, source, occurred_at")
            .eq("order_id", order.id)
            .order("occurred_at", { ascending: false });

        const { data: notificationAttempts } = await supabase
            .from("logistics_notifications")
            .select("id, purpose, status, provider, attempt_number, retry_of_notification_id, provider_message_sid, recipient_phone, error_message, created_at")
            .eq("order_id", order.id)
            .order("created_at", { ascending: false });

        // P1.2: la ficha muestra el enlace de rastreo guardado en `shipments`
        // (la columna que el bot lee para responder "dónde está mi pedido").
        const { data: shipmentRow } = await supabase
            .from("shipments")
            .select("tracking_url, service_level")
            .eq("order_id", order.id)
            .neq("status", "cancelled")
            .order("shipment_number", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (!error && data) {
            const items = (data as unknown as {
                id: string;
                qty: number;
                unit_price_cents: number;
                unit_cost_cents: number;
                variant_size: number | string;
                product_brand: string;
                product_model: string;
                product_sku: string;
            }[]).map((item): OrderItemDetail => ({
                id: item.id,
                qty: item.qty,
                unit_price_cents: item.unit_price_cents,
                unit_cost_cents: item.unit_cost_cents,
                variant: {
                    size: String(item.variant_size),
                    product: {
                        brand: item.product_brand,
                        model: item.product_model,
                        sku: item.product_sku,
                    },
                },
            }));

            setSelectedOrder({
                ...order,
                items,
                economics: (economics as OrderEconomics | null) || order.economics || null,
                variableCosts: (variableCosts as OrderVariableCost[] | null) || [],
                notificationAttempts: (notificationAttempts as LogisticsNotification[] | null) || [],
                shipment: (shipmentRow as OrderShipmentInfo | null) || null,
            });
        }
    }

    async function refreshNotificationAttempts(orderId: string) {
        const { data, error } = await supabase
            .from("logistics_notifications")
            .select("id, purpose, status, provider, attempt_number, retry_of_notification_id, provider_message_sid, recipient_phone, error_message, created_at")
            .eq("order_id", orderId)
            .order("created_at", { ascending: false });
        if (error) {
            console.warn("Could not refresh logistics notification attempts:", error.message);
            return;
        }
        setSelectedOrder((current) => current?.id === orderId
            ? { ...current, notificationAttempts: (data as LogisticsNotification[] | null) || [] }
            : current);
    }

    async function handleRetryNotification(notification: LogisticsNotification) {
        if (!selectedOrder || !["failed", "undelivered"].includes(notification.status)) return;
        const purpose = notification.purpose === "dispatch" ? "despacho" : "entrega";
        const confirmed = window.confirm(
            `¿Reenviar el aviso de ${purpose} por WhatsApp? Esto reenvía solo el mensaje; no repite el cambio logístico del pedido.`,
        );
        if (!confirmed) return;

        setRetryingNotificationId(notification.id);
        setNotificationActionMessage(null);
        try {
            const { data, error } = await supabase.functions.invoke("retry_logistics_notification", {
                body: {
                    notification_id: notification.id,
                    retry_request_id: crypto.randomUUID(),
                },
            });
            if (error) throw new Error(error.message || "No se pudo confirmar el reintento.");
            if (!data?.success) throw new Error(data?.code || "El reintento no fue autorizado.");

            if (data.status === "unknown" || data.status === "pending" || data.status === "queued") {
                setNotificationActionMessage("El resultado no está confirmado. Verifica WhatsApp; no vuelvas a enviarlo mientras siga incierto.");
            } else if (data.status === "failed" || data.status === "undelivered") {
                setNotificationActionMessage(`El reintento terminó en ${notificationStatusLabel(data.status)}. Revisa el detalle antes de decidir otro intento.`);
            } else {
                setNotificationActionMessage(`Estado del aviso: ${notificationStatusLabel(data.status)}.`);
            }
            await refreshNotificationAttempts(selectedOrder.id);
        } catch (retryError) {
            setNotificationActionMessage(
                `No se confirmó el resultado del reintento. Verifica WhatsApp y actualiza el pedido antes de intentar otra vez. ${retryError instanceof Error ? retryError.message : ""}`.trim(),
            );
            await refreshNotificationAttempts(selectedOrder.id);
        } finally {
            setRetryingNotificationId(null);
        }
    }

    async function handleAddVariableCost(e: React.FormEvent) {
        e.preventDefault();
        if (!selectedOrder) return;

        const amount = Number(variableCostForm.amount);
        if (!Number.isFinite(amount) || amount < 0) return;

        setIsAddingVariableCost(true);
        try {
            const { error } = await supabase
                .from("order_variable_costs")
                .insert({
                    order_id: selectedOrder.id,
                    cost_type: variableCostForm.costType,
                    amount_cents: Math.round(amount * 100),
                    source: "manual",
                });

            if (error) throw error;

            setVariableCostForm({ costType: 'shipping_real', amount: '' });
            await fetchOrders();
            await viewOrder(selectedOrder);
        } catch (err) {
            alert(err instanceof Error ? err.message : "Could not save cost");
        } finally {
            setIsAddingVariableCost(false);
        }
    }

    async function handleDispatch(e: React.FormEvent) {
        e.preventDefault();
        if (!selectedOrder) return;
        const carrier = trackingInfo.carrier.trim();
        const trackingNumber = trackingInfo.trackingNumber.trim();

        if (!carrier || !trackingNumber) {
            alert("Please fill in both Carrier and Tracking Number");
            return;
        }

        const trackingUrlCheck = validateTrackingUrl(trackingInfo.trackingUrl);
        if (!trackingUrlCheck.ok) {
            alert(trackingUrlCheck.error);
            return;
        }

        if (selectedOrder.status !== 'paid') {
            setDispatchError(`Only paid orders can be dispatched. Current status is "${selectedOrder.status}".`);
            return;
        }

        setIsSubmittingDispatch(true);
        setDispatchError(null);

        try {
            const { data, error } = await supabase.functions.invoke('dispatch_order', {
                body: {
                    order_id: selectedOrder.id,
                    carrier_name: carrier,
                    tracking_number: trackingNumber,
                    ...(trackingUrlCheck.url ? { tracking_url: trackingUrlCheck.url } : {})
                }
            });

            if (error || data?.error) {
                throw new Error(data?.error || error?.message || "Dispatch failed");
            }

            const updates = {
                status: data?.order_status || 'shipped',
                carrier_name: data?.shipment?.carrier_name || carrier,
                tracking_number: data?.shipment?.tracking_number || trackingNumber,
                shipped_at: data?.shipment?.shipped_at || new Date().toISOString()
            };

            setOrders(orders.map(o => o.id === selectedOrder.id ? { ...o, ...updates } : o));
            setSelectedOrder({
                ...selectedOrder,
                ...updates,
                shipment: {
                    ...selectedOrder.shipment,
                    tracking_url: data?.shipment?.tracking_url || trackingUrlCheck.url || null,
                },
            });
            setIsDispatching(false);
            setTrackingInfo({ carrier: '', trackingNumber: '', trackingUrl: '' });
            await refreshNotificationAttempts(selectedOrder.id);

            if (data?.notification_status === 'unknown') {
                setDispatchError("Order dispatched, but the WhatsApp result is uncertain. Verify WhatsApp before retrying.");
            } else if (data?.notification_trace_error) {
                setDispatchError(`Order dispatched, but logistics notification trace failed: ${data.notification_trace_error}`);
            } else if (data?.notification_status === 'failed') {
                setDispatchError(`Order dispatched, but WhatsApp notification failed: ${data.notification_error || "unknown error"}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Dispatch failed";
            setDispatchError(message);
        } finally {
            setIsSubmittingDispatch(false);
        }
    }

    async function handleDelivered() {
        if (!selectedOrder) return;

        if (selectedOrder.status !== 'shipped') {
            setDeliveryError(`Only shipped orders can be marked as delivered. Current status is "${selectedOrder.status}".`);
            return;
        }

        setIsSubmittingDelivery(true);
        setDeliveryError(null);

        try {
            const { data, error } = await supabase.functions.invoke('mark_order_delivered', {
                body: { order_id: selectedOrder.id }
            });

            if (error || data?.error) {
                throw new Error(data?.error || error?.message || "Delivery update failed");
            }

            const updates = {
                status: data?.order_status || 'delivered',
                delivered_at: data?.shipment?.delivered_at || new Date().toISOString()
            };

            setOrders(orders.map(o => o.id === selectedOrder.id ? { ...o, ...updates } : o));
            setSelectedOrder({ ...selectedOrder, ...updates });
            await refreshNotificationAttempts(selectedOrder.id);

            if (data?.notification_status === 'unknown') {
                setDeliveryError("Order delivered, but the WhatsApp result is uncertain. Verify WhatsApp before retrying.");
            } else if (data?.notification_trace_error) {
                setDeliveryError(`Order delivered, but logistics notification trace failed: ${data.notification_trace_error}`);
            } else if (data?.notification_status === 'failed') {
                setDeliveryError(`Order delivered, but WhatsApp notification failed: ${data.notification_error || "unknown error"}`);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : "Delivery update failed";
            setDeliveryError(message);
        } finally {
            setIsSubmittingDelivery(false);
        }
    }

    const getStatusColor = (status: string) => {
        switch (status) {
            case "paid": return "text-green-600 bg-green-100";
            case "shipped": return "text-blue-600 bg-blue-100";
            case "delivered": return "text-emerald-700 bg-emerald-100";
            case "pending_payment": return "text-yellow-600 bg-yellow-100";
            case "awaiting_payment": return "text-yellow-600 bg-yellow-100";
            case "expired": return "text-orange-600 bg-orange-100";
            case "cancelled": return "text-red-600 bg-red-100";
            default: return "text-gray-600 bg-gray-100";
        }
    };

    const paidQueue = orders.filter((order) => order.status === "paid");
    const shippedQueue = orders.filter((order) => order.status === "shipped");
    const deliveredQueue = orders.filter((order) => order.status === "delivered");
    const alertQueue = orders.filter((order) => hasLogisticsAlert(order, sla));

    const filteredOrders = orders.filter((order) => {
        switch (activeQueue) {
            case "paid":
                return order.status === "paid";
            case "shipped":
                return order.status === "shipped";
            case "delivered":
                return order.status === "delivered";
            case "alerts":
                return hasLogisticsAlert(order, sla);
            default:
                return true;
        }
    });

    const queueOptions: {
        id: LogisticsQueue;
        label: string;
        count: number;
        icon: React.ReactNode;
    }[] = [
            { id: "all", label: "Todas", count: orders.length, icon: <PackageCheck className="h-4 w-4" /> },
            { id: "paid", label: "Por despachar", count: paidQueue.length, icon: <Clock className="h-4 w-4" /> },
            { id: "shipped", label: "Enviadas", count: shippedQueue.length, icon: <Truck className="h-4 w-4" /> },
            { id: "delivered", label: "Entregadas", count: deliveredQueue.length, icon: <CheckCircle2 className="h-4 w-4" /> },
            { id: "alerts", label: "Alertas", count: alertQueue.length, icon: <AlertTriangle className="h-4 w-4" /> },
        ];

    const notificationAttempts = selectedOrder?.notificationAttempts || [];
    const latestNotificationByPurpose = new Map<string, LogisticsNotification>();
    for (const attempt of notificationAttempts) {
        const current = latestNotificationByPurpose.get(attempt.purpose);
        if (!current || attempt.attempt_number > current.attempt_number
            || (attempt.attempt_number === current.attempt_number && attempt.created_at > current.created_at)) {
            latestNotificationByPurpose.set(attempt.purpose, attempt);
        }
    }

    const getLogisticsSummary = (order: Order) => {
        if (order.status === "paid") {
            return {
                title: "Pendiente de despacho",
                detail: `Pagada hace ${formatAge(order.paid_at || order.created_at)}`,
            };
        }

        if (order.status === "shipped") {
            return {
                title: order.tracking_number || "Tracking faltante",
                detail: `${order.carrier_name || "Sin transportadora"} · ${formatAge(order.shipped_at)} en tránsito`,
            };
        }

        if (order.status === "delivered") {
            return {
                title: "Entregada",
                detail: `Cerrada hace ${formatAge(order.delivered_at)}`,
            };
        }

        return {
            title: "Sin etapa logística",
            detail: `Creada hace ${formatAge(order.created_at)}`,
        };
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Orders</h2>
                    <p className="text-sm text-muted-foreground">Fulfillment queue</p>
                </div>
                <button
                    onClick={fetchOrders}
                    disabled={isLoadingOrders}
                    className="self-start rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 sm:self-auto"
                >
                    {isLoadingOrders ? "Refreshing..." : "Refresh"}
                </button>
            </div>

            {ordersLoadError && (
                <div role="alert" className="flex items-start justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                    <span>{ordersLoadError}</span>
                    <button type="button" onClick={fetchOrders} disabled={isLoadingOrders} className="shrink-0 font-semibold underline disabled:opacity-60">
                        Reintentar
                    </button>
                </div>
            )}

            <div className="grid gap-3 md:grid-cols-4">
                <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-muted-foreground">Por despachar</p>
                        <Clock className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="mt-2 text-2xl font-semibold">{paidQueue.length}</p>
                    <p className="text-xs text-muted-foreground">{paidQueue.filter((order) => isFulfillmentOverdue(order, sla.fulfillment)).length} sobre SLA</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-muted-foreground">Enviadas</p>
                        <Truck className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="mt-2 text-2xl font-semibold">{shippedQueue.length}</p>
                    <p className="text-xs text-muted-foreground">{shippedQueue.filter(isMissingTracking).length} sin tracking completo</p>
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium text-muted-foreground">Entregadas</p>
                        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                    </div>
                    <p className="mt-2 text-2xl font-semibold">{deliveredQueue.length}</p>
                    <p className="text-xs text-muted-foreground">Cerradas</p>
                </div>
                <div className={cn(
                    "rounded-lg border p-4",
                    alertQueue.length > 0 ? "border-amber-200 bg-amber-50 text-amber-950" : "border-border bg-card"
                )}>
                    <div className="flex items-center justify-between">
                        <p className="text-sm font-medium">Alertas</p>
                        <AlertTriangle className="h-4 w-4" />
                    </div>
                    <p className="mt-2 text-2xl font-semibold">{alertQueue.length}</p>
                    <p className="text-xs opacity-75">SLA, tracking y atrasos</p>
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                {queueOptions.map((option) => (
                    <button
                        key={option.id}
                        type="button"
                        onClick={() => setActiveQueue(option.id)}
                        className={cn(
                            "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                            activeQueue === option.id
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border bg-background hover:bg-muted"
                        )}
                    >
                        {option.icon}
                        <span>{option.label}</span>
                        <span className={cn(
                            "rounded-full px-2 py-0.5 text-xs",
                            activeQueue === option.id ? "bg-primary-foreground/20" : "bg-muted"
                        )}>
                            {option.count}
                        </span>
                    </button>
                ))}
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                        <tr>
                            <th className="px-6 py-3">Order ID</th>
                            <th className="px-6 py-3">Customer</th>
                            <th className="px-6 py-3">Date</th>
                            <th className="px-6 py-3">Status</th>
                            <th className="px-6 py-3">Logistics</th>
                            <th className="px-6 py-3 text-right">Total</th>
                            <th className="px-6 py-3 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredOrders.length === 0 ? (
                            <tr>
                                <td colSpan={7} className="px-6 py-4 text-center text-muted-foreground">
                                    {ordersLoadError ? "No se pudo confirmar la lista de pedidos; reintenta." : "No orders found"}
                                </td>
                            </tr>
                        ) : (
                            filteredOrders.map((order) => {
                                const logistics = getLogisticsSummary(order);
                                const fulfillmentOverdue = isFulfillmentOverdue(order, sla.fulfillment);
                                const deliveryOverdue = isDeliveryOverdue(order, sla.delivery);
                                const missingTracking = isMissingTracking(order);

                                return (
                                <tr key={order.id} className="bg-background border-b border-border hover:bg-muted/50">
                                    <td className="px-6 py-4 font-medium truncate max-w-[150px]" title={order.id}>
                                        {order.id.substring(0, 8)}...
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="font-medium">{order.customers?.name || "Unknown"}</div>
                                        <div className="text-xs text-muted-foreground">{order.customers?.phone_e164}</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        {new Date(order.created_at).toLocaleDateString()}
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className={cn("px-2 py-1 rounded-full text-xs font-semibold uppercase", getStatusColor(order.status))}>
                                            {order.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="font-medium">{logistics.title}</div>
                                        <div className="text-xs text-muted-foreground">{logistics.detail}</div>
                                        <div className="mt-2 flex flex-wrap gap-1">
                                            {fulfillmentOverdue && (
                                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                                                    +{sla.fulfillment}h sin despacho
                                                </span>
                                            )}
                                            {deliveryOverdue && (
                                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                                                    +{sla.delivery}h sin entrega
                                                </span>
                                            )}
                                            {missingTracking && (
                                                <span className="rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
                                                    tracking faltante
                                                </span>
                                            )}
                                        </div>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        <div className="font-medium">{formatCents(order.total_cents)}</div>
                                        {order.economics && (
                                            <div className={cn(
                                                "text-xs",
                                                order.economics.contribution_margin_cents < 0 ? "text-red-600" : "text-muted-foreground"
                                            )}>
                                                CM {formatCents(order.economics.contribution_margin_cents)} · {formatMarginBps(order.economics.contribution_margin_bps)}
                                            </div>
                                        )}
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        <button
                                            onClick={() => viewOrder(order)}
                                            className="text-primary hover:text-primary/80 transition-colors"
                                            title="View Details"
                                        >
                                            <Eye className="w-5 h-5" />
                                        </button>
                                    </td>
                                </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* Order Detail Modal */}
            {selectedOrder && (
                <div className="fixed inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-card border border-border w-full max-w-2xl rounded-lg shadow-lg flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 duration-200">
                        <div className="p-6 border-b border-border flex justify-between items-center">
                            <div>
                                <h3 className="text-lg font-semibold flex items-center gap-2">
                                    Order Details
                                    {selectedOrder.status === 'shipped' && <Truck className="w-5 h-5 text-blue-500" />}
                                </h3>
                                <p className="text-sm text-muted-foreground">ID: {selectedOrder.id}</p>
                            </div>
                            <button onClick={() => setSelectedOrder(null)} className="p-2 hover:bg-muted rounded-full">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 overflow-y-auto space-y-6">
                            {dispatchError && !isDispatching && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
                                    {dispatchError}
                                </div>
                            )}
                            {deliveryError && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
                                    {deliveryError}
                                </div>
                            )}
                            {notificationActionMessage && (
                                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-300">
                                    {notificationActionMessage}
                                </div>
                            )}

                            {/* WhatsApp logistics notification attempts */}
                            <section className="rounded-lg border border-border bg-card p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <div>
                                        <h4 className="font-semibold">WhatsApp logistics notices</h4>
                                        <p className="text-xs text-muted-foreground">Evolution delivery evidence and explicit retries</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => refreshNotificationAttempts(selectedOrder.id)}
                                        className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                                    >
                                        <RefreshCw className="h-3.5 w-3.5" /> Refresh
                                    </button>
                                </div>
                                <div className="mt-3 space-y-3">
                                    {notificationAttempts.length === 0 ? (
                                        <p className="text-sm text-muted-foreground">No WhatsApp logistics notices recorded.</p>
                                    ) : notificationAttempts.map((attempt) => {
                                        const latest = latestNotificationByPurpose.get(attempt.purpose)?.id === attempt.id;
                                        const retryable = latest && ["failed", "undelivered"].includes(attempt.status);
                                        const stalePending = ["pending", "queued"].includes(attempt.status)
                                            && Date.now() - new Date(attempt.created_at).getTime() >= 90_000;
                                        const statusLabel = stalePending
                                            ? "Incierto · verificar WhatsApp"
                                            : notificationStatusLabel(attempt.status);
                                        const purposeLabel = attempt.purpose === "dispatch" ? "Despacho" : "Entrega";

                                        return (
                                            <div key={attempt.id} className="rounded-md border border-border p-3">
                                                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                                                    <div className="min-w-0 space-y-1">
                                                        <div className="flex flex-wrap items-center gap-2">
                                                            <span className="font-medium">Aviso de {purposeLabel}</span>
                                                            <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${notificationStatusClass(stalePending ? "unknown" : attempt.status)}`}>
                                                                {statusLabel}
                                                            </span>
                                                            <span className="text-xs text-muted-foreground">Intento #{attempt.attempt_number} · {attempt.provider}</span>
                                                        </div>
                                                        <p className="text-xs text-muted-foreground">
                                                            {new Date(attempt.created_at).toLocaleString()} · {attempt.recipient_phone || "sin teléfono"}
                                                        </p>
                                                        {attempt.provider_message_sid && (
                                                            <p className="break-all font-mono text-[11px] text-muted-foreground">ID proveedor: {attempt.provider_message_sid}</p>
                                                        )}
                                                        {attempt.error_message && (
                                                            <p className="break-words text-xs text-red-700 dark:text-red-300">{attempt.error_message}</p>
                                                        )}
                                                        {attempt.status === "unknown" || stalePending ? (
                                                            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
                                                                Confirma manualmente si llegó. No se reintentará automáticamente.
                                                            </p>
                                                        ) : null}
                                                    </div>
                                                    {retryable && (
                                                        <button
                                                            type="button"
                                                            disabled={retryingNotificationId !== null}
                                                            onClick={() => handleRetryNotification(attempt)}
                                                            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                                                        >
                                                            <RefreshCw className={`h-3.5 w-3.5 ${retryingNotificationId === attempt.id ? "animate-spin" : ""}`} />
                                                            {retryingNotificationId === attempt.id ? "Reintentando..." : "Reenviar aviso"}
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>

                            {/* Actions / Dispatch Bar */}
                            {selectedOrder.status === 'paid' && !isDispatching && (
                                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg flex justify-between items-center border border-blue-100 dark:border-blue-900/30">
                                    <div>
                                        <h4 className="font-semibold text-blue-900 dark:text-blue-300">Ready for Dispatch</h4>
                                        <p className="text-sm text-blue-700 dark:text-blue-400">Payment confirmed. Generate tracking info.</p>
                                    </div>
                                    <button
                                        onClick={() => {
                                            setDispatchError(null);
                                            setIsDispatching(true);
                                        }}
                                        className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700 flex items-center gap-2"
                                    >
                                        <Truck className="w-4 h-4" />
                                        Dispatch Order
                                    </button>
                                </div>
                            )}

                            {/* Mark as Delivered Bar */}
                            {selectedOrder.status === 'shipped' && (
                                <div className="bg-emerald-50 dark:bg-emerald-900/20 p-4 rounded-lg flex justify-between items-center border border-emerald-100 dark:border-emerald-900/30">
                                    <div>
                                        <h4 className="font-semibold text-emerald-900 dark:text-emerald-300">In Transit</h4>
                                        <p className="text-sm text-emerald-700 dark:text-emerald-400">
                                            Tracking: {selectedOrder.tracking_number} ({selectedOrder.carrier_name})
                                            {selectedOrder.shipment?.tracking_url && (
                                                <>
                                                    {" · "}
                                                    <a href={selectedOrder.shipment.tracking_url} target="_blank" rel="noreferrer" className="underline hover:no-underline">
                                                        Rastrear envío
                                                    </a>
                                                </>
                                            )}
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleDelivered}
                                        disabled={isSubmittingDelivery}
                                        className="bg-emerald-600 text-white px-4 py-2 rounded-md hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60 flex items-center gap-2"
                                    >
                                        <CheckCircle2 className="w-4 h-4" />
                                        {isSubmittingDelivery ? "Marking..." : "Mark as Delivered"}
                                    </button>
                                </div>
                            )}

                            {/* Delivered Success Banner */}
                            {selectedOrder.status === 'delivered' && (
                                <div className="bg-emerald-100 dark:bg-emerald-900/30 p-4 rounded-lg border border-emerald-200 dark:border-emerald-800">
                                    <h4 className="font-semibold text-emerald-800 dark:text-emerald-300 flex items-center gap-2">
                                        ✓ Order Delivered
                                    </h4>
                                    <p className="text-sm text-emerald-700 dark:text-emerald-400">
                                        This order has been completed successfully.
                                    </p>
                                </div>
                            )}

                            {/* Dispatch Form */}
                            {isDispatching && (
                                <form onSubmit={handleDispatch} className="bg-muted p-4 rounded-lg space-y-4 border border-border">
                                    <h4 className="font-semibold flex items-center gap-2">
                                        <Truck className="w-4 h-4" /> Shipping Details
                                    </h4>
                                    {dispatchError && (
                                        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-300">
                                            {dispatchError}
                                        </div>
                                    )}
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Carrier (Transportadora)</label>
                                            <select
                                                required
                                                disabled={isSubmittingDispatch}
                                                className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                                value={trackingInfo.carrier}
                                                onChange={e => setTrackingInfo({ ...trackingInfo, carrier: e.target.value })}
                                            >
                                                <option value="">Select Carrier...</option>
                                                <option value="Servientrega">Servientrega</option>
                                                <option value="Coordinadora">Coordinadora</option>
                                                <option value="Interrapidisimo">Interrapidisimo</option>
                                                <option value="Deprisa">Deprisa</option>
                                                <option value="Envía">Envía</option>
                                                <option value="FedEx">FedEx</option>
                                            </select>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Tracking # (Guía)</label>
                                            <input
                                                required
                                                disabled={isSubmittingDispatch}
                                                type="text"
                                                placeholder="e.g. 192837465"
                                                className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                                value={trackingInfo.trackingNumber}
                                                onChange={e => setTrackingInfo({ ...trackingInfo, trackingNumber: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-sm font-medium">Tracking URL (enlace de seguimiento, opcional)</label>
                                        <input
                                            disabled={isSubmittingDispatch}
                                            type="text"
                                            inputMode="url"
                                            placeholder="https://rastreo.transportadora.com/guia/192837465"
                                            className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                            value={trackingInfo.trackingUrl}
                                            onChange={e => setTrackingInfo({ ...trackingInfo, trackingUrl: e.target.value })}
                                        />
                                        <p className="text-xs text-muted-foreground">
                                            El bot usará este enlace cuando el cliente pregunte por su pedido. Déjalo vacío si la transportadora no genera enlace.
                                        </p>
                                    </div>
                                    <div className="flex justify-end gap-2">
                                        <button
                                            type="button"
                                            disabled={isSubmittingDispatch}
                                            onClick={() => {
                                                setDispatchError(null);
                                                setIsDispatching(false);
                                            }}
                                            className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={isSubmittingDispatch}
                                            className="bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 disabled:opacity-60 flex items-center gap-2"
                                        >
                                            {isSubmittingDispatch ? "Dispatching..." : "Confirm Dispatch"}
                                        </button>
                                    </div>
                                </form>
                            )}

                            {/* Shipped Status Info */}
                            {selectedOrder.status === 'shipped' && (
                                <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg border border-green-100 dark:border-green-900/30">
                                    <h4 className="font-semibold text-green-900 dark:text-green-300 flex items-center gap-2">
                                        <Truck className="w-4 h-4" /> Order Shipped
                                    </h4>
                                    <div className="mt-2 grid grid-cols-2 gap-4 text-sm">
                                        <div>
                                            <span className="block text-muted-foreground text-xs uppercase">Carrier</span>
                                            <span className="font-medium">{selectedOrder.carrier_name}</span>
                                        </div>
                                        <div>
                                            <span className="block text-muted-foreground text-xs uppercase">Tracking Number</span>
                                            <span className="font-mono">{selectedOrder.tracking_number}</span>
                                        </div>
                                        {selectedOrder.shipment?.tracking_url && (
                                            <div className="col-span-2">
                                                <span className="block text-muted-foreground text-xs uppercase">Tracking URL</span>
                                                <a
                                                    href={selectedOrder.shipment.tracking_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="font-medium text-blue-600 hover:underline break-all"
                                                >
                                                    {selectedOrder.shipment.tracking_url}
                                                </a>
                                            </div>
                                        )}
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-2">Shipped at: {new Date(selectedOrder.shipped_at!).toLocaleString()}</p>
                                </div>
                            )}

                            {/* Customer Info */}
                            <div className="grid grid-cols-2 gap-4 bg-muted/30 p-4 rounded-lg">
                                <div>
                                    <p className="text-xs font-medium text-muted-foreground uppercase">Cliente (chat)</p>
                                    <p className="font-medium">{selectedOrder.customers?.name}</p>
                                    <p className="text-sm text-muted-foreground">{selectedOrder.customers?.phone_e164}</p>
                                </div>
                                <div className="text-right">
                                    <p className="text-xs font-medium text-muted-foreground uppercase">Status</p>
                                    <span className={cn("px-2 py-1 rounded-full text-xs font-semibold inline-block mt-1 uppercase", getStatusColor(selectedOrder.status))}>
                                        {selectedOrder.status}
                                    </span>
                                    <p className="text-xs text-muted-foreground mt-1">Ref: {selectedOrder.id.slice(0, 8)}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-medium text-muted-foreground uppercase">Destinatario (BD)</p>
                                    <p className="font-medium">{selectedOrder.shipping_name?.trim() || selectedOrder.customers?.name}</p>
                                    <p className="text-sm text-muted-foreground">{selectedOrder.shipping_phone?.trim() || selectedOrder.customers?.phone_e164}</p>
                                </div>
                                <div>
                                    <p className="text-xs font-medium text-muted-foreground uppercase">Dirección de envío</p>
                                    <p className="font-medium">{selectedOrder.shipping_address?.trim() || "—"}</p>
                                    <p className="text-sm text-muted-foreground">
                                        {[selectedOrder.shipping_city?.trim(), selectedOrder.shipping_region?.trim()].filter(Boolean).join(", ") || "—"}
                                    </p>
                                </div>
                            </div>

                            {/* Unit Economics */}
                            {selectedOrder.economics && (
                                <div className="border border-border rounded-lg overflow-hidden">
                                    <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                                        <h4 className="font-medium">Unit Economics</h4>
                                        <span className={cn(
                                            "text-sm font-semibold",
                                            selectedOrder.economics.contribution_margin_cents < 0 ? "text-red-600" : "text-emerald-600"
                                        )}>
                                            {formatCents(selectedOrder.economics.contribution_margin_cents)} · {formatMarginBps(selectedOrder.economics.contribution_margin_bps)}
                                        </span>
                                    </div>
                                    <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border text-sm">
                                        {[
                                            ["Revenue", selectedOrder.economics.revenue_cents],
                                            ["COGS", selectedOrder.economics.cogs_cents],
                                            ["Variable", selectedOrder.economics.variable_cost_cents],
                                            ["Payment fee", selectedOrder.economics.payment_fee_cents],
                                        ].map(([label, value]) => (
                                            <div key={label} className="bg-card p-3">
                                                <div className="text-xs text-muted-foreground uppercase">{label}</div>
                                                <div className="font-mono font-medium">{formatCents(value as number)}</div>
                                            </div>
                                        ))}
                                    </div>
                                    {selectedOrder.economics.data_quality_flags.length > 0 && (
                                        <div className="px-4 py-3 bg-amber-50 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                                            {selectedOrder.economics.data_quality_flags.join(" · ")}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Variable Costs */}
                            <div className="border border-border rounded-lg overflow-hidden">
                                <div className="px-4 py-3 border-b border-border">
                                    <h4 className="font-medium">Variable Costs</h4>
                                </div>
                                <div className="divide-y divide-border">
                                    {(selectedOrder.variableCosts || []).length === 0 ? (
                                        <div className="px-4 py-3 text-sm text-muted-foreground">No variable costs recorded</div>
                                    ) : selectedOrder.variableCosts?.map((cost) => (
                                        <div key={cost.id} className="px-4 py-3 flex items-center justify-between text-sm">
                                            <div>
                                                <div className="font-medium">{VARIABLE_COST_LABELS[cost.cost_type] || cost.cost_type}</div>
                                                <div className="text-xs text-muted-foreground">{cost.source}</div>
                                            </div>
                                            <div className="font-mono">{formatCents(cost.amount_cents)}</div>
                                        </div>
                                    ))}
                                </div>
                                <form onSubmit={handleAddVariableCost} className="grid grid-cols-1 sm:grid-cols-[1fr_140px_auto] gap-2 p-4 border-t border-border bg-muted/20">
                                    <select
                                        className="px-3 py-2 rounded-md border border-input bg-background text-sm"
                                        value={variableCostForm.costType}
                                        onChange={(e) => setVariableCostForm({ ...variableCostForm, costType: e.target.value })}
                                        disabled={isAddingVariableCost}
                                    >
                                        {Object.entries(VARIABLE_COST_LABELS)
                                            .filter(([key]) => key !== "payment_fee")
                                            .map(([key, label]) => (
                                                <option key={key} value={key}>{label}</option>
                                            ))}
                                    </select>
                                    <input
                                        type="number"
                                        min="0"
                                        placeholder="COP"
                                        className="px-3 py-2 rounded-md border border-input bg-background text-sm"
                                        value={variableCostForm.amount}
                                        onChange={(e) => setVariableCostForm({ ...variableCostForm, amount: e.target.value })}
                                        disabled={isAddingVariableCost}
                                    />
                                    <button
                                        type="submit"
                                        disabled={isAddingVariableCost || !variableCostForm.amount}
                                        className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm hover:bg-primary/90 disabled:opacity-50"
                                    >
                                        Add
                                    </button>
                                </form>
                            </div>

                            {/* Items Table */}
                            <div>
                                <h4 className="font-medium mb-3">Items Purchased</h4>
                                <div className="border border-border rounded-lg overflow-hidden">
                                    <table className="w-full text-sm">
                                        <thead className="bg-muted/50 text-xs uppercase text-muted-foreground">
                                            <tr>
                                                <th className="px-4 py-2 text-left">Product</th>
                                                <th className="px-4 py-2 text-center">Size</th>
                                                <th className="px-4 py-2 text-center">Qty</th>
                                                <th className="px-4 py-2 text-right">Price</th>
                                                <th className="px-4 py-2 text-right">Cost</th>
                                                <th className="px-4 py-2 text-right">Subtotal</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border">
                                            {selectedOrder.items?.map((item) => (
                                                <tr key={item.id} className="bg-card">
                                                    <td className="px-4 py-3">
                                                        <div className="font-medium">{item.variant.product.model}</div>
                                                        <div className="text-xs text-muted-foreground">{item.variant.product.brand} • {item.variant.product.sku}</div>
                                                    </td>
                                                    <td className="px-4 py-3 text-center font-mono">{item.variant.size}</td>
                                                    <td className="px-4 py-3 text-center">{item.qty}</td>
                                                    <td className="px-4 py-3 text-right text-muted-foreground">
                                                        {formatCents(item.unit_price_cents)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-muted-foreground">
                                                        {formatCents(item.unit_cost_cents)}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-medium">
                                                        {formatCents(item.unit_price_cents * item.qty)}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot className="bg-muted/50 font-medium">
                                            <tr>
                                                <td colSpan={5} className="px-4 py-3 text-right">Total</td>
                                                <td className="px-4 py-3 text-right text-lg">
                                                    {formatCents(selectedOrder.total_cents)}
                                                </td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
