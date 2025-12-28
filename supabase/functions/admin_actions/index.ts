import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { sendWhatsApp } from "../_shared/twilio.ts";

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

        // Action: Send message from admin chat
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

            // 2. Send via shared Twilio helper
            const result = await sendWhatsApp({
                to: toPhone,
                body: content || "",
                mediaUrls: media_url ? [media_url] : []
            });

            if (!result.success) {
                throw new Error("Twilio Error: " + result.error);
            }

            // 3. Log to DB
            await supabase.from("messages").insert({
                conversation_id,
                direction: "outbound",
                role: "assistant",
                body: content,
                twilio_message_sid: result.sid
            });

            return new Response(JSON.stringify({ success: true, sid: result.sid }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 200,
            });
        }

        // Action: Direct WhatsApp send (for delivery notifications, etc.)
        if (action === "send_whatsapp") {
            const { phone, message } = payload;

            if (!phone || !message) {
                throw new Error("phone and message are required for send_whatsapp");
            }

            const result = await sendWhatsApp({
                to: phone,
                body: message
            });

            if (!result.success) {
                console.error("Twilio send_whatsapp error:", result.error);
                throw new Error("Twilio Error: " + result.error);
            }

            console.log("WhatsApp sent successfully via send_whatsapp:", result.sid);

            return new Response(JSON.stringify({ success: true, sid: result.sid }), {
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
