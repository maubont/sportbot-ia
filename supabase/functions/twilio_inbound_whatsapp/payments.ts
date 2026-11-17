import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import OpenAI from "npm:openai@4";
import {
    buildPaymentInstructions,
    buildReceiptCompleteNotice,
    buildReceiptUnreadableNotice,
    buildShortfallNotice,
    computePaymentProgress,
    evaluateReceiptEvidence,
    parseCopAmount,
    sumReceiptAmountsCents,
    type PaymentConfig,
    type PaymentInstructions,
    type ReceiptExtraction,
} from "./payments-core.ts";
import { recordConversationEvent } from "./events.ts";
import { sendReceiptFollowup } from "./receipt-followup.ts";
import {
    captureReceipts,
    detectReceiptReuse,
    parseOrderReference,
    type ReceiptCaptureResult,
    type ReceiptOrderLookup,
} from "./receipt-capture-core.ts";

const RECEIPT_BUCKET = "whatsapp-media";
const MAX_RECEIPTS_PER_MESSAGE = 3;

export type StoredInboundMedia = {
    mediaFileId: string | null;
    storagePath: string;
    contentType: string;
    bytes: Uint8Array;
};

export type AwaitingOrder = {
    id: string;
    paymentReference: string;
    totalCents: number;
    rejectionReason: string | null;
};

function isReceiptMedia(contentType: string): boolean {
    const type = contentType.toLowerCase();
    return type.startsWith("image/") || type === "application/pdf";
}

export async function loadPaymentConfig(supabase: SupabaseClient): Promise<PaymentConfig> {
    const { data, error } = await supabase
        .from("settings")
        .select(
            "payment_nequi_number, payment_nequi_holder, payment_breb_key, payment_breb_holder, payment_instructions, payment_receipt_window_hours",
        )
        .eq("id", 1)
        .maybeSingle();

    if (error) {
        console.warn("[payments] no se pudo leer la configuracion de recaudo:", error.message);
    }

    return {
        nequiNumber: data?.payment_nequi_number ?? null,
        nequiHolder: data?.payment_nequi_holder ?? null,
        brebKey: data?.payment_breb_key ?? null,
        brebHolder: data?.payment_breb_holder ?? null,
        customInstructions: data?.payment_instructions ?? null,
        receiptWindowHours: Number(data?.payment_receipt_window_hours ?? 24) || 24,
    };
}

export async function paymentInstructionsFor(
    supabase: SupabaseClient,
    order: { id: string; paymentReference: string; totalCents: number },
): Promise<PaymentInstructions> {
    const config = await loadPaymentConfig(supabase);
    return buildPaymentInstructions(config, {
        id: order.id,
        paymentReference: order.paymentReference,
        totalCents: order.totalCents,
    });
}

