/**
 * Reglas de la ficha de pedido (P1.2).
 *
 * `validateTrackingUrl` es el mismo contrato que aplica `dispatch_order` en el
 * backend (`supabase/functions/_shared/tracking_url.ts`). Se re-exporta para que
 * haya una sola fuente de verdad: el formulario y la Edge Function no pueden
 * diverger porque ejecutan la misma función.
 */

export {
    MAX_TRACKING_URL_LENGTH,
    validateTrackingUrl,
    type TrackingUrlResult,
} from "../../../supabase/functions/_shared/tracking_url.ts";

export const DEFAULT_FULFILLMENT_SLA_HOURS = 24;
export const DEFAULT_DELIVERY_SLA_HOURS = 72;

/**
 * Horas de SLA efectivas: usa el valor configurado en `settings` cuando es un
 * número positivo; si es null/0/negativo/no-numérico, cae al fallback operativo.
 */
export function slaOrDefault(value: unknown, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : fallback;
}
