import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAdmin } from "../_shared/admin_auth.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
    if (req.method !== "POST") {
        return new Response(JSON.stringify({ success: false, code: "method_not_allowed" }), {
            status: 405,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    const auth = await requireAdmin(req, corsHeaders);
    if (auth instanceof Response) return auth;

    // Retire the old Twilio-only sender. In particular, do not permit a stale
    // Chats client to bypass Inbox ownership, bot pause, Evolution routing, or
    // outbound idempotency. The new workstation is admin_conversation_actions.
    return new Response(JSON.stringify({
        success: false,
        code: "legacy_sender_retired",
        message: "Use the Inbox operator workspace for audited WhatsApp replies.",
    }), {
        status: 410,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
});
