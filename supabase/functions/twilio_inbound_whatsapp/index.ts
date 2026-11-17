import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import OpenAI from "npm:openai@4";
import { processAIResponse } from "./ai.ts";
import { buildWelcomeText, getStoreInfo } from "./tools.ts";
import { fetchTwilioMedia, storeInboundMedia, storeInboundMediaFromBytes } from "./media.ts";
import { transcribeAudio } from "./stt.ts";
import {
    describeInboundImage,
    formatImageReadingForAgent,
    summarizeImageReading,
} from "./vision.ts";
import { recordConversationEvent, refreshCustomerProfileBestEffort } from "./events.ts";
import { extractStorefrontHandoffCode, linkStorefrontHandoff, stripStorefrontHandoffCode } from "./handoff.ts";
import { verifyTwilioSignature } from "./signature.ts";
import { isBotPaused, loadConversationState, patchConversationState } from "./state.ts";
import {
    capturePaymentReceipt,
    prevalidateReceipts,
    type StoredInboundMedia,
} from "./payments.ts";
import type { ReceiptExtraction } from "./payments-core.ts";
import { receiptCaptureReply, type ReceiptCaptureResult } from "./receipt-capture-core.ts";
import {
    recordEvolutionLogisticsNotificationStatus,
    updateLogisticsNotificationFromTwilioStatus,
} from "../_shared/logistics_notifications.ts";
import {
    detectChannel,
    sendOutbound,
    verifyWebhookSecret,
} from "../_shared/channels/index.ts";
import type { EvolutionConfig } from "../_shared/channels/evolution.ts";
import {
    fetchEvolutionMedia,
    isRetryableEvolutionIgnoredEvent,
    parseEvolutionEvent,
} from "../_shared/channels/evolution.ts";
import { parseTwilioPayload } from "../_shared/channels/twilio.ts";
import {
    requireInboundMessageId,
    resolveInboundClaimResult,
} from "./inbound-claim.ts";
import {
    canAdvanceEvolutionDeliveryStatus,
    mapEvolutionDeliveryStatus,
} from "../_shared/channels/delivery-status.ts";
import { isTestAllowed } from "../_shared/channels/test-guard.ts";
import type { ChannelName, InboundEnvelope } from "../_shared/channels/types.ts";

/** Configuración de Evolution, o null si el canal no está montado todavía. */
function evolutionConfig(): EvolutionConfig | null {
    const baseUrl = Deno.env.get("EVOLUTION_API_URL") ?? "";
    const apiKey = Deno.env.get("EVOLUTION_API_KEY") ?? "";
    const instance = Deno.env.get("EVOLUTION_INSTANCE") ?? "";
    if (!baseUrl || !apiKey || !instance) return null;
    return { baseUrl, apiKey, instance };
}

async function persistEvolutionOperatorDeliveryStatus(
    supabase: SupabaseClient,
    params: { providerMessageId: string; providerStatus: string; errorMessage: string | null },
) {
    const nextStatus = mapEvolutionDeliveryStatus(params.providerStatus);
    if (!nextStatus) return { updated: false, reason: "status_not_delivery_lifecycle" };

    let message: Record<string, any> | null = null;
    let updated: Record<string, any> | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error: lookupError } = await supabase
            .from("messages")
            .select("id, conversation_id, delivery_status, role, sent_by_user_id")
            .eq("channel", "evolution")
            .eq("provider_message_id", params.providerMessageId)
            .maybeSingle();
        if (lookupError) return { updated: false, reason: "lookup_failed" };
        if (!data) return { updated: false, reason: "outbound_not_found" };

        message = data;
        const current = String(message.delivery_status ?? "");
        if (!canAdvanceEvolutionDeliveryStatus(current, nextStatus)) {
            return { updated: false, reason: "stale_status" };
        }

        let updateQuery = supabase
            .from("messages")
            .update({
                delivery_status: nextStatus,
                delivery_error: nextStatus === "failed" ? String(params.errorMessage ?? "Evolution reported a send error").slice(0, 500) : null,
                delivery_updated_at: new Date().toISOString(),
            })
            .eq("id", message.id)
            .eq("channel", "evolution");
        updateQuery = current
            ? updateQuery.eq("delivery_status", current)
            : updateQuery.is("delivery_status", null);
        const { data: changed, error: updateError } = await updateQuery
            .select("id, conversation_id")
            .maybeSingle();
        if (updateError) return { updated: false, reason: "update_failed" };
        if (changed) {
            updated = changed;
            break;
        }
    }
    if (!message || !updated) return { updated: false, reason: "update_race" };

    const eventType = nextStatus === "delivered" ? "provider_delivered"
        : nextStatus === "read" ? "provider_read"
        : nextStatus === "failed" ? "message_send_failed"
        : "message_send_accepted";
    if (message.role === "agent" || message.sent_by_user_id) {
        await supabase.from("conversation_operator_events").insert({
            conversation_id: updated.conversation_id,
            actor_user_id: null,
            event_type: eventType,
            message_id: updated.id,
            channel: "evolution",
            details: { provider_status: params.providerStatus },
        });
    }

    return { updated: true, deliveryStatus: nextStatus };
}

