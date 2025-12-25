
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { getProductMedia, resolveProduct } from "./tools.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const url = new URL(req.url);
        const query = url.searchParams.get("query") || "jordan";

        console.log(`[test_tools v3] Testing getProductMedia with query: ${query}`);

        // Test 1: Resolve Product directly
        // Note: resolveProduct is not exported? Wait, I need to check if it's exported.
        // I can't check resolveProduct if it's not exported. 
        // But getProductMedia uses it internally.

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
