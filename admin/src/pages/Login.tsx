import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/lib/auth-context";
import { getAdminUrl } from "@/lib/auth-url";

export default function Login() {
    const navigate = useNavigate();
    const location = useLocation();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [resetLoading, setResetLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(
        (location.state as { notice?: string } | null)?.notice || null
    );
    const { user } = useAuth();
    const redirectTo = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname || "/";

    useEffect(() => {
        if (user) navigate(redirectTo, { replace: true });
    }, [navigate, redirectTo, user]);

    async function handleAuth(e: React.FormEvent) {
        e.preventDefault();
        setLoading(true);
        setError(null);
        setNotice(null);

        const { error } = await supabase.auth.signInWithPassword({
            email,
            password,
        });

        if (error) {
            setError(error.message);
            setLoading(false);
        } else {
            navigate(redirectTo, { replace: true });
        }
    }

    async function handlePasswordReset() {
        setError(null);
        setNotice(null);

        if (!email) {
            setError("Escribe tu email para enviarte el enlace de recuperación.");
            return;
        }

        setResetLoading(true);
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
            redirectTo: getAdminUrl("/set-password"),
        });
        setResetLoading(false);

        if (error) {
            setError(error.message);
            return;
        }

        setNotice("Te enviamos un enlace para crear o recuperar tu contraseña.");
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50">
            <div className="w-full max-w-md space-y-8 p-8 bg-white rounded-lg shadow-md">
                <div className="text-center">
                    <h2 className="text-3xl font-bold tracking-tight text-gray-900">
                        SportBot Admin
                    </h2>
                    <p className="mt-2 text-sm text-gray-600">
                        Inicia sesión para controlar tu negocio
                    </p>
                </div>

                <form className="mt-8 space-y-6" onSubmit={handleAuth}>
                    {error && (
                        <div className="p-3 text-sm text-red-500 bg-red-50 rounded-md">
                            {error}
                        </div>
                    )}
                    {notice && (
                        <div className="p-3 text-sm text-emerald-600 bg-emerald-50 rounded-md">
                            {notice}
                        </div>
                    )}

                    <div className="space-y-4 rounded-md shadow-sm">
                        <input
                            type="email"
                            required
                            className="relative block w-full rounded-md border-0 py-1.5 px-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6"
                            placeholder="Email address"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                        />
                        <input
                            type="password"
                            required
                            className="relative block w-full rounded-md border-0 py-1.5 px-3 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm sm:leading-6"
                            placeholder="Password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </div>

                    <div>
                        <button
                            type="submit"
                            disabled={loading}
                            className="group relative flex w-full justify-center rounded-md bg-black px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black disabled:opacity-50"
                        >
                            {loading ? "Procesando..." : "Iniciar Sesión"}
                        </button>
                    </div>
                    <button
                        type="button"
                        onClick={handlePasswordReset}
                        disabled={resetLoading}
                        className="w-full text-center text-sm font-medium text-gray-600 hover:text-gray-900 disabled:opacity-50"
                    >
                        {resetLoading ? "Enviando enlace..." : "Crear o recuperar contraseña"}
                    </button>
                </form>
            </div>
        </div>
    );
}