export async function findAwaitingOrder(
    supabase: SupabaseClient,
    customerId: string,
    caption: string,
): Promise<ReceiptOrderLookup> {
    const parsedReference = parseOrderReference(caption);
    if (parsedReference.kind === "invalid") return { kind: "invalid_reference" };

    let query = supabase
        .from("orders")
        .select("id, payment_reference, total_cents, payment_rejection_reason")
        .eq("customer_id", customerId)
        .eq("status", "awaiting_payment")
        .not("payment_reference", "is", null);
    if (parsedReference.kind === "valid") {
        query = query.eq("payment_reference", parsedReference.reference);
    }
    const { data, error } = await query.limit(2);

    if (error) {
        console.error("[payments] no se pudo buscar el pedido pendiente:", error.message);
        throw new Error("No se pudo buscar el pedido pendiente");
    }

    const orders = data ?? [];
    if (orders.length === 0) {
        return { kind: parsedReference.kind === "valid" ? "reference_not_found" : "no_pending_order" };
    }
    if (orders.length > 1) return { kind: "reference_required" };

    const row = orders[0];
    const order: AwaitingOrder = {
        id: row.id,
        paymentReference: row.payment_reference,
        totalCents: Number(row.total_cents ?? 0),
        rejectionReason: row.payment_rejection_reason ?? null,
    };
    return { kind: "selected", order };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Guarda los comprobantes de un mensaje y responde de forma determinista.
 *
 * Distingue captura, ausencia de pedido y fallo. La validación posterior solo
 * deja evidencia; nunca aprueba un pago.
 */
export async function capturePaymentReceipt(
    supabase: SupabaseClient,
    params: {
        customerId: string;
        conversationId: string;
        messageId: string | null;
        providerMessageId: string | null;
        caption: string;
        media: StoredInboundMedia[];
    },
): Promise<ReceiptCaptureResult> {
    const media = params.media.filter((item) => isReceiptMedia(item.contentType));
    // El almacenamiento de media usa la ruta del mensaje; no asociar dos
    // archivos distintos si comparten ruta y podrían haberse sobrescrito.
    if (new Set(media.map((item) => item.storagePath)).size !== media.length) {
        console.error("[payments] archivos con la misma ruta; se requiere reenvío individual");
        return { kind: "failed" };
    }

    const result = await captureReceipts({
        media,
        maxReceipts: MAX_RECEIPTS_PER_MESSAGE,
        findOrder: () => findAwaitingOrder(supabase, params.customerId, params.caption),
        onError: (error) => console.error("[payments] no se pudo registrar el comprobante:", error),
        saveReceipt: async (order, item) => {
            const digest = await sha256Hex(item.bytes);
            const { data, error } = await supabase
                .from("payment_receipts")
                .insert({
                    order_id: order.id,
                    customer_id: params.customerId,
                    message_id: params.messageId,
                    media_file_id: item.mediaFileId,
                    storage_bucket: RECEIPT_BUCKET,
                    storage_path: item.storagePath,
                    content_type: item.contentType,
                    bytes: item.bytes.byteLength,
                    sha256: digest,
                    caption: params.caption || null,
                    provider_message_id: params.providerMessageId,
                    status: "received",
                })
                .select("id")
                .single();

            if (error) {
                // Reintento del mismo webhook: ya existe, se reutiliza.
                if (String(error.code) === "23505") {
                    const { data: existing } = await supabase
                        .from("payment_receipts")
                        .select("id")
                        .eq("order_id", order.id)
                        .eq("storage_path", item.storagePath)
                        .maybeSingle();
                    return existing?.id ?? null;
                }

                console.error("[payments] no se pudo guardar el comprobante:", error.message);
                return null;
            }

            return data?.id ?? null;
        },
    });

    if (result.kind !== "captured") return result;

    const { order, receiptIds } = result;

    // La telemetría no puede convertir un registro exitoso en un falso fallo.
    try {
        await recordConversationEvent(supabase, {
            eventType: "payment_receipt_received",
            conversationId: params.conversationId,
            customerId: params.customerId,
            messageId: params.messageId ?? undefined,
            actorType: "customer",
            direction: "internal",
            funnelStage: "payment_review",
            intent: "payment",
            source: "whatsapp_inbound_receipt",
            dedupeKey: params.providerMessageId
                ? `receipt:${params.providerMessageId}:received`
                : `receipt:${receiptIds[0]}:received`,
            metadata: {
                order_id: order.id,
                payment_reference: order.paymentReference,
                total_cents: order.totalCents,
                receipt_count: receiptIds.length,
                receipt_ids: receiptIds,
                channel: "whatsapp",
            },
        });
    } catch (error) {
        console.warn("[payments] no se pudo registrar el evento de captura:", error);
    }

    return result;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;

    try {
        const parsed = JSON.parse(raw.slice(start, end + 1));
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

function toNumberOrNull(value: unknown): number | null {
    return parseCopAmount(value);
}

function toStringOrNull(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const trimmed = String(value).trim();
    return trimmed ? trimmed : null;
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }

    return btoa(binary);
}

async function readReceiptWithVision(
    bytes: Uint8Array,
    contentType: string,
): Promise<{ extracted: ReceiptExtraction; model: string } | { error: string }> {
    const apiKey = Deno.env.get("OPENAI_API_KEY")?.trim();
    if (!apiKey) return { error: "OPENAI_API_KEY ausente" };

    const model = (Deno.env.get("OPENAI_VISION_MODEL") ?? "").trim() || "gpt-6-luna";
    const baseUrl = (Deno.env.get("OPENAI_BASE_URL") ?? "").trim();

    const openai = new OpenAI({
        apiKey,
        maxRetries: 0,
        timeout: 25_000,
        ...(baseUrl ? { baseURL: baseUrl } : {}),
    });

    const dataUrl = `data:${contentType};base64,${toBase64(bytes)}`;

    try {
        const response = await openai.chat.completions.create({
            model,
            max_completion_tokens: 350,
            messages: [
                {
                    role: "system",
                    content:
                        "Verificas comprobantes de pago colombianos (Nequi, Bre-B, transferencias). " +
                        "Devuelve SOLO un objeto JSON, sin explicaciones ni markdown, con esta forma: " +
                        '{"looks_like_receipt": boolean, "amount_cop": number|null, "reference": string|null, "holder": string|null, "date": string|null, "bank": string|null}. ' +
                        "amount_cop va en pesos enteros (si dice $450.000, devuelve 450000). " +
                        "date va en formato YYYY-MM-DD si la puedes leer. " +
                        "bank es la entidad: Nequi, Bre-B, Bancolombia, Davivienda, etc. " +
                        "No inventes datos: si no puedes leerlos, usa null. " +
                        "looks_like_receipt es false si la imagen no es un comprobante de pago.",
                },
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Lee este comprobante." },
                        { type: "image_url", image_url: { url: dataUrl } },
                    ],
                },
            ],
        } as any);

        const content = response.choices?.[0]?.message?.content ?? "";
        const parsed = parseJsonObject(String(content));
        if (!parsed) return { error: "respuesta no interpretable" };

        return {
            model,
            extracted: {
                amount_cop: toNumberOrNull(parsed.amount_cop),
                reference: toStringOrNull(parsed.reference),
                holder: toStringOrNull(parsed.holder),
                date: toStringOrNull(parsed.date),
                bank: toStringOrNull(parsed.bank),
                looks_like_receipt: typeof parsed.looks_like_receipt === "boolean"
                    ? parsed.looks_like_receipt
                    : null,
            },
        };
    } catch (err: any) {
        return { error: String(err?.message ?? err).slice(0, 300) };
    }
}

