
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { getProductMedia } from "./tools.ts";
import { requireAdmin } from "../_shared/admin_auth.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const auth = await requireAdmin(req, corsHeaders);
        if (auth instanceof Response) return auth;

        const { supabase } = auth;

        const url = new URL(req.url);
        const query = url.searchParams.get("query") || "jordan";

        console.log(`[test_tools v3] Testing getProductMedia with query: ${query}`);

        const result = await getProductMedia(supabase, query);

        return new Response(JSON.stringify({
            query,
            result
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (err: any) {
        return new Response(JSON.stringify({
            error: err.message,
            stack: err.stack
        }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
        });
    }
});
