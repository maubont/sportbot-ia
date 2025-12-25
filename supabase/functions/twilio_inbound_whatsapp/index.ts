import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import OpenAI from "npm:openai@4";
import { processAIResponse } from "./ai.ts";
import { getStoreInfo } from "./tools.ts";
import { storeInboundMedia } from "./media.ts";
import { transcribeAudio } from "./stt.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    try {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

        const formData = await req.formData();
        const data = Object.fromEntries(formData);

        const Body = (data.Body as string) || "";
        const From = (data.From as string) || "";
        const NumMedia = parseInt((data.NumMedia as string) || "0");
        const ProfileName = (data.ProfileName as string) || "Customer";

        console.log(`[Inbound] ${From}: ${Body} (${NumMedia} media)`);

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. Get/Create Customer
        let { data: customer } = await supabase.from("customers").select("id").eq("phone_e164", From).single();
        if (!customer) {
            const { data: newC, error: newCError } = await supabase.from("customers").insert({
                phone_e164: From,
                name: ProfileName
            }).select("id").single();
            if (newCError) throw newCError;
            customer = newC!;
        }

        // 2. Get/Create Conversation
        let { data: conversation } = await supabase.from("conversations").select("id").eq("customer_id", customer.id).eq("status", "open").maybeSingle();
        if (!conversation) {
            const { data: newConv, error: convError } = await supabase.from("conversations").insert({
                customer_id: customer.id,
                status: "open"
            }).select("id").single();
            if (convError) throw convError;
            conversation = newConv!;
        }

        // 3. Create initial Message Record
        const { data: messageMsg, error: msgError } = await supabase.from("messages").insert({
            conversation_id: conversation.id,
            direction: "inbound",
            role: "user",
            body: Body,
            raw_payload: data,
            twilio_message_sid: data.MessageSid as string
        }).select().single();
        if (msgError) throw msgError;

        // 4. Process Media (Storage + STT)
        let finalUserText = Body;
        if (NumMedia > 0) {
            for (let i = 0; i < NumMedia; i++) {
                const mediaUrl = data[`MediaUrl${i}`] as string;
                const contentType = data[`MediaContentType${i}`] as string;

                try {
                    const stored = await storeInboundMedia({
                        messageId: messageMsg.id,
                        fromPhone: From,
                        mediaUrl,
                        contentType
                    });

                    if (contentType.startsWith("audio/")) {
                        const transcription = await transcribeAudio(stored.id, stored.fileBytes, contentType);
                        if (transcription) {
                            finalUserText += (finalUserText ? "\n" : "") + `[Nota de voz]: ${transcription}`;
                        }
                    }
                } catch (mediaErr) {
                    console.error(`Error processing media ${i}:`, mediaErr);
                }
            }

            // Update message body if transcriptions were added
            if (finalUserText !== Body) {
                await supabase.from("messages").update({ body: finalUserText }).eq("id", messageMsg.id);
            }
        }

        // 5. Generate AI Response (or Welcome Protocol)
        let aiText = "";
        let aiMedia: string[] = [];

        const greetingRegex = /^(hola|buenas|start|inicio|hi|hello)\b/i;
        const isGreeting = greetingRegex.test(finalUserText.trim().toLowerCase());
        const isShort = finalUserText.trim().length < 30;

        if (isGreeting && isShort) {
            console.log(`[Inbound] Detected greeting: "${finalUserText}" -> Triggering Welcome Protocol`);

            try {
                const storeInfo = await getStoreInfo(supabase);

                aiText = "¡Bienvenido a SportBot! 👟🔥\n\nSomos especialistas en sneakers exclusivos. Aquí tienes nuestro catálogo actualizado y las mejores ofertas del día.\n\n¿Buscas alguna marca en especial? (Ej: Jordan, Nike, Adidas)";

                if (storeInfo.welcome_image) aiMedia.push(storeInfo.welcome_image);
                if (storeInfo.catalog_pdf) aiMedia.push(storeInfo.catalog_pdf);

                // Save Assistant Response to DB
                await supabase.from("messages").insert({
                    conversation_id: conversation.id,
                    role: "assistant",
                    direction: "outbound",
                    body: aiText,
                });
            } catch (welcomeErr: any) {
                console.error("Welcome Flow Error:", welcomeErr);
                aiText = "¡Hola! Bienvenido a SportBot. ¿En qué puedo ayudarte hoy?";
            }

        } else {
            const result = await processAIResponse(supabase, conversation.id, customer.id, finalUserText);
            aiText = result.text;
            aiMedia = result.media;
        }

        // 6. Reply via TwiML
        const escapedAiText = aiText
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&apos;");

        const mediaTags = (aiMedia || []).map(url => `<Media>${url}</Media>`).join("\n");
        const twiml = `
        <Response>
            <Message>
                <Body>${escapedAiText}</Body>
                ${mediaTags}
            </Message>
        </Response>`;

        return new Response(twiml, {
            headers: { ...corsHeaders, "Content-Type": "text/xml" },
            status: 200,
        });

    } catch (err: any) {
        console.error("Critical Error:", err);
        const errorTwiml = `<Response><Message>Lo siento, error tecnico: ${err.message}</Message></Response>`;
        return new Response(errorTwiml, {
            headers: { ...corsHeaders, "Content-Type": "text/xml" },
            status: 200,
        });
    }
});