/**
 * Tarea que puede seguir despues de responder el webhook. En Supabase se usa
 * EdgeRuntime.waitUntil; en cualquier otro runtime se espera (con timeout en
 * la propia tarea) para no perderla.
 */
function scheduleBackground(task: Promise<unknown>) {
    const edgeRuntime = (globalThis as typeof globalThis & {
        EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;

    if (edgeRuntime?.waitUntil) {
        edgeRuntime.waitUntil(task);
        return;
    }

    void task;
}

/**
 * Acuse de recibo. Twilio exige TwiML; Evolution solo mira el código HTTP.
 */
function ack(channel: ChannelName, body?: Record<string, unknown>) {
    if (channel === "evolution") {
        return new Response(JSON.stringify(body ?? { ok: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200,
        });
    }
    return new Response("<Response></Response>", {
        headers: { ...corsHeaders, "Content-Type": "text/xml" },
        status: 200,
    });
}

/**
 * Marca el mensaje entrante con su estado final.
 * Si falla, se registra pero no se propaga: la respuesta al cliente ya está lista
 * y el reintento automático (5 min) recuperará el mensaje.
 */
async function finishInboundMessage(
    supabase: SupabaseClient,
    provider: ChannelName,
    messageSid: string,
    status: "done" | "failed",
    errorMessage?: string | null,
) {
    const { error } = await supabase.rpc("finish_inbound_message", {
        p_provider: provider,
        p_message_id: messageSid,
        p_status: status,
        p_error: errorMessage ?? null,
    });

    if (error) {
        console.error(`[Dedupe] finish_inbound_message(${status}) failed:`, error.message);
    }
}

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function isGreetingIntent(text: string) {
    return /^(hola|buenas|start|inicio|hi|hello)\b/i.test(text.trim().toLowerCase());
}

function inferBasicIntent(text: string, mediaCount: number) {
    const normalized = text.toLowerCase();
    if (isGreetingIntent(text)) return "greeting";
    if (mediaCount > 0 && !text.trim()) return "support";
    if (/\b(foto|imagen|ver|mostrar|color)\b/i.test(normalized)) return "product_image";
    if (/\b(talla|numero|n[uú]mero|disponible|stock)\b/i.test(normalized)) return "size_availability";
    if (/\b(comprar|compra|pagar|pedido|orden)\b/i.test(normalized)) return "buy_intent";
    if (/\b(precio|vale|cu[aá]nto|cuanto)\b/i.test(normalized)) return "price_question";
    if (/\b(env[ií]o|gu[ií]a|despacho|entrega|tracking)\b/i.test(normalized)) return "shipping_status";
    if (/\b(queja|cambio|devolver|garant[ií]a|problema)\b/i.test(normalized)) return "support";
    return "unknown";
}

function normalizeAudioTranscript(text: string) {
    return text
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function isLowInformationAudioTranscript(text: string) {
    const normalized = normalizeAudioTranscript(text);
    if (!normalized) return true;

    const words = normalized.split(" ").filter(Boolean);
    const fillerWords = new Set([
        "ok",
        "okay",
        "okey",
        "si",
        "sip",
        "sí",
        "listo",
        "dale",
        "bueno",
        "aja",
        "ajá",
        "perfecto",
        "gracias",
        "ya",
        "vale",
    ]);

    return words.length <= 2 && words.every((word) => fillerWords.has(word));
}

function audioClarificationMessage(params: {
    mediaProcessingFailed: boolean;
    audioTranscriptText: string;
}) {
    if (params.mediaProcessingFailed) {
        return "Recibí tu nota de voz, pero no pude transcribirla bien. ¿Me escribes por texto la marca, modelo, talla o los datos de envío?";
    }

    if (params.audioTranscriptText) {
        return `Recibí tu nota de voz, pero solo alcancé a entender "${params.audioTranscriptText}". ¿Me la repites o me escribes la marca, modelo y talla? Por ejemplo: Nike Air Max talla 42.`;
    }

    return "Recibí tu nota de voz, pero no encontré suficiente texto para procesarla. ¿Me escribes la marca, modelo, talla o lo que necesitas?";
}

serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    let channel: ChannelName = "evolution";

    let inboundClaim: {
        supabase: SupabaseClient;
        provider: ChannelName;
        messageSid: string;
        finished: boolean;
    } | null = null;

    try {
        if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

        channel = detectChannel(req);

        let envelope: InboundEnvelope;
        let rawPayload: Record<string, unknown>;

        if (channel === "evolution") {
            if (!verifyWebhookSecret(req, Deno.env.get("EVOLUTION_WEBHOOK_SECRET"))) {
                console.warn("[Evolution] Webhook sin secreto válido");
                return new Response("Forbidden", { status: 403, headers: corsHeaders });
            }

            let payload: unknown;
            try {
                payload = await req.json();
            } catch {
                return new Response("Bad Request", { status: 400, headers: corsHeaders });
            }

            const parsed = parseEvolutionEvent(payload);

            if (parsed.kind === "ignored") {
                if (isRetryableEvolutionIgnoredEvent(parsed)) {
                    console.warn("[Evolution] Mensaje entrante sin ID estable; se solicita reintento.");
                    return new Response(JSON.stringify({ ok: false, error: "message_id_required" }), {
                        headers: { ...corsHeaders, "Content-Type": "application/json" },
                        status: 503,
                    });
                }
                console.log(`[Evolution] Evento ignorado: ${parsed.reason}`);
                return ack(channel, { ok: true, ignored: parsed.reason });
            }

            if (parsed.kind === "status") {
                console.log(`[Evolution] Estado ${parsed.status} de ${parsed.messageId}`);
                const statusSupabase = createClient(
                    Deno.env.get("SUPABASE_URL")!,
                    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
                );
                const [persisted, logisticsStatus] = await Promise.all([
                    persistEvolutionOperatorDeliveryStatus(statusSupabase, {
                        providerMessageId: parsed.messageId,
                        providerStatus: parsed.status,
                        errorMessage: parsed.errorMessage,
                    }),
                    recordEvolutionLogisticsNotificationStatus(statusSupabase, {
                        providerMessageId: parsed.messageId,
                        status: parsed.status,
                        errorMessage: parsed.errorMessage,
                        rawPayload: parsed.raw,
                    }),
                ]);
                if (!persisted.updated && persisted.reason !== "outbound_not_found" && persisted.reason !== "status_not_delivery_lifecycle") {
                    console.warn("[Evolution] No se pudo actualizar el estado del mensaje humano:", persisted.reason);
                }
                if (logisticsStatus?.error) {
                    console.warn("[Evolution] No se pudo actualizar la traza logística:", logisticsStatus.error);
                }
                return ack(channel, { ok: true, status: parsed.status });
            }

            envelope = parsed;
            rawPayload = parsed.raw;
        } else {
            const formData = await req.formData();
            const data = Object.fromEntries(formData);
            const validSignature = await verifyTwilioSignature(req, data, {
                authToken: Deno.env.get("TWILIO_AUTH_TOKEN"),
                supabaseUrl: Deno.env.get("SUPABASE_URL"),
            });
            if (!validSignature) {
                console.warn("[Twilio] Invalid request signature");
                return new Response("Forbidden", { status: 403, headers: corsHeaders });
            }

            const parsed = parseTwilioPayload(data as Record<string, unknown>);

            if (parsed.kind === "ignored") {
                console.log(`[Twilio] Evento ignorado: ${parsed.reason}`);
                return ack(channel);
            }

            if (parsed.kind === "status") {
                const messageSid = parsed.messageId;
                const twilioStatus = parsed.status;
                console.log("[Twilio] Status callback received", twilioStatus, messageSid);

                if (messageSid && twilioStatus) {
                    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
                    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
                    const supabase = createClient(supabaseUrl, supabaseKey);

                    await updateLogisticsNotificationFromTwilioStatus(supabase, {
                        providerMessageSid: messageSid,
                        twilioStatus,
                        rawPayload: Object.fromEntries(
                            Object.entries(data).map(([key, value]) => [key, String(value)])
                        ),
                        errorMessage: parsed.errorMessage,
                    });
                }

                return ack(channel);
            }

            envelope = parsed;
            rawPayload = data as Record<string, unknown>;
        }

        const Body = envelope.text;
        const From = envelope.from;
        const NumMedia = envelope.media.length;
        const ProfileName = envelope.profileName ?? "Customer";
        const providerMessageId = envelope.messageId;
        const eventSource = channel === "evolution" ? "evolution_inbound_whatsapp" : "twilio_inbound_whatsapp";

        // Candado de pruebas. Con un número personal vinculado, el bot respondería
        // también a familia y amigos que escriban por casualidad.
        const testAllowlist = Deno.env.get("SPORTBOT_TEST_ALLOWLIST");
        if (!isTestAllowed(From, testAllowlist)) {
            console.warn("[Test] Sender fuera de la allowlist de prueba; evento ignorado.");
            return ack(channel, { ok: true, ignored: "not_in_test_allowlist" });
        }

        // Sin identidad estable del proveedor no es seguro procesar una
        // intención que puede terminar creando un pedido.
        const messageSid = requireInboundMessageId(providerMessageId);

        console.log(`[Inbound:${channel}] Mensaje recibido (${Body.length} caracteres, ${NumMedia} adjuntos).`);

        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const supabase = createClient(supabaseUrl, supabaseKey);

        // 1. Get/Create Customer
        // El teléfono canónico es la identidad. Si quedaron filas viejas con el
        // prefijo de Twilio (`whatsapp:+57...`), se reutilizan y se corrigen en
        // el primer contacto en vez de duplicar al cliente.
        let { data: customer } = await supabase
            .from("customers")
            .select("id")
            .eq("phone_e164", From)
            .maybeSingle();

        if (!customer && envelope.fromRaw && envelope.fromRaw !== From) {
            const { data: legacyCustomer } = await supabase
                .from("customers")
                .select("id")
                .eq("phone_e164", envelope.fromRaw)
                .maybeSingle();

            if (legacyCustomer) {
                customer = legacyCustomer;
                const { error: healError } = await supabase
                    .from("customers")
                    .update({ phone_e164: From })
                    .eq("id", legacyCustomer.id);
                if (healError) {
                    console.warn("[Identity] No se pudo normalizar el teléfono:", healError.message);
                }
            }
        }

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

        // 3. Reclamar el mensaje entrante ANTES de insertarlo o razonar.
        // Un reintento del webhook con el mismo id de proveedor responde 200 sin IA.
        const { data: claimed, error: claimError } = await supabase.rpc("claim_inbound_message", {
            p_provider: channel,
            p_message_id: messageSid,
            p_conversation_id: conversation.id,
        });
        const claimDisposition = resolveInboundClaimResult(claimed, claimError);

        if (claimDisposition === "duplicate") {
            console.log(`[Dedupe] Mensaje ${messageSid} ya procesado o en curso; se ignora.`);
            return ack(channel);
        }
        inboundClaim = { supabase, provider: channel, messageSid, finished: false };

        // 4. Create initial Message Record
        const { data: messageMsg, error: msgError } = await supabase.from("messages").insert({
            conversation_id: conversation.id,
            direction: "inbound",
            role: "user",
            body: Body,
            raw_payload: rawPayload,
            channel,
            provider_message_id: messageSid || null,
            twilio_message_sid: channel === "twilio" ? (messageSid || null) : null,
        }).select().single();
        if (msgError) throw msgError;

        const storefrontHandoffCode = extractStorefrontHandoffCode(Body);
        const storefrontHandoff = storefrontHandoffCode
            ? await linkStorefrontHandoff(supabase, {
                code: storefrontHandoffCode,
                customerId: customer.id,
                conversationId: conversation.id,
                messageId: messageMsg.id,
                twilioMessageSid: channel === "twilio" ? messageSid : null,
            })
            : null;
        const linkedStorefrontHandoff = storefrontHandoff?.status === "linked"
            || storefrontHandoff?.status === "already_linked"
            ? storefrontHandoff.row
            : null;

        await recordConversationEvent(supabase, {
            eventType: "message_inbound_received",
            conversationId: conversation.id,
            customerId: customer.id,
            messageId: messageMsg.id,
            actorType: "customer",
            direction: "inbound",
            funnelStage: linkedStorefrontHandoff?.funnel_stage || (isGreetingIntent(Body) ? "new" : "exploring"),
            intent: linkedStorefrontHandoff?.intent || inferBasicIntent(Body, NumMedia),
            productId: linkedStorefrontHandoff?.product_id,
            sizeRequested: linkedStorefrontHandoff?.size_requested,
            source: eventSource,
            dedupeKey: messageSid
                ? `${channel}:${messageSid}:message_inbound_received`
                : `message:${messageMsg.id}:message_inbound_received`,
            metadata: {
                body_length: Body.length,
                has_media: NumMedia > 0,
                media_count: NumMedia,
                storefront_handoff_code: storefrontHandoff?.code || null,
                storefront_handoff_status: storefrontHandoff?.status || null,
                storefront_handoff_reason: storefrontHandoff?.reason || null,
                storefront_session_id: linkedStorefrontHandoff?.storefront_session_id || null,
                source_surface: linkedStorefrontHandoff?.source_surface || null,
                product_brand: linkedStorefrontHandoff?.product_brand || null,
                product_model: linkedStorefrontHandoff?.product_model || null,
            },
        });

        if (storefrontHandoff?.status === "linked" && storefrontHandoff.row) {
            await recordConversationEvent(supabase, {
                eventType: "storefront_handoff_linked",
                conversationId: conversation.id,
                customerId: customer.id,
                messageId: messageMsg.id,
                actorType: "system",
                direction: "internal",
                funnelStage: storefrontHandoff.row.funnel_stage,
                intent: storefrontHandoff.row.intent,
                productId: storefrontHandoff.row.product_id,
                sizeRequested: storefrontHandoff.row.size_requested,
                source: eventSource,
                dedupeKey: messageSid
                    ? `${channel}:${messageSid}:storefront_handoff_linked`
                    : `message:${messageMsg.id}:storefront_handoff_linked`,
                metadata: {
                    handoff_id: storefrontHandoff.row.id,
                    handoff_code: storefrontHandoff.row.handoff_code,
                    storefront_session_id: storefrontHandoff.row.storefront_session_id,
                    source_surface: storefrontHandoff.row.source_surface,
                    product_brand: storefrontHandoff.row.product_brand,
                    product_model: storefrontHandoff.row.product_model,
                    size_requested: storefrontHandoff.row.size_requested,
                },
            });
        } else if (storefrontHandoff?.status === "unresolved" || storefrontHandoff?.status === "error") {
            await recordConversationEvent(supabase, {
                eventType: "storefront_handoff_unresolved",
                conversationId: conversation.id,
                customerId: customer.id,
                messageId: messageMsg.id,
                actorType: "system",
                direction: "internal",
                source: eventSource,
                dedupeKey: messageSid
                    ? `${channel}:${messageSid}:storefront_handoff_unresolved`
                    : `message:${messageMsg.id}:storefront_handoff_unresolved`,
                metadata: {
                    handoff_code: storefrontHandoff.code,
                    reason: storefrontHandoff.reason,
                    handoff_id: storefrontHandoff.row?.id || null,
                    handoff_status: storefrontHandoff.row?.status || null,
                    storefront_session_id: storefrontHandoff.row?.storefront_session_id || null,
                },
            });
        }

        // 4. Process Media (Storage + STT)
        let finalUserText = storefrontHandoffCode ? (stripStorefrontHandoffCode(Body) || Body) : Body;
        let mediaProcessingFailed = false;
        let hadAudioMedia = false;
        const audioTranscriptions: string[] = [];
        const receiptMedia: StoredInboundMedia[] = [];
        let failedFileCount = 0;
        let observedReceipt: string | null = null;
        // Lo que la visión leyó de cada imagen, para que la pre-validación del
        // comprobante no vuelva a llamar al modelo por el mismo archivo.
        const imagePrefetch: Record<string, { extracted: ReceiptExtraction; model: string }> = {};
        const captionSaysPayment = /\b(comprobante|pago|pagu[eé]|pagado|transferencia|nequi|bre-?b|consignaci[oó]n|abono)\b/i.test(Body);
        if (NumMedia > 0) {
            for (const media of envelope.media) {
                const i = media.index;
                const contentType = media.contentType ?? "application/octet-stream";
                const isAudio = media.kind === "audio" || contentType.startsWith("audio/");
                if (isAudio) hadAudioMedia = true;
                let transcription = "";

                try {
                    const stored = envelope.channel === "evolution"
                        ? await storeInboundMediaFromBytes({
                            messageId: messageMsg.id,
                            fromPhone: From,
                            sourceUrl: `evolution:${media.providerRef ?? providerMessageId}`,
                            ...await fetchEvolutionMedia(evolutionConfig(), providerMessageId),
                        })
                        : await storeInboundMedia({
                            messageId: messageMsg.id,
                            fromPhone: From,
                            mediaUrl: media.url ?? "",
                            contentType,
                        });

                    if (isAudio) {
                        transcription = await transcribeAudio(stored.id, stored.fileBytes, contentType);
                    } else if (contentType.startsWith("image/")) {
                        // Modalidad de imagen: se lee una vez y el resumen entra
                        // al turno del agente, igual que la transcripción de voz.
                        const described = await describeInboundImage(stored.fileBytes, contentType);

                        if ("reading" in described) {
                            if (described.reading.looks_like_receipt === true && !observedReceipt) {
                                observedReceipt = formatImageReadingForAgent(described.reading);
                            }
                            finalUserText += (finalUserText ? "\n" : "")
                                + `[Imagen]: ${formatImageReadingForAgent(described.reading)}`;

                            imagePrefetch[stored.path] = {
                                extracted: {
                                    amount_cop: described.reading.amount_cop,
                                    date: described.reading.date,
                                    bank: described.reading.bank,
                                    reference: described.reading.reference,
                                    holder: described.reading.holder,
                                    looks_like_receipt: described.reading.looks_like_receipt,
                                },
                                model: described.model,
                            };

                            console.log("[vision] imagen leída:", summarizeImageReading(described.reading));
                        } else {
                            console.warn(`[vision] no se pudo leer la imagen ${i}: ${described.error}`);
                        }

                        // Si la visión dice claramente que no es un comprobante y
                        // el cliente tampoco habla de pago, no se registra como
                        // comprobante: era una foto de producto o una captura.
                        // Ante la duda o ante un fallo, se conserva el camino del
                        // dinero y se registra para revisión humana.
                        const isReceiptCandidate = captionSaysPayment
                            || !("reading" in described)
                            || described.reading.looks_like_receipt !== false;

                        if (isReceiptCandidate) {
                            receiptMedia.push({
                                mediaFileId: stored.id ?? null,
                                storagePath: stored.path,
                                contentType,
                                bytes: stored.fileBytes,
                            });
                        }
                    } else if (contentType === "application/pdf") {
                        receiptMedia.push({
                            mediaFileId: stored.id ?? null,
                            storagePath: stored.path,
                            contentType,
                            bytes: stored.fileBytes,
                        });
                    }
                } catch (mediaErr) {
                    console.error(`Error processing media ${i}:`, mediaErr);
                    mediaProcessingFailed = true;
                    if (!isAudio && (media.kind === "image" || media.kind === "document"
                        || contentType.startsWith("image/") || contentType === "application/pdf")) {
                        failedFileCount++;
                    }

                    // El reintento de transcripción solo existe para Twilio: en
                    // Evolution la descarga del binario ya ocurrió arriba.
                    if (isAudio && channel === "twilio" && media.url) {
                        try {
                            const fallbackBytes = await fetchTwilioMedia(media.url);
                            transcription = await transcribeAudio(null, fallbackBytes, contentType);
                        } catch (fallbackErr) {
                            console.error(`Fallback transcription failed for media ${i}:`, fallbackErr);
                        }
                    }
                }

                if (transcription) {
                    const cleanedTranscription = transcription.trim();
                    if (cleanedTranscription) audioTranscriptions.push(cleanedTranscription);
                    finalUserText += (finalUserText ? "\n" : "") + `[Nota de voz]: ${cleanedTranscription}`;
                    mediaProcessingFailed = false;
                    await recordConversationEvent(supabase, {
                        eventType: "audio_transcribed",
                        conversationId: conversation.id,
                        customerId: customer.id,
                        messageId: messageMsg.id,
                        actorType: "system",
                        direction: "internal",
                        source: eventSource,
                        dedupeKey: messageSid
                            ? `${channel}:${messageSid}:audio_transcribed:${i}`
                            : `message:${messageMsg.id}:audio_transcribed:${i}`,
                        metadata: {
                            media_index: i,
                            content_type: contentType,
                            transcription_length: cleanedTranscription.length,
                        },
                    });
                } else if (isAudio) {
                    mediaProcessingFailed = true;
                    await recordConversationEvent(supabase, {
                        eventType: "audio_transcription_failed",
                        conversationId: conversation.id,
                        customerId: customer.id,
                        messageId: messageMsg.id,
                        actorType: "system",
                        direction: "internal",
                        source: eventSource,
                        dedupeKey: messageSid
                            ? `${channel}:${messageSid}:audio_transcription_failed:${i}`
                            : `message:${messageMsg.id}:audio_transcription_failed:${i}`,
                        metadata: {
                            media_index: i,
                            content_type: contentType,
                        },
                    });
                }
            }

            // Update message body if transcriptions were added
            if (finalUserText !== Body) {
                await supabase.from("messages").update({ body: finalUserText }).eq("id", messageMsg.id);
            }
        }

        // 4b. Comprobante de pago. Se guarda y se acusa de forma determinista:
        // el modelo nunca dice "pago aprobado". La pre-validacion con vision
        // corre en segundo plano y solo deja un veredicto para el humano.
        let receiptReply: string | null = null;
        let receiptReplyKind: ReceiptCaptureResult["kind"] | "media_failed" | null = null;
        if (receiptMedia.length > 0) {
            let captured: ReceiptCaptureResult;
            try {
                captured = await capturePaymentReceipt(supabase, {
                    customerId: customer.id,
                    conversationId: conversation.id,
                    messageId: messageMsg.id,
                    providerMessageId: providerMessageId ?? null,
                    caption: Body,
                    media: receiptMedia,
                });
            } catch (receiptErr: any) {
                console.error("[payments] no se pudo registrar el comprobante:", receiptErr?.message ?? receiptErr);
                captured = { kind: "failed" };
            }
            receiptReply = receiptCaptureReply(captured, failedFileCount, observedReceipt);
            receiptReplyKind = captured.kind;

            if (captured.kind === "captured") {
                try {
                    await patchConversationState(supabase, conversation.id, {
                        stage: "receipt_received",
                        lastIntent: "payment",
                        pendingAction: {
                            type: "payment_review",
                            order_id: captured.order.id,
                            payment_reference: captured.order.paymentReference,
                            total_cents: captured.order.totalCents,
                            receipt_ids: captured.receiptIds,
                        },
                    });
                } catch (stateErr: any) {
                    console.warn("[payments] no se pudo mover el estado a receipt_received:", stateErr?.message);
                }

                scheduleBackground(
                    prevalidateReceipts(supabase, {
                        receiptIds: captured.receiptIds,
                        conversationId: conversation.id,
                        customerId: customer.id,
                        orderId: captured.order.id,
                        totalCents: captured.order.totalCents,
                        reference: captured.order.paymentReference,
                        caption: Body,
                        prefetchedByPath: imagePrefetch,
                    }).catch((err) => {
                        console.error("[payments] pre-validacion fallo:", err?.message ?? err);
                    }),
                );
            }
        } else if (failedFileCount > 0) {
            // No se sabe si era un comprobante: no inventar recepción ni registro.
            receiptReply = "No pude procesar el archivo que enviaste. Por favor, vuelve a enviarlo. Si es un comprobante, incluye la referencia del pedido (ORD-...).";
            receiptReplyKind = "media_failed";
        }

        // 5. Generate AI Response (or Welcome Protocol)
        let aiText = "";
        let aiMedia: string[] = [];
        let skipReply = false;
        const bodyHasUsefulText = Boolean(Body.trim()) && !isLowInformationAudioTranscript(Body);
        const audioTranscriptText = audioTranscriptions.join(" ").trim();
        const isLowInformationAudio = hadAudioMedia
            && audioTranscriptions.length > 0
            && isLowInformationAudioTranscript(audioTranscriptText);
        const audioNeedsClarification = hadAudioMedia
            && !bodyHasUsefulText
            && (mediaProcessingFailed || !audioTranscriptText || isLowInformationAudio);

        const greetingRegex = /^(hola|buenas|start|inicio|hi|hello)\b/i;
        const isGreeting = greetingRegex.test(finalUserText.trim().toLowerCase());
        const isShort = finalUserText.trim().length < 30;

        if (receiptReply) {
            const receiptState = await loadConversationState(supabase, conversation.id);

            if (isBotPaused(receiptState)) {
                // Un humano esta al mando: el comprobante queda guardado, pero
                // el acuse lo da la persona para no duplicar mensajes.
                skipReply = true;
            } else {
                aiText = receiptReply;

                const { data: assistantMessage } = await supabase.from("messages").insert({
                    conversation_id: conversation.id,
                    role: "assistant",
                    direction: "outbound",
                    channel,
                    body: aiText,
                }).select("id").single();

                await recordConversationEvent(supabase, {
                    eventType: "message_outbound_sent",
                    conversationId: conversation.id,
                    customerId: customer.id,
                    messageId: assistantMessage?.id,
                    actorType: "bot",
                    direction: "outbound",
                    funnelStage: receiptReplyKind === "captured" ? "payment_review" : "support",
                    intent: receiptReplyKind === "captured" ? "payment" : "support",
                    source: eventSource,
                    dedupeKey: assistantMessage?.id
                        ? `message:${assistantMessage.id}:message_outbound_sent`
                        : null,
                    metadata: {
                        body_length: aiText.length,
                        contains_payment_link: false,
                        reason: "payment_receipt_result",
                        receipt_capture_result: receiptReplyKind,
                    },
                });
            }
        } else if (audioNeedsClarification) {
            aiText = audioClarificationMessage({ mediaProcessingFailed, audioTranscriptText });

            const { data: assistantMessage } = await supabase.from("messages").insert({
                conversation_id: conversation.id,
                role: "assistant",
                direction: "outbound",
                channel,
                body: aiText,
            }).select("id").single();

            await recordConversationEvent(supabase, {
                eventType: "message_outbound_sent",
                conversationId: conversation.id,
                customerId: customer.id,
                messageId: assistantMessage?.id,
                actorType: "bot",
                direction: "outbound",
                funnelStage: "support",
                intent: "support",
                source: eventSource,
                dedupeKey: assistantMessage?.id
                    ? `message:${assistantMessage.id}:message_outbound_sent`
                    : `conversation:${conversation.id}:media_empty_reply`,
                metadata: {
                    reason: mediaProcessingFailed
                        ? "media_transcription_failed"
                        : isLowInformationAudio
                            ? "audio_low_information"
                            : "empty_audio_message",
                    body_length: aiText.length,
                    audio_transcription_length: audioTranscriptText.length,
                    audio_transcription_preview: audioTranscriptText.slice(0, 180),
                },
            });
        } else if (NumMedia > 0 && !finalUserText.trim()) {
            aiText = "Recibí tu archivo, pero no encontré texto para procesar. ¿Me escribes por texto lo que necesitas?";

            const { data: assistantMessage } = await supabase.from("messages").insert({
                conversation_id: conversation.id,
                role: "assistant",
                direction: "outbound",
                channel,
                body: aiText,
            }).select("id").single();

            await recordConversationEvent(supabase, {
                eventType: "message_outbound_sent",
                conversationId: conversation.id,
                customerId: customer.id,
                messageId: assistantMessage?.id,
                actorType: "bot",
                direction: "outbound",
                funnelStage: "support",
                intent: "support",
                source: eventSource,
                dedupeKey: assistantMessage?.id
                    ? `message:${assistantMessage.id}:message_outbound_sent`
                    : `conversation:${conversation.id}:media_empty_reply`,
                metadata: {
                    reason: "empty_media_message",
                    body_length: aiText.length,
                },
            });
        } else if (isGreeting && isShort) {
            console.log("[Inbound] Saludo detectado; se activa el protocolo de bienvenida.");

            try {
                const storeInfo = await getStoreInfo(supabase);

                aiText = buildWelcomeText(storeInfo);

                // El saludo sale sin media: en WhatsApp un primer mensaje con
                // adjunto se marca como no deseado con más facilidad. Las fotos
                // van cuando el cliente pide un modelo concreto.

                // Save Assistant Response to DB
                const { data: assistantMessage } = await supabase.from("messages").insert({
                    conversation_id: conversation.id,
                    role: "assistant",
                    direction: "outbound",
                    channel,
                    body: aiText,
                }).select("id").single();

                await recordConversationEvent(supabase, {
                    eventType: "customer_greeted",
                    conversationId: conversation.id,
                    customerId: customer.id,
                    messageId: assistantMessage?.id,
                    actorType: "bot",
                    direction: "outbound",
                    funnelStage: "new",
                    intent: "greeting",
                    source: eventSource,
                    dedupeKey: assistantMessage?.id
                        ? `message:${assistantMessage.id}:customer_greeted`
                        : `conversation:${conversation.id}:customer_greeted`,
                    metadata: {
                        store_name: storeInfo.store_name || "SportBot",
                        has_catalog_pdf: Boolean(storeInfo.catalog_pdf),
                        has_store_url: Boolean(storeInfo.store_url),
                    },
                });
            } catch (welcomeErr: any) {
                console.error("Welcome Flow Error:", welcomeErr);
                aiText = "¡Hola! Bienvenido a SportBot. ¿En qué puedo ayudarte hoy?";
            }

        } else {
            const conversationState = await loadConversationState(supabase, conversation.id);

            if (isBotPaused(conversationState)) {
                // Un humano tomó la conversación o hay una pausa vigente:
                // se registra el mensaje, pero el bot no responde.
                skipReply = true;
                console.log(
                    `[State] Bot pausado (${conversationState.stage}/${conversationState.handoffStatus}); no se responde.`,
                );
            } else {
                const aiContext = {
                    messageSid,
                    channel,
                    ...(linkedStorefrontHandoff
                        ? {
                            storefrontHandoff: {
                                handoffCode: linkedStorefrontHandoff.handoff_code,
                                productId: linkedStorefrontHandoff.product_id,
                                productBrand: linkedStorefrontHandoff.product_brand,
                                productModel: linkedStorefrontHandoff.product_model,
                                sizeRequested: linkedStorefrontHandoff.size_requested,
                                intent: linkedStorefrontHandoff.intent,
                                funnelStage: linkedStorefrontHandoff.funnel_stage,
                                sourceSurface: linkedStorefrontHandoff.source_surface,
                            },
                        }
                        : {}),
                };

                const result = await processAIResponse(
                    supabase,
                    conversation.id,
                    customer.id,
                    finalUserText,
                    aiContext,
                );
                aiText = result.text;
                aiMedia = result.media;
            }
        }

        if (skipReply) {
            if (inboundClaim) {
                await finishInboundMessage(supabase, inboundClaim.provider, inboundClaim.messageSid, "done");
                inboundClaim.finished = true;
            }
            return ack(channel);
        }

        // 6. Send reply through the active channel and acknowledge the webhook.
        // Direct API sends are more observable than TwiML replies in the WhatsApp Sandbox.
        const sendReply = sendOutbound({
            channel,
            to: From,
            text: aiText,
            mediaUrls: aiMedia,
            evolution: channel === "evolution" ? evolutionConfig() : null,
        }).then((sendResult) => {
            if (!sendResult.success) {
                console.error(`[${channel}] Outbound reply failed:`, sendResult.error);
            }
        }).catch((sendErr) => {
            console.error(`[${channel}] Outbound reply crashed:`, sendErr);
        });

        const edgeRuntime = (globalThis as typeof globalThis & {
            EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
        }).EdgeRuntime;

        if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(sendReply);
        else await sendReply;

        const refreshProfile = refreshCustomerProfileBestEffort(supabase, customer.id);
        if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(refreshProfile);
        else await refreshProfile;

        if (inboundClaim) {
            await finishInboundMessage(supabase, inboundClaim.provider, inboundClaim.messageSid, "done");
            inboundClaim.finished = true;
        }

        return ack(channel);

    } catch (err: any) {
        console.error("Critical Error:", err);
        if (err instanceof Error && err.message === "INBOUND_CLAIM_UNAVAILABLE") {
            const isEvolution = channel === "evolution";
            return new Response(
                isEvolution ? JSON.stringify({ ok: false }) : "<Response></Response>",
                {
                    headers: {
                        ...corsHeaders,
                        "Content-Type": isEvolution ? "application/json" : "text/xml",
                    },
                    status: 503,
                },
            );
        }
        if (inboundClaim && !inboundClaim.finished) {
            await finishInboundMessage(
                inboundClaim.supabase,
                inboundClaim.provider,
                inboundClaim.messageSid,
                "failed",
                err?.message ?? String(err),
            );
            inboundClaim.finished = true;
        }

        if (channel === "evolution") {
            // No se filtra el detalle interno al proveedor.
            return new Response(JSON.stringify({ ok: false }), {
                headers: { ...corsHeaders, "Content-Type": "application/json" },
                status: 500,
            });
        }

        const errorTwiml = `<Response><Message>Lo siento, error tecnico: ${err.message}</Message></Response>`;
        return new Response(errorTwiml, {
            headers: { ...corsHeaders, "Content-Type": "text/xml" },
            status: 200,
        });
    }
});

