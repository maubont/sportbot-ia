import { createContext, useContext } from "react";
import { type Session, type User } from "@supabase/supabase-js";

export type AuthContextType = {
    user: User | null;
    session: Session | null;
    loading: boolean;
    signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextType>({
    user: null,
    session: null,
    loading: true,
    signOut: async () => undefined,
});

export const useAuth = () => useContext(AuthContext);
