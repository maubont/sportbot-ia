/**
 * Shared Twilio WhatsApp Helper
 * 
 * Centralized utility for sending WhatsApp messages via Twilio.
 * Used by: dispatch_order, wompi_events, admin_actions, twilio_inbound_whatsapp
 */

export interface TwilioSendOptions {
    to: string;
    body: string;
    mediaUrls?: string[];
    timeout?: number; // ms, default 5000
}

export interface TwilioSendResult {
    success: boolean;
    sid?: string;
    error?: string;
}

/**
 * Send a WhatsApp message via Twilio
 * 
 * @param options - Message options (to, body, mediaUrls, timeout)
 * @returns Result object with success status and message SID or error
 */
export async function sendWhatsApp(options: TwilioSendOptions): Promise<TwilioSendResult> {
    const { to, body, mediaUrls = [], timeout = 5000 } = options;

    const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
    const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
    const fromNumber = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+14155238886";

    if (!accountSid || !authToken) {
        console.error("[Twilio] Missing credentials (TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN)");
        return { success: false, error: "Missing Twilio credentials" };
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const basic = btoa(`${accountSid}:${authToken}`);

    const form = new URLSearchParams();
    form.set("From", fromNumber);
    form.set("To", to);
    if (body) form.set("Body", body);
    mediaUrls.forEach((m) => form.append("MediaUrl", m));

    // Timeout handling
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: {
                Authorization: `Basic ${basic}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
            const errData = await res.json().catch(() => ({ message: "Unknown error" }));
            const errMsg = errData.message || errData.detail || `HTTP ${res.status}`;
            console.error("[Twilio] Send failed:", errMsg);
            return { success: false, error: errMsg };
        }

        const data = await res.json();
        return { success: true, sid: data.sid };

    } catch (err: any) {
        clearTimeout(timeoutId);
        if (err.name === "AbortError") {
            console.error("[Twilio] Request timeout");
            return { success: false, error: "Request timeout" };
        }
        console.error("[Twilio] Network error:", err.message);
        return { success: false, error: err.message };
    }
}
