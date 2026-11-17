export const STAFF_ROLES = ["owner", "admin", "operator"] as const;
export type StaffRole = typeof STAFF_ROLES[number];

export type StaffIdentity = {
    userId: string;
    role: StaffRole;
};

export class IdentityError extends Error {
    readonly status: 401 | 403 | 503;

    constructor(
        message: string,
        status: 401 | 403 | 503,
    ) {
        super(message);
        this.name = "IdentityError";
        this.status = status;
    }
}

/** Extract only a JWT bearer. Shared gateway secrets and alternate headers are deliberately ignored. */
export function extractUserBearer(req: Request): string | null {
    const authorization = req.headers.get("authorization") ?? "";
    const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
    if (!match) return null;
    const token = match[1];
    if (token.length > 8192 || token.split(".").length !== 3) return null;
    return token;
}

/** Verify the token with Supabase Auth, then load the current staff role from the server-side membership table. */
export async function resolveStaffIdentity(
    authClient: any,
    membershipClient: any,
    accessToken: string,
): Promise<StaffIdentity> {
    const authResult = await authClient.auth.getUser(accessToken);
    const userId = authResult?.data?.user?.id;
    if (authResult?.error || typeof userId !== "string" || !userId) {
        throw new IdentityError("Sesión ausente, inválida o expirada", 401);
    }

    const membershipResult = await membershipClient
        .from("admin_users")
        .select("role")
        .eq("user_id", userId)
        .maybeSingle();
    if (membershipResult?.error) {
        throw new IdentityError("No fue posible verificar la membresía", 503);
    }

    const role = membershipResult?.data?.role;
    if (!STAFF_ROLES.includes(role)) {
        throw new IdentityError("Usuario sin membresía staff", 403);
    }

    return { userId, role };
}
