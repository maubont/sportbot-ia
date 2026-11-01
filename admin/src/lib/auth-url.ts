const configuredSiteUrl = import.meta.env.VITE_ADMIN_SITE_URL as string | undefined;

export function getAdminUrl(path = "/") {
    const origin = (configuredSiteUrl || window.location.origin).replace(/\/+$/, "");
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    return `${origin}${normalizedPath}`;
}
