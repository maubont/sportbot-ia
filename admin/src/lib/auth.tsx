import { type ReactNode, useEffect, useState } from "react";
import { type User, type Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";
import { AuthContext } from "./auth-context";

export function AuthProvider({ children }: { children: ReactNode }) {
    const [user, setUser] = useState<User | null>(null);
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    async function signOut() {
        const { error } = await supabase.auth.signOut();

        if (error) {
            throw error;
        }

        setSession(null);
        setUser(null);
    }

    useEffect(() => {
        // Optimistic check - don't block render if failing
        supabase.auth.getSession().then(({ data: { session } }) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
        }).catch(() => setLoading(false));

        const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
            setUser(session?.user ?? null);
            setLoading(false);
        });

        return () => subscription.unsubscribe();
    }, []);

    return (
        <AuthContext.Provider value={{ user, session, loading, signOut }}>
            {children}
        </AuthContext.Provider>
    );
}
