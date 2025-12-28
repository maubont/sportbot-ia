import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const { action, payload } = await req.json();
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        if (action === "send_message") {
            const { conversation_id, content, media_url } = payload;

            // 1. Get Customer Phone
            const { data: conversation } = await supabase
                .from("conversations")
                .select("customer_id, customers(phone_e164)")
                .eq("id", conversation_id)
                .single();

            if (!conversation) throw new Error("Conversation not found");

            const customer = conversation.customers as any;
            const toPhone = customer?.phone_e164;

            // 2. Send via Twilio API
            const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
            const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
            const fromNumber = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+14155238886";

            const body = new URLSearchParams();
            body.append("From", fromNumber);
            body.append("To", toPhone);
            if (content) body.append("Body", content);
            if (media_url) body.append("MediaUrl", media_url);

            const twilioResp = await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": "Basic " + btoa(accountSid + ":" + authToken),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: body,
                }
            );

            if (!twilioResp.ok) {
                const errText = await twilioResp.text();
                throw new Error("Twilio Error: " + errText);
            }

            const twilioData = await twilioResp.json();

            // 3. Log to DB
            await supabase.from("messages").insert({
                conversation_id,
                direction: "outbound",
                role: "assistant",
                body: content,
                twilio_message_sid: twilioData.sid
            });


            return new Response(JSON.stringify({ success: true, sid: twilioData.sid }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 200,
            });
        }

        // Direct WhatsApp send (used by Orders page for delivery notifications)
        if (action === "send_whatsapp") {
            const { phone, message } = payload;

            if (!phone || !message) {
                throw new Error("phone and message are required for send_whatsapp");
            }

            const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
            const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
            const fromNumber = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+14155238886";

            const body = new URLSearchParams();
            body.append("From", fromNumber);
            body.append("To", phone);
            body.append("Body", message);

            const twilioResp = await fetch(
                `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
                {
                    method: "POST",
                    headers: {
                        "Authorization": "Basic " + btoa(accountSid + ":" + authToken),
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    body: body,
                }
            );

            if (!twilioResp.ok) {
                const errText = await twilioResp.text();
                console.error("Twilio send_whatsapp error:", errText);
                throw new Error("Twilio Error: " + errText);
            }

            const twilioData = await twilioResp.json();
            console.log("WhatsApp sent successfully via send_whatsapp:", twilioData.sid);

            return new Response(JSON.stringify({ success: true, sid: twilioData.sid }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 200,
            });
        }

        return new Response("Action not supported", { status: 400, headers: corsHeaders });

    } catch (error) {
        console.error("Error in admin_actions:", error);
        return new Response(JSON.stringify({ error: error.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
        });
    }
});
