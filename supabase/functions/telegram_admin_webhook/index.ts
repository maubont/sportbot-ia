import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
    COMMAND_ROLE_ALLOWLIST,
    canRunCommand,
    cleanText,
    detectConversationalIntent,
    formatHelp,
    getAllowedCommands,
    getMessage,
    isHelpCommand,
    normalizeCommand,
    roleCanCreateAgentAction,
    roleCanRunCommand,
    shouldCreateSuggestedAction,
    timingSafeEqual,
    type AdminChannelUser,
    type AgentActionDraft,
    type CommandResult,
    type TelegramMessage,
    type TelegramUpdate,
    type TelegramUser,
} from "./logic.ts";

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
};

type JsonBody = Record<string, unknown>;

type SupabaseClient = ReturnType<typeof createClient>;

const BOGOTA_TIMEZONE = "America/Bogota";
const MONEY_FORMATTER = new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0,
});

function jsonResponse(body: JsonBody, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
}

function textResponse(body: string, status = 200) {
    return new Response(body, {
        status,
        headers: corsHeaders,
    });
}

function requireEnv(name: string) {
    const value = Deno.env.get(name);
    if (!value) throw new Error(`${name} is not configured`);
    return value;
}

function createServiceClient() {
    return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
        auth: {
            autoRefreshToken: false,
            persistSession: false,
        },
    });
}

function formatDisplayName(user?: TelegramUser) {
    return [user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.username || "Telegram admin";
}

function formatMoney(cents: unknown) {
    const numericCents = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
    return MONEY_FORMATTER.format(Math.round(numericCents / 100));
}

function formatPercentBps(bps: unknown) {
    const numericBps = typeof bps === "number" && Number.isFinite(bps) ? bps : 0;
    return `${(numericBps / 100).toFixed(1)}%`;
}

function safeNumber(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getBogotaDayWindow(now = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: BOGOTA_TIMEZONE,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const day = formatter.format(now);

    return {
        from: new Date(`${day}T00:00:00-05:00`).toISOString(),
        to: now.toISOString(),
        label: day,
    };
}

function hoursSince(value: string | null | undefined) {
    if (!value) return 0;
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return 0;
    return Math.max(0, (Date.now() - timestamp) / 36e5);
}

function shortId(id: unknown) {
    if (typeof id !== "string") return "sin-id";
    return id.length <= 10 ? id : `${id.slice(0, 8)}...`;
}

function getCustomerName(order: Record<string, unknown>) {
    const customer = order.customers;
    if (!customer || typeof customer !== "object") return "Cliente";
    const maybeName = (customer as { name?: unknown }).name;
    return typeof maybeName === "string" && maybeName.trim() ? maybeName.trim() : "Cliente";
}

function getProductName(variant: Record<string, unknown>) {
    const product = variant.products;
    if (!product || typeof product !== "object") return "Producto";
    const typedProduct = product as { brand?: unknown; model?: unknown };
    return [typedProduct.brand, typedProduct.model]
        .filter((value) => typeof value === "string" && value.trim())
        .join(" ") || "Producto";
}

async function createTelegramAgentAction(
    supabase: SupabaseClient,
    row: AdminChannelUser,
    draft: AgentActionDraft,
    input: {
        rawText: string;
        normalizedIntent: string;
        externalChatId: string;
    },
) {
    if (!roleCanCreateAgentAction(row)) {
        return { created: false, reason: "role_cannot_create_action" };
    }

    let existingQuery = supabase
        .from("agent_actions")
        .select("id, status, created_at")
        .eq("channel", "telegram_admin")
        .eq("action_type", draft.actionType)
        .in("status", ["suggested", "pending_approval", "approved"])
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(1);

    existingQuery = draft.targetType
        ? existingQuery.eq("target_type", draft.targetType)
        : existingQuery.is("target_type", null);

    existingQuery = draft.targetId
        ? existingQuery.eq("target_id", draft.targetId)
        : existingQuery.is("target_id", null);

    const { data: existing, error: existingError } = await existingQuery;
    if (existingError) throw existingError;

    const existingAction = Array.isArray(existing) ? existing[0] as { id?: unknown } | undefined : undefined;
    if (existingAction?.id && typeof existingAction.id === "string") {
        return { created: false, existingId: existingAction.id, reason: "duplicate_open_action" };
    }

    const { data, error } = await supabase
        .from("agent_actions")
        .insert({
            agent_name: "openclaw",
            channel: "telegram_admin",
            created_by_user_id: row.admin_user_id,
            role_scope: row.role_scope,
            action_type: draft.actionType,
            target_type: draft.targetType || null,
            target_id: draft.targetId || null,
            target_ref: draft.targetRef || null,
            status: draft.approvalRequired ? "pending_approval" : "suggested",
            risk_level: draft.riskLevel,
            summary: draft.summary,
            evidence: draft.evidence,
            input_context: {
                source: "telegram_admin_webhook",
                mode: "suggest_only",
                normalized_intent: input.normalizedIntent,
                requested_text: cleanText(input.rawText),
                external_chat_id: input.externalChatId,
                created_from_role: row.role_scope,
                generated_at: new Date().toISOString(),
            },
            proposed_payload: {
                ...draft.proposedPayload,
                review_surface: "/ai-ops",
            },
            approval_required: draft.approvalRequired,
            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        })
        .select("id")
        .single();

    if (error) throw error;

    const actionId = data && typeof data === "object" && "id" in data ? String((data as { id: unknown }).id) : null;
    return { created: Boolean(actionId), actionId, reason: "created" };
}

async function sendTelegramMessage(chatId: string, text: string) {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    if (!botToken) {
        console.warn("[telegram_admin_webhook] TELEGRAM_BOT_TOKEN is not configured; response was not sent to Telegram");
        return { sent: false, reason: "missing_bot_token" };
    }

    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
        }),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error("[telegram_admin_webhook] Telegram sendMessage failed", response.status, errorText.slice(0, 500));
        return { sent: false, reason: "telegram_api_error", status: response.status };
    }

    return { sent: true };
}

