export async function twilioSendWhatsApp(to: string, body: string, mediaUrls: string[] = []) {
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const token = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const from = Deno.env.get("TWILIO_WHATSAPP_FROM") ?? "whatsapp:+14155238886"; // Sandbox default

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const basic = btoa(`${sid}:${token}`);

    const form = new URLSearchParams();
    form.set("From", from);
    form.set("To", to);
    if (body) form.set("Body", body);

    // Twilio supports multiple MediaUrl parameters
    mediaUrls.forEach((m) => form.append("MediaUrl", m));

    const res = await fetch(url, {
        method: "POST",
        headers: {
            Authorization: `Basic ${basic}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
    });

    if (!res.ok) {
        const errText = await res.text();
        console.error("Twilio send failed:", errText);
        throw new Error(`Twilio send failed: ${res.status} ${errText}`);
    }

    return await res.json();
}
