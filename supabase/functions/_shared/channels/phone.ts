/**
 * Normalización de teléfonos a E.164.
 *
 * Los tres orígenes que nos importan:
 *   - Twilio:    `whatsapp:+12025550102`
 *   - Baileys:   `12025550102@s.whatsapp.net` (o con sufijo de dispositivo `:12@`)
 *   - Humano:    `+12025550102`, `0057 300...`
 *
 * Regla: si no se puede derivar un E.164 creíble, se devuelve `null` en vez de
 * inventar un número. Un cliente fantasma es peor que un mensaje ignorado.
 *
 * NO adivina el país: no convierte `2025550102` en `+12025550102`. Eso lo debe
 * resolver el proveedor, que es quien conoce la cuenta conectada.
 */

const MIN_DIGITS = 8;
const MAX_DIGITS = 15;

export function canonicalE164(raw: string | null | undefined): string | null {
    if (typeof raw !== "string") return null;

    const original = raw.trim();
    if (!original) return null;

    // ¿El valor trae una pista de país? Prefijo de proveedor, JID, `+` o `00`.
    // Sin pista, un número corto es un nacional ambiguo2025550102 podría ser
    // Colombia o el país 30) y no se adivina.
    const hasCountryHint =
        /^whatsapp:/i.test(original)
        || original.includes("@")
        || original.startsWith("+")
        || original.startsWith("00");

    let value = original;

    // Prefijo de proveedor (Twilio) y sufijo de JID (Baileys).
    value = value.replace(/^whatsapp:/i, "");
    value = value.replace(/@[^@]*$/, "");
    // Sufijo de dispositivo (`12025550102:12`).
    value = value.split(":")[0];

    // Separadores humanos y extensiones.
    value = value.replace(/[\s()\-.]/g, "");

    // Marcas de discado internacional.
    value = value.replace(/^00/, "+");
    value = value.replace(/^0+(?=\d{10,})/, "");

    if (!value.startsWith("+")) value = `+${value}`;

    const digits = value.slice(1);
    if (!/^\d+$/.test(digits)) return null;

    const minDigits = hasCountryHint ? MIN_DIGITS : 11;
    if (digits.length < minDigits || digits.length > MAX_DIGITS) return null;
    // E.164 no permite ceros a la izquierda.
    if (digits.startsWith("0")) return null;

    return `+${digits}`;
}

/** Solo dígitos, que es lo que piden Evolution/Baileys y los deep links. */
export function digitsOnly(phone: string): string {
    return phone.replace(/\D/g, "");
}

/** Formato que exige la API de Twilio. */
export function toTwilioAddress(phone: string): string | null {
    const canonical = canonicalE164(phone);
    return canonical ? `whatsapp:${canonical}` : null;
}

/** Formato que entiende Evolution (`number` en sendText). */
export function toEvolutionNumber(phone: string): string | null {
    const canonical = canonicalE164(phone);
    return canonical ? digitsOnly(canonical) : null;
}
