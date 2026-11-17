/**
 * Contrato de la URL de rastreo del despacho (P1.2).
 *
 * Única fuente de verdad: `dispatch_order` la aplica en el backend y el Admin la
 * re-exporta en `admin/src/lib/logistics.ts` para el formulario. Debe permanecer
 * sin dependencias de Deno ni de Supabase para ejecutarse con Node
 * (--experimental-strip-types) y empaquetarse en el bundle del Admin sin fricción.
 *
 * La defensa en BD (`shipments_tracking_url_shape`) es intencionalmente más laxa:
 * solo exige prefijo http(s) y longitud; este módulo es el portero estricto.
 */

export const MAX_TRACKING_URL_LENGTH = 500;

const TRACKING_URL_PATTERN = /^https?:\/\/\S+$/i;

export type TrackingUrlResult =
    | { ok: true; url: string }
    | { ok: false; error: string };

/**
 * Valida la URL de rastreo que el dueño pega junto a la guía.
 * Es opcional: vacío (o null/undefined) es válido con `url: ""`.
 * Acepta solo http(s), sin espacios y hasta MAX_TRACKING_URL_LENGTH caracteres.
 */
export function validateTrackingUrl(raw: unknown): TrackingUrlResult {
    if (raw === null || raw === undefined) return { ok: true, url: "" };
    if (typeof raw !== "string") {
        return { ok: false, error: "La URL de rastreo debe ser texto." };
    }
    const url = raw.trim();
    if (!url) return { ok: true, url: "" };
    if (/\s/.test(url)) {
        return { ok: false, error: "La URL de rastreo no puede contener espacios." };
    }
    if (url.length > MAX_TRACKING_URL_LENGTH) {
        return {
            ok: false,
            error: `La URL de rastreo no puede superar ${MAX_TRACKING_URL_LENGTH} caracteres.`,
        };
    }
    if (!TRACKING_URL_PATTERN.test(url)) {
        return { ok: false, error: "La URL de rastreo debe empezar por http:// o https://." };
    }
    return { ok: true, url };
}
