import { createClient } from "jsr:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(supabaseUrl, supabaseKey);

console.log("--- PRODUCTS ---");
const { data: products } = await supabase.from("products").select("id, sku, brand, model, active");
console.table(products);

console.log("\n--- VARIANTS FOR JORDAN (NK-JOR-010) ---");
const jordan = products?.find(p => p.sku === "NK-JOR-010");
if (jordan) {
    const { data: variants } = await supabase.from("product_variants").select("size, stock").eq("product_id", jordan.id);
    console.table(variants);
} else {
    console.log("Jordan NK-JOR-010 not found!");
}

console.log("\n--- RECENT MESSAGES ---");
const { data: messages } = await supabase.from("messages").select("role, body, created_at").order("created_at", { ascending: false }).limit(10);
console.table(messages);
