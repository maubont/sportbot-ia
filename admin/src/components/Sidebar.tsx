import { Link, useLocation } from "react-router-dom";
import { MessageSquare, Package, ShoppingCart, Settings, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

const items = [
    { title: "Dashboard", url: "/", icon: LayoutDashboard },
    { title: "Chats", url: "/chats", icon: MessageSquare },
    { title: "Orders", url: "/orders", icon: ShoppingCart },
    { title: "Inventory", url: "/inventory", icon: Package },
    { title: "Settings", url: "/settings", icon: Settings },
];

export function Sidebar() {
    const location = useLocation();

    return (
        <div className="w-64 h-screen bg-card border-r border-border p-4 flex flex-col">
            <div className="text-2xl font-bold mb-8 px-2 text-primary">SportBot IA</div>
            <nav className="flex-1 space-y-1">
                {items.map((item) => (
                    <Link
                        key={item.title}
                        to={item.url}
                        className={cn(
                            "flex items-center gap-3 px-3 py-2 rounded-md transition-colors",
                            location.pathname === item.url
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                        )}
                    >
                        <item.icon className="w-5 h-5" />
                        <span>{item.title}</span>
                    </Link>
                ))}
            </nav>
        </div>
    );
}