async function auditMessage(
    supabase: SupabaseClient,
    payload: {
        channelUser?: AdminChannelUser | null;
        update: TelegramUpdate;
        message?: TelegramMessage | null;
        direction: "inbound" | "outbound";
        messageType: "command" | "text" | "system";
        normalizedIntent?: string | null;
        sanitizedBody?: string | null;
        responseSummary?: string | null;
        agentActionId?: string | null;
        status: "received" | "processed" | "blocked" | "failed";
        errorMessage?: string | null;
        metadata?: Record<string, unknown>;
    },
) {
    const message = payload.message || getMessage(payload.update);
    const from = message?.from;
    const chat = message?.chat;

    const { error } = await supabase.from("agent_channel_messages").insert({
        channel: "telegram_admin",
        external_update_id: payload.update.update_id == null ? null : String(payload.update.update_id),
        external_message_id: message?.message_id == null ? null : String(message.message_id),
        external_user_id: from?.id == null ? null : String(from.id),
        external_chat_id: chat?.id == null ? null : String(chat.id),
        admin_user_id: payload.channelUser?.admin_user_id || null,
        agent_action_id: payload.agentActionId || null,
        direction: payload.direction,
        message_type: payload.messageType,
        normalized_intent: payload.normalizedIntent || null,
        sanitized_body: payload.sanitizedBody ? cleanText(payload.sanitizedBody) : null,
        response_summary: payload.responseSummary ? cleanText(payload.responseSummary) : null,
        status: payload.status,
        error_message: payload.errorMessage || null,
        metadata: payload.metadata || {},
    });

    if (error) {
        console.warn("[telegram_admin_webhook] agent_channel_messages audit failed", error.message);
    }
}

async function loadAllowedUser(
    supabase: SupabaseClient,
    params: {
        externalUserId: string;
        externalChatId: string;
    },
) {
    const { data, error } = await supabase
        .from("admin_channel_users")
        .select("id, admin_user_id, external_chat_id, role_scope, allowed_commands, status")
        .eq("channel", "telegram_admin")
        .eq("external_user_id", params.externalUserId)
        .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    const row = data as AdminChannelUser;
    if (row.external_chat_id && row.external_chat_id !== params.externalChatId) return null;
    return row;
}

