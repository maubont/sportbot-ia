import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Eye } from "lucide-react";

type Order = {
    id: string;
    created_at: string;
    status: string;
    total_cents: number;
    customers: {
        name: string;
        phone_e164: string;
    };
};

export default function Orders() {
    const [orders, setOrders] = useState<Order[]>([]);

    useEffect(() => {
        fetchOrders();
    }, []);

    async function fetchOrders() {
        // Correct join syntax for Supabase
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

    const getStatusColor = (status: string) => {
        switch (status) {
            case "paid": return "text-green-600 bg-green-100";
            case "pending_payment": return "text-yellow-600 bg-yellow-100";
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
                                        <span className={cn("px-2 py-1 rounded-full text-xs font-semibold", getStatusColor(order.status))}>
                                            {order.status}
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-right">
                                        ${(order.total_cents / 100).toLocaleString('es-CO')}
                                    </td>
                                    <td className="px-6 py-4 text-center">
                                        <button className="text-primary hover:text-primary/80">
                                            <Eye className="w-5 h-5" />
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

