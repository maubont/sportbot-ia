import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendWhatsApp } from "../_shared/twilio.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function sha256Hex(input: string): Promise<string> {
    const data = new TextEncoder().encode(input);
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const checksum = req.headers.get("x-event-checksum");

        const body = await req.json();
        const { event, data } = body;

        console.log(`[Wompi] Event: ${event} (Ref: ${data.transaction?.reference})`);

        // 1. Verify Authentication (per Wompi docs: https://docs.wompi.co/docs/colombia/eventos/)
        // Uses body.timestamp (NOT header x-event-timestamp)
        const eventSecret = Deno.env.get("WOMPI_EVENT_SECRET");
        const signature = body.signature;
        const bodyTimestamp = body.timestamp; // CRITICAL: timestamp comes from body, not header

        if (eventSecret && checksum && signature?.properties && bodyTimestamp) {
            // Build chain from signature.properties
            let chain = "";
            for (const prop of signature.properties) {
                const parts = prop.split(".");
                let value: any = data;
                for (const part of parts) {
                    value = value?.[part];
                }
                chain += String(value ?? "");
            }
            // Add body timestamp and secret
            chain += bodyTimestamp + eventSecret;

            const myChecksum = await sha256Hex(chain);

            if (checksum.toLowerCase() !== myChecksum.toLowerCase()) {
                console.error("CHECKSUM MISMATCH - Rejecting request", {
                    received: checksum,
                    calculated: myChecksum,
                    properties: signature.properties,
                    bodyTimestamp
                });
                return new Response(JSON.stringify({ error: "Invalid integrity" }), { status: 401, headers: corsHeaders });
            }
            console.log("[Wompi] ✓ Checksum validated successfully");
        } else if (eventSecret && checksum && !signature?.properties) {
            console.warn("[Wompi] Event missing signature.properties - skipping validation");
        } else {
            console.warn("[Wompi] Skipping Checksum validation (missing: secret, checksum, or timestamp)");
        }

        if (event !== "transaction.updated") {
            return new Response(JSON.stringify({ status: "ignored" }), { headers: corsHeaders });
        }

        // 2. Process Transaction
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        const tx = data.transaction;
        const ref = tx.reference;
        const status = tx.status;

        // 3. Find Order & Customer
        const { data: order, error: orderError } = await supabase
            .from("orders")
            .select("id, status, customer_id, total_cents, customers(phone_e164, name)")
            .eq("payment_reference", ref)
            .single();

        if (orderError || !order) {
            console.error("Order not found or error:", ref, orderError);
            return new Response(JSON.stringify({ error: "Order not found" }), { status: 404, headers: corsHeaders });
        }

        const customer = Array.isArray(order.customers) ? order.customers[0] : order.customers;

        // 4. Update Payment Record
        const { error: payError } = await supabase
            .from("payments")
            .upsert({
                order_id: order.id,
                reference: ref,
                transaction_id: tx.id,
                status: status.toLowerCase(),
                provider: "wompi",
                raw_event: data,
                updated_at: new Date().toISOString()
            }, { onConflict: "reference" });

        if (payError) console.error("Payment sync error:", payError);

        // 5. Update Order Status
        if (status === "APPROVED" && order.status !== "paid") {
            const { error: updateError } = await supabase
                .from("orders")
                .update({ status: "paid" })
                .eq("id", order.id);

            if (updateError) {
                console.error("Error updating order status:", updateError);
            }

            // Notify Customer via WhatsApp using shared helper
            const toPhone = customer?.phone_e164;
            if (toPhone) {
                const amountFormatted = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(order.total_cents / 100);
                const msg = `✅ *¡Pago confirmado!* \n\nHola ${customer?.name || 'cliente'}, hemos recibido tu pago de ${amountFormatted} para el pedido *#${order.id.slice(0, 8)}*. \n\nEstamos preparando tus 👟 y te avisaremos cuando estén en camino. ¡Gracias por confiar en SportBot! 🚀`;

                const result = await sendWhatsApp({ to: toPhone, body: msg });

                if (result.success) {
                    // Log message in conversation history
                    const { data: conversation } = await supabase
                        .from("conversations")
                        .select("id")
                        .eq("customer_id", order.customer_id)
                        .limit(1)
                        .single();

                    if (conversation) {
                        await supabase.from("messages").insert({
                            conversation_id: conversation.id,
                            role: 'assistant',
                            direction: 'outbound',
                            body: msg,
                            twilio_message_sid: result.sid
                        });
                    }
                } else {
                    console.error("[Wompi] WhatsApp notification failed:", result.error);
                }
            }
        }
        else if ((status === "DECLINED" || status === "VOIDED" || status === "ERROR") && order.status !== "cancelled") {
            console.log(`[Wompi] Payment Failed (${status}). Restocking Order ${order.id}`);

            const { error: updateError } = await supabase
                .from("orders")
                .update({ status: "cancelled" })
                .eq("id", order.id);

            if (!updateError) {
                const { data: items } = await supabase
                    .from("order_items")
                    .select("variant_id, qty")
                    .eq("order_id", order.id);

                if (items) {
                    for (const item of items) {
                        const { error: stockErr } = await supabase.rpc('increment_stock', {
                            row_id: item.variant_id,
                            amount: item.qty
                        });

                        if (stockErr) {
                            const { data: v } = await supabase.from("product_variants").select("stock").eq("id", item.variant_id).single();
                            if (v) {
                                await supabase.from("product_variants").update({ stock: v.stock + item.qty }).eq("id", item.variant_id);
                            }
                        }
                    }
                }
            }
        }

        return new Response(JSON.stringify({ success: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });

    } catch (err) {
        console.error("Wompi Webhook Error:", err);
        return new Response(JSON.stringify({ error: err.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
        });
    }
});
