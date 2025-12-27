import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Zombie Order Cleanup Function
 * 
 * Runs on schedule (hourly) to:
 * 1. Find orders stuck in 'awaiting_payment' for more than 24 hours
 * 2. Release reserved stock back to inventory
 * 3. Mark orders as 'expired'
 */
serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // Configuration
        const EXPIRY_HOURS = 2; // WhatsApp commerce: quick decisions
        const expiryThreshold = new Date(Date.now() - EXPIRY_HOURS * 60 * 60 * 1000).toISOString();

        console.log(`[Zombie Cleanup] Starting... Looking for orders older than ${EXPIRY_HOURS}h (before ${expiryThreshold})`);

        // 1. Find zombie orders
        const { data: zombieOrders, error: findError } = await supabase
            .from("orders")
            .select("id, created_at, order_items(variant_id, qty)")
            .eq("status", "awaiting_payment")
            .lt("created_at", expiryThreshold);

        if (findError) {
            throw new Error(`Failed to find zombie orders: ${findError.message}`);
        }

        if (!zombieOrders || zombieOrders.length === 0) {
            console.log("[Zombie Cleanup] No zombie orders found. All clean! ✨");
            return new Response(JSON.stringify({
                success: true,
                message: "No zombie orders found",
                processed: 0
            }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 200,
            });
        }

        console.log(`[Zombie Cleanup] Found ${zombieOrders.length} zombie orders to process`);

        let processedCount = 0;
        let stockReleasedCount = 0;
        const errors: string[] = [];

        // 2. Process each zombie order
        for (const order of zombieOrders) {
            try {
                console.log(`[Zombie Cleanup] Processing Order ${order.id}...`);

                // 2a. Release stock for each item
                for (const item of order.order_items || []) {
                    const { error: stockError } = await supabase.rpc('increment_stock', {
                        row_id: item.variant_id,
                        amount: item.qty
                    });

                    if (stockError) {
                        // Fallback: Direct update
                        const { data: variant } = await supabase
                            .from("product_variants")
                            .select("stock")
                            .eq("id", item.variant_id)
                            .single();

                        if (variant) {
                            await supabase
                                .from("product_variants")
                                .update({ stock: variant.stock + item.qty })
                                .eq("id", item.variant_id);
                        }
                    }

                    stockReleasedCount += item.qty;
                }

                // 2b. Mark order as expired
                const { error: updateError } = await supabase
                    .from("orders")
                    .update({
                        status: "expired",
                        updated_at: new Date().toISOString()
                    })
                    .eq("id", order.id);

                if (updateError) {
                    throw new Error(`Failed to update order: ${updateError.message}`);
                }

                processedCount++;
                console.log(`[Zombie Cleanup] ✅ Order ${order.id} expired, ${stockReleasedCount} units released`);

            } catch (orderErr: any) {
                errors.push(`Order ${order.id}: ${orderErr.message}`);
                console.error(`[Zombie Cleanup] ❌ Error processing ${order.id}:`, orderErr);
            }
        }

        const summary = {
            success: true,
            message: `Cleaned up ${processedCount} zombie orders`,
            processed: processedCount,
            stockReleased: stockReleasedCount,
            errors: errors.length > 0 ? errors : undefined
        };

        console.log("[Zombie Cleanup] Completed:", summary);

        return new Response(JSON.stringify(summary), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });

    } catch (err: any) {
        console.error("[Zombie Cleanup] Fatal Error:", err);
        return new Response(JSON.stringify({
            success: false,
            error: err.message
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
        });
    }
});