/**
 * Pre-valida los comprobantes de un mensaje con vision y guarda el veredicto.
 *
 * Se ejecuta en segundo plano: si el modelo falla o tarda, el comprobante
 * queda "uncertain" y el humano decide igual. Nunca cambia el estado del pago.
 *
 * Despues de leer todos los comprobantes calcula el avance del pago y le dice
 * al cliente cuanto falta. Ese aviso es guia, no contabilidad: la aprobacion
 * sigue siendo humana.
 */
export async function prevalidateReceipts(
    supabase: SupabaseClient,
    params: {
        receiptIds: string[];
        conversationId: string;
        customerId: string;
        orderId: string;
        totalCents: number;
        reference: string;
        caption: string;
        /** Lectura ya hecha en el webhook para no llamar dos veces al modelo. */
        prefetchedByPath?: Record<string, { extracted: ReceiptExtraction; model: string }>;
    },
): Promise<void> {
    const receiptIds = (params.receiptIds ?? [])
        .filter((id) => typeof id === "string" && id.length > 0)
        .slice(0, MAX_RECEIPTS_PER_MESSAGE);

    if (receiptIds.length === 0) return;

    for (const receiptId of receiptIds) {
        await prevalidateOneReceipt(supabase, { ...params, receiptId });
    }

    await registerPaymentProgress(supabase, params);
}

/**
 * Una misma imagen enviada a dos pedidos distintos es la senal mas clara de un
 * comprobante reutilizado. No decide nada: solo evita que el panel lo muestre
 * como "datos coinciden".
 */
async function receiptIsReused(
    supabase: SupabaseClient,
    receipt: { order_id: string | null; sha256: string | null },
): Promise<boolean> {
    return detectReceiptReuse({
        receipt,
        query: async (sha256, orderId) => {
            const { data, error } = await supabase
                .from("payment_receipts")
                .select("id")
                .eq("sha256", sha256)
                .neq("order_id", orderId)
                .limit(1);

            if (error) throw new Error(error.message);
            return data;
        },
        onError: (error) =>
            console.warn(
                "[payments] no se pudo comprobar el comprobante repetido:",
                error instanceof Error ? error.message : error,
            ),
    });
}

