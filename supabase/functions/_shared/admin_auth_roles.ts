export type AdminAccessLevel = "admin" | "staff";

const ADMIN_ROLES = new Set(["owner", "admin"]);
const STAFF_ROLES = new Set(["owner", "admin", "operator"]);

export function hasAdminRoleAccess(role: unknown, access: AdminAccessLevel): boolean {
    if (typeof role !== "string") return false;
    return (access === "admin" ? ADMIN_ROLES : STAFF_ROLES).has(role);
}
