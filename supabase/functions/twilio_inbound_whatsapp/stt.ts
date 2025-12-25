import OpenAI from "npm:openai@4";
import { getSupabaseAdmin } from "./media.ts";

export async function transcribeAudio(mediaId: string, fileBytes: Uint8Array, contentType: string) {
    const client = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") ?? "" });

    // Create a File object for the OpenAI SDK
    const blob = new Blob([fileBytes], { type: contentType });
    const file = new File([blob], "audio.ogg", { type: contentType });

    const result = await client.audio.transcriptions.create({
        file: file,
        model: "whisper-1",
        language: "es", // Prioritize Spanish for this project
    });

    const text = result.text ?? "";

    if (text) {
        const supabase = getSupabaseAdmin();
        await supabase.from("media_files").update({ transcription: text }).eq("id", mediaId);
    }

    return text;
}
