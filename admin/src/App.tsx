import { type ReactNode } from "react";
import { BrowserRouter, Routes, Route, Outlet, Navigate, useLocation } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { AuthProvider } from "./lib/auth";
import { useAuth } from "./lib/auth-context";
import AiOps from "./pages/AiOps";
import Dashboard from "./pages/Dashboard";
import Inbox from "./pages/Inbox";
import Inventory from "./pages/Inventory";
import Login from "./pages/Login";
import Logistics from "./pages/Logistics";
import Orders from "./pages/Orders";
import Payments from "./pages/Payments";
import SetPassword from "./pages/SetPassword";
import Settings from "./pages/Settings";

function Layout() {
  return (
    <div className="flex h-screen w-full bg-background text-foreground">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  const isLocalReviewRoute = import.meta.env.DEV && location.pathname === "/inbox-review";

  if (isLocalReviewRoute) {
    return <>{children}</>;
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Validando sesión...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/set-password" element={<SetPassword />} />
          <Route element={<ProtectedRoute><Layout /></ProtectedRoute>}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/inbox-review" element={<Inbox reviewFixture />} />
            {/* Legacy URL now lands in the single operator workstation. */}
            <Route path="/chats" element={<Navigate to="/inbox" replace />} />
            <Route path="/ai-ops" element={<AiOps />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/payments" element={<Payments />} />
            <Route path="/logistics" element={<Logistics />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}


export default App;