async function updateLastSeen(supabase: SupabaseClient, row: AdminChannelUser) {
    const { error } = await supabase
        .from("admin_channel_users")
        .update({ last_seen_at: new Date().toISOString() })
        .eq("id", row.id);

    if (error) {
        console.warn("[telegram_admin_webhook] last_seen_at update failed", error.message);
    }
}

async function fetchDashboardSummary(supabase: SupabaseClient, row: AdminChannelUser): Promise<CommandResult> {
    const window = getBogotaDayWindow();
    const { data: paidOrders, error: paidError } = await supabase
        .from("orders")
        .select("id, status, total_cents, paid_at")
        .in("status", ["paid", "shipped", "delivered"])
        .gte("paid_at", window.from)
        .lt("paid_at", window.to);

    if (paidError) throw paidError;

    const paidOrderRows = Array.isArray(paidOrders) ? paidOrders as Array<Record<string, unknown>> : [];
    const revenueCents = paidOrderRows.reduce((total, order) => total + safeNumber(order.total_cents), 0);
    const orderIds = paidOrderRows.map((order) => order.id).filter((id): id is string => typeof id === "string");

    const { data: pendingOrders, error: pendingError } = await supabase
        .from("orders")
        .select("id, total_cents, paid_at")
        .eq("status", "paid")
        .not("paid_at", "is", null)
        .order("paid_at", { ascending: true })
        .limit(100);

    if (pendingError) throw pendingError;

    const pendingRows = Array.isArray(pendingOrders) ? pendingOrders as Array<Record<string, unknown>> : [];
    const pendingOrderIds = pendingRows.map((order) => order.id).filter((id): id is string => typeof id === "string");

    const { data: shipments, error: shipmentsError } = pendingOrderIds.length
        ? await supabase
            .from("shipments")
            .select("order_id, status")
            .in("order_id", pendingOrderIds)
            .in("status", ["shipped", "in_transit", "out_for_delivery", "delivered"])
        : { data: [], error: null };

    if (shipmentsError) throw shipmentsError;

    const shippedOrderIds = new Set(
        (Array.isArray(shipments) ? shipments : [])
            .map((shipment: Record<string, unknown>) => shipment.order_id)
            .filter((id): id is string => typeof id === "string"),
    );
    const paidPendingDispatch = pendingRows.filter((order) => typeof order.id === "string" && !shippedOrderIds.has(order.id));
    const overdueDispatch = paidPendingDispatch.filter((order) => hoursSince(order.paid_at as string) >= 24);

    const { data: actions, error: actionsError } = await supabase
        .from("agent_actions")
        .select("id")
        .in("status", ["suggested", "pending_approval", "approved"])
        .limit(100);

    if (actionsError) throw actionsError;

    let financeLine = row.role_scope === "owner"
        ? "Margen contribucion: sin ventas aprobadas hoy para calcular."
        : "Margen: oculto para este rol.";
    if (row.role_scope === "owner" && orderIds.length > 0) {
        const { data: economics, error: economicsError } = await supabase
            .from("order_economics")
            .select("order_id, contribution_margin_cents, contribution_margin_bps, data_quality_flags")
            .in("order_id", orderIds);

        if (economicsError) throw economicsError;

        const economicRows = Array.isArray(economics) ? economics as Array<Record<string, unknown>> : [];
        const marginCents = economicRows.reduce((total, item) => total + safeNumber(item.contribution_margin_cents), 0);
        const missingCogs = economicRows.filter((item) =>
            Array.isArray(item.data_quality_flags) && item.data_quality_flags.includes("missing_cogs")
        ).length;
        financeLine = `Margen contribucion: ${formatMoney(marginCents)}. Costos faltantes: ${missingCogs}.`;
    }

    const actionCount = Array.isArray(actions) ? actions.length : 0;
    const riskLine = overdueDispatch.length > 0
        ? `Prioridad: ${overdueDispatch.length} pedido(s) pagado(s) superan 24h sin despacho.`
        : "Prioridad: no hay pagadas fuera de SLA de 24h.";
    const suggestedAction: AgentActionDraft | null = paidPendingDispatch.length > 0
        ? {
            actionType: "ops_action_plan",
            targetType: "operations",
            riskLevel: overdueDispatch.length > 0 ? "high" : "medium",
            summary: `Preparar prioridades del dia: ${paidPendingDispatch.length} pagadas por despachar, ${overdueDispatch.length} fuera de SLA.`,
            evidence: [
                { source: "telegram_admin_webhook", metric: "paid_pending_dispatch_count", value: paidPendingDispatch.length },
                { source: "telegram_admin_webhook", metric: "paid_over_sla_count", value: overdueDispatch.length },
                { source: "telegram_admin_webhook", metric: "today_revenue_cents", value: revenueCents },
            ],
            proposedPayload: {
                safe_next_step: "review_operations_priorities",
                paid_to_dispatch_order_ids: paidPendingDispatch.slice(0, 5).map((order) => order.id),
                mode: "suggest_only",
            },
            approvalRequired: true,
        }
        : null;

    return {
        status: "processed",
        messageType: "command",
        suggestedAction,
        response: [
            `Resumen SportBot (${window.label}, Bogota)`,
            "",
            `Ventas aprobadas hoy: ${formatMoney(revenueCents)} en ${paidOrderRows.length} pedido(s).`,
            `Pagadas por despachar: ${paidPendingDispatch.length}. Fuera de SLA: ${overdueDispatch.length}.`,
            financeLine,
            `Acciones AI Ops abiertas: ${actionCount}.`,
            "",
            riskLine,
            "Modo: lectura/sugerencia. No ejecuto cambios desde Telegram.",
        ].join("\n"),
    };
}

