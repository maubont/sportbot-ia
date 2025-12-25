
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
    }

    try {
        const supabase = createClient(
            Deno.env.get("SUPABASE_URL")!,
            Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        // 1. Check if table exists by selecting 1 row
        const { data, error } = await supabase.from('product_media').select('*').limit(1);

        if (error) {
            console.error("Table check error:", error);
            return new Response(JSON.stringify({
                success: false,
                error: error.message,
                hint: "Table likely missing"
            }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 400
            });
        }

        // 2. If table exists but is empty, try to seed a dummy record
        if (data.length === 0) {
            console.log("Table exists but empty. Seeding...");
            // Get a product
            const { data: products } = await supabase.from('products').select('id, model').limit(1);

            if (products && products.length > 0) {
                const product = products[0];
                const { error: insErr } = await supabase.from('product_media').insert({
                    product_id: product.id,
                    type: 'image',
                    url: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff', // Generic Nike shoe
                    is_primary: true
                });

                if (insErr) {
                    return new Response(JSON.stringify({ success: false, error: insErr.message }), {
                        headers: { ...corsHeaders, "Content-Type": "application/json" },
                        status: 400
                    });
                }

                return new Response(JSON.stringify({
                    success: true,
                    message: `Seeded media for ${product.model}`,
                    seeded: true
                }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
        }

        return new Response(JSON.stringify({
            success: true,
            message: "Table exists and has data",
            data
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

    } catch (err: any) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 500,
        });
    }
});
