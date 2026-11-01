import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Bot, Inbox, KeyRound, LogOut, Package, ShoppingCart, Settings, LayoutDashboard, Truck, Wallet } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";

const items = [
    { title: "Dashboard", url: "/", icon: LayoutDashboard },
    { title: "Inbox", url: "/inbox", icon: Inbox },
    { title: "AI Ops", url: "/ai-ops", icon: Bot },
    { title: "Orders", url: "/orders", icon: ShoppingCart },
    { title: "Pagos", url: "/payments", icon: Wallet },
    { title: "Logistics", url: "/logistics", icon: Truck },
    { title: "Inventory", url: "/inventory", icon: Package },
    { title: "Settings", url: "/settings", icon: Settings },
    { title: "Password", url: "/set-password", icon: KeyRound },
];

export function Sidebar() {
    const location = useLocation();
    const navigate = useNavigate();
    const { user, signOut } = useAuth();
    const [signingOut, setSigningOut] = useState(false);

    async function handleSignOut() {
        setSigningOut(true);

        try {
            await signOut();
            navigate("/login", { replace: true });
        } catch (error) {
            console.error("Error signing out", error);
        } finally {
            setSigningOut(false);
        }
    }

    return (
        <div className="w-64 h-screen bg-white border-r border-slate-200 flex flex-col shadow-sm">
            {/* Header / Brand */}
            <div className="h-16 flex items-center px-6 border-b border-slate-100">
                <div className="flex items-center gap-3">
                    <div className="size-8 rounded-lg bg-electric-mist flex items-center justify-center shadow-md">
                        <span className="material-symbols-outlined text-[18px] text-white">bolt</span>
                    </div>
                    <span className="font-bold text-lg tracking-tight text-slate-800">SPORTBOT</span>
                </div>
            </div>

            {/* Navigation */}
            <nav className="flex-1 p-4 space-y-1">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4 px-2">Workspace</div>
                {items.map((item) => {
                    const isActive = location.pathname === item.url;
                    return (
                        <Link
                            key={item.title}
                            to={item.url}
                            className={cn(
                                "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group font-medium",
                                isActive
                                    ? "bg-cyan-50/80 text-cyan-700 shadow-sm ring-1 ring-cyan-100"
                                    : "text-slate-500 hover:bg-slate-50 hover:text-slate-900"
                            )}
                        >
                            <item.icon className={cn("w-[18px] h-[18px]", isActive ? "text-cyan-600" : "text-slate-400 group-hover:text-slate-600")} />
                            <span>{item.title}</span>
                            {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-cyan-500"></div>}
                        </Link>
                    );
                })}
            </nav>

            {/* Footer User Profile */}
            <div className="p-4 border-t border-slate-100">
                <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2">
                    <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-slate-200 flex items-center justify-center text-slate-500">
                            <span className="material-symbols-outlined text-sm">person</span>
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate">Admin User</p>
                            <p className="text-xs text-slate-400 truncate">{user?.email || "contact@example.test"}</p>
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleSignOut}
                        disabled={signingOut}
                        className="mt-3 flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:border-red-100 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <LogOut className="h-4 w-4" />
                        {signingOut ? "Cerrando..." : "Cerrar sesión"}
                    </button>
                </div>
            </div>
        </div>
    );
}