async function prevalidateOneReceipt(
    supabase: SupabaseClient,
    params: {
        receiptId: string;
        conversationId: string;
        customerId: string;
        totalCents: number;
        reference: string;
        caption: string;
        prefetchedByPath?: Record<string, { extracted: ReceiptExtraction; model: string }>;
    },
): Promise<void> {
    const { data: receipt, error } = await supabase
        .from("payment_receipts")
        .select("id, order_id, sha256, storage_bucket, storage_path, content_type, status")
        .eq("id", params.receiptId)
        .maybeSingle();

    if (error || !receipt) {
        console.error("[payments] comprobante no encontrado para pre-validar:", error?.message);
        return;
    }

    let extracted: ReceiptExtraction = {};
    let model: string | null = null;
    let evidenceExtra: Array<Record<string, unknown>> = [];
    const contentType = String(receipt.content_type ?? "");
    const prefetched = params.prefetchedByPath?.[String(receipt.storage_path ?? "")];

    if (!contentType.startsWith("image/")) {
        evidenceExtra = [{
            kind: "human_review_pdf",
            detail: "El comprobante es un PDF; la lectura automatica queda para revision humana.",
        }];
    } else if (prefetched) {
        // La imagen ya se leyó en el webhook para el agente: se reutiliza.
        extracted = prefetched.extracted;
        model = prefetched.model;
    } else {
        const { data: blob, error: downloadError } = await supabase.storage
            .from(receipt.storage_bucket || RECEIPT_BUCKET)
            .download(receipt.storage_path);

        if (downloadError || !blob) {
            evidenceExtra = [{
                kind: "download_failed",
                detail: "No se pudo reabrir el comprobante para pre-validarlo.",
            }];
        } else {
            const bytes = new Uint8Array(await blob.arrayBuffer());

            if (bytes.byteLength > 5_000_000) {
                evidenceExtra = [{
                    kind: "image_too_large",
                    detail: "La imagen supera 5 MB; se revisa a mano.",
                }];
            } else {
                const result = await readReceiptWithVision(bytes, contentType);

                if ("error" in result) {
                    evidenceExtra = [{
                        kind: "vision_unavailable",
                        detail: `La lectura automatica no estuvo disponible: ${result.error}`,
                    }];
                } else {
                    extracted = result.extracted;
                    model = result.model;
                }
            }
        }
    }

    const verdict = evaluateReceiptEvidence({
        extracted,
        caption: params.caption,
        totalCents: params.totalCents,
        reference: params.reference,
    });

    // La misma imagen no puede pagar dos pedidos. Si ya aparece en otro, se
    // marca para el humano: no se acusa al cliente, solo se deja la evidencia.
    const reused = await receiptIsReused(supabase, receipt);
    if (reused) {
        verdict.verdict = "mismatch";
        verdict.evidence.push({
            kind: "receipt_reused_other_order",
            detail: "La misma imagen ya se habia usado en otro pedido.",
            source: "vision",
        });
    }

    const evidence = [
        ...verdict.evidence,
        ...evidenceExtra,
    ];

    const { error: updateError } = await supabase
        .from("payment_receipts")
        .update({
            ai_verdict: evidenceExtra.length > 0 && verdict.evidence.length === 0
                ? "not_run"
                : verdict.verdict,
            ai_confidence: verdict.confidence,
            ai_extracted: extracted as Record<string, unknown>,
            ai_evidence: evidence,
            ai_model: model,
            ai_checked_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        })
        .eq("id", params.receiptId);

    if (updateError) {
        console.error("[payments] no se pudo guardar el veredicto:", updateError.message);
    }

    await supabase
        .from("payment_receipts")
        .update({ status: "prevalidated" })
        .eq("id", params.receiptId)
        .eq("status", "received");

    await recordConversationEvent(supabase, {
        eventType: "payment_receipt_prevalidated",
        conversationId: params.conversationId,
        customerId: params.customerId,
        actorType: "system",
        direction: "internal",
        funnelStage: "payment_review",
        intent: "payment",
        source: "whatsapp_inbound_receipt",
        dedupeKey: `receipt:${params.receiptId}:prevalidated`,
        metadata: {
            receipt_id: params.receiptId,
            order_reference: params.reference,
            ai_verdict: verdict.verdict,
            ai_confidence: verdict.confidence,
            ai_model: model,
            evidence_kinds: evidence.map((item: any) => item.kind),
            decision: "human_required",
        },
    });
}

