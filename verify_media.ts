
// @ts-nocheck
import { createClient } from "npm:@supabase/supabase-js@2";
import "jsr:@std/dotenv/load";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

if (!supabaseUrl || !supabaseKey) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    Deno.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

console.log("Checking 'product_media' table...");

const { data, error } = await supabase
    .from("product_media")
    .select("*")
    .limit(5);

if (error) {
    console.error("Error accessing product_media:", error.message);
    // If table doesn't exist, error usually mentions "relation ... does not exist"
} else {
    console.log("Table 'product_media' exists.");
    console.log(`Found ${data.length} records.`);
    if (data.length > 0) console.table(data);
}
