import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Eye, X, Truck } from "lucide-react";

type Order = {
    id: string;
    created_at: string;
    status: string;
    total_cents: number;
    payment_reference?: string;
    tracking_number?: string;
    carrier_name?: string;
    shipped_at?: string;
    customers: {
        name: string;
        phone_e164: string;
    };
};

type OrderDetail = Order & {
    items?: {
        id: string;
        qty: number;
        unit_price_cents: number;
        variant: {
            size: string;
            product: {
                brand: string;
                model: string;
                sku: string;
            }
        }
    }[]
};

export default function Orders() {
    const [orders, setOrders] = useState<Order[]>([]);
    const [selectedOrder, setSelectedOrder] = useState<OrderDetail | null>(null);

    // Dispatch State
    const [isDispatching, setIsDispatching] = useState(false);
    const [trackingInfo, setTrackingInfo] = useState({ carrier: '', trackingNumber: '' });

    useEffect(() => {
        fetchOrders();
    }, []);

    async function fetchOrders() {
        const { data } = await supabase
            .from("orders")
            .select(`
                *,
                customers (
                    name,
                    phone_e164
                )
            `)
            .order("created_at", { ascending: false });
        if (data) setOrders(data as Order[]);
    }

    async function viewOrder(order: Order) {
        setIsDispatching(false); // Reset form
        setTrackingInfo({ carrier: '', trackingNumber: '' });

        // Fetch items for this order
        const { data, error } = await supabase
            .from("order_items")
            .select(`
                id, qty, unit_price_cents,
                variant:product_variants (
                    size,
                    product:products (
                        brand, model, sku
                    )
                )
            `)
            .eq("order_id", order.id);

        if (!error && data) {
            setSelectedOrder({ ...order, items: data as any });
        }
    }

    async function handleDispatch(e: React.FormEvent) {
        e.preventDefault();
        if (!selectedOrder) return;
        if (!trackingInfo.carrier || !trackingInfo.trackingNumber) {
            alert("Please fill in both Carrier and Tracking Number");
            return;
        }

        // ============================================================
        // OPTIMISTIC UI PATTERN (Industry Standard for Distributed Systems)
        // ============================================================
        // 1. IMMEDIATELY update local state to reflect "shipped" status.
        // 2. Close the dispatch form.
        // 3. Fire-and-forget the Edge Function call (NO await).
        // ============================================================

        const updates = {
            status: 'shipped',
            carrier_name: trackingInfo.carrier,
            tracking_number: trackingInfo.trackingNumber,
            shipped_at: new Date().toISOString()
        };

        // Instant UI feedback
        setOrders(orders.map(o => o.id === selectedOrder.id ? { ...o, ...updates } : o));
        setSelectedOrder({ ...selectedOrder, ...updates });
        setIsDispatching(false);
        setTrackingInfo({ carrier: '', trackingNumber: '' });

        // Background execution (fire-and-forget)
        console.log("Dispatching order in background...");
        supabase.functions.invoke('dispatch_order', {
            body: {
                order_id: selectedOrder.id,
                carrier_name: trackingInfo.carrier,
                tracking_number: trackingInfo.trackingNumber
            }
        }).then(({ data, error }) => {
            if (error || data?.error) {
                console.error("Background dispatch error (logged for monitoring):", error || data?.error);
                // In production, you might send this to a monitoring service (Sentry, etc.)
            } else if (data?.notification_status === 'failed') {
                console.warn("WhatsApp notification failed (24h window or Sandbox):", data.notification_error);
            } else {
                console.log("Dispatch completed successfully in background.");
            }
        }).catch(err => {
            console.error("Network error during background dispatch:", err);
        });
    }

    async function handleDelivered() {
        if (!selectedOrder) return;

        // OPTIMISTIC UI PATTERN
        const updates = {
            status: 'delivered',
            delivered_at: new Date().toISOString()
        };

        // Instant UI feedback
        setOrders(orders.map(o => o.id === selectedOrder.id ? { ...o, ...updates } : o));
        setSelectedOrder({ ...selectedOrder, ...updates });

        // Background: Update database
        supabase.from("orders")
            .update(updates)
            .eq("id", selectedOrder.id)
            .then(({ error }) => {
                if (error) {
                    console.error("Error updating order to delivered:", error);
                } else {
                    console.log("Order marked as delivered successfully");
                }
            });

        // Background: Send WhatsApp notification
        const customerPhone = selectedOrder.customers?.phone_e164;
        if (customerPhone) {
            const msg = `✅ *¡Pedido entregado!*\n\nHola ${selectedOrder.customers?.name || 'Cliente'}, tu pedido ha sido entregado exitosamente.\n\n¡Gracias por tu compra en SportBot! 🎉\n\n¿Todo llegó bien? Si tienes alguna pregunta, estamos aquí para ayudarte. 👟`;

            supabase.functions.invoke('admin_actions', {
                body: { action: 'send_whatsapp', payload: { phone: customerPhone, message: msg } }
            }).catch(err => console.error("WhatsApp notification error:", err));
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

    return (
        <div className="space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-3xl font-bold tracking-tight">Orders</h2>
            </div>

            <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                        <tr>
                            <th className="px-6 py-3">Order ID</th>
                            <th className="px-6 py-3">Customer</th>
                            <th className="px-6 py-3">Date</th>
                            <th className="px-6 py-3">Status</th>
                            <th className="px-6 py-3 text-right">Total</th>
                            <th className="px-6 py-3 text-center">Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orders.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-6 py-4 text-center text-muted-foreground">No orders found</td>
                            </tr>
                        ) : (
                            orders.map((order) => (
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
                                    <td className="px-6 py-4 text-right">
                                        ${(order.total_cents / 100).toLocaleString('es-CO')}
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
                            ))
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
                            {/* Actions / Dispatch Bar */}
                            {selectedOrder.status === 'paid' && !isDispatching && (
                                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg flex justify-between items-center border border-blue-100 dark:border-blue-900/30">
                                    <div>
                                        <h4 className="font-semibold text-blue-900 dark:text-blue-300">Ready for Dispatch</h4>
                                        <p className="text-sm text-blue-700 dark:text-blue-400">Payment confirmed. Generate tracking info.</p>
                                    </div>
                                    <button
                                        onClick={() => setIsDispatching(true)}
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
                                        </p>
                                    </div>
                                    <button
                                        onClick={handleDelivered}
                                        className="bg-emerald-600 text-white px-4 py-2 rounded-md hover:bg-emerald-700 flex items-center gap-2"
                                    >
                                        ✓ Mark as Delivered
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
                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium">Carrier (Transportadora)</label>
                                            <select
                                                required
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
                                                type="text"
                                                placeholder="e.g. 192837465"
                                                className="w-full px-3 py-2 rounded-md border border-input bg-background"
                                                value={trackingInfo.trackingNumber}
                                                onChange={e => setTrackingInfo({ ...trackingInfo, trackingNumber: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                    <div className="flex justify-end gap-2">
                                        <button
                                            type="button"
                                            onClick={() => setIsDispatching(false)}
                                            className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            className="bg-primary text-primary-foreground px-4 py-2 rounded-md hover:bg-primary/90 flex items-center gap-2"
                                        >
                                            Confirm Dispatch
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
                                    </div>
                                    <p className="text-xs text-muted-foreground mt-2">Shipped at: {new Date(selectedOrder.shipped_at!).toLocaleString()}</p>
                                </div>
                            )}

                            {/* Customer Info */}
                            <div className="grid grid-cols-2 gap-4 bg-muted/30 p-4 rounded-lg">
                                <div>
                                    <p className="text-xs font-medium text-muted-foreground uppercase">Customer</p>
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
                                                        ${(item.unit_price_cents / 100).toLocaleString('es-CO')}
                                                    </td>
                                                    <td className="px-4 py-3 text-right font-medium">
                                                        ${((item.unit_price_cents * item.qty) / 100).toLocaleString('es-CO')}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                        <tfoot className="bg-muted/50 font-medium">
                                            <tr>
                                                <td colSpan={4} className="px-4 py-3 text-right">Total</td>
                                                <td className="px-4 py-3 text-right text-lg">
                                                    ${(selectedOrder.total_cents / 100).toLocaleString('es-CO')}
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
