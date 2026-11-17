import OpenAI from "npm:openai@4";
import { getSupabaseAdmin } from "./media.ts";

function filenameFromContentType(contentType: string) {
    const normalized = contentType.toLowerCase();
    if (normalized.includes("mpeg") || normalized.includes("mp3")) return "audio.mp3";
    if (normalized.includes("mp4")) return "audio.mp4";
    if (normalized.includes("m4a")) return "audio.m4a";
    if (normalized.includes("wav")) return "audio.wav";
    if (normalized.includes("webm")) return "audio.webm";
    if (normalized.includes("ogg") || normalized.includes("opus")) return "audio.ogg";
    if (normalized.includes("3gpp")) return "audio.3gp";
    return "audio.bin";
}

export async function transcribeAudio(mediaId: string | null, fileBytes: Uint8Array, contentType: string) {
    const client = new OpenAI({ apiKey: Deno.env.get("OPENAI_API_KEY") ?? "" });

    const blob = new Blob([new Uint8Array(fileBytes)], { type: contentType });
    const file = new File([blob], filenameFromContentType(contentType), { type: contentType });
    const model = Deno.env.get("OPENAI_TRANSCRIBE_MODEL") || "whisper-1";
    const prompt = [
        "Conversacion de WhatsApp en espanol colombiano entre un cliente y una tienda de sneakers llamada SportBot.",
        "El cliente puede preguntar por disponibilidad, precio, fotos, tallas o compra.",
        "Vocabulario frecuente: Nike, Nike Air Max, Air Max 90, Jordan, Adidas, Ultraboost, Metcon, Revolution, talla 39, 40, 41, 42, 43, Bogota, Medellin, Cali.",
        "Transcribe exactamente lo que dice el cliente. No resumas. No respondas al cliente.",
    ].join(" ");

    const result = await client.audio.transcriptions.create({
        file,
        model,
        language: "es",
        prompt,
        temperature: 0,
    } as any);

    const text = (result.text ?? "").trim();

    if (text && mediaId) {
        const supabase = getSupabaseAdmin();
        await supabase.from("media_files").update({ transcription: text }).eq("id", mediaId);
    }

    return text;
}