async function fetchLogisticsSummary(supabase: SupabaseClient): Promise<CommandResult> {
    const { data: pendingOrders, error: pendingError } = await supabase
        .from("orders")
        .select("id, total_cents, paid_at, shipping_city, customers(name)")
        .eq("status", "paid")
        .not("paid_at", "is", null)
        .order("paid_at", { ascending: true })
        .limit(50);

    if (pendingError) throw pendingError;

    const pendingRows = Array.isArray(pendingOrders) ? pendingOrders as Array<Record<string, unknown>> : [];
    const pendingOrderIds = pendingRows.map((order) => order.id).filter((id): id is string => typeof id === "string");

    const { data: shipments, error: shipmentsError } = pendingOrderIds.length
        ? await supabase
            .from("shipments")
            .select("order_id, status, tracking_number, shipped_at")
            .in("order_id", pendingOrderIds)
            .in("status", ["shipped", "in_transit", "out_for_delivery", "delivered"])
        : { data: [], error: null };

    if (shipmentsError) throw shipmentsError;

    const shippedOrderIds = new Set(
        (Array.isArray(shipments) ? shipments : [])
            .map((shipment: Record<string, unknown>) => shipment.order_id)
            .filter((id): id is string => typeof id === "string"),
    );
    const paidPendingDispatch = pendingRows.filter((order) => typeof order.id === "string" && !shippedOrderIds.has(order.id));
    const overdueDispatch = paidPendingDispatch.filter((order) => hoursSince(order.paid_at as string) >= 24);

    const { data: activeShipments, error: activeError } = await supabase
        .from("shipments")
        .select("id, order_id, status, carrier_name, tracking_number, shipped_at")
        .in("status", ["shipped", "in_transit", "out_for_delivery"])
        .order("shipped_at", { ascending: true })
        .limit(20);

    if (activeError) throw activeError;

    const activeRows = Array.isArray(activeShipments) ? activeShipments as Array<Record<string, unknown>> : [];
    const missingTracking = activeRows.filter((shipment) => !cleanText(shipment.tracking_number)).length;

    const { data: failedNotifications, error: notificationError } = await supabase
        .from("logistics_notifications")
        .select("id, order_id, purpose, status, error_message, created_at")
        .in("status", ["failed", "undelivered"])
        .order("created_at", { ascending: false })
        .limit(5);

    if (notificationError) throw notificationError;

    const queueLines = paidPendingDispatch.slice(0, 5).map((order, index) =>
        `${index + 1}. ${shortId(order.id)} - ${getCustomerName(order)} - ${formatMoney(order.total_cents)} - ${Math.round(hoursSince(order.paid_at as string))}h`
    );
    const firstDispatch = paidPendingDispatch[0];
    const suggestedAction: AgentActionDraft | null = firstDispatch
        ? {
            actionType: "dispatch_review",
            targetType: "order",
            targetId: typeof firstDispatch.id === "string" ? firstDispatch.id : null,
            targetRef: shortId(firstDispatch.id),
            riskLevel: overdueDispatch.length > 0 ? "high" : "medium",
            summary: `Revisar despacho de ${shortId(firstDispatch.id)}: ${Math.round(hoursSince(firstDispatch.paid_at as string))}h esperando.`,
            evidence: [
                { source: "telegram_admin_webhook", metric: "paid_pending_dispatch_count", value: paidPendingDispatch.length },
                { source: "telegram_admin_webhook", metric: "paid_over_sla_count", value: overdueDispatch.length },
                { source: "telegram_admin_webhook", queue: "paid_to_dispatch", first_order_id: firstDispatch.id },
            ],
            proposedPayload: {
                order_id: firstDispatch.id,
                safe_next_step: "review_dispatch_in_orders",
                mode: "suggest_only",
            },
            approvalRequired: true,
        }
        : null;

    return {
        status: "processed",
        messageType: "command",
        suggestedAction,
        response: [
            "Logistica SportBot",
            "",
            `Pagadas por despachar: ${paidPendingDispatch.length}. Fuera de SLA 24h: ${overdueDispatch.length}.`,
            `Envios activos: ${activeRows.length}. Sin tracking: ${missingTracking}.`,
            `Notificaciones fallidas: ${Array.isArray(failedNotifications) ? failedNotifications.length : 0}.`,
            "",
            queueLines.length ? "Cola prioritaria:\n" + queueLines.join("\n") : "No hay cola pendiente por despachar.",
            "",
            "No despacho desde Telegram. Usa Admin/AI Ops para revisar o ejecutar.",
        ].join("\n"),
    };
}

