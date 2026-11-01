import { createClient } from "jsr:@supabase/supabase-js@2";
import { hasAdminRoleAccess, type AdminAccessLevel } from "./admin_auth_roles.ts";

export type AdminAuthContext = {
    // The service-role client intentionally bypasses generated database types:
    // Edge RPCs/migrations are deployed before browser type generation and are
    // validated by the database contract and dedicated integration tests.
    supabase: any;
    userId: string;
    email?: string;
    role: string;
};

type CorsHeaders = Record<string, string>;

function jsonResponse(body: Record<string, unknown>, status: number, headers: CorsHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json" },
    });
}

async function requireRole(
    req: Request,
    corsHeaders: CorsHeaders,
    access: AdminAccessLevel,
): Promise<AdminAuthContext | Response> {
    const authHeader = req.headers.get("authorization") || "";
    const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/i);

    if (!tokenMatch) {
        return jsonResponse({ error: "Missing authorization token" }, 401, corsHeaders);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
        return jsonResponse({ error: "Supabase environment is not configured" }, 500, corsHeaders);
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });

    const token = tokenMatch[1];
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    const user = userData.user;

    if (userError || !user) {
        return jsonResponse({ error: "Invalid authorization token" }, 401, corsHeaders);
    }

    const { data: adminUser, error: adminError } = await supabase
        .from("admin_users")
        .select("user_id, role")
        .eq("user_id", user.id)
        .maybeSingle();

    if (adminError) {
        console.error("Admin authorization check failed:", adminError);
        return jsonResponse({ error: "Admin authorization check failed" }, 500, corsHeaders);
    }

    if (!adminUser || !hasAdminRoleAccess(adminUser.role, access)) {
        const requiredRole = access === "admin" ? "Admin" : "Staff";
        return jsonResponse({ error: `${requiredRole} access required` }, 403, corsHeaders);
    }

    return {
        supabase,
        userId: user.id,
        email: user.email,
        role: adminUser.role,
    };
}

// Privileged endpoints (payments, configuration, Agent Actions) are owner/admin-only.
export function requireAdmin(req: Request, corsHeaders: CorsHeaders): Promise<AdminAuthContext | Response> {
    return requireRole(req, corsHeaders, "admin");
}

// Operator-safe endpoints must opt in explicitly; membership alone is never enough.
export function requireStaff(req: Request, corsHeaders: CorsHeaders): Promise<AdminAuthContext | Response> {
    return requireRole(req, corsHeaders, "staff");
}