/**
 * Primer filtro del dinero: suma lo leido de los comprobantes, guarda el avance
 * y le dice al cliente cuanto falta.
 *
 * Solo corre si el pedido sigue pendiente de pago. Si ya lo aprobo o rechazo
 * una persona, no se le escribe nada al cliente desde aqui.
 */
async function registerPaymentProgress(
    supabase: SupabaseClient,
    params: {
        conversationId: string;
        customerId: string;
        orderId: string;
        totalCents: number;
        reference: string;
    },
): Promise<void> {
    const { data: order, error } = await supabase
        .from("orders")
        .select("id, status, total_cents, payment_reference")
        .eq("id", params.orderId)
        .maybeSingle();

    if (error || !order) {
        console.error("[payments] no se pudo leer el pedido del comprobante:", error?.message);
        return;
    }

    // La decision humana manda: si ya hay pago resuelto, no se le escribe nada.
    if (order.status !== "awaiting_payment") return;

    const { data: receipts, error: receiptsError } = await supabase
        .from("payment_receipts")
        .select("id, sha256, status, ai_extracted")
        .eq("order_id", params.orderId);

    if (receiptsError) {
        console.error("[payments] no se pudieron sumar los comprobantes:", receiptsError.message);
        return;
    }

    const totalCents = Number(order.total_cents ?? params.totalCents ?? 0);
    const reference = String(order.payment_reference ?? params.reference ?? "");
    const receivedCents = sumReceiptAmountsCents(receipts ?? []);

    if (receivedCents <= 0) {
        await sendReceiptFollowup(supabase, {
            conversationId: params.conversationId,
            customerId: params.customerId,
            orderId: params.orderId,
            paymentReference: reference,
            text: buildReceiptUnreadableNotice({
                id: params.orderId,
                paymentReference: reference,
                totalCents,
            }),
            dedupeKey: `order:${params.orderId}:unreadable_notice`,
            eventType: "payment_receipt_unreadable_notified",
            metadata: { total_cents: totalCents },
        });
        return;
    }

    const progress = computePaymentProgress({ totalCents, receivedCents });

    const { error: rpcError } = await supabase.rpc("record_payment_progress", {
        p_order_id: params.orderId,
        p_received_cents: progress.receivedCents,
        p_source: "vision",
    });

    if (rpcError) {
        console.error("[payments] no se pudo guardar el avance del pago:", rpcError.message);
    }

    if (progress.complete) {
        await sendReceiptFollowup(supabase, {
            conversationId: params.conversationId,
            customerId: params.customerId,
            orderId: params.orderId,
            paymentReference: reference,
            text: buildReceiptCompleteNotice({
                order: { id: params.orderId, paymentReference: reference, totalCents },
                receivedCents: progress.receivedCents,
            }),
            dedupeKey: `order:${params.orderId}:complete_notice:${progress.receivedCents}`,
            eventType: "payment_receipt_covered_notified",
            amountCents: progress.receivedCents,
            metadata: {
                total_cents: totalCents,
                received_cents: progress.receivedCents,
                overpaid_cents: progress.overpaidCents,
            },
        });
        return;
    }

    const config = await loadPaymentConfig(supabase);

    await sendReceiptFollowup(supabase, {
        conversationId: params.conversationId,
        customerId: params.customerId,
        orderId: params.orderId,
        paymentReference: reference,
        text: buildShortfallNotice({
            order: { id: params.orderId, paymentReference: reference, totalCents },
            receivedCents: progress.receivedCents,
            shortfallCents: progress.shortfallCents,
            windowHours: config.receiptWindowHours,
        }),
        dedupeKey: `order:${params.orderId}:shortfall_notice:${progress.receivedCents}`,
        eventType: "payment_shortfall_notified",
        amountCents: progress.shortfallCents,
        metadata: {
            total_cents: totalCents,
            received_cents: progress.receivedCents,
            shortfall_cents: progress.shortfallCents,
            window_hours: config.receiptWindowHours,
        },
    });
}
