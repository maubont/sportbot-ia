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

function resolveApprovalTimestamp(tx: Record<string, unknown>): string {
    const candidates = [tx.finalized_at, tx.created_at];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))) {
            return new Date(candidate).toISOString();
        }
    }

    return new Date().toISOString();
}

function getNumberAtPath(source: Record<string, unknown>, path: string): number | null {
    let value: unknown = source;

    for (const segment of path.split(".")) {
        if (!value || typeof value !== "object" || !(segment in value)) return null;
        value = (value as Record<string, unknown>)[segment];
    }

    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
}

function resolveWompiFeeCents(tx: Record<string, unknown>): number | null {
    const candidatePaths = [
        "fee_in_cents",
        "fees_in_cents",
        "wompi_fee_in_cents",
        "merchant_fee_in_cents",
        "fees.fee_in_cents",
        "fees.wompi_fee_in_cents",
        "fees.total_fee_in_cents",
        "fees.transaction_fee_in_cents",
        "fees.total_in_cents",
        "fee.amount_in_cents",
    ];

    for (const path of candidatePaths) {
        const value = getNumberAtPath(tx, path);
        if (value !== null && value >= 0) return Math.round(value);
    }

    return null;
}

function formatCopFromCents(cents: number): string {
    const amount = new Intl.NumberFormat("es-CO", {
        maximumFractionDigits: 0,
    }).format(cents / 100);

    return `$${amount}`;
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const body = await req.json();
        const { event, data } = body;
        const checksum = req.headers.get("x-event-checksum") || body.signature?.checksum;

        console.log(`[Wompi] Event: ${event} (Ref: ${data.transaction?.reference})`);

        // 1. Verify Authentication (per Wompi docs: https://docs.wompi.co/docs/colombia/eventos/)
        // Uses body.timestamp (NOT header x-event-timestamp)
        const eventSecret = Deno.env.get("WOMPI_EVENT_SECRET");
        const signature = body.signature;
        const bodyTimestamp = body.timestamp; // CRITICAL: timestamp comes from body, not header

        if (!eventSecret) {
            console.error("[Wompi] WOMPI_EVENT_SECRET is not configured - rejecting request");
            return new Response(JSON.stringify({ error: "Wompi event secret is not configured" }), { status: 500, headers: corsHeaders });
        }

        if (!checksum || !signature?.properties || !bodyTimestamp) {
            console.error("[Wompi] Missing signature fields - rejecting request", {
                hasChecksum: Boolean(checksum),
                hasProperties: Boolean(signature?.properties),
                hasTimestamp: Boolean(bodyTimestamp)
            });
            return new Response(JSON.stringify({ error: "Missing integrity signature" }), { status: 401, headers: corsHeaders });
        }

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
        const isApproved = status === "APPROVED";
        const approvedAt = isApproved ? resolveApprovalTimestamp(tx) : null;
        const wompiFeeCents = isApproved ? resolveWompiFeeCents(tx) : null;

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

        if (payError) {
            console.error("Payment sync error:", payError);
            throw payError;
        }

        if (approvedAt) {
            const { error: approvedPaymentError } = await supabase
                .from("payments")
                .update({ approved_at: approvedAt })
                .eq("reference", ref)
                .is("approved_at", null);

            if (approvedPaymentError) {
                console.error("Payment approval timestamp sync error:", approvedPaymentError);
                throw approvedPaymentError;
            }
        }

        if (isApproved && wompiFeeCents !== null && wompiFeeCents > 0) {
            const feeExternalRef = typeof tx.id === "string" && tx.id ? tx.id : ref;
            const { error: feeError } = await supabase
                .from("order_variable_costs")
                .upsert({
                    order_id: order.id,
                    cost_type: "payment_fee",
                    amount_cents: wompiFeeCents,
                    currency: "COP",
                    source: "wompi",
                    external_ref: feeExternalRef,
                    occurred_at: approvedAt || new Date().toISOString(),
                    metadata: {
                        provider: "wompi",
                        reference: ref,
                        transaction_id: tx.id ?? null,
                    },
                }, { onConflict: "order_id,cost_type,source,external_ref" });

            if (feeError) {
                console.error("Wompi fee sync error:", feeError);
                throw feeError;
            }
        }

        // 5. Update Order Status
        if (isApproved && ["paid", "processing", "shipped", "delivered"].includes(order.status)) {
            const { error: paidAtError } = await supabase
                .from("orders")
                .update({ paid_at: approvedAt })
                .eq("id", order.id)
                .is("paid_at", null);

            if (paidAtError) {
                console.error("Error syncing order paid_at:", paidAtError);
                throw paidAtError;
            }
        }

        if (isApproved && !["paid", "processing", "shipped", "delivered"].includes(order.status)) {
            const { error: commitError } = await supabase.rpc('commit_order_stock', {
                target_order_id: order.id
            });

            if (commitError) {
                console.error("Error committing stock:", commitError);
                throw commitError;
            }

            const { error: updateError } = await supabase
                .from("orders")
                .update({ status: "paid", paid_at: approvedAt })
                .eq("id", order.id);

            if (updateError) {
                console.error("Error updating order status:", updateError);
                throw updateError;
            }

            // Notify Customer via WhatsApp using shared helper
            const toPhone = customer?.phone_e164;
            if (toPhone) {
                const amountFormatted = formatCopFromCents(Number(order.total_cents || 0));
                const msg = `✅ *Pago confirmado*\n\nHola ${customer?.name || "cliente"}, recibimos tu pago de ${amountFormatted} para el pedido *#${order.id.slice(0, 8)}*.\n\nYa estamos preparando tus 👟. Te avisaremos cuando estén en camino.`;

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
        else if (
            (status === "DECLINED" || status === "VOIDED" || status === "ERROR") &&
            !["cancelled", "expired", "paid", "processing", "shipped", "delivered"].includes(order.status)
        ) {
            console.log(`[Wompi] Payment Failed (${status}). Restocking Order ${order.id}`);

            const { error: releaseError } = await supabase.rpc('release_order_stock', {
                target_order_id: order.id
            });

            if (releaseError) {
                console.error("Error releasing reserved stock:", releaseError);
                throw releaseError;
            }

            const { error: updateError } = await supabase
                .from("orders")
                .update({ status: "cancelled" })
                .eq("id", order.id);

            if (updateError) throw updateError;
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
