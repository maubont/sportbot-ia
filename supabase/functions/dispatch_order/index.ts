import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const { order_id, carrier_name, tracking_number } = await req.json();

        if (!order_id || !carrier_name || !tracking_number) {
            return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400, headers: corsHeaders });
        }

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. Get Order & Customer Details
        const { data: order, error: orderError } = await supabase
            .from('orders')
            .select(`
            *,
            customers (
                id,
                name,
                phone_e164
            )
        `)
            .eq('id', order_id)
            .single();

        if (orderError || !order) throw new Error("Order not found");

        // 2. PRIMARY ACTION: Update Order Status
        // This MUST succeed for the business process to continue.
        const { error: updateError } = await supabase
            .from('orders')
            .update({
                status: 'shipped',
                carrier_name,
                tracking_number,
                shipped_at: new Date().toISOString()
            })
            .eq('id', order_id);

        if (updateError) throw updateError;

        // 3. SECONDARY ACTION: Send WhatsApp Notification (Best Effort)
        let notificationStatus = "sent";
        let notificationError = null;

        const customerName = order.customers?.name || "Cliente";
        const phone = order.customers?.phone_e164;

        if (phone) {
            try {
                const messageBody = `📦 *¡Tu paquete va en camino!*\n\nHola ${customerName}, tu orden ha sido despachada con la transportadora *${carrier_name}*.\n\n📝 *Número de Guía:* ${tracking_number}\n\nPuedes rastrear tu envío en la página oficial de ${carrier_name}.\n\n¡Gracias por tu compra! 👟`;

                const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID')!;
                const authToken = Deno.env.get('TWILIO_AUTH_TOKEN')!;
                const fromNumber = Deno.env.get('TWILIO_WHATSAPP_FROM')!;

                const body = new URLSearchParams({
                    To: phone,
                    From: fromNumber,
                    Body: messageBody
                });

                console.log(`Sending WhatsApp to ${phone}...`);

                // TIMEOUT ENFORCEMENT: 5 seconds max
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);

                try {
                    const twilioRes = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Basic ${btoa(accountSid + ":" + authToken)}`,
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        body: body,
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    // Safe JSON parsing
                    let twilioData;
                    try {
                        twilioData = await twilioRes.json();
                    } catch (e) {
                        twilioData = { detail: "Invalid JSON response from Twilio" };
                    }

                    if (!twilioRes.ok) {
                        const twilioMsg = twilioData.message || twilioData.detail || "Unknown Twilio Error";
                        console.error("Twilio Warning:", twilioMsg);
                        notificationStatus = "failed";
                        notificationError = twilioMsg;
                    } else {
                        // 4. Log in History
                        let { data: conversation } = await supabase.from("conversations").select("id").eq("customer_id", order.customers.id).limit(1).single();
                        if (conversation) {
                            await supabase.from("messages").insert({
                                conversation_id: conversation.id,
                                role: 'assistant',
                                direction: 'outbound',
                                body: messageBody
                            });
                        }
                    }
                } catch (fetchErr: any) {
                    clearTimeout(timeoutId);
                    if (fetchErr.name === 'AbortError') {
                        throw new Error("Twilio Fetch Timeout");
                    }
                    throw fetchErr;
                }

            } catch (msgErr: any) {
                console.error("Notification System Error:", msgErr);
                notificationStatus = "failed";
                notificationError = msgErr.message;
            }
        } else {
            notificationStatus = "skipped_no_phone";
        }

        // Return Success (200) but include Notification Status
        return new Response(JSON.stringify({
            success: true,
            message: "Order marked as dispatched.",
            notification_status: notificationStatus,
            notification_error: notificationError
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });

    } catch (err: any) {
        console.error("Critical Dispatch Error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400,
        });
    }
});