async function fetchInventorySummary(supabase: SupabaseClient): Promise<CommandResult> {
    const { data: variants, error } = await supabase
        .from("product_variants")
        .select("id, size, stock, reserved, products(brand, model)")
        .limit(300);

    if (error) throw error;

    const rows = Array.isArray(variants) ? variants as Array<Record<string, unknown>> : [];
    const enrichedVariants: Array<Record<string, unknown> & { available: number }> = rows
        .map((variant) => ({
            ...variant,
            available: safeNumber(variant.stock) - safeNumber(variant.reserved),
        }));
    const critical = enrichedVariants
        .filter((variant) => variant.available < 3)
        .sort((left, right) => left.available - right.available)
        .slice(0, 8);

    const lines = critical.map((variant, index) =>
        `${index + 1}. ${getProductName(variant)} talla ${variant.size ?? "?"}: disp. ${variant.available}`
    );
    const firstCritical = critical[0];
    const suggestedAction: AgentActionDraft | null = firstCritical
        ? {
            actionType: "inventory_alert_review",
            targetType: "product_variant",
            targetId: typeof firstCritical.id === "string" ? firstCritical.id : null,
            targetRef: `${getProductName(firstCritical)} talla ${firstCritical.size ?? "?"}`,
            riskLevel: firstCritical.available <= 0 ? "medium" : "low",
            summary: `Revisar inventario critico: ${getProductName(firstCritical)} talla ${firstCritical.size ?? "?"}, disponibles ${firstCritical.available}.`,
            evidence: [
                { source: "telegram_admin_webhook", metric: "critical_variant_count", value: critical.length },
                { source: "telegram_admin_webhook", queue: "inventory_alerts", first_variant_id: firstCritical.id },
            ],
            proposedPayload: {
                variant_id: firstCritical.id,
                safe_next_step: "review_inventory_restock",
                mode: "suggest_only",
            },
            approvalRequired: true,
        }
        : null;

    return {
        status: "processed",
        messageType: "command",
        suggestedAction,
        response: [
            "Inventario critico",
            "",
            `Referencias/tallas con menos de 3 disponibles: ${critical.length}.`,
            lines.length ? lines.join("\n") : "No veo alertas criticas en las primeras referencias revisadas.",
            "",
            "Recomendacion: revisar reposicion y demanda antes de pausar ventas.",
        ].join("\n"),
    };
}

