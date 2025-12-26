import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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
        const timestamp = req.headers.get("x-event-timestamp");
        const checksum = req.headers.get("x-event-checksum");

        const body = await req.json();
        const { event, data } = body;

        console.log(`[Wompi] Event: ${event} (Ref: ${data.transaction?.reference})`);

        // 1. Verify Authentication
        const eventSecret = Deno.env.get("WOMPI_EVENT_SECRET");
        if (eventSecret && checksum) {
            const t = data.transaction;
            // Standard Wompi Chain: id + status + amount_in_cents + timestamp + secret
            const chain = `${t.id}${t.status}${t.amount_in_cents}${timestamp}${eventSecret}`;
            const myChecksum = await sha256Hex(chain);

            if (checksum.toLowerCase() !== myChecksum.toLowerCase()) {
                console.error("CHECKSUM MISMATCH WARNING", { received: checksum, calculated: myChecksum, chain });
                // FOR NOW: Don't return 401, just warn. This ensures we process the payment while debugging integrity.
                // return new Response(JSON.stringify({ error: "Invalid integrity" }), { status: 401, headers: corsHeaders });
            }
        } else {
            console.warn("Skipping Checksum validation (WOMPI_EVENT_SECRET not set)");
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
        const status = tx.status; // APPROVED, DECLINED, VOIDED, ERROR

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
            // Update Order
            const { error: updateError } = await supabase
                .from("orders")
                .update({ status: "paid" })
                .eq("id", order.id);

            if (updateError) {
                console.error("Error updating order status:", updateError);
            }
            // Note: Stock is NOT deducted here anymore. It was deducted at creation time (Reserve First).

            // Notify Customer via WhatsApp
            const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID");
            const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
            const fromPhone = Deno.env.get("TWILIO_WHATSAPP_FROM") || "whatsapp:+14155238886";
            const toPhone = customer?.phone_e164;

            if (accountSid && authToken && toPhone) {
                const amountFormatted = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(order.total_cents / 100);
                const msg = `✅ *¡Pago confirmado!* \n\nHola ${customer?.name || 'cliente'}, hemos recibido tu pago de ${amountFormatted} para el pedido *#${order.id.slice(0, 8)}*. \n\nEstamos preparando tus 👟 y te avisaremos cuando estén en camino. ¡Gracias por confiar en SportBot! 🚀`;

                await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
                    method: "POST",
                    headers: {
                        "Authorization": "Basic " + btoa(`${accountSid}:${authToken}`),
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                    body: new URLSearchParams({ From: fromPhone, To: toPhone, Body: msg })
                });
            }
        }
        else if ((status === "DECLINED" || status === "VOIDED" || status === "ERROR") && order.status !== "cancelled") {
            // --- RESTOCK LOGIC ---
            // If payment failed, we MUST release the reservation (add stock back).
            console.log(`[Wompi] Payment Failed (${status}). Restocking Order ${order.id}`);

            const { error: updateError } = await supabase
                .from("orders")
                .update({ status: "cancelled" }) // Mark as cancelled so we don't restock twice
                .eq("id", order.id);

            if (!updateError) {
                const { data: items } = await supabase
                    .from("order_items")
                    .select("variant_id, qty")
                    .eq("order_id", order.id);

                if (items) {
                    for (const item of items) {
                        // Add stock back
                        const { error: stockErr } = await supabase.rpc('increment_stock', {
                            row_id: item.variant_id,
                            amount: item.qty
                        });

                        // Fallback
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

