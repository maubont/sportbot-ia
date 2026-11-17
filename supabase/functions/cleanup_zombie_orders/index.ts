import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Zombie Order Cleanup Function
 * 
 * Runs on schedule and delegates all state/stock changes to the transactional
 * `expire_stale_payment_orders` RPC, which applies the configured payment
 * window and excludes orders awaiting human receipt review or already paid.
 * Customer notification belongs to `ops_sweep`; this legacy endpoint does not
 * send messages.
 */
serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 405,
        });
    }

    try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const cleanupJobSecret = Deno.env.get("CLEANUP_JOB_SECRET");
        const authHeader = req.headers.get("authorization") || "";
        const isServiceRole = Boolean(supabaseKey && authHeader === `Bearer ${supabaseKey}`);
        const isCleanupJob = Boolean(cleanupJobSecret && authHeader === `Bearer ${cleanupJobSecret}`);

        if (!supabaseKey || (!isServiceRole && !isCleanupJob)) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 401,
            });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        const body = await req.json().catch(() => ({}));
        const requestedLimit = Number(body?.limit ?? 50);
        const safeLimit = Number.isFinite(requestedLimit)
            ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 200)
            : 50;

        // La RPC aplica la ventana configurada, verifica recibos/aprobaciones,
        // bloquea la orden y libera sus reservas en la misma transacción.
        const { data, error } = await supabase.rpc("expire_stale_payment_orders", {
            p_limit: safeLimit,
        });
        if (error) {
            console.error("[Zombie Cleanup] Expiration RPC failed", { code: error.code ?? "unknown" });
            throw new Error("Order cleanup RPC failed");
        }

        const candidates = Array.isArray(data) ? data : [];
        const summary = {
            success: true,
            processed: candidates.filter((order: any) => order.expired_now === true).length,
            candidates: candidates.length,
            notificationCandidates: candidates.filter((order: any) => order.should_notify === true).length,
            stockRelease: "atomic_rpc",
        };

        console.log("[Zombie Cleanup] Completed:", JSON.stringify(summary));

        return new Response(JSON.stringify(summary), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });

    } catch (err: any) {
        console.error("[Zombie Cleanup] Fatal error", { message: err?.message ?? "unknown" });
        return new Response(JSON.stringify({
            success: false,
            error: "cleanup_failed"
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
        });
    }
});