async function fetchMarginRiskSummary(supabase: SupabaseClient, row: AdminChannelUser): Promise<CommandResult> {
    if (row.role_scope !== "owner") {
        return {
            status: "processed",
            messageType: "command",
            response: "Este comando solo esta disponible para owner. No muestro margen ni costos a este rol.",
        };
    }

    const { data: economics, error } = await supabase
        .from("order_economics")
        .select("order_id, revenue_cents, contribution_margin_cents, contribution_margin_bps, data_quality_flags, updated_at")
        .order("updated_at", { ascending: false })
        .limit(100);

    if (error) throw error;

    const rows = Array.isArray(economics) ? economics as Array<Record<string, unknown>> : [];
    const missingCogs = rows.filter((item) =>
        Array.isArray(item.data_quality_flags) && item.data_quality_flags.includes("missing_cogs")
    );
    const negativeMargin = rows.filter((item) => safeNumber(item.contribution_margin_cents) < 0);
    const lowMargin = rows.filter((item) => {
        const bps = safeNumber(item.contribution_margin_bps);
        return bps > 0 && bps < 1500;
    });

    const examples = [...negativeMargin, ...missingCogs, ...lowMargin]
        .slice(0, 5)
        .map((item, index) =>
            `${index + 1}. ${shortId(item.order_id)} margen ${formatMoney(item.contribution_margin_cents)} (${formatPercentBps(item.contribution_margin_bps)})`
        );
    const firstRisk = [...negativeMargin, ...missingCogs, ...lowMargin][0];
    const suggestedAction: AgentActionDraft | null = firstRisk
        ? {
            actionType: "margin_data_review",
            targetType: typeof firstRisk.order_id === "string" ? "order" : "finance",
            targetId: typeof firstRisk.order_id === "string" ? firstRisk.order_id : null,
            targetRef: typeof firstRisk.order_id === "string" ? shortId(firstRisk.order_id) : undefined,
            riskLevel: negativeMargin.length > 0 ? "high" : "medium",
            summary: `Revisar margen: ${missingCogs.length} costos faltantes, ${negativeMargin.length} margen negativo, ${lowMargin.length} margen bajo.`,
            evidence: [
                { source: "telegram_admin_webhook", metric: "missing_cogs_count", value: missingCogs.length },
                { source: "telegram_admin_webhook", metric: "negative_margin_count", value: negativeMargin.length },
                { source: "telegram_admin_webhook", metric: "low_margin_count", value: lowMargin.length },
            ],
            proposedPayload: {
                order_id: firstRisk.order_id,
                safe_next_step: "complete_cost_data",
                mode: "suggest_only",
            },
            approvalRequired: true,
        }
        : null;

    return {
        status: "processed",
        messageType: "command",
        suggestedAction,
        response: [
            "Riesgo de margen",
            "",
            `Ordenes revisadas: ${rows.length}.`,
            `Costos faltantes: ${missingCogs.length}. Margen negativo: ${negativeMargin.length}. Margen bajo: ${lowMargin.length}.`,
            examples.length ? "\nEjemplos:\n" + examples.join("\n") : "",
            "",
            "No cambio costos desde Telegram. Crea/revisa acciones en Admin AI Ops.",
        ].filter(Boolean).join("\n"),
    };
}

async function fetchAgentActionsSummary(supabase: SupabaseClient): Promise<CommandResult> {
    const { data: actions, error } = await supabase
        .from("agent_actions")
        .select("id, status, risk_level, action_type, summary, created_at")
        .in("status", ["suggested", "pending_approval", "approved"])
        .order("created_at", { ascending: false })
        .limit(8);

    if (error) throw error;

    const rows = Array.isArray(actions) ? actions as Array<Record<string, unknown>> : [];
    const lines = rows.map((action, index) =>
        `${index + 1}. ${shortId(action.id)} [${action.risk_level}/${action.status}] ${action.summary}`
    );

    return {
        status: "processed",
        messageType: "command",
        response: [
            "Acciones AI Ops abiertas",
            "",
            lines.length ? lines.join("\n") : "No hay acciones abiertas.",
            "",
            "La revision y ejecucion siguen en Admin /ai-ops.",
        ].join("\n"),
    };
}

