import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import {
    ShoppingBag,
    DollarSign,
    ArrowUpRight,
    Package,
    AlertTriangle
} from "lucide-react";

export default function Dashboard() {
    const [stats, setStats] = useState({
        totalCustomers: 0,
        totalOrders: 0,
        totalRevenue: 0,
        activeConversations: 0,
        totalInventory: 0,
        lowStockCount: 0
    });

    const [recentOrders, setRecentOrders] = useState<any[]>([]);
    const [lowStockItems, setLowStockItems] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchDashboardData();

        // Real-time Subscription for New Orders
        const ordersChannel = supabase
            .channel('dashboard-orders')
            .on(
                'postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'orders' },
                (payload) => {
                    console.log('New Order Received!', payload);
                    // Optimistic update or re-fetch
                    fetchDashboardData();
                    // Optional: sound or toast here
                }
            )
            .subscribe();

        return () => {
            supabase.removeChannel(ordersChannel);
        };
    }, []);

    async function fetchDashboardData() {
        try {
            // 1. Get Core Stats
            const [
                { count: customerCount },
                { count: orderCount },
                { data: revenueData },
                { count: convCount },
                { data: inventoryData },
                { data: activeOrders }
            ] = await Promise.all([
                supabase.from('customers').select('*', { count: 'exact', head: true }),
                supabase.from('orders').select('*', { count: 'exact', head: true }),
                supabase.from('orders').select('total_cents').in('status', ['paid', 'shipped']),
                supabase.from('conversations').select('*', { count: 'exact', head: true }).eq('status', 'open'),
                supabase.from('product_variants').select('id, stock, size, products(brand, model)'),
                supabase.from("orders").select('id, order_items ( variant_id, qty )').in('status', ['paid', 'processing'])
            ]);

            // 2. Calculate Committed Stock Map
            const committedMap: Record<string, number> = {};
            activeOrders?.forEach((order: any) => {
                order.order_items.forEach((item: any) => {
                    committedMap[item.variant_id] = (committedMap[item.variant_id] || 0) + item.qty;
                });
            });

            // 3. Process Inventory Metrics
            let totalPhysicalUnits = 0;
            const processedInventory = inventoryData?.map((item: any) => {
                const reserved = committedMap[item.id] || 0;
                const physical = item.stock || 0;
                // If wompi decreases stock, available is just stock.
                // But Inventory.tsx logic assumes stock is physical including sold-but-not-shipped.
                // We trust Inventory.tsx logic for consistency:
                const available = physical - reserved;

                totalPhysicalUnits += physical;

                return {
                    ...item,
                    stock: physical,
                    reserved: reserved,
                    available: available
                };
            }) || [];

            // Low stock based on REAL availability
            const lowStock = processedInventory.filter((item: any) => item.available < 3);
            const totalUnits = totalPhysicalUnits;

            // Calculate Total Revenue
            const totalRev = (revenueData?.reduce((acc, curr) => acc + (curr.total_cents || 0), 0) || 0) / 100;

            setStats({
                totalCustomers: customerCount || 0,
                totalOrders: orderCount || 0,
                totalRevenue: totalRev,
                activeConversations: convCount || 0,
                totalInventory: totalUnits, // Keep showing total physical assets
                lowStockCount: lowStock.length
            });

            setLowStockItems(lowStock.slice(0, 5)); // Show top 5 alerts

            // 2. Get Recent Orders
            const { data: recents } = await supabase
                .from('orders')
                .select(`
          id, 
          created_at, 
          status, 
          total_cents,
          customers ( name, phone_e164 )
        `)
                .order('created_at', { ascending: false })
                .limit(5);

            if (recents) setRecentOrders(recents);

        } catch (error) {
            console.error("Error loading dashboard:", error);
        } finally {
            setLoading(false);
        }
    }

    const formatCurrency = (val: number) =>
        new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(val);

    if (loading) return <div className="p-10 text-center">Cargando métricas en tiempo real...</div>;

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
                <div className="flex items-center gap-2">
                    <span className="flex h-2 w-2 rounded-full bg-green-500 animate-pulse"></span>
                    <span className="text-sm text-muted-foreground">En Vivo</span>
                </div>
            </div>

            {/* STATS GRID */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <StatCard
                    title="Ingresos Totales"
                    value={formatCurrency(stats.totalRevenue)}
                    icon={<DollarSign className="h-4 w-4 text-muted-foreground" />}
                    subtext="+4% mes pasado"
                />
                <StatCard
                    title="Pedidos"
                    value={stats.totalOrders.toString()}
                    icon={<ShoppingBag className="h-4 w-4 text-muted-foreground" />}
                    subtext="Total procesados"
                />
                <StatCard
                    title="Inventario Físico"
                    value={stats.totalInventory.toString()}
                    icon={<Package className="h-4 w-4 text-muted-foreground" />}
                    subtext="Unidades en bodega"
                />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* RECENT ORDERS TABLE */}
                <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
                    <div className="p-6 flex flex-row items-center justify-between space-y-0">
                        <h3 className="font-semibold leading-none tracking-tight">Actividad Reciente</h3>
                        <button className="text-sm text-blue-500 flex items-center hover:underline">
                            Ver todo <ArrowUpRight className="ml-1 h-3 w-3" />
                        </button>
                    </div>
                    <div className="p-0">
                        <div className="relative w-full overflow-auto">
                            <table className="w-full caption-bottom text-sm">
                                <thead className="[&_tr]:border-b">
                                    <tr className="border-b transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted">
                                        <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">ID</th>
                                        <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Estado</th>
                                        <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">Monto</th>
                                    </tr>
                                </thead>
                                <tbody className="[&_tr:last-child]:border-0">
                                    {recentOrders.map((order) => (
                                        <tr key={order.id} className="border-b transition-colors hover:bg-muted/50">
                                            <td className="p-4 align-middle font-medium">{order.id.slice(0, 8)}...</td>
                                            <td className="p-4 align-middle">
                                                <StatusBadge status={order.status} />
                                            </td>
                                            <td className="p-4 align-middle text-right">{formatCurrency((order.total_cents || 0) / 100)}</td>
                                        </tr>
                                    ))}
                                    {recentOrders.length === 0 && (
                                        <tr>
                                            <td colSpan={3} className="p-4 text-center text-muted-foreground">No hay pedidos recientes.</td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>

                {/* INVENTORY ALERTS */}
                <div className="rounded-xl border bg-card text-card-foreground shadow-sm">
                    <div className="p-6 flex flex-row items-center justify-between border-b">
                        <div className="flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5 text-amber-500" />
                            <h3 className="font-semibold leading-none tracking-tight">Alertas de Inventario</h3>
                        </div>
                        <span className="text-xs font-medium bg-red-100 text-red-800 px-2.5 py-1 rounded-full border border-red-200">
                            {stats.lowStockCount} Referencias Críticas
                        </span>
                    </div>
                    <div className="p-0">
                        <div className="space-y-0 divide-y">
                            {lowStockItems.map((item, idx) => {
                                const available = (item.stock || 0) - (item.reserved || 0);
                                const saturation = item.stock > 0 ? ((item.reserved || 0) / item.stock) * 100 : 100;
                                const isSoldOut = available <= 0;

                                return (
                                    <div key={idx} className="p-4 hover:bg-muted/50 transition-colors">
                                        <div className="flex items-start justify-between mb-2">
                                            <div>
                                                <p className="font-medium text-sm text-foreground">{item.products?.brand} {item.products?.model}</p>
                                                <p className="text-xs text-muted-foreground font-mono mt-0.5">Talla: {item.size}</p>
                                            </div>
                                            <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${isSoldOut ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>
                                                {isSoldOut ? 'Agotado' : 'Bajo Stock'}
                                            </div>
                                        </div>

                                        {/* Professional Stock Matrix */}
                                        <div className="grid grid-cols-3 gap-2 text-center text-xs bg-muted/30 rounded-lg p-2 border">
                                            <div className="space-y-1">
                                                <p className="text-muted-foreground text-[10px] uppercase">Bodega</p>
                                                <p className="font-bold text-slate-700">{item.stock}</p>
                                            </div>
                                            <div className="space-y-1 border-x border-slate-200">
                                                <p className="text-muted-foreground text-[10px] uppercase">Pedidos</p>
                                                <p className="font-bold text-blue-600">{item.reserved || 0}</p>
                                            </div>
                                            <div className="space-y-1">
                                                <p className="text-muted-foreground text-[10px] uppercase">Venta</p>
                                                <p className={`font-bold ${isSoldOut ? 'text-red-600' : 'text-green-600'}`}>
                                                    {available}
                                                </p>
                                            </div>
                                        </div>

                                        {/* Visual Saturation Bar */}
                                        <div className="mt-3 flex items-center gap-2">
                                            <div className="h-1.5 flex-1 bg-slate-100 rounded-full overflow-hidden">
                                                <div
                                                    className={`h-full ${isSoldOut ? 'bg-red-500' : 'bg-amber-500'}`}
                                                    style={{ width: `${Math.min(saturation, 100)}%` }}
                                                />
                                            </div>
                                            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                                                {saturation.toFixed(0)}% Ocupado
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                            {lowStockItems.length === 0 && (
                                <div className="text-center text-sm text-green-600 py-8 flex flex-col items-center gap-2">
                                    <div className="h-8 w-8 rounded-full bg-green-100 flex items-center justify-center">
                                        <Package className="h-4 w-4 text-green-600" />
                                    </div>
                                    <p>Inventario Saludable</p>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// --- HELPER COMPONENTS ---

function StatCard({ title, value, icon, subtext }: any) {
    return (
        <div className="rounded-xl border bg-card text-card-foreground shadow-sm p-6">
            <div className="flex flex-row items-center justify-between space-y-0 pb-2">
                <h3 className="tracking-tight text-sm font-medium">{title}</h3>
                {icon}
            </div>
            <div>
                <div className="text-2xl font-bold">{value}</div>
                <p className="text-xs text-muted-foreground">{subtext}</p>
            </div>
        </div>
    );
}

function StatusBadge({ status }: { status: string }) {
    const styles: any = {
        pending: "bg-yellow-100 text-yellow-800",
        awaiting_payment: "bg-yellow-100 text-yellow-800",
        paid: "bg-green-100 text-green-800",
        shipped: "bg-blue-100 text-blue-800",
        cancelled: "bg-red-100 text-red-800"
    };

    const label = status === 'pending' ? 'Pendiente' :
        status === 'awaiting_payment' ? 'Por Pagar' :
            status === 'paid' ? 'Pagado' :
                status === 'shipped' ? 'Enviado' : status;

    return (
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[status] || "bg-gray-100 text-gray-800"}`}>
            {label}
        </span>
    );
}
