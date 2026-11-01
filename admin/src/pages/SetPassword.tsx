import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

export default function SetPassword() {
    const { user, loading: authLoading } = useAuth();
    const navigate = useNavigate();
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        setError(null);

        if (password.length < 8) {
            setError("La contraseña debe tener al menos 8 caracteres.");
            return;
        }

        if (password !== confirmPassword) {
            setError("Las contraseñas no coinciden.");
            return;
        }

        setLoading(true);
        const { error } = await supabase.auth.updateUser({ password });
        setLoading(false);

        if (error) {
            setError(error.message);
            return;
        }

        setSuccess(true);
        setPassword("");
        setConfirmPassword("");
    }

    return (
        <div className="mx-auto flex min-h-full max-w-xl items-center justify-center">
            <div className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
                <div className="mb-6">
                    <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                        Crear contraseña
                    </h1>
                    <p className="mt-2 text-sm text-slate-500">
                        Define la contraseña que usarás para entrar al panel admin.
                    </p>
                    {user?.email && (
                        <p className="mt-3 rounded-md bg-slate-50 px-3 py-2 text-sm font-medium text-slate-700">
                            {user.email}
                        </p>
                    )}
                </div>

                {authLoading ? (
                    <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-600">
                        Validando enlace...
                    </div>
                ) : !user ? (
                    <div className="space-y-4">
                        <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-700">
                            Abre esta pantalla desde el enlace de invitación o recuperación enviado por Supabase.
                        </div>
                        <button
                            type="button"
                            onClick={() => navigate("/login")}
                            className="flex w-full justify-center rounded-md bg-black px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800"
                        >
                            Ir al login
                        </button>
                    </div>
                ) : success ? (
                    <div className="space-y-4">
                        <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">
                            Contraseña actualizada. Ya puedes iniciar sesión con tu email y esta contraseña.
                        </div>
                        <button
                            type="button"
                            onClick={() => navigate("/")}
                            className="flex w-full justify-center rounded-md bg-black px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800"
                        >
                            Ir al dashboard
                        </button>
                    </div>
                ) : (
                    <form className="space-y-4" onSubmit={handleSubmit}>
                        {error && (
                            <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">
                                {error}
                            </div>
                        )}

                        <input
                            type="password"
                            required
                            minLength={8}
                            className="block w-full rounded-md border-0 px-3 py-2 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm"
                            placeholder="Nueva contraseña"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        <input
                            type="password"
                            required
                            minLength={8}
                            className="block w-full rounded-md border-0 px-3 py-2 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-primary sm:text-sm"
                            placeholder="Confirmar contraseña"
                            value={confirmPassword}
                            onChange={(e) => setConfirmPassword(e.target.value)}
                        />
                        <button
                            type="submit"
                            disabled={loading}
                            className="flex w-full justify-center rounded-md bg-black px-3 py-2 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
                        >
                            {loading ? "Guardando..." : "Guardar contraseña"}
                        </button>
                    </form>
                )}
            </div>
        </div>
    );
}