async function handleAllowedCommand(supabase: SupabaseClient, row: AdminChannelUser, command: string) {
    if (command === "/ayuda" || command === "/help" || command === "/start") {
        return {
            status: "processed" as const,
            messageType: "command" as const,
            normalizedIntent: command,
            response: formatHelp(row),
        };
    }

    if (command === "/resumen_hoy") {
        return fetchDashboardSummary(supabase, row);
    }

    if (command === "/logistica" || command === "/pagadas_sin_despacho") {
        return fetchLogisticsSummary(supabase);
    }

    if (command === "/stock_critico") {
        return fetchInventorySummary(supabase);
    }

    if (command === "/margen_riesgo") {
        return fetchMarginRiskSummary(supabase, row);
    }

    if (command === "/acciones") {
        return fetchAgentActionsSummary(supabase);
    }

    return {
        status: "processed" as const,
        messageType: command.startsWith("/") ? "command" as const : "text" as const,
        normalizedIntent: command.startsWith("/") ? command : "unsupported_text",
        response: [
            "Recibi tu solicitud, pero no corresponde a un comando soportado en esta fase.",
            "Usa /ayuda para ver las opciones disponibles.",
        ].join("\n"),
    };
}

async function handleConversationalText(
    supabase: SupabaseClient,
    row: AdminChannelUser,
    rawText: string,
    externalChatId: string,
): Promise<CommandResult> {
    const intent = detectConversationalIntent(rawText);

    if (!canRunCommand(row, intent.command)) {
        return {
            status: "processed",
            messageType: "text",
            normalizedIntent: intent.label,
            response: [
                "Entendi la intencion, pero tu rol o allowlist no permite consultar ese bloque desde Telegram.",
                "Usa /ayuda para ver lo disponible para tu usuario.",
            ].join("\n"),
        };
    }

    const result = await handleAllowedCommand(supabase, row, intent.command);
    let actionLine = "";
    let agentActionId: string | null = null;

    if (result.suggestedAction && shouldCreateSuggestedAction(rawText)) {
        try {
            const actionResult = await createTelegramAgentAction(supabase, row, result.suggestedAction, {
                rawText,
                normalizedIntent: intent.label,
                externalChatId,
            });

            if (actionResult.created && actionResult.actionId) {
                agentActionId = actionResult.actionId;
                actionLine = `\n\nDeje una accion sugerida en AI Ops para revision: ${shortId(actionResult.actionId)}. No ejecute ningun cambio.`;
            } else if (actionResult.existingId) {
                agentActionId = actionResult.existingId;
                actionLine = `\n\nYa existia una accion abierta similar en AI Ops: ${shortId(actionResult.existingId)}. Evite duplicarla.`;
            }
        } catch (actionError) {
            console.error("[telegram_admin_webhook] agent action creation failed", actionError);
            actionLine = "\n\nNo pude registrar la accion sugerida, pero la lectura anterior sigue siendo valida.";
        }
    }

    return {
        ...result,
        messageType: "text",
        normalizedIntent: intent.label,
        agentActionId,
        response: [
            intent.lead,
            "",
            result.response,
        ].join("\n") + actionLine,
    };
}

