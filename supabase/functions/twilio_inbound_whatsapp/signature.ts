export async function hmacSha1Base64(secret: string, message: string) {
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-1" },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
    return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

export function timingSafeEqual(left: string, right: string) {
    const leftBytes = new TextEncoder().encode(left);
    const rightBytes = new TextEncoder().encode(right);
    if (leftBytes.length !== rightBytes.length) return false;

    let diff = 0;
    for (let i = 0; i < leftBytes.length; i++) {
        diff |= leftBytes[i] ^ rightBytes[i];
    }
    return diff === 0;
}

export async function verifyTwilioSignature(
    req: Request,
    data: Record<string, FormDataEntryValue>,
    options: {
        authToken?: string | null;
        supabaseUrl?: string | null;
    } = {},
) {
    const authToken = options.authToken?.trim();
    if (!authToken) {
        console.error("[Twilio] TWILIO_AUTH_TOKEN is not configured; rejecting request");
        return false;
    }

    const receivedSignature = req.headers.get("x-twilio-signature");
    if (!receivedSignature) return false;

    const sortedPayload = Object.keys(data)
        .sort()
        .map((key) => `${key}${String(data[key])}`)
        .join("");

    const requestUrl = new URL(req.url);
    const candidates = new Set<string>([req.url]);

    const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") || "https";
    if (host) candidates.add(`${proto}://${host}${requestUrl.pathname}${requestUrl.search}`);

    if (options.supabaseUrl) {
        const publicBase = options.supabaseUrl.replace(/\/$/, "");
        candidates.add(`${publicBase}/functions/v1/twilio_inbound_whatsapp${requestUrl.search}`);
        candidates.add(`${publicBase}/functions/v1/twilio_inbound_whatsapp/${requestUrl.search}`);
    }

    for (const candidateUrl of candidates) {
        const expectedSignature = await hmacSha1Base64(authToken, `${candidateUrl}${sortedPayload}`);
        if (timingSafeEqual(expectedSignature, receivedSignature)) return true;
    }

    return false;
}
