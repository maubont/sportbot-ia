/**
 * Candado de pruebas para números personales.
 *
 * Mientras el gateway use un WhatsApp personal, el bot responde a *cualquiera*
 * que escriba: familia, amigos, el chat del edificio. Con
 * `SPORTBOT_TEST_ALLOWLIST` definida, solo atiende a los números listados.
 *
 * Reglas:
 *   - Variable vacía o ausente → atiende a todos (comportamiento actual).
 *   - Variable definida con números válidos → solo esos.
 *   - Variable definida pero sin ningún número válido → **no atiende a nadie**.
 *     Fallar cerrado es intencional: si alguien escribe `2025550102` sin `+57`,
 *     la lista quedaría vacía y el candado se apagaría en silencio, que es peor
 *     que no responder.
 */

import { canonicalE164 } from "./phone.ts";

/** Números de la lista, ya en E.164 y sin duplicados. */
export function parseTestAllowlist(raw: string | null | undefined): string[] {
    const configured = (raw ?? "").trim();
    if (!configured) return [];

    const numbers = configured
        .split(/[,;\n]+/)
        .map((entry) => canonicalE164(entry))
        .filter((entry): entry is string => entry !== null);

    return [...new Set(numbers)];
}

/** ¿Este remitente puede hablar con el bot? */
export function isTestAllowed(phone: string, raw: string | null | undefined): boolean {
    const configured = (raw ?? "").trim();
    if (!configured) return true;

    const allowlist = parseTestAllowlist(configured);
    if (allowlist.length === 0) return false;

    const canonical = canonicalE164(phone);
    return canonical !== null && allowlist.includes(canonical);
}