serve(async (req) => {
    if (req.method === "OPTIONS") return textResponse("ok");
    if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

    let supabase: SupabaseClient | null = null;
    let update: TelegramUpdate | null = null;

    try {
        const expectedSecret = requireEnv("TELEGRAM_ADMIN_WEBHOOK_SECRET");
        const receivedSecret = req.headers.get("x-telegram-bot-api-secret-token") || "";

        if (!receivedSecret || !timingSafeEqual(receivedSecret, expectedSecret)) {
            return jsonResponse({ error: "Invalid Telegram webhook secret" }, 401);
        }

        supabase = createServiceClient();
        update = await req.json() as TelegramUpdate;
        const message = getMessage(update);
        const from = message?.from;
        const chat = message?.chat;
        const rawText = cleanText(message?.text);
        const command = normalizeCommand(rawText);
        const inboundIntent = command.startsWith("/")
            ? command
            : detectConversationalIntent(rawText).label;

        if (!message || !from?.id || !chat?.id) {
            await auditMessage(supabase, {
                update,
                message,
                direction: "inbound",
                messageType: "system",
                status: "blocked",
                errorMessage: "Unsupported Telegram update",
                metadata: { reason: "unsupported_update" },
            });
            return jsonResponse({ ok: true, ignored: true });
        }

        await auditMessage(supabase, {
            update,
            message,
            direction: "inbound",
            messageType: command.startsWith("/") ? "command" : "text",
            normalizedIntent: inboundIntent || null,
            sanitizedBody: rawText,
            status: "received",
            metadata: {
                chat_type: chat.type || null,
                display_name: formatDisplayName(from),
            },
        });

        if (chat.type !== "private") {
            await auditMessage(supabase, {
                update,
                message,
                direction: "outbound",
                messageType: "system",
                normalizedIntent: command || null,
                responseSummary: "Blocked non-private chat",
                status: "blocked",
                metadata: { reason: "non_private_chat" },
            });
            return jsonResponse({ error: "Private chat required" }, 403);
        }

        const externalUserId = String(from.id);
        const externalChatId = String(chat.id);
        const channelUser = await loadAllowedUser(supabase, { externalUserId, externalChatId });

        if (!channelUser || channelUser.status !== "active") {
            await auditMessage(supabase, {
                update,
                message,
                direction: "outbound",
                messageType: "system",
                normalizedIntent: command || null,
                responseSummary: "Blocked user outside allowlist",
                status: "blocked",
                metadata: { reason: "not_allowlisted" },
            });
            return jsonResponse({ error: "Not allowed" }, 403);
        }

        await updateLastSeen(supabase, channelUser);

        const allowedCommands = getAllowedCommands(channelUser);
        const isKnownCommand = Boolean(COMMAND_ROLE_ALLOWLIST[command]);
        if (!isHelpCommand(command) && command.startsWith("/") && !allowedCommands.has(command)) {
            const response = "Tu rol no tiene permiso para ese comando. Usa /ayuda para ver opciones disponibles.";
            await sendTelegramMessage(externalChatId, response);
            await auditMessage(supabase, {
                channelUser,
                update,
                message,
                direction: "outbound",
                messageType: "command",
                normalizedIntent: command,
                responseSummary: response,
                status: "blocked",
                metadata: { reason: "command_not_allowed" },
            });
            return jsonResponse({ ok: true, blocked: true });
        }

        if (command.startsWith("/") && (!isKnownCommand || !roleCanRunCommand(channelUser, command))) {
            const response = "Ese comando no esta habilitado para tu rol. Usa /ayuda para ver opciones disponibles.";
            await sendTelegramMessage(externalChatId, response);
            await auditMessage(supabase, {
                channelUser,
                update,
                message,
                direction: "outbound",
                messageType: "command",
                normalizedIntent: command,
                responseSummary: response,
                status: "blocked",
                metadata: { reason: "role_not_allowed" },
            });
            return jsonResponse({ ok: true, blocked: true });
        }

        const result = command.startsWith("/")
            ? await handleAllowedCommand(supabase, channelUser, command)
            : await handleConversationalText(supabase, channelUser, rawText, externalChatId);
        const sendResult = await sendTelegramMessage(externalChatId, result.response);

        await auditMessage(supabase, {
            channelUser,
            update,
            message,
            direction: "outbound",
            messageType: result.messageType,
            normalizedIntent: result.normalizedIntent || inboundIntent || null,
            agentActionId: result.agentActionId || null,
            responseSummary: result.response,
            status: result.status,
            metadata: { send_result: sendResult },
        });

        return jsonResponse({
            ok: true,
            sent: sendResult.sent,
            command: command || null,
            mode: "suggest_only",
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        console.error("[telegram_admin_webhook] error", message);

        if (supabase && update) {
            await auditMessage(supabase, {
                update,
                direction: "outbound",
                messageType: "system",
                status: "failed",
                errorMessage: message,
                metadata: { reason: "unhandled_error" },
            });
        }

        return jsonResponse({ error: "Telegram admin webhook failed" }, 500);
    }
});
