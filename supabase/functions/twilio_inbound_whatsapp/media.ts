import { createClient } from "jsr:@supabase/supabase-js@2";

export function getSupabaseAdmin() {
    return createClient(
        Deno.env.get("SUPABASE_URL") ?? "",
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchTwilioMedia(url: string): Promise<Uint8Array> {
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID") ?? "";
    const token = Deno.env.get("TWILIO_AUTH_TOKEN") ?? "";
    const basic = btoa(`${sid}:${token}`);

    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { Authorization: `Basic ${basic}` },
            });

            if (!res.ok) throw new Error(`Twilio media fetch failed: ${res.status}`);
            return new Uint8Array(await res.arrayBuffer());
        } catch (err) {
            lastError = err;
            if (attempt < 3) await delay(350 * attempt);
        }
    }

    throw lastError instanceof Error ? lastError : new Error("Twilio media fetch failed");
}

export function extFromContentType(ct: string) {
    if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
    if (ct.includes("png")) return "png";
    if (ct.includes("pdf")) return "pdf";
    if (ct.includes("mp4")) return "mp4";
    if (ct.includes("ogg")) return "ogg";
    if (ct.includes("mpeg")) return "mp3";
    if (ct.includes("aac")) return "aac";
    if (ct.includes("3gpp")) return "3gp";
    return "bin";
}

export async function storeInboundMedia(params: {
    messageId: string;
    fromPhone: string;
    mediaUrl: string;
    contentType: string;
}) {
    const bytes = await fetchTwilioMedia(params.mediaUrl);

    return await storeInboundMediaFromBytes({
        messageId: params.messageId,
        fromPhone: params.fromPhone,
        contentType: params.contentType,
        sourceUrl: params.mediaUrl,
        bytes,
    });
}

/**
 * Guarda media que ya está en memoria (Evolution entrega base64, no una URL).
 */
export async function storeInboundMediaFromBytes(params: {
    messageId: string;
    fromPhone: string;
    contentType: string;
    sourceUrl: string;
    bytes: Uint8Array;
}) {
    const supabase = getSupabaseAdmin();
    const bytes = params.bytes;

    const ext = extFromContentType(params.contentType);
    const path = `inbound/${params.fromPhone}/${params.messageId}.${ext}`;

    const { error: uploadError } = await supabase.storage
        .from("whatsapp-media")
        .upload(path, bytes, { contentType: params.contentType, upsert: true });

    if (uploadError) throw uploadError;

    const { data: mediaFile, error: insError } = await supabase.from("media_files").insert({
        message_id: params.messageId,
        source_url: params.sourceUrl,
        content_type: params.contentType,
        storage_bucket: "whatsapp-media",
        storage_path: path,
        direction: "inbound",
        bytes: bytes.byteLength,
        media_type: params.contentType.split('/')[0]
    }).select().single();

    if (insError) throw insError;
    return { path, bytes: bytes.byteLength, id: mediaFile.id, fileBytes: bytes };
}
