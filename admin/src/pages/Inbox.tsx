import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
    AlertTriangle,
    ArrowDownToLine,
    Bot,
    CheckCircle2,
    Clock,
    ClipboardList,
    Copy,
    CreditCard,
    Filter,
    Inbox as InboxIcon,
    Link2,
    MessageSquareText,
    NotebookPen,
    PackageCheck,
    RefreshCw,
    RotateCcw,
    Save,
    Search,
    SendHorizontal,
    ShieldCheck,
    ShoppingBag,
    Truck,
    Type,
    UserCheck,
    UserRound,
    type LucideIcon,
} from "lucide-react";
import { supabase } from "../lib/supabase";
import { cn } from "../lib/utils";
import { Link } from "react-router-dom";
import { useAuth } from "../lib/auth-context";
import {
    buildActiveContextResolutionAudit,
    buildActiveContextSuggestedReply,
    canSendWithLoadedInboxMessages,
    isCurrentInboxMessageRequest,
    runInboxMessageRequest,
    type InboxMessageLoadStatus,
} from "../lib/inboxContext";

type InboxFilter =
    | "all"
    | "needs_reply"
    | "handoff"
    | "payment_pending"
    | "fulfillment_pending"
    | "over_sla"
    | "agent_actions"
    | "mis";

type InboxSnapshot = {
    generated_at?: string;
    summary?: {
        total_count?: number;
        open_count?: number;
        handoff_required_count?: number;
        needs_reply_count?: number;
        payment_pending_count?: number;
        paid_pending_dispatch_count?: number;
        paid_over_sla_count?: number;
        open_agent_actions_count?: number;
    };
    conversations?: InboxConversation[];
    agent_context?: {
        mode?: string;
        recommended_focus?: string;
        allowed_actions?: string[];
    };
};

type StorefrontIdentityBridge = {
    id?: string | null;
    handoff_code?: string | null;
    status?: string | null;
    storefront_session_id?: string | null;
    source_surface?: string | null;
    product_brand?: string | null;
    product_model?: string | null;
    size_requested?: string | number | null;
    intent?: string | null;
    funnel_stage?: string | null;
    linked_customer_id?: string | null;
    linked_conversation_id?: string | null;
    linked_message_id?: string | null;
    created_at?: string | null;
    linked_at?: string | null;
    expires_at?: string | null;
    metadata?: Record<string, unknown> | null;
};

type ActiveContextResolution = {
    id: string;
    conversation_id: string;
    customer_id?: string | null;
    source_action_id?: string | null;
    active_context: ActiveContextFocus | "manual_review" | string;
    status?: string | null;
    resolution_reason?: string | null;
    dispatch_order_id?: string | null;
    dispatch_payment_reference?: string | null;
    dispatch_product_name?: string | null;
    dispatch_size?: string | null;
    storefront_handoff_id?: string | null;
    storefront_handoff_code?: string | null;
    storefront_product_name?: string | null;
    storefront_size?: string | null;
    guardrails?: Record<string, unknown> | null;
    evidence?: Record<string, unknown> | null;
    resolved_at?: string | null;
    created_at?: string | null;
};

type InboxConversation = {
    conversation_id: string;
    customer_id?: string | null;
    customer_name?: string | null;
    phone_e164?: string | null;
    channel?: string | null;
    conversation_status?: string | null;
    unread_count?: number;
    operator_assignment?: {
        status: "bot" | "waiting_human" | "human";
        owner_user_id?: string | null;
        owner_email?: string | null;
        claimed_at?: string | null;
    };
    last_message_at?: string | null;
    last_message?: {
        message_id?: string | null;
        direction?: string | null;
        role?: string | null;
        preview?: string | null;
        created_at?: string | null;
    };
    message_activity?: {
        last_inbound_at?: string | null;
        last_outbound_at?: string | null;
        inbound_count?: number;
        outbound_count?: number;
        needs_reply?: boolean;
    };
    commercial?: {
        stage?: string | null;
        intent?: string | null;
        risk_level?: RiskLevel | string | null;
        handoff_required?: boolean;
        handoff_reason?: string | null;
        next_best_action?: string | null;
        priority_score?: number;
    };
    customer_profile?: {
        preferred_sizes?: Array<string | number>;
        preferred_brands?: string[];
        preferred_models?: string[];
        city?: string | null;
        conversation_summary?: string | null;
        has_operator_notes?: boolean;
    };
    active_product?: {
        product_id?: string | null;
        variant_id?: string | null;
        brand?: string | null;
        model?: string | null;
        colorway?: string | null;
        display_name?: string | null;
        size?: string | number | null;
        price_cents?: number | null;
        available_units?: number | null;
        context_source?: string | null;
        context_quality?: string | null;
        context_warning?: string | null;
    };
    order?: {
        order_id?: string | null;
        status?: string | null;
        payment_reference?: string | null;
        total_cents?: number | null;
        paid_at?: string | null;
        created_at?: string | null;
        context_source?: string | null;
    };
    payment?: {
        payment_id?: string | null;
        status?: string | null;
        approved_at?: string | null;
    };
    fulfillment?: {
        shipment_id?: string | null;
        status?: string | null;
        carrier_name?: string | null;
        tracking_number?: string | null;
        shipped_at?: string | null;
        delivered_at?: string | null;
        paid_over_sla?: boolean;
    };
    agent_actions?: {
        open_count?: number;
        first_action_id?: string | null;
        first_summary?: string | null;
        highest_risk?: RiskLevel | string | null;
    };
    last_event?: {
        event_id?: string | null;
        event_type?: string | null;
        funnel_stage?: string | null;
        intent?: string | null;
        sentiment?: string | null;
        occurred_at?: string | null;
    };
};

type Message = {
    id: string;
    conversation_id: string;
    direction?: "inbound" | "outbound" | string | null;
    role?: string | null;
    body?: string | null;
    created_at?: string | null;
    delivery_status?: "sending" | "accepted" | "delivered" | "read" | "failed" | "unknown" | null;
    delivery_error?: string | null;
};

type HumanControl = {
    status: "bot" | "waiting_human" | "human";
    owner_user_id?: string | null;
    owner_email?: string | null;
    claimed_at?: string | null;
    pending_sends?: Array<{ id: string; preview: string; created_at: string }>;
    uncertain_sends?: Array<{ id: string; preview: string; error?: string | null; created_at: string }>;
    events?: Array<{ id: string; event_type: string; actor_email?: string | null; created_at: string; details?: Record<string, unknown> }>;
};

type QuickAnswer = {
    id: string;
    shortcut: string;
    body: string;
    is_global: boolean;
    created_at?: string | null;
};

type ConversationClosure = {
    conversation_id: string;
    closed_at?: string | null;
    closed_by?: string | null;
    close_reason?: string | null;
    reopened_at?: string | null;
    reopened_by?: string | null;
    reopen_reason?: string | null;
};

type SearchResult = {
    conversation_id: string;
    customer_id?: string | null;
    customer_name?: string | null;
    phone_e164?: string | null;
    last_message_at?: string | null;
    match_type?: string | null;
    match_preview?: string | null;
    conversation_status?: string | null;
};

type RiskLevel = "low" | "medium" | "high" | "critical";

type InboxActionInput = {
    actionType: string;
    summary: string;
    riskLevel?: RiskLevel | string | null;
    evidence?: Record<string, unknown>[];
    inputContext?: Record<string, unknown>;
    proposedPayload?: Record<string, unknown>;
};

type ProductThreadCoherence = {
    ok: boolean;
    severity: "none" | "high";
    productName?: string | null;
    reason: string;
    matchedTokens: string[];
    recentProductSignals: string[];
};

type MultiContextState = {
    bridgeProductName: string;
    bridgeSize?: string | null;
    orderProductName: string;
    orderSize?: string | null;
    summary: string;
    operatorGuidance: string;
};

type ActiveContextFocus = "dispatch_pending_order" | "new_storefront_purchase";

type AssignmentState = {
    ownerLabel: string;
    statusLabel: string;
    helper: string;
    tone: "slate" | "cyan" | "amber" | "red" | "green" | "indigo";
};

type HumanTimelineEntry = {
    label: string;
    meta?: string | null;
    tone?: "slate" | "cyan" | "amber" | "red" | "green" | "indigo";
};

const FILTERS: Array<{ key: InboxFilter; label: string }> = [
    { key: "all", label: "Todas" },
    { key: "needs_reply", label: "Responder" },
    { key: "handoff", label: "Humano" },
    { key: "payment_pending", label: "Pago" },
    { key: "fulfillment_pending", label: "Despacho" },
    { key: "over_sla", label: "SLA" },
    { key: "agent_actions", label: "AI Ops" },
    { key: "mis", label: "Mis chats" },
];

const EMPTY_FILTER_COPY: Record<InboxFilter, string> = {
    all: "No hay conversaciones abiertas en esta ventana.",
    needs_reply: "No hay clientes esperando respuesta del equipo.",
    handoff: "No hay conversaciones marcadas para intervención humana.",
    payment_pending: "No hay pedidos conversacionales pendientes de pago.",
    fulfillment_pending: "No hay órdenes pagadas pendientes por despachar.",
    over_sla: "No hay despachos fuera de SLA en esta ventana.",
    agent_actions: "No hay conversaciones con acciones AI Ops abiertas.",
    mis: "No hay conversaciones tomadas por ti.",
};

const MESSAGE_FETCH_LIMIT = 60;
const MESSAGE_FETCH_TIMEOUT_MS = 15_000;

const REVIEW_CONVERSATION_ID = "review-conversation-mauricio";

const INBOX_REVIEW_MESSAGES: Record<string, Message[]> = {
    [REVIEW_CONVERSATION_ID]: [
        {
            id: "review-msg-1",
            conversation_id: REVIEW_CONVERSATION_ID,
            direction: "inbound",
            role: "user",
            body: "Hola, estoy buscando unas Nike Pegasus talla 40. ¿Tienen disponibles?",
            created_at: "2026-05-21T13:52:00-05:00",
        },
        {
            id: "review-msg-2",
            conversation_id: REVIEW_CONVERSATION_ID,
            direction: "outbound",
            role: "assistant",
            body: "Sí tenemos Nike Pegasus 40 Black/White en talla 40, con 10 pares disponibles. ¿Te gustaría comprarlas o ver otra opción?",
            created_at: "2026-05-21T13:52:20-05:00",
        },
        {
            id: "review-msg-3",
            conversation_id: REVIEW_CONVERSATION_ID,
            direction: "inbound",
            role: "user",
            body: "Las quiero. Estoy en Cúcuta, ¿me puedes generar el pago?",
            created_at: "2026-05-21T13:58:00-05:00",
        },
        {
            id: "review-msg-4",
            conversation_id: REVIEW_CONVERSATION_ID,
            direction: "outbound",
            role: "assistant",
            body: "Perfecto. Dejé tu pedido listo y te envié las instrucciones de pago. Cuando confirmemos el dinero en el banco, te avisamos por WhatsApp.",
            created_at: "2026-05-21T13:59:00-05:00",
        },
        {
            id: "review-msg-5",
            conversation_id: REVIEW_CONVERSATION_ID,
            direction: "outbound",
            role: "assistant",
            body: "Pago confirmado. Estamos preparando tus zapatillas y te avisaremos cuando estén en camino.",
            created_at: "2026-05-21T14:04:00-05:00",
        },
    ],
};

const INBOX_REVIEW_SNAPSHOT: InboxSnapshot = {
    generated_at: "2026-05-21T15:00:00-05:00",
    summary: {
        total_count: 4,
        open_count: 4,
        handoff_required_count: 1,
        needs_reply_count: 0,
        payment_pending_count: 0,
        paid_pending_dispatch_count: 1,
        paid_over_sla_count: 1,
        open_agent_actions_count: 2,
    },
    agent_context: {
        mode: "suggest_only",
        recommended_focus: "revisar pagadas sin despacho y acciones AI Ops abiertas",
        allowed_actions: ["review_reply", "take_handoff", "save_note"],
    },
    conversations: [
        {
            conversation_id: REVIEW_CONVERSATION_ID,
            customer_id: "review-customer-mauricio",
            customer_name: "Usuario de prueba Bonilla",
            phone_e164: "whatsapp:+12025550100",
            channel: "whatsapp",
            conversation_status: "open",
            last_message_at: "2026-05-21T14:04:00-05:00",
            last_message: {
                message_id: "review-msg-5",
                direction: "outbound",
                role: "assistant",
                preview: "Pago confirmado. Estamos preparando tus zapatillas y te avisaremos cuando estén en camino.",
                created_at: "2026-05-21T14:04:00-05:00",
            },
            message_activity: {
                last_inbound_at: "2026-05-21T13:58:00-05:00",
                last_outbound_at: "2026-05-21T14:04:00-05:00",
                inbound_count: 2,
                outbound_count: 3,
                needs_reply: false,
            },
            commercial: {
                stage: "fulfillment_pending",
                intent: "purchase",
                risk_level: "high",
                handoff_required: false,
                next_best_action: "dispatch_review",
                priority_score: 92,
            },
            customer_profile: {
                preferred_sizes: [40, 42],
                preferred_brands: ["Nike", "Jordan"],
                preferred_models: ["Pegasus"],
                city: "Cúcuta",
                conversation_summary: "Cliente pagó Nike Pegasus 40 y espera despacho.",
                has_operator_notes: true,
            },
            active_product: {
                product_id: "review-product-pegasus",
                variant_id: "review-variant-40",
                brand: "Nike",
                model: "Pegasus 40",
                colorway: "Black/White",
                display_name: "Nike Pegasus 40 Black/White",
                size: 40,
                price_cents: 52000000,
                available_units: 10,
                context_source: "recent_message_match",
                context_quality: "inferred_from_recent_messages",
            },
            order: {
                order_id: "review-order-1",
                status: "paid",
                payment_reference: "ORD-REVIEW-001",
                total_cents: 52000000,
                paid_at: "2026-05-21T14:04:00-05:00",
                created_at: "2026-05-21T13:59:00-05:00",
                context_source: "conversation_order",
            },
            payment: {
                payment_id: "review-payment-1",
                status: "approved",
                approved_at: "2026-05-21T14:04:00-05:00",
            },
            fulfillment: {
                shipment_id: null,
                status: "pending_dispatch",
                carrier_name: null,
                tracking_number: null,
                paid_over_sla: true,
            },
            agent_actions: {
                open_count: 2,
                first_action_id: "review-action-1",
                first_summary: "Revisar despacho pendiente y confirmar guía al cliente.",
                highest_risk: "high",
            },
            last_event: {
                event_id: "review-event-1",
                event_type: "payment_approved",
                funnel_stage: "paid",
                intent: "purchase",
                sentiment: "positive",
                occurred_at: "2026-05-21T14:04:00-05:00",
            },
        },
        {
            conversation_id: "review-conversation-qa",
            customer_id: "review-customer-qa",
            customer_name: "QA Pago Sandbox",
            phone_e164: "whatsapp:+12025550101",
            channel: "whatsapp",
            conversation_status: "open",
            last_message_at: "2026-05-21T10:15:00-05:00",
            last_message: {
                message_id: "review-qa-msg-1",
                direction: "outbound",
                role: "assistant",
                preview: "Pago confirmado para prueba sandbox.",
                created_at: "2026-05-21T10:15:00-05:00",
            },
            message_activity: {
                inbound_count: 1,
                outbound_count: 2,
                needs_reply: false,
            },
            commercial: {
                stage: "paid",
                intent: "qa_payment",
                risk_level: "low",
                handoff_required: false,
                priority_score: 20,
            },
            customer_profile: {
                preferred_sizes: [42],
                preferred_brands: ["Nike"],
                city: "Bogotá",
                has_operator_notes: false,
            },
            active_product: {
                display_name: "Nike Air Max 90 Infrared",
                size: 42,
                price_cents: 45000000,
                available_units: 6,
                context_source: "conversation_order",
                context_quality: "direct",
            },
            order: {
                order_id: "review-order-qa",
                status: "paid",
                payment_reference: "ORD-REVIEW-QA",
                total_cents: 45000000,
                paid_at: "2026-05-21T10:15:00-05:00",
                context_source: "conversation_order",
            },
            payment: {
                status: "approved",
                approved_at: "2026-05-21T10:15:00-05:00",
            },
            fulfillment: {
                status: "shipped",
                carrier_name: "Manual",
                tracking_number: "GUIA-REVIEW-123",
                shipped_at: "2026-05-21T11:00:00-05:00",
                paid_over_sla: false,
            },
            agent_actions: {
                open_count: 0,
            },
        },
    ],
};

const INBOX_REVIEW_IDENTITY_BRIDGE: StorefrontIdentityBridge = {
    id: "review-handoff-1",
    handoff_code: "WEB-REVIEW1",
    status: "linked",
    storefront_session_id: "review-storefront-session-mauricio",
    source_surface: "product_card",
    product_brand: "Nike",
    product_model: "Pegasus 40 Black/White",
    size_requested: 40,
    intent: "buy_intent",
    funnel_stage: "ready_to_order",
    linked_customer_id: "review-customer-mauricio",
    linked_conversation_id: REVIEW_CONVERSATION_ID,
    linked_message_id: "review-msg-1",
    created_at: "2026-05-21T13:51:00-05:00",
    linked_at: "2026-05-21T13:52:00-05:00",
    expires_at: "2026-05-22T13:51:00-05:00",
    metadata: {
        linked_from: "twilio_inbound_whatsapp",
        source: "review_fixture",
    },
};

type InboxProps = {
    reviewFixture?: boolean;
};

export default function Inbox({ reviewFixture = false }: InboxProps) {
    const reviewMode = reviewFixture && import.meta.env.DEV;
    const { user } = useAuth();
    const [range, setRange] = useState(14);
    const [filter, setFilter] = useState<InboxFilter>("all");
    const [search, setSearch] = useState("");
    const [snapshot, setSnapshot] = useState<InboxSnapshot | null>(() => (reviewMode ? INBOX_REVIEW_SNAPSHOT : null));
    const [selectedId, setSelectedId] = useState<string | null>(() => (reviewMode ? REVIEW_CONVERSATION_ID : null));
    const [messages, setMessages] = useState<Message[]>(() => (reviewMode ? INBOX_REVIEW_MESSAGES[REVIEW_CONVERSATION_ID] : []));
    const [identityBridge, setIdentityBridge] = useState<StorefrontIdentityBridge | null>(() => (reviewMode ? INBOX_REVIEW_IDENTITY_BRIDGE : null));
    const [activeContextResolution, setActiveContextResolution] = useState<ActiveContextResolution | null>(null);
    const [loading, setLoading] = useState(!reviewMode);
    const [messagesLoading, setMessagesLoading] = useState(false);
    const [messageLoadState, setMessageLoadState] = useState<{ conversationId: string | null; status: InboxMessageLoadStatus }>(() => ({
        conversationId: reviewMode ? REVIEW_CONVERSATION_ID : null,
        status: reviewMode ? "loaded" : "idle",
    }));
    const [error, setError] = useState<string | null>(null);
    const [actionNotice, setActionNotice] = useState<string | null>(null);
    const [draftReply, setDraftReply] = useState("");
    const [operatorNote, setOperatorNote] = useState("");
    const [operatorNoteLoading, setOperatorNoteLoading] = useState(false);
    const [savingNote, setSavingNote] = useState(false);
    const [copyingDraft, setCopyingDraft] = useState(false);
    const [humanControl, setHumanControl] = useState<HumanControl>({ status: "bot" });
    const [humanControlConversationId, setHumanControlConversationId] = useState<string | null>(null);
    const [unreadCounts, setUnreadCounts] = useState<Map<string, number>>(new Map());
    const [quickAnswers, setQuickAnswers] = useState<QuickAnswer[]>([]);
    const [conversationClosure, setConversationClosure] = useState<ConversationClosure | null>(null);
    const [serverSearchResults, setServerSearchResults] = useState<SearchResult[]>([]);
    const [humanActionBusy, setHumanActionBusy] = useState(false);
    const [sendBusy, setSendBusy] = useState(false);
    const messageListRef = useRef<HTMLDivElement | null>(null);
    const messageEndRef = useRef<HTMLDivElement | null>(null);
    const selectedIdRef = useRef(selectedId);
    const messagesRequestIdRef = useRef(0);
    const messagesRequestRef = useRef<{ conversationId: string; requestId: number; controller: AbortController } | null>(null);
    const humanControlRequestIdRef = useRef(0);
    useLayoutEffect(() => {
        selectedIdRef.current = selectedId;
    }, [selectedId]);
    const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const notificationSoundRef = useRef<HTMLAudioElement | null>(null);
    const previousNeedsReplyRef = useRef<number | null>(null);
    const [notificationPrefs, setNotificationPrefs] = useState<{
        sound_enabled: boolean;
        sound_volume: number;
        notify_new_message: boolean;
        notify_when_in_thread: boolean;
        silent_mode: boolean;
    } | null>(null);
    const [activityFeed, setActivityFeed] = useState<Array<{
        id: string;
        conversation_id: string;
        actor_user_id?: string | null;
        event_type: string;
        match_type?: string | null;
        match_preview?: string | null;
        created_at: string;
    }>>([]);

    const scrollMessagesToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
        const list = messageListRef.current;
        if (!list) return;

        const bottom = Math.max(0, list.scrollHeight - list.clientHeight);
        if (behavior === "auto") {
            list.scrollTop = bottom;
            messageEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
            return;
        }

        list.scrollTo({
            top: bottom,
            behavior,
        });
        messageEndRef.current?.scrollIntoView({ block: "end", behavior });
    }, []);

    const markConversationRead = useCallback(async (conversationId: string) => {
        const actorId = user?.id;
        if (!actorId) return;
        const { error } = await supabase.rpc("admin_mark_conversation_read", {
            p_conversation_id: conversationId,
            p_actor_user_id: actorId,
        });
        if (error) {
            console.warn("No se pudo marcar la conversación como leída:", error);
            return;
        }
        setUnreadCounts((prev) => {
            const next = new Map(prev);
            next.set(conversationId, 0);
            return next;
        });
    }, []);

    const loadQuickAnswers = useCallback(async () => {
        const actorId = user?.id;
        if (!actorId) return;
        try {
            const { data } = await supabase.rpc("admin_list_quick_answers", {
                p_user_id: actorId,
            });
            setQuickAnswers(
                (data || []).map((row: Record<string, unknown>) => ({
                    id: String(row.id),
                    shortcut: String(row.shortcut),
                    body: String(row.body),
                    is_global: Boolean(row.is_global),
                    created_at: row.created_at ? String(row.created_at) : undefined,
                })),
            );
        } catch (error) {
            console.warn("No se pudieron cargar las respuestas rápidas:", error);
        }
    }, []);

    const closeConversation = useCallback(async (conversationId: string, reason: string) => {
        if (!user?.id) return;
        setHumanActionBusy(true);
        try {
            const { data, error } = await supabase.rpc("admin_close_conversation", {
                p_conversation_id: conversationId,
                p_actor_user_id: user.id,
                p_close_reason: reason,
            });
            if (error || !data?.success) {
                const code = data?.code || error?.message || "close_failed";
                setActionNotice(humanActionError(code));
                return;
            }
            setActionNotice("Conversación cerrada. El motivo quedó registrado.");
            await Promise.all([fetchHumanControl(conversationId), fetchInbox()]);
            void loadConversationClosure(conversationId);
        } finally {
            setHumanActionBusy(false);
        }
    }, [user?.id]);

    const reopenConversation = useCallback(async (conversationId: string, reason?: string) => {
        if (!user?.id) return;
        setHumanActionBusy(true);
        try {
            const { data, error } = await supabase.rpc("admin_reopen_conversation", {
                p_conversation_id: conversationId,
                p_actor_user_id: user.id,
                p_reopen_reason: reason ?? null,
            });
            if (error || !data?.success) {
                const code = data?.code || error?.message || "reopen_failed";
                setActionNotice(humanActionError(code));
                return;
            }
            setActionNotice("Conversación reabierta. El bot volverá a atenderla.");
            await Promise.all([fetchHumanControl(conversationId), fetchInbox()]);
            void loadConversationClosure(conversationId);
        } finally {
            setHumanActionBusy(false);
        }
    }, [user?.id]);

    const loadConversationClosure = useCallback(async (conversationId: string) => {
        const { data } = await supabase
            .from("conversation_closures")
            .select("conversation_id, closed_at, closed_by, close_reason, reopened_at, reopened_by, reopen_reason")
            .eq("conversation_id", conversationId)
            .maybeSingle();
        if (data) {
            setConversationClosure(data as unknown as ConversationClosure);
            const ownerIds = [data.closed_by, data.reopened_by].filter(Boolean) as string[];
            if (ownerIds.length) {
                const { data: users } = await supabase
                    .from("admin_users")
                    .select("user_id, email")
                    .in("user_id", ownerIds);
                const byId = new Map((users || []).map((u) => [u.user_id, u.email]));
                setConversationClosure((prev) => ({
                    ...prev!,
                    closed_by: prev?.closed_by ? (byId.get(prev.closed_by) ?? prev.closed_by) : null,
                    reopened_by: prev?.reopened_by ? (byId.get(prev.reopened_by) ?? prev.reopened_by) : null,
                }));
            }
        } else {
            setConversationClosure(null);
        }
    }, []);

    const loadNotificationPreferences = useCallback(async () => {
        if (!user?.id) return;
        try {
            const { data, error } = await supabase
                .from("inbox_notification_preferences")
                .select("sound_enabled, sound_volume, notify_new_message, notify_when_in_thread, silent_mode")
                .eq("user_id", user.id)
                .maybeSingle();
            if (error) {
                // Si no existen preferencias aún, se usan los valores por defecto.
                setNotificationPrefs(null);
                return;
            }
            setNotificationPrefs(data as {
                sound_enabled: boolean;
                sound_volume: number;
                notify_new_message: boolean;
                notify_when_in_thread: boolean;
                silent_mode: boolean;
            } | null);
        } catch (error) {
            console.warn("No se pudieron cargar las preferencias de notificación:", error);
            setNotificationPrefs(null);
        }
    }, []);

    const loadActivityFeed = useCallback(async () => {
        if (!user?.id) return;
        try {
            const { data } = await supabase
                .from("inbox_activity_feed")
                .select("id, conversation_id, actor_user_id, event_type, match_type, match_preview, created_at")
                .order("created_at", { ascending: false })
                .limit(15);
            setActivityFeed((data || []) as Array<{
                id: string;
                conversation_id: string;
                actor_user_id?: string | null;
                event_type: string;
                match_type?: string | null;
                match_preview?: string | null;
                created_at: string;
            }>);
        } catch (error) {
            console.warn("No se pudo cargar el centro de actividad:", error);
        }
    }, []);

    const playNotificationSound = useCallback(() => {
        if (!notificationPrefs?.notify_new_message) return;
        if (notificationPrefs?.silent_mode) return;
        if (!notificationPrefs?.sound_enabled) return;

        let audio = notificationSoundRef.current;
        if (!audio) {
            audio = new Audio("/notification-sound.mp3");
            audio.volume = notificationPrefs.sound_volume;
            notificationSoundRef.current = audio;
        } else {
            audio.volume = notificationPrefs.sound_volume;
        }
        audio.currentTime = 0;
        void audio.play().catch(() => {
            // El navegador puede bloquear autoplay sin interacción previa del usuario.
        });
    }, [notificationPrefs]);

    const runServerSearch = useCallback(async (query: string) => {
        if (!query.trim() || !user?.id) {
            setServerSearchResults([]);
            return;
        }
        try {
            const { data, error } = await supabase.rpc("admin_search_conversations", {
                p_query: query.trim(),
                p_limit: 50,
                p_offset: 0,
            });
            if (error) {
                console.warn("Búsqueda server-side falló:", error);
                setServerSearchResults([]);
                return;
            }
            setServerSearchResults(
                (data || []).map((row: Record<string, unknown>) => ({
                    conversation_id: String(row.conversation_id),
                    customer_id: row.customer_id ? String(row.customer_id) : null,
                    customer_name: row.customer_name ? String(row.customer_name) : null,
                    phone_e164: row.phone_e164 ? String(row.phone_e164) : null,
                    last_message_at: row.last_message_at ? String(row.last_message_at) : null,
                    match_type: row.match_type ? String(row.match_type) : null,
                    match_preview: row.match_preview ? String(row.match_preview) : null,
                    conversation_status: row.conversation_status ? String(row.conversation_status) : null,
                })),
            );
        } catch (error) {
            console.warn("Búsqueda server-side interrumpida:", error);
            setServerSearchResults([]);
        }
    }, [user?.id]);

    const fetchInbox = useCallback(async () => {
        if (reviewMode) {
            setSnapshot(INBOX_REVIEW_SNAPSHOT);
            setLoading(false);
            setError(null);
            return;
        }

        const to = new Date();
        const from = new Date(to.getTime() - range * 24 * 60 * 60 * 1000);

        try {
            const { data, error: rpcError } = await supabase.rpc("admin_conversation_inbox_snapshot", {
                p_from: from.toISOString(),
                p_to: to.toISOString(),
                p_timezone: "America/Bogota",
                p_limit: 75,
                p_fulfillment_sla_hours: 24,
            });

            if (rpcError) throw rpcError;

            const typedSnapshot = (data || null) as InboxSnapshot | null;
            const ids = (typedSnapshot?.conversations || []).map((item) => item.conversation_id);
            if (ids.length > 0) {
                const [assignmentResult, stateResult] = await Promise.all([
                    supabase.from("conversation_operator_assignments")
                        .select("conversation_id, status, owner_user_id, claimed_at")
                        .in("conversation_id", ids),
                    supabase.from("conversation_state")
                        .select("conversation_id, handoff_status")
                        .in("conversation_id", ids),
                ]);
                if (assignmentResult.error) console.warn("Operator assignments unavailable in Inbox:", assignmentResult.error);
                if (stateResult.error) console.warn("Conversation handoff status unavailable in Inbox:", stateResult.error);
                const assignments = assignmentResult.data || [];
                const ownerIds = [...new Set(assignments.map((row) => row.owner_user_id).filter(Boolean))] as string[];
                const ownerResult = ownerIds.length
                    ? await supabase.from("admin_users").select("user_id, email").in("user_id", ownerIds)
                    : { data: [], error: null };
                const ownersById = new Map((ownerResult.data || []).map((row) => [row.user_id, row.email]));
                const assignmentByConversation = new Map(assignments.map((row) => [row.conversation_id, row]));
                const stateByConversation = new Map((stateResult.data || []).map((row) => [row.conversation_id, row]));
                const conversations = (typedSnapshot?.conversations || []).map((item) => {
                    const assignment = assignmentByConversation.get(item.conversation_id);
                    const state = stateByConversation.get(item.conversation_id);
                    const status: HumanControl["status"] = assignment?.status === "human" ? "human"
                        : state?.handoff_status === "waiting_human" ? "waiting_human" : "bot";
                    return {
                        ...item,
                        operator_assignment: {
                            status,
                            owner_user_id: assignment?.owner_user_id ?? null,
                            owner_email: assignment?.owner_user_id ? ownersById.get(assignment.owner_user_id) ?? null : null,
                            claimed_at: assignment?.claimed_at ?? null,
                        },
                    };
                });
                const humanCount = conversations.filter((item) =>
                    item.operator_assignment?.status === "human"
                    || item.operator_assignment?.status === "waiting_human"
                    || item.commercial?.handoff_required
                ).length;
                setSnapshot(typedSnapshot ? {
                    ...typedSnapshot,
                    conversations,
                    summary: { ...typedSnapshot.summary, handoff_required_count: humanCount },
                } : null);
            } else {
                setSnapshot(typedSnapshot);
            }

            // Conteo de no leídos por operador (SB-106). Se carga junto con la
            // bandeja para mostrar el badge numérico por conversación.
            if (user?.id) {
                const { data: countsData } = await supabase.rpc("admin_conversation_unread_counts", {
                    p_user_id: user.id,
                });
                const countsMap = new Map((countsData as Array<{ conversation_id: string; unread_count: number }> | []).map((row) => [
                    row.conversation_id,
                    Number(row.unread_count || 0),
                ]));
                setUnreadCounts(countsMap);

                // Respuestas rápidas del operador + globales (SB-108).
                void loadQuickAnswers();

                // Preferencias de notificación y centro de actividad (SB-111).
                void loadNotificationPreferences();
                void loadActivityFeed();

                // Detectar nuevos mensajes para notificación sonora (SB-111).
                const newNeedsReply = typedSnapshot?.summary?.needs_reply_count ?? 0;
                if (
                    previousNeedsReplyRef.current !== null
                    && newNeedsReply > previousNeedsReplyRef.current
                    && notificationPrefs?.notify_new_message
                    && !notificationPrefs?.silent_mode
                    && (!notificationPrefs?.notify_when_in_thread || !selectedId)
                ) {
                    void playNotificationSound();
                }
                previousNeedsReplyRef.current = newNeedsReply;
            }

            // Conteo de no leídos por operador (SB-106). Se carga junto con la
            // bandeja para mostrar el badge numérico por conversación.
            if (user?.id) {
                const { data: countsData } = await supabase.rpc("admin_conversation_unread_counts", {
                    p_user_id: user.id,
                });
                const countsMap = new Map((countsData as Array<{ conversation_id: string; unread_count: number }> | []).map((row) => [
                    row.conversation_id,
                    Number(row.unread_count || 0),
                ]));
                setUnreadCounts(countsMap);

                // Respuestas rápidas del operador + globales (SB-108).
                void loadQuickAnswers();
            }

            setError(null);
        } catch (fetchError) {
            console.error("Error loading conversation inbox snapshot:", fetchError);
            setError("No se pudo cargar el inbox comercial.");
        } finally {
            setLoading(false);
        }
    }, [range, reviewMode]);

    useEffect(() => {
        setLoading(true);
        fetchInbox();
    }, [fetchInbox]);

    useEffect(() => {
        if (!selectedId) {
            setMessages([]);
            setMessagesLoading(false);
            setMessageLoadState({ conversationId: null, status: "idle" });
            return;
        }

        if (reviewMode) {
            setMessages(INBOX_REVIEW_MESSAGES[selectedId] || []);
            setMessagesLoading(false);
            setMessageLoadState({ conversationId: selectedId, status: "loaded" });
            return;
        }

        if (!reviewMode && selectedId) {
            void markConversationRead(selectedId);
        }

        const conversationId = selectedId;
        let cancelled = false;
        setMessages([]);
        setMessagesLoading(true);
        setMessageLoadState({ conversationId, status: "loading" });

        async function fetchMessages(showLoading: boolean) {
            const existingRequest = messagesRequestRef.current;
            if (existingRequest && !existingRequest.controller.signal.aborted) {
                if (existingRequest.conversationId === conversationId) return;
                existingRequest.controller.abort();
            }
            const controller = new AbortController();
            const requestId = ++messagesRequestIdRef.current;
            messagesRequestRef.current = { conversationId, requestId, controller };
            if (showLoading) setMessagesLoading(true);
            try {
                const result = await runInboxMessageRequest(async (signal) => {
                    const { data, error: messagesError } = await supabase
                        .from("messages")
                        .select("id, conversation_id, direction, role, body, created_at, delivery_status, delivery_error")
                        .eq("conversation_id", conversationId)
                        .order("created_at", { ascending: false })
                        .limit(MESSAGE_FETCH_LIMIT)
                        .abortSignal(signal);
                    if (messagesError) throw messagesError;
                    return (data || []) as Message[];
                }, controller, MESSAGE_FETCH_TIMEOUT_MS);

                if (result.status === "aborted" || !isCurrentInboxMessageRequest({
                    conversationId,
                    requestId,
                    selectedConversationId: selectedIdRef.current,
                    currentRequestId: messagesRequestRef.current?.requestId ?? -1,
                    cancelled,
                })) return;
                if (result.status !== "loaded") {
                    console.error("Error loading conversation messages:", result.status === "error" ? result.error : "Request timed out");
                    setMessages([]);
                    setMessageLoadState({ conversationId, status: "error" });
                } else {
                    setMessages([...result.data].reverse());
                    setMessageLoadState({ conversationId, status: "loaded" });
                }
            } finally {
                if (messagesRequestRef.current?.requestId === requestId) {
                    messagesRequestRef.current = null;
                    if (showLoading && !cancelled && selectedIdRef.current === conversationId) setMessagesLoading(false);
                }
            }
        }

        void fetchMessages(true);

        // Polling keeps the operator workstation current even when the project
        // has not enabled Realtime publication for `messages`.
        const refreshTimer = window.setInterval(() => {
            void fetchMessages(false);
        }, 5_000);

        return () => {
            cancelled = true;
            if (messagesRequestRef.current?.conversationId === conversationId) {
                messagesRequestRef.current.controller.abort();
            }
            window.clearInterval(refreshTimer);
        };
    }, [selectedId, reviewMode, markConversationRead]);

    const fetchHumanControl = useCallback(async (conversationId: string) => {
        const requestId = ++humanControlRequestIdRef.current;
        if (reviewMode) {
            if (selectedIdRef.current === conversationId && humanControlRequestIdRef.current === requestId) {
                setHumanControl({ status: "bot" });
                setHumanControlConversationId(conversationId);
            }
            return;
        }
        try {
            const { data, error: invokeError } = await supabase.functions.invoke("admin_conversation_actions", {
                body: { action: "status", conversation_id: conversationId },
            });
            if (humanControlRequestIdRef.current !== requestId || selectedIdRef.current !== conversationId) return;
            if (invokeError || !data?.success) {
                console.error("Could not load human control state:", invokeError || data);
                setHumanControlConversationId(null);
                return;
            }
            setHumanControl(data as HumanControl);
            setHumanControlConversationId(conversationId);
        } catch (fetchError) {
            console.error("Unexpected error loading human control state:", fetchError);
            if (humanControlRequestIdRef.current === requestId && selectedIdRef.current === conversationId) {
                setHumanControlConversationId(null);
            }
        }
    }, [reviewMode]);

    const refreshConversationMessages = useCallback(async (conversationId: string) => {
        if (reviewMode || conversationId !== selectedIdRef.current) return;
        messagesRequestRef.current?.controller.abort();
        const controller = new AbortController();
        const requestId = ++messagesRequestIdRef.current;
        messagesRequestRef.current = { conversationId, requestId, controller };
        setMessagesLoading(true);
        setMessageLoadState({ conversationId, status: "loading" });
        try {
            const result = await runInboxMessageRequest(async (signal) => {
                const { data, error: messagesError } = await supabase
                    .from("messages")
                    .select("id, conversation_id, direction, role, body, created_at, delivery_status, delivery_error")
                    .eq("conversation_id", conversationId)
                    .order("created_at", { ascending: false })
                    .limit(MESSAGE_FETCH_LIMIT)
                    .abortSignal(signal);
                if (messagesError) throw messagesError;
                return (data || []) as Message[];
            }, controller, MESSAGE_FETCH_TIMEOUT_MS);
            if (result.status === "aborted" || !isCurrentInboxMessageRequest({
                conversationId,
                requestId,
                selectedConversationId: selectedIdRef.current,
                currentRequestId: messagesRequestRef.current?.requestId ?? -1,
            })) return;
            if (result.status !== "loaded") {
                console.error("Error refreshing operator messages:", result.status === "error" ? result.error : "Request timed out");
                setMessages([]);
                setMessageLoadState({ conversationId, status: "error" });
                return;
            }
            setMessages([...result.data].reverse());
            setMessageLoadState({ conversationId, status: "loaded" });
        } finally {
            if (messagesRequestRef.current?.requestId === requestId) {
                messagesRequestRef.current = null;
                if (selectedIdRef.current === conversationId) setMessagesLoading(false);
            }
        }
    }, [reviewMode]);

    useEffect(() => {
        if (!selectedId) {
            humanControlRequestIdRef.current += 1;
            setHumanControl({ status: "bot" });
            setHumanControlConversationId(null);
            return;
        }
        void fetchHumanControl(selectedId);
        void loadConversationClosure(selectedId);
        const timer = window.setInterval(() => void fetchHumanControl(selectedId), 8_000);
        return () => window.clearInterval(timer);
    }, [fetchHumanControl, selectedId]);

    const conversations = useMemo(() => snapshot?.conversations || [], [snapshot]);
    const selectedConversation = useMemo(
        () => conversations.find((item) => item.conversation_id === selectedId) || null,
        [conversations, selectedId]
    );
    const humanControlReady = Boolean(selectedId) && humanControlConversationId === selectedId;
    const currentHumanControl = humanControlReady ? humanControl : { status: "bot" as const };
    const currentMessageLoadStatus = messageLoadState.conversationId === selectedId
        ? messageLoadState.status
        : "loading";
    const selectedCustomerId = selectedConversation?.customer_id || null;
    useEffect(() => {
        if (!selectedConversation || !selectedId) {
            setIdentityBridge(null);
            return;
        }

        if (reviewMode) {
            setIdentityBridge(
                selectedId === REVIEW_CONVERSATION_ID
                    ? INBOX_REVIEW_IDENTITY_BRIDGE
                    : null
            );
            return;
        }

        let cancelled = false;

        async function fetchIdentityBridge() {
            const selectColumns = [
                "id",
                "handoff_code",
                "status",
                "storefront_session_id",
                "source_surface",
                "product_brand",
                "product_model",
                "size_requested",
                "intent",
                "funnel_stage",
                "linked_customer_id",
                "linked_conversation_id",
                "linked_message_id",
                "created_at",
                "linked_at",
                "expires_at",
                "metadata",
            ].join(", ");
            const filters = [`linked_conversation_id.eq.${selectedId}`];

            if (selectedCustomerId) {
                filters.push(`linked_customer_id.eq.${selectedCustomerId}`);
            }

            const { data, error: bridgeError } = await supabase
                .from("storefront_handoffs")
                .select(selectColumns)
                .or(filters.join(","))
                .order("linked_at", { ascending: false, nullsFirst: false })
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (cancelled) return;

            if (bridgeError) {
                console.error("Error loading storefront identity bridge:", bridgeError);
                setIdentityBridge(null);
                return;
            }

            setIdentityBridge((data || null) as StorefrontIdentityBridge | null);
        }

        fetchIdentityBridge();

        return () => {
            cancelled = true;
        };
    }, [selectedConversation, selectedCustomerId, selectedId, reviewMode]);

    useEffect(() => {
        if (!selectedId) {
            setActiveContextResolution(null);
            return;
        }

        if (reviewMode) {
            setActiveContextResolution(null);
            return;
        }

        let cancelled = false;

        async function fetchActiveContextResolution() {
            const filters = [`conversation_id.eq.${selectedId}`];

            if (selectedCustomerId) {
                filters.push(`customer_id.eq.${selectedCustomerId}`);
            }

            const { data, error: resolutionError } = await supabase
                .from("conversation_context_resolutions")
                .select([
                    "id",
                    "conversation_id",
                    "customer_id",
                    "source_action_id",
                    "active_context",
                    "status",
                    "resolution_reason",
                    "dispatch_order_id",
                    "dispatch_payment_reference",
                    "dispatch_product_name",
                    "dispatch_size",
                    "storefront_handoff_id",
                    "storefront_handoff_code",
                    "storefront_product_name",
                    "storefront_size",
                    "guardrails",
                    "evidence",
                    "resolved_at",
                    "created_at",
                ].join(", "))
                .eq("status", "active")
                .or(filters.join(","))
                .order("created_at", { ascending: false })
                .limit(1)
                .maybeSingle();

            if (cancelled) return;

            if (resolutionError) {
                console.warn("Active context resolution unavailable:", resolutionError);
                setActiveContextResolution(null);
                return;
            }

            setActiveContextResolution((data || null) as ActiveContextResolution | null);
        }

        fetchActiveContextResolution();

        return () => {
            cancelled = true;
        };
    }, [selectedCustomerId, selectedId, reviewMode]);

    const selectedProductCoherence = useMemo(
        () => (selectedConversation ? getProductThreadCoherence(selectedConversation, messages, identityBridge) : null),
        [selectedConversation, messages, identityBridge]
    );
    const selectedMultiContext = useMemo(
        () => (selectedConversation ? getMultiContextState(selectedConversation, identityBridge) : null),
        [selectedConversation, identityBridge]
    );

    useEffect(() => {
        if (!selectedConversation) {
            setDraftReply("");
            setActionNotice(null);
            setCopyingDraft(false);
            return;
        }

        setDraftReply(buildSuggestedReply(selectedConversation, messages, identityBridge, activeContextResolution));
        setActionNotice(null);
        setCopyingDraft(false);
    }, [selectedConversation, messages, identityBridge, activeContextResolution]);

    useEffect(() => {
        if (!selectedCustomerId) {
            setOperatorNote("");
            setOperatorNoteLoading(false);
            return;
        }

        if (reviewMode) {
            setOperatorNote("Confirmar guía antes de responder. Cliente pagó y espera despacho.");
            setOperatorNoteLoading(false);
            return;
        }

        let cancelled = false;

        async function fetchOperatorNote() {
            setOperatorNoteLoading(true);
            const { data, error: noteError } = await supabase
                .from("customer_profiles")
                .select("operator_notes")
                .eq("customer_id", selectedCustomerId)
                .maybeSingle();

            if (cancelled) return;

            if (noteError) {
                console.error("Error loading operator notes:", noteError);
                setOperatorNote("");
            } else {
                setOperatorNote(data?.operator_notes || "");
            }
            setOperatorNoteLoading(false);
        }

        fetchOperatorNote();

        return () => {
            cancelled = true;
        };
    }, [selectedCustomerId, reviewMode]);

    const filteredConversations = useMemo(() => {
        const normalizedSearch = search.trim().toLowerCase();

        return conversations.filter((item) => {
            const matchesFilter =
                filter === "all" ||
                (filter === "needs_reply" && item.message_activity?.needs_reply) ||
                (filter === "handoff" && (
                    item.commercial?.handoff_required
                    || item.operator_assignment?.status === "human"
                    || item.operator_assignment?.status === "waiting_human"
                )) ||
                (filter === "payment_pending" && item.commercial?.stage === "payment_pending") ||
                (filter === "fulfillment_pending" && item.commercial?.stage === "fulfillment_pending") ||
                (filter === "over_sla" && item.fulfillment?.paid_over_sla) ||
                (filter === "agent_actions" && number(item.agent_actions?.open_count) > 0) ||
                (filter === "mis" && item.operator_assignment?.status === "human"
                    && item.operator_assignment?.owner_user_id === user?.id);

            if (!matchesFilter) return false;
            if (!normalizedSearch) return true;

            const haystack = [
                item.customer_name,
                item.phone_e164,
                item.last_message?.preview,
                item.active_product?.display_name,
                item.order?.payment_reference,
                item.commercial?.stage,
                item.commercial?.intent,
            ]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();

            return haystack.includes(normalizedSearch);
        });
    }, [conversations, filter, search, user?.id]);

    const activeConversations = useMemo(() => {
        const trimmed = search.trim();
        if (!trimmed) return filteredConversations;
        if (serverSearchResults.length === 0) return [];
        return serverSearchResults.map((r) => ({
            conversation_id: r.conversation_id,
            customer_id: r.customer_id,
            customer_name: r.customer_name,
            phone_e164: r.phone_e164,
            conversation_status: r.conversation_status,
            last_message_at: r.last_message_at,
            last_message: r.match_preview
                ? { preview: r.match_preview, created_at: r.last_message_at }
                : undefined,
            commercial: {
                stage: r.conversation_status,
                intent: r.match_type,
                handoff_required: false,
                next_best_action: null,
                priority_score: 0,
            },
            customer_profile: {
                city: null,
                conversation_summary: null,
                has_operator_notes: false,
            },
        } as unknown as InboxConversation));
    }, [filteredConversations, search, serverSearchResults]);

    useEffect(() => {
        if (!activeConversations.length) {
            if (selectedId) setSelectedId(null);
            return;
        }

        const selectedStillVisible = activeConversations.some((item) => item.conversation_id === selectedId);
        if (!selectedStillVisible) {
            setSelectedId(filteredConversations[0].conversation_id);
        }
    }, [filteredConversations, selectedId]);

    useLayoutEffect(() => {
        if (!messagesLoading && messages.length > 0 && messageListRef.current) {
            const frame = window.requestAnimationFrame(() => scrollMessagesToBottom("auto"));
            const timers = [80, 240, 600, 1200].map((delay) =>
                window.setTimeout(() => scrollMessagesToBottom("auto"), delay)
            );

            return () => {
                window.cancelAnimationFrame(frame);
                timers.forEach((timer) => window.clearTimeout(timer));
            };
        }

        return undefined;
    }, [messages, messagesLoading, scrollMessagesToBottom, selectedId]);

    async function createInboxAction(input: InboxActionInput) {
        if (!selectedConversation) return;

        const customerName = selectedConversation.customer_name || selectedConversation.phone_e164 || "cliente";

        setActionNotice(null);

        if (reviewMode) {
            setActionNotice(`Modo revisión: se simularía una acción ${input.actionType} para ${customerName}. No se escribió en Supabase.`);
            return;
        }

        const inputContext = input.inputContext || buildInboxActionContext(
            selectedConversation,
            input.actionType,
            messages,
            identityBridge,
            activeContextResolution
        );
        const proposedPayload = input.proposedPayload || {};
        const contextWarnings = getContextWarningsFromActionContext(inputContext);
        const riskLevel = contextWarnings.length > 0 ? "high" : normalizeRisk(input.riskLevel || selectedConversation.commercial?.risk_level);

        const { data: actionId, error: actionError } = await supabase.rpc("create_agent_action", {
            p_agent_name: "openclaw",
            p_channel: "admin",
            p_action_type: input.actionType,
            p_target_type: "conversation",
            p_target_id: selectedConversation.conversation_id,
            p_target_ref: customerName,
            p_risk_level: riskLevel,
            p_summary: input.summary,
            p_evidence: input.evidence || [
                buildInboxEvidence(selectedConversation, identityBridge),
            ],
            p_input_context: inputContext,
            p_proposed_payload: {
                source: "admin_inbox",
                mode: "suggest_only",
                no_auto_send: true,
                manual_review_required: true,
                context_warnings: contextWarnings,
                ...proposedPayload,
            },
            p_approval_required: true,
            p_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        });

        if (actionError) {
            console.error("Error creating inbox agent action:", actionError);
            setActionNotice("No se pudo crear la acción sugerida.");
            return;
        }

        setActionNotice(`Propuesta creada en AI Ops${actionId ? `: ${String(actionId).slice(0, 8)}...` : "."} Pendiente de revisión; no se ejecutó ni se envió nada.`);
        await fetchInbox();
    }

    async function createSuggestedAction() {
        if (!selectedConversation) return;

        const customerName = selectedConversation.customer_name || selectedConversation.phone_e164 || "cliente";
        const nextBestAction = selectedConversation.commercial?.next_best_action || "review_conversation";
        const coherence = getProductThreadCoherence(selectedConversation, messages, identityBridge);
        const contextWarnings = buildProductContextWarnings(selectedConversation, coherence);

        await createInboxAction({
            actionType: "commercial_follow_up",
            summary: contextWarnings.length === 0
                ? `Preparar siguiente paso para ${customerName}: ${humanizeAction(nextBestAction)}.`
                : `Validar producto/hilo antes de preparar siguiente paso para ${customerName}.`,
            riskLevel: contextWarnings.length === 0 ? undefined : "high",
            proposedPayload: {
                action: "prepare_next_customer_step",
                conversation_id: selectedConversation.conversation_id,
                next_best_action: nextBestAction,
                customer_name: customerName,
                product_name: selectedConversation.active_product?.display_name || "producto sin identificar",
                validation_required: contextWarnings.map((warning) => warning.code),
                product_thread_coherence: coherence,
                active_context_resolution: buildActiveContextResolutionAudit(activeContextResolution),
                constraints: [
                    "no enviar WhatsApp automáticamente",
                    "validar producto, talla, pedido y pago antes de sugerir ejecución",
                    "si el contexto es inferido, pedir confirmación al operador",
                    "si hay incoherencia producto/hilo, confirmar modelo y talla antes de responder",
                ],
            },
        });
    }

    async function createDraftReplyAction() {
        if (!selectedConversation) return;

        const draft = draftReply.trim();
        if (!draft) {
            setActionNotice("Escribe o restaura un borrador antes de crear la acción.");
            return;
        }

        const customerName = selectedConversation.customer_name || selectedConversation.phone_e164 || "cliente";
        const coherence = getProductThreadCoherence(selectedConversation, messages, identityBridge);
        const contextWarnings = buildProductContextWarnings(selectedConversation, coherence);

        await createInboxAction({
            actionType: "draft_customer_reply",
            summary: contextWarnings.length === 0
                ? `Revisar borrador de respuesta para ${customerName}.`
                : `Revisar borrador con alerta producto/hilo para ${customerName}.`,
            riskLevel: contextWarnings.length === 0 ? "medium" : "high",
            proposedPayload: {
                action: "review_customer_reply_draft",
                conversation_id: selectedConversation.conversation_id,
                customer_id: selectedConversation.customer_id,
                customer_name: customerName,
                draft_body: draft,
                delivery_channel: selectedConversation.channel || "whatsapp",
                send_mode: "operator_manual_send",
                validation_required: contextWarnings.map((warning) => warning.code),
                product_thread_coherence: coherence,
                active_context_resolution: buildActiveContextResolutionAudit(activeContextResolution),
                draft_context_source: activeContextResolution
                    ? "conversation_context_resolutions"
                    : "live_inbox_snapshot",
                requires_operator_copy_or_send: true,
                no_auto_send: true,
            },
        });
    }

    async function copyDraftReply() {
        if (!selectedConversation) return;

        const draft = draftReply.trim();
        if (!draft) {
            setActionNotice("No hay borrador para copiar.");
            return;
        }

        const coherence = getProductThreadCoherence(selectedConversation, messages, identityBridge);
        const contextWarnings = buildProductContextWarnings(selectedConversation, coherence);

        setCopyingDraft(true);
        try {
            await copyTextToClipboard(draft);
            setActionNotice(
                contextWarnings.length === 0
                    ? "Borrador copiado. No se envio automaticamente."
                    : "Borrador copiado con alerta de contexto. Valida modelo, talla y pedido antes de enviarlo manualmente."
            );
        } catch {
            const selectedDraft = selectVisibleDraftReply();
            setActionNotice(
                selectedDraft
                    ? "El navegador bloqueó la copia. Dejé el borrador seleccionado para copiar con Ctrl+C."
                    : "No se pudo copiar el borrador. Selecciona el texto manualmente."
            );
        } finally {
            setCopyingDraft(false);
        }
    }

    async function runHumanControlAction(action: "claim" | "release", conversationId?: string) {
        const targetId = conversationId ?? selectedConversation?.conversation_id;
        if (!targetId) return;
        if (reviewMode) {
            setActionNotice("Modo revisión: toma/liberación simulada. No se escribió en Supabase.");
            return;
        }
        setHumanActionBusy(true);
        setActionNotice(null);
        try {
            const { data, error: invokeError } = await supabase.functions.invoke("admin_conversation_actions", {
                body: { action, conversation_id: targetId },
            });
            const result = data as (HumanControl & { success?: boolean; code?: string }) | null;
            if (invokeError || !result?.success) {
                const code = result?.code || await readFunctionErrorCode(invokeError) || "request_failed";
                setActionNotice(humanActionError(code));
                await fetchHumanControl(targetId);
                return;
            }
            if (selectedIdRef.current === targetId) {
                humanControlRequestIdRef.current += 1;
                setHumanControl(result);
                setHumanControlConversationId(targetId);
            }
            setActionNotice(action === "claim"
                ? "Caso tomado. El bot quedó pausado para esta conversación."
                : "Caso devuelto al bot. La próxima respuesta entrante volverá a la atención automática.");
            await Promise.all([fetchHumanControl(targetId), fetchInbox()]);
        } catch (actionError) {
            console.error("Human handoff action failed:", actionError);
            setActionNotice("No se pudo actualizar la toma del caso. Verifica el estado antes de repetir.");
        } finally {
            setHumanActionBusy(false);
        }
    }

    async function sendHumanReply() {
        if (!selectedConversation) return;
        if (!canSendWithLoadedInboxMessages(currentMessageLoadStatus)) {
            setActionNotice(currentMessageLoadStatus === "error"
                ? "No se puede enviar porque no cargó el historial. Reintenta la carga antes de responder."
                : "Espera a que cargue el historial de mensajes antes de responder.");
            return;
        }
        const text = draftReply.trim();
        if (!text) {
            setActionNotice("Escribe una respuesta antes de enviarla.");
            return;
        }
        if (reviewMode) {
            setActionNotice("Modo revisión: el envío se simularía. No se contactó al cliente.");
            return;
        }
        if (!humanControlReady || currentHumanControl.status !== "human" || currentHumanControl.owner_user_id !== user?.id) {
            setActionNotice("Toma esta conversación antes de enviar. El bot debe quedar pausado mientras atiendes.");
            return;
        }

        const coherence = getProductThreadCoherence(selectedConversation, messages, identityBridge);
        const contextWarnings = buildProductContextWarnings(selectedConversation, coherence);
        if (contextWarnings.length > 0 && !window.confirm(
            `Hay alertas de contexto (${contextWarnings.map((item) => item.code).join(", ")}). ¿Revisaste modelo, talla y pedido antes de enviar?`,
        )) return;

        const matchingUnknown = currentHumanControl.uncertain_sends?.find((item) => item.preview === text.slice(0, 120));
        if (matchingUnknown && !window.confirm(
            "El intento anterior tuvo resultado incierto. Verifica primero el chat de WhatsApp para evitar enviar el mismo mensaje dos veces. ¿Confirmas que deseas crear un nuevo intento?",
        )) return;

        setSendBusy(true);
        setActionNotice(null);
        const clientSendId = crypto.randomUUID();
        try {
            const { data, error: invokeError } = await supabase.functions.invoke("admin_conversation_actions", {
                body: {
                    action: "send_message",
                    conversation_id: selectedConversation.conversation_id,
                    client_send_id: clientSendId,
                    content: text,
                },
            });

            if (invokeError || !data?.success) {
                console.error("Operator message send failed:", invokeError || data);
                const code = data?.code || await readFunctionErrorCode(invokeError);
                setActionNotice(code
                    ? humanActionError(code)
                    : "No recibimos confirmación del servicio. Comprueba el estado del mensaje antes de intentar de nuevo.");
            } else if (data.delivery_status === "accepted") {
                setActionNotice("WhatsApp aceptó el mensaje. La entrega final puede tardar unos segundos.");
                setDraftReply("");
            } else if (data.delivery_status === "failed") {
                setActionNotice(`WhatsApp rechazó el envío. No se entregó; corrige el problema y vuelve a intentar. ${data.error || ""}`);
            } else if (data.delivery_status === "unknown") {
                setActionNotice("Resultado incierto: el proveedor pudo recibirlo. Revisa WhatsApp antes de crear otro intento.");
            } else {
                setActionNotice("El mensaje quedó en proceso. No lo envíes otra vez mientras se resuelve.");
            }
        } catch (sendError) {
            console.error("Operator message request interrupted:", sendError);
            setActionNotice("Se interrumpió la confirmación. El mensaje pudo haber salido; revisa el chat y el estado antes de reenviar.");
        } finally {
            await Promise.all([
                fetchHumanControl(selectedConversation.conversation_id),
                refreshConversationMessages(selectedConversation.conversation_id),
                fetchInbox(),
            ]);
            setSendBusy(false);
        }
    }

    async function createActiveContextDecisionAction(focus: ActiveContextFocus) {
        if (!selectedConversation) return;

        const multiContext = getMultiContextState(selectedConversation, identityBridge);
        const customerName = selectedConversation.customer_name || selectedConversation.phone_e164 || "cliente";

        if (!multiContext) {
            setActionNotice("No hay dos contextos activos para resolver en esta conversación.");
            return;
        }

        const focusLabel =
            focus === "dispatch_pending_order"
                ? "despacho/pedido operativo pendiente"
                : "nueva compra iniciada desde la web";
        const inputContext = buildInboxActionContext(
            selectedConversation,
            "resolve_active_context",
            messages,
            identityBridge,
            activeContextResolution
        );

        await createInboxAction({
            actionType: "resolve_active_context",
            summary: `Definir contexto activo para ${customerName}: priorizar ${focusLabel}.`,
            riskLevel: "high",
            inputContext: {
                ...inputContext,
                active_context_decision: {
                    selected_context: focus,
                    dispatch_context: {
                        order_id: selectedConversation.order?.order_id,
                        payment_reference: selectedConversation.order?.payment_reference,
                        product_name: multiContext.orderProductName,
                        size: multiContext.orderSize,
                        payment_status: selectedConversation.payment?.status || selectedConversation.order?.status,
                        fulfillment_status: selectedConversation.fulfillment?.status,
                        paid_over_sla: selectedConversation.fulfillment?.paid_over_sla,
                    },
                    storefront_context: {
                        handoff_code: identityBridge?.handoff_code,
                        product_name: multiContext.bridgeProductName,
                        size: multiContext.bridgeSize,
                        funnel_stage: identityBridge?.funnel_stage,
                        intent: identityBridge?.intent,
                    },
                    decision_guardrail:
                        "Esta accion fija una prioridad de atencion sugerida; no ejecuta despacho, cobro, reserva ni envio de WhatsApp.",
                },
            },
            proposedPayload: {
                action:
                    focus === "dispatch_pending_order"
                        ? "prioritize_dispatch_context"
                        : "prioritize_storefront_purchase_context",
                selected_context: focus,
                conversation_id: selectedConversation.conversation_id,
                customer_id: selectedConversation.customer_id,
                customer_name: customerName,
                dispatch_product_name: multiContext.orderProductName,
                dispatch_size: multiContext.orderSize,
                storefront_product_name: multiContext.bridgeProductName,
                storefront_size: multiContext.bridgeSize,
                handoff_code: identityBridge?.handoff_code,
                requires_operator_confirmation: true,
                no_auto_send: true,
                no_stock_mutation: true,
                no_payment_or_dispatch_execution: true,
                next_operator_step:
                    focus === "dispatch_pending_order"
                        ? "responder primero sobre estado de despacho y mantener separada la nueva compra web"
                        : "confirmar primero la nueva compra web y mantener separado el pedido pendiente",
            },
        });
    }

    async function saveOperatorNote() {
        if (!selectedConversation?.customer_id) {
            setActionNotice("No hay cliente vinculado para guardar nota.");
            return;
        }

        if (reviewMode) {
            setActionNotice("Modo revisión: nota simulada. No se escribió en Supabase.");
            return;
        }

        setSavingNote(true);
        const { error: noteError } = await supabase.from("customer_profiles").upsert(
            {
                customer_id: selectedConversation.customer_id,
                operator_notes: operatorNote.trim() || null,
                profile_source: "manual",
            },
            { onConflict: "customer_id" }
        );

        setSavingNote(false);

        if (noteError) {
            console.error("Error saving operator note:", noteError);
            setActionNotice("No se pudo guardar la nota interna.");
            return;
        }

        setActionNotice("Nota interna guardada.");
        await fetchInbox();
    }

    const summary = snapshot?.summary || {};

    return (
        <div className="flex min-h-[calc(100vh-3rem)] flex-col gap-3 xl:h-[calc(100vh_-_3rem)] xl:overflow-hidden">
            <header className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div>
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-cyan-700">
                        <InboxIcon className="h-4 w-4" />
                        Inbox Comercial
                    </div>
                    <h1 className="mt-0.5 text-2xl font-bold text-slate-950 xl:text-[1.65rem]">Conversaciones</h1>
                    <p className="mt-0.5 text-sm text-slate-500">
                        {formatDateTime(snapshot?.generated_at)} · {range} días · modo {formatAgentMode(snapshot?.agent_context?.mode)}
                    </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    {[7, 14, 30].map((option) => (
                        <button
                            key={option}
                            type="button"
                            onClick={() => setRange(option)}
                            className={cn(
                                "rounded-md border px-3 py-2 text-sm font-semibold transition-colors xl:px-2.5 xl:py-1.5",
                                range === option
                                    ? "border-slate-950 bg-slate-950 text-white"
                                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300"
                            )}
                        >
                            {option}d
                        </button>
                    ))}
                    <button
                        type="button"
                        onClick={fetchInbox}
                        className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:border-slate-300 xl:px-2.5 xl:py-1.5"
                    >
                        <RefreshCw className="h-4 w-4" />
                        Actualizar
                    </button>
                </div>
            </header>

            <section className="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-6">
                <MetricCard label="Abiertas" value={number(summary.open_count)} />
                <MetricCard label="Responder" value={number(summary.needs_reply_count)} tone="cyan" />
                <MetricCard label="Humanas" value={number(summary.handoff_required_count)} tone="amber" />
                <MetricCard label="Pago" value={number(summary.payment_pending_count)} />
                <MetricCard label="Despacho" value={number(summary.paid_pending_dispatch_count)} tone="red" />
                <MetricCard label="AI Ops" value={number(summary.open_agent_actions_count)} tone="indigo" />
            </section>

            {error && (
                <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
                    {error}
                </div>
            )}

            <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(210px,0.78fr)_minmax(300px,1.4fr)_minmax(210px,0.82fr)] 2xl:grid-cols-[minmax(260px,320px)_minmax(0,1fr)_minmax(300px,360px)]">
                <aside className="flex min-h-[420px] min-w-0 flex-col rounded-lg border border-slate-200 bg-white xl:min-h-0">
                    <div className="border-b border-slate-100 p-3 xl:p-2.5">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                            <input
                                value={search}
                                onChange={(event) => {
                                    const value = event.target.value;
                                    setSearch(value);
                                    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                                    searchDebounceRef.current = setTimeout(() => {
                                        void runServerSearch(value);
                                    }, 300);
                                }}
                                placeholder="Buscar cliente, producto, orden"
                                className="w-full rounded-md border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm outline-none focus:border-cyan-400 focus:bg-white xl:py-1.5"
                            />
                        </div>
                        <div className="scrollbar-none mt-3 flex items-center gap-2 overflow-x-auto pb-1">
                            <Filter className="h-4 w-4 shrink-0 text-slate-400" />
                            {FILTERS.map((item) => (
                                <button
                                    key={item.key}
                                    type="button"
                                    onClick={() => setFilter(item.key)}
                                    className={cn(
                                        "shrink-0 rounded-full px-3 py-1 text-xs font-semibold",
                                        filter === item.key
                                            ? "bg-slate-950 text-white"
                                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                                    )}
                                >
                                    {item.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
                        {loading ? (
                            <EmptyState text="Cargando conversaciones..." />
                        ) : activeConversations.length === 0 ? (
                            <EmptyState text={emptyFilterText(filter, search)} />
                        ) : (
                            activeConversations.map((item) => {
                                const unread = unreadCounts.get(item.conversation_id) || 0;
                                return (
                                    <button
                                        key={item.conversation_id}
                                    type="button"
                                    onClick={() => setSelectedId(item.conversation_id)}
                                    className={cn(
                                        "w-full border-b border-slate-100 p-4 text-left transition-colors hover:bg-slate-50 xl:p-3",
                                        selectedId === item.conversation_id && "bg-cyan-50/70"
                                    )}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold text-slate-950">
                                                {item.customer_name || item.phone_e164 || "Cliente sin nombre"}
                                            </p>
                                            <p className="truncate text-xs text-slate-500">{item.phone_e164 || item.channel || "-"}</p>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <RiskBadge risk={item.commercial?.risk_level} />
                                            {item.operator_assignment?.status !== "human" && (
                                                <button
                                                    type="button"
                                                    onClick={(event) => {
                                                        event.stopPropagation();
                                                        void runHumanControlAction("claim", item.conversation_id);
                                                    }}
                                                    className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none"
                                                >
                                                    Tomar
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                    <p className="mt-2 line-clamp-2 text-sm text-slate-600">
                                        {item.last_message?.preview || "Sin mensajes recientes."}
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        <StageBadge stage={item.commercial?.stage} />
                                        {item.message_activity?.needs_reply && <MiniBadge tone="cyan">responder</MiniBadge>}
                                        {unread > 0 && <MiniBadge tone="red">{unread} sin leer</MiniBadge>}
                                        {item.operator_assignment?.status === "human" ? (
                                            <MiniBadge tone="green">con {item.operator_assignment.owner_email || "operador"}</MiniBadge>
                                        ) : (item.commercial?.handoff_required || item.operator_assignment?.status === "waiting_human") && (
                                            <MiniBadge tone="amber">espera humano</MiniBadge>
                                        )}
                                        {selectedId === item.conversation_id && activeContextResolution ? (
                                            <MiniBadge tone="green">contexto fijado</MiniBadge>
                                        ) : selectedId === item.conversation_id && selectedMultiContext ? (
                                            <MiniBadge tone="amber">2 contextos</MiniBadge>
                                        ) : null}
                                        {item.fulfillment?.paid_over_sla && <MiniBadge tone="red">+24h</MiniBadge>}
                                    </div>
                                </button>
                                );
                            })
                        )}
                        {activityFeed.length > 0 && (
                            <div className="border-t border-slate-100 p-3 mt-3">
                                <div className="flex items-center gap-2 mb-2">
                                    <Clock className="h-4 w-4 text-slate-500" />
                                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actividad reciente</h3>
                                </div>
                                <div className="space-y-1 max-h-48 overflow-y-auto">
                                    {activityFeed.map((activity) => (
                                        <div key={activity.id} className="flex items-start gap-2 text-xs">
                                            <div className="mt-1.5 h-2 w-2 rounded-full {activity.event_type === 'new_message' ? 'bg-cyan-500' : 'bg-slate-400'}"></div>
                                            <div className="min-w-0">
                                                <p className="text-slate-800 leading-tight">{activity.match_preview || activity.event_type}</p>
                                                <p className="text-[10px] text-slate-400">{formatDateTime(activity.created_at)}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </aside>

                <main className="flex h-[calc(100vh_-_10rem)] min-h-[640px] max-h-[780px] min-w-0 flex-col overflow-hidden rounded-lg border border-slate-200 bg-white xl:h-auto xl:min-h-0 xl:max-h-none">
                    {selectedConversation ? (
                        <>
                            <div className="border-b border-slate-100 p-4 xl:p-3">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                                    <div>
                                        <h2 className="text-xl font-bold text-slate-950 xl:text-lg">
                                            {selectedConversation.customer_name || selectedConversation.phone_e164 || "Cliente"}
                                        </h2>
                                        <p className="mt-0.5 text-sm text-slate-500">
                                            {selectedConversation.channel || "canal"} · {formatDateTime(selectedConversation.last_message_at)}
                                        </p>
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        <StageBadge stage={selectedConversation.commercial?.stage} />
                                        <RiskBadge risk={selectedConversation.commercial?.risk_level} />
                                        {!humanControlReady ? (
                                            <MiniBadge tone="amber">verificando toma</MiniBadge>
                                        ) : currentHumanControl.status === "human" ? (
                                            <MiniBadge tone="green">humano · bot pausado</MiniBadge>
                                        ) : currentHumanControl.status === "waiting_human" ? (
                                            <MiniBadge tone="amber">espera operador</MiniBadge>
                                        ) : null}
                                        {activeContextResolution ? (
                                            <MiniBadge tone="green">
                                                contexto fijado · {activeContextLabel(activeContextResolution.active_context)}
                                            </MiniBadge>
                                        ) : selectedMultiContext && (
                                            <MiniBadge tone="amber">2 contextos activos</MiniBadge>
                                        )}
                                    </div>
                                </div>
                            </div>

                            <DecisionStrip
                                item={selectedConversation}
                                identityBridge={identityBridge}
                                activeContextResolution={activeContextResolution}
                                messageCount={messages.length}
                                onJumpToLatest={() => scrollMessagesToBottom("smooth")}
                            />

                            <div
                                ref={messageListRef}
                                data-testid="inbox-message-list"
                                className="min-h-0 flex-1 space-y-4 overflow-x-hidden overflow-y-auto bg-slate-50 p-4 xl:p-3"
                            >
                                {currentMessageLoadStatus === "error" ? (
                                    <div role="alert" className="m-auto max-w-sm rounded-md border border-rose-200 bg-white p-4 text-center text-sm text-rose-800">
                                        <p>No se pudo cargar el historial. El envío está bloqueado para evitar responder sin contexto.</p>
                                        <button
                                            type="button"
                                            onClick={() => void refreshConversationMessages(selectedConversation.conversation_id)}
                                            disabled={messagesLoading}
                                            className="mt-3 rounded-md bg-rose-700 px-3 py-2 font-semibold text-white hover:bg-rose-800 disabled:opacity-50"
                                        >
                                            Reintentar carga
                                        </button>
                                    </div>
                                ) : currentMessageLoadStatus !== "loaded" || messagesLoading ? (
                                    <div role="status" aria-live="polite">
                                        <EmptyState text="Cargando mensajes..." />
                                    </div>
                                ) : messages.length === 0 ? (
                                    <ConversationFallback item={selectedConversation} />
                                ) : (
                                    <div className="space-y-4">
                                        {messages.map((message) => <MessageBubble key={message.id} message={message} />)}
                                        <div ref={messageEndRef} aria-hidden="true" className="h-px" />
                                    </div>
                                )}
                            </div>
                        </>
                    ) : (
                        <EmptyState text="Selecciona una conversación." />
                    )}
                </main>

                <aside className="min-h-[360px] max-h-[780px] min-w-0 overflow-x-hidden overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 xl:min-h-0 xl:max-h-none xl:p-3">
                    {selectedConversation ? (
                            <ContextPanel
                                item={selectedConversation}
                                messages={messages}
                                humanControl={currentHumanControl}
                                humanControlReady={humanControlReady}
                                currentUserId={user?.id || null}
                                humanActionBusy={humanActionBusy}
                                sendBusy={sendBusy}
                                messagesReady={canSendWithLoadedInboxMessages(currentMessageLoadStatus)}
                                identityBridge={identityBridge}
                                multiContext={selectedMultiContext}
                                activeContextResolution={activeContextResolution}
                                draftReply={draftReply}
                            productCoherence={selectedProductCoherence || getProductThreadCoherence(selectedConversation, messages, identityBridge)}
                            operatorNote={operatorNote}
                            operatorNoteLoading={operatorNoteLoading}
                            savingNote={savingNote}
                            copyingDraft={copyingDraft}
                            actionNotice={actionNotice}
                            onDraftReplyChange={setDraftReply}
                            onOperatorNoteChange={setOperatorNote}
                            onResetDraft={() => setDraftReply(buildSuggestedReply(
                                selectedConversation,
                                messages,
                                identityBridge,
                                activeContextResolution
                            ))}
                            onCopyDraftReply={copyDraftReply}
                            onCreateSuggestedAction={createSuggestedAction}
                            onCreateDraftReplyAction={createDraftReplyAction}
                            onHumanControlAction={runHumanControlAction}
                            onSendHumanReply={sendHumanReply}
                            onCreateActiveContextDecisionAction={createActiveContextDecisionAction}
                            onSaveOperatorNote={saveOperatorNote}
                            quickAnswers={quickAnswers}
                            conversationClosure={conversationClosure}
                            onCloseConversation={closeConversation}
                            onReopenConversation={reopenConversation}
                        />
                    ) : (
                        <EmptyState text="Sin contexto." />
                    )}
                </aside>
            </div>
        </div>
    );
}

function DecisionStrip({
    item,
    identityBridge,
    activeContextResolution,
    messageCount,
    onJumpToLatest,
}: {
    item: InboxConversation;
    identityBridge?: StorefrontIdentityBridge | null;
    activeContextResolution?: ActiveContextResolution | null;
    messageCount: number;
    onJumpToLatest: () => void;
}) {
    const product = item.active_product;
    const order = item.order;
    const fulfillment = item.fulfillment;
    const multiContext = getMultiContextState(item, identityBridge);
    const productName = product?.display_name || "Producto sin confirmar";
    const productMeta = buildProductMeta(item);
    const paymentStatus = item.payment?.status || order?.status || item.commercial?.stage;
    const paymentMeta = (order?.total_cents == null ? [] : [
        order.payment_reference || null,
        formatCents(order.total_cents),
        order.paid_at ? `Pago ${formatDateTime(order.paid_at)}` : null,
    ])
        .filter((value) => value && value !== "-")
        .join(" · ");
    const logisticsValue = fulfillment?.paid_over_sla
        ? "Despacho atrasado"
        : fulfillment?.status
          ? humanizeStage(fulfillment.status)
          : item.commercial?.stage === "fulfillment_pending"
            ? "Por despachar"
            : "Sin envío activo";
    const logisticsMeta = [
        fulfillment?.carrier_name || null,
        fulfillment?.tracking_number ? `Guía ${fulfillment.tracking_number}` : null,
        fulfillment?.shipped_at ? `Salida ${formatDateTime(fulfillment.shipped_at)}` : null,
    ]
        .filter(Boolean)
        .join(" · ");
    const bridgeMeta = identityBridge
        ? [
            identityBridge.handoff_code,
            storefrontObservedProductLabel(identityBridge),
            identityBridge.size_requested ? `Talla ${identityBridge.size_requested}` : null,
        ]
            .filter(Boolean)
            .join(" · ")
        : "Sin código WEB-* enlazado";

    return (
        <div className="scrollbar-none flex min-h-[88px] overflow-x-auto border-b border-slate-100 bg-white">
            <DecisionFact
                label={getProductDecisionLabel(item, identityBridge)}
                value={productName}
                meta={product?.context_warning || productMeta || getProductContextHint(product)}
                tone={multiContext ? "amber" : product?.context_warning ? "red" : product?.display_name ? "cyan" : "amber"}
            />
            {multiContext && (
                <DecisionFact
                    label={activeContextResolution ? "Contexto fijado" : "Contexto"}
                    value={
                        activeContextResolution
                            ? activeContextLabel(activeContextResolution.active_context)
                            : "2 líneas activas"
                    }
                    meta={
                        activeContextResolution
                            ? activeContextResolution.resolution_reason || `Decisión auditada ${formatDateTime(activeContextResolution.resolved_at)}`
                            : "Pedido operativo pendiente y compra web reciente del mismo WhatsApp."
                    }
                    tone={activeContextResolution ? "green" : "amber"}
                />
            )}
            <DecisionFact
                label="Pedido/Pago"
                value={humanizeStage(paymentStatus)}
                meta={paymentMeta || getOrderContextHint(order)}
                tone={paymentStatus === "paid" || paymentStatus === "approved" ? "green" : "slate"}
            />
            <DecisionFact
                label="Logística"
                value={logisticsValue}
                meta={logisticsMeta || (fulfillment?.paid_over_sla ? "Supera SLA de 24h" : "Sin alerta logística activa")}
                tone={fulfillment?.paid_over_sla ? "red" : "slate"}
            />
            <DecisionFact
                label="Puente web"
                value={identityBridge ? humanizeStage(identityBridge.status) : "Sin evidencia"}
                meta={bridgeMeta}
                tone={identityBridge?.status === "linked" ? "green" : identityBridge ? "amber" : "slate"}
            />
            <div className="flex min-w-[132px] items-center justify-center border-l border-slate-100 px-3 py-2">
                <button
                    type="button"
                    onClick={onJumpToLatest}
                    className="inline-flex shrink-0 items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                >
                    <ArrowDownToLine className="h-4 w-4" />
                    Últimos ({messageCount || 0})
                </button>
            </div>
        </div>
    );
}

function DecisionFact({
    label,
    value,
    meta,
    tone = "slate",
}: {
    label: string;
    value?: string | number | null;
    meta?: string | null;
    tone?: "slate" | "cyan" | "amber" | "red" | "green";
}) {
    return (
        <div className="min-w-[180px] flex-1 border-l border-slate-100 px-3 py-2 first:border-l-0">
            <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</p>
            <p className={cn("mt-1 truncate text-sm font-bold", decisionToneClass(tone))}>{value || "-"}</p>
            <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-slate-500 2xl:line-clamp-2">{meta || "-"}</p>
        </div>
    );
}

function OperatorPanel({
    item,
    messages,
    humanControl,
    humanControlReady,
    currentUserId,
    humanActionBusy,
    sendBusy,
    messagesReady,
    draftReply,
    productCoherence,
    multiContext,
    activeContextResolution,
    operatorNote,
    operatorNoteLoading,
    savingNote,
    copyingDraft,
    actionNotice,
    onDraftReplyChange,
    onOperatorNoteChange,
    onResetDraft,
    onCopyDraftReply,
    onCreateSuggestedAction,
    onCreateDraftReplyAction,
    onHumanControlAction,
    onSendHumanReply,
    onCreateActiveContextDecisionAction,
    onSaveOperatorNote,
    quickAnswers,
    conversationClosure,
    onCloseConversation,
    onReopenConversation,
}: {
    item: InboxConversation;
    messages: Message[];
    humanControl: HumanControl;
    humanControlReady: boolean;
    currentUserId: string | null;
    humanActionBusy: boolean;
    sendBusy: boolean;
    messagesReady: boolean;
    draftReply: string;
    productCoherence: ProductThreadCoherence;
    multiContext?: MultiContextState | null;
    activeContextResolution?: ActiveContextResolution | null;
    operatorNote: string;
    operatorNoteLoading: boolean;
    savingNote: boolean;
    copyingDraft: boolean;
    actionNotice?: string | null;
    onDraftReplyChange: (value: string) => void;
    onOperatorNoteChange: (value: string) => void;
    onResetDraft: () => void;
    onCopyDraftReply: () => void;
    onCreateSuggestedAction: () => void;
    onCreateDraftReplyAction: () => void;
    onHumanControlAction: (action: "claim" | "release") => void;
    onSendHumanReply: () => void;
    onCreateActiveContextDecisionAction: (focus: ActiveContextFocus) => void;
    onSaveOperatorNote: () => void;
    quickAnswers: QuickAnswer[];
    conversationClosure: ConversationClosure | null;
    onCloseConversation: (conversationId: string, reason: string) => void;
    onReopenConversation: (conversationId: string, reason?: string) => void;
}) {
    const assignment = getAssignmentState(item, operatorNote, humanControl);
    const timeline = buildHumanTimeline(item, messages, operatorNote, humanControl.events || []);
    const isCurrentOwner = humanControlReady && humanControl.status === "human" && humanControl.owner_user_id === currentUserId;
    const isOwnedByOther = humanControlReady && humanControl.status === "human" && !isCurrentOwner;
    const hasUncertainSend = (humanControl.uncertain_sends || []).some((message) =>
        message.preview === draftReply.trim().slice(0, 120)
    );
    const hasFixedActiveContext = Boolean(activeContextResolution);
    const needsContextResolution = Boolean(multiContext && !activeContextResolution);
    const attentionTone = multiContext ? "amber" : "red";
    const attentionTitle = multiContext ? "Dos líneas activas" : "Producto/hilo por validar";
    const attentionMessage = multiContext?.operatorGuidance || productCoherence.reason;

    const [quickMenuOpen, setQuickMenuOpen] = useState(false);
    const draftRef = useRef<HTMLTextAreaElement | null>(null);

    const resolveQuickAnswerVariables = (body: string): string => {
        const total = item.order?.total_cents != null
            ? (item.order.total_cents / 100).toLocaleString("es-CO", {
                  style: "currency",
                  currency: "COP",
              })
            : "-";
        return body
            .replace(/\{cliente\}/gi, item.customer_name || "cliente")
            .replace(/\{producto\}/gi, item.active_product?.display_name || "producto")
            .replace(/\{talla\}/gi, String(item.active_product?.size ?? "-"))
            .replace(/\{pedido\}/gi, item.order?.order_id || "-")
            .replace(/\{total\}/gi, total);
    };

    const insertQuickAnswer = (body: string) => {
        const resolved = resolveQuickAnswerVariables(body);
        const textarea = draftRef.current;
        if (!textarea) return;
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        const value = textarea.value;
        const next = value.slice(0, start) + resolved + value.slice(end);
        textarea.value = next;
        textarea.selectionStart = textarea.selectionEnd = start + resolved.length;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
        onDraftReplyChange(next);
        setQuickMenuOpen(false);
    };

    return (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 px-3 py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                        <ClipboardList className="h-4 w-4 shrink-0 text-indigo-600" />
                        <h3 className="truncate text-sm font-bold text-slate-950">Mesa humana</h3>
                    </div>
                    <MiniBadge tone={hasFixedActiveContext ? "green" : multiContext ? "amber" : "indigo"}>
                        {hasFixedActiveContext ? "contexto fijado" : multiContext ? "2 contextos" : "modo seguro"}
                    </MiniBadge>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                    Prepara respuesta, toma del caso o nota interna. Envío manual.
                </p>
            </div>

            <div className="space-y-3 p-3">
                <div className={cn(
                    "rounded-md border px-3 py-2.5",
                    !humanControlReady
                        ? "border-amber-200 bg-amber-50 text-amber-950"
                        : humanControl.status === "human"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-950"
                        : humanControl.status === "waiting_human"
                            ? "border-amber-200 bg-amber-50 text-amber-950"
                            : "border-slate-200 bg-slate-50 text-slate-800"
                )}>
                    <div className="flex items-start gap-2">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                        <div className="min-w-0">
                            <p className="text-xs font-bold">
                                {!humanControlReady
                                    ? "Verificando estado de atención…"
                                    : humanControl.status === "human"
                                    ? isCurrentOwner ? "La atiendes tú · bot pausado" : `Atención humana · ${humanControl.owner_email || "otro operador"}`
                                    : humanControl.status === "waiting_human" ? "El cliente espera atención humana" : "Bot activo · sin operador asignado"}
                            </p>
                            <p className="mt-1 text-[11px] leading-relaxed opacity-80">
                                {!humanControlReady
                                    ? "No tomes ni respondas el caso hasta confirmar el estado actual."
                                    : humanControl.status === "human"
                                    ? `Tomado ${humanControl.claimed_at ? formatDateTime(humanControl.claimed_at) : "ahora"}. El bot no responderá hasta devolver el caso.`
                                    : "Toma el caso para pausar al bot. Las respuestas manuales de este puesto salen por Evolution."}
                            </p>
                        </div>
                    </div>
                </div>

                {(humanControl.pending_sends?.length || 0) > 0 && (
                    <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs text-cyan-950">
                        <p className="font-bold">Un envío sigue en proceso</p>
                        <p className="mt-1">No lo repitas todavía. El estado se actualiza automáticamente.</p>
                    </div>
                )}
                {(humanControl.uncertain_sends?.length || 0) > 0 && (
                    <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
                        <p className="font-bold">Verifica WhatsApp antes de reenviar</p>
                        <p className="mt-1">Hay {humanControl.uncertain_sends?.length} intento(s) cuyo resultado el proveedor no confirmó. No se reintentan automáticamente.</p>
                    </div>
                )}

                {activeContextResolution && (
                    <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-relaxed text-emerald-900">
                        <div className="flex items-start gap-2">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                            <div>
                                <p className="font-bold">
                                    Contexto activo fijado: {activeContextLabel(activeContextResolution.active_context)}
                                </p>
                                <p className="mt-1">
                                    {activeContextResolution.resolution_reason ||
                                        `Decisión registrada ${formatDateTime(activeContextResolution.resolved_at)}.`}
                                </p>
                            </div>
                        </div>
                    </div>
                )}

                {(!productCoherence.ok || needsContextResolution) && (
                    <div
                        className={cn(
                            "rounded-md border px-3 py-2 text-xs leading-relaxed",
                            attentionTone === "amber"
                                ? "border-amber-200 bg-amber-50 text-amber-900"
                                : "border-red-200 bg-red-50 text-red-800"
                        )}
                    >
                        <div className="flex items-start gap-2">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <div>
                                <p className="font-bold">{attentionTitle}</p>
                                <p className="mt-1">{attentionMessage}</p>
                            </div>
                        </div>
                    </div>
                )}

                {multiContext && (
                    <div className={cn(
                        "rounded-md border p-3",
                        activeContextResolution ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"
                    )}>
                        <div className="flex items-start gap-2">
                            <ClipboardList className={cn(
                                "mt-0.5 h-4 w-4 shrink-0",
                                activeContextResolution ? "text-emerald-700" : "text-amber-700"
                            )} />
                            <div className="min-w-0">
                                <p className={cn(
                                    "text-xs font-bold uppercase tracking-wide",
                                    activeContextResolution ? "text-emerald-800" : "text-amber-800"
                                )}>
                                    {activeContextResolution ? "Cambiar contexto activo" : "Resolver contexto activo"}
                                </p>
                                <p className={cn(
                                    "mt-1 text-xs leading-relaxed",
                                    activeContextResolution ? "text-emerald-900" : "text-amber-900"
                                )}>
                                    {activeContextResolution
                                        ? "Si el foco operativo cambia, crea una nueva acción auditada para reemplazar esta decisión."
                                        : "Crea una acción auditada en AI Ops. No envía mensajes ni ejecuta cambios."}
                                </p>
                            </div>
                        </div>
                        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                            <button
                                type="button"
                                onClick={() => onCreateActiveContextDecisionAction("dispatch_pending_order")}
                                className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100"
                            >
                                <Truck className="h-4 w-4" />
                                Priorizar despacho
                            </button>
                            <button
                                type="button"
                                onClick={() => onCreateActiveContextDecisionAction("new_storefront_purchase")}
                                className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-300 bg-white px-3 py-2 text-xs font-bold text-amber-900 hover:bg-amber-100"
                            >
                                <ShoppingBag className="h-4 w-4" />
                                Priorizar compra web
                            </button>
                        </div>
                    </div>
                )}

                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <button
                        type="button"
                        onClick={() => onHumanControlAction(isCurrentOwner ? "release" : "claim")}
                        disabled={!humanControlReady || humanActionBusy || sendBusy || isOwnedByOther}
                        className={cn(
                            "inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-55",
                            isCurrentOwner
                                ? "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                                : "border-emerald-300 bg-emerald-50 text-emerald-900 hover:bg-emerald-100"
                        )}
                    >
                        {isCurrentOwner ? <Bot className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                        {humanActionBusy
                            ? "Actualizando toma…"
                            : isCurrentOwner
                                ? "Devolver al bot"
                                : isOwnedByOther
                                    ? `En atención · ${humanControl.owner_email || "operador"}`
                                    : "Tomar conversación"}
                    </button>
                    <button
                        type="button"
                        onClick={onCreateSuggestedAction}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs font-bold text-indigo-700 hover:bg-indigo-100"
                    >
                        <Bot className="h-4 w-4" />
                        Seguimiento AI
                    </button>
                    <button
                        type="button"
                        onClick={onResetDraft}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 sm:col-span-2 xl:col-span-1 2xl:col-span-2"
                    >
                        <RotateCcw className="h-4 w-4" />
                        Restaurar borrador
                    </button>
                </div>

                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 mt-3">
                    {conversationClosure ? (
                        <>
                            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-950 sm:col-span-2">
                                <p className="font-bold">Cerrada · {conversationClosure.close_reason}</p>
                                <p className="mt-1">
                                    Cerró {conversationClosure.closed_by || "operador"} ·
                                    {formatDateTime(conversationClosure.closed_at)}
                                    {conversationClosure.reopened_at && (
                                        <>
                                            {" · "}
                                            Reabrió {conversationClosure.reopened_by || "operador"} ·
                                            {formatDateTime(conversationClosure.reopened_at)}
                                        </>
                                    )}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    const reason = window.prompt("Motivo de la reapertura (opcional):", "");
                                    if (reason !== null) {
                                        void onReopenConversation(item.conversation_id, reason.trim() || undefined);
                                    }
                                }}
                                disabled={humanActionBusy || sendBusy}
                                className="inline-flex items-center justify-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-900 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-55 sm:col-span-2 xl:col-span-1 2xl:col-span-2"
                            >
                                <RotateCcw className="h-4 w-4" />
                                Reabrir conversación
                            </button>
                        </>
                    ) : (
                        <button
                            type="button"
                            onClick={() => {
                                const reason = window.prompt("Motivo del cierre (obligatorio):", "");
                                if (reason === null || !reason.trim()) {
                                    return;
                                }
                                void onCloseConversation(item.conversation_id, reason.trim());
                            }}
                            disabled={humanActionBusy || sendBusy}
                            className="inline-flex items-center justify-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs font-bold text-red-900 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-55 sm:col-span-2 xl:col-span-1 2xl:col-span-2"
                        >
                            <AlertTriangle className="h-4 w-4" />
                            Cerrar conversación
                        </button>
                    )}
                </div>

                <div className="border-y border-slate-100 py-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                                <UserCheck className="h-4 w-4 text-cyan-600" />
                                Asignación
                            </p>
                            <p className="mt-1 text-sm font-bold text-slate-950">{assignment.ownerLabel}</p>
                        </div>
                        <MiniBadge tone={assignment.tone}>{assignment.statusLabel}</MiniBadge>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-slate-500">{assignment.helper}</p>
                    <div className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                        <OperatorFact label="Último contacto" value={formatDateTime(item.last_message_at)} />
                        <OperatorFact
                            label="AI Ops abiertas"
                            value={
                                number(item.agent_actions?.open_count) > 0
                                    ? `${number(item.agent_actions?.open_count)} pendiente(s)`
                                    : "Sin pendientes"
                            }
                        />
                        <OperatorFact
                            label="Nota interna"
                            value={operatorNote.trim() || item.customer_profile?.has_operator_notes ? "Registrada" : "Sin nota"}
                        />
                        <OperatorFact label="Etapa" value={humanizeStage(item.commercial?.stage)} />
                    </div>
                </div>

                <div className="border-b border-slate-100 pb-3">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                        <Clock className="h-4 w-4 text-cyan-600" />
                        Bitácora humana
                    </p>
                    <div className="mt-2 space-y-2">
                        {timeline.map((entry) => (
                            <div key={`${entry.label}-${entry.meta || ""}`} className="flex items-start gap-2 text-xs">
                                <span
                                    className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dotToneClass(entry.tone || "slate"))}
                                />
                                <div className="min-w-0">
                                    <p className="font-semibold text-slate-800">{entry.label}</p>
                                    {entry.meta && <p className="mt-0.5 break-words text-slate-500">{entry.meta}</p>}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                <label className="block">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                        <SendHorizontal className="h-4 w-4 text-cyan-600" />
                        Borrador de respuesta
                    </span>
                    {activeContextResolution && (
                        <span className="mt-2 inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Usa contexto fijado: {activeContextLabel(activeContextResolution.active_context)}
                        </span>
                    )}
                    <textarea
                        data-testid="inbox-draft-reply"
                        ref={draftRef}
                        value={draftReply}
                        onChange={(event) => onDraftReplyChange(event.target.value)}
                        rows={5}
                        className="mt-2 h-24 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-800 outline-none focus:border-cyan-400 focus:bg-white 2xl:h-28"
                    />
                    <div className="mt-2 flex items-end justify-between gap-2">
                        <button
                            type="button"
                            onClick={() => setQuickMenuOpen((open) => !open)}
                            disabled={quickAnswers.length === 0}
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:pointer-events-none",
                                quickMenuOpen && "bg-cyan-50 border-cyan-200"
                            )}
                        >
                            <Type className="h-3.5 w-3.5" />
                            {quickMenuOpen ? "Cerrar plantillas" : "Respuestas rápidas"}
                        </button>
                        {quickMenuOpen && quickAnswers.length > 0 && (
                            <div className="absolute z-20 mt-1 w-80 rounded-md border border-slate-200 bg-white shadow-lg text-left">
                                <div className="px-2 py-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wide border-b border-slate-100">
                                    Plantillas disponibles ({quickAnswers.length})
                                </div>
                                <div className="max-h-48 overflow-y-auto">
                                    {quickAnswers.map((answer) => (
                                        <button
                                            key={answer.id}
                                            type="button"
                                            onClick={() => {
                                                insertQuickAnswer(answer.body);
                                            }}
                                            className="flex w-full cursor-pointer gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                                        >
                                            <div className="shrink-0">
                                                <span className="text-[10px] font-mono text-indigo-600">{answer.shortcut}</span>
                                            </div>
                                            <div className="min-w-0 truncate text-slate-600">
                                                {answer.body.slice(0, 90)}
                                            </div>
                                            {answer.is_global && (
                                                <span className="ml-auto shrink-0 text-[10px] text-slate-400">global</span>
                                            )}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </label>

                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                    <button
                        type="button"
                        onClick={onCreateDraftReplyAction}
                        className="inline-flex items-center justify-center gap-2 rounded-md bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                    >
                        <Bot className="h-4 w-4" />
                        Crear acción de respuesta
                    </button>
                    <button
                        type="button"
                        onClick={onSendHumanReply}
                        disabled={!messagesReady || !isCurrentOwner || sendBusy || !draftReply.trim() || (humanControl.pending_sends?.length || 0) > 0}
                        className="inline-flex items-center justify-center gap-2 rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <SendHorizontal className="h-4 w-4" />
                        {sendBusy ? "Enviando…" : hasUncertainSend ? "Verificar y reenviar" : "Enviar por Evolution"}
                    </button>
                    <button
                        type="button"
                        onClick={onCopyDraftReply}
                        disabled={copyingDraft || !draftReply.trim()}
                        className="inline-flex items-center justify-center gap-2 rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-sm font-semibold text-cyan-800 hover:bg-cyan-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                        <Copy className="h-4 w-4" />
                        {copyingDraft ? "Copiando..." : "Copiar respuesta"}
                    </button>
                </div>

                <div className="flex flex-wrap gap-2">
                    <MiniBadge tone="green">manual</MiniBadge>
                    <MiniBadge tone={productCoherence.ok ? "green" : "red"}>
                        {productCoherence.ok ? "contexto ok" : "validar contexto"}
                    </MiniBadge>
                    <MiniBadge tone="slate">sin envío automático</MiniBadge>
                </div>

                <label className="block">
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
                        <NotebookPen className="h-4 w-4 text-cyan-600" />
                        Nota interna
                    </span>
                    <textarea
                        value={operatorNoteLoading ? "Cargando nota..." : operatorNote}
                        onChange={(event) => onOperatorNoteChange(event.target.value)}
                        disabled={operatorNoteLoading || !item.customer_id}
                        rows={4}
                        placeholder="Ej: cliente prefiere talla 42, pagar contraentrega no disponible, llamar antes de despachar."
                        className="mt-2 h-20 w-full resize-none rounded-md border border-slate-200 bg-slate-50 p-3 text-sm leading-relaxed text-slate-800 outline-none focus:border-cyan-400 focus:bg-white disabled:text-slate-400 2xl:h-24"
                    />
                </label>

                <button
                    type="button"
                    onClick={onSaveOperatorNote}
                    disabled={savingNote || operatorNoteLoading || !item.customer_id}
                    className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                    <Save className="h-4 w-4" />
                    {savingNote ? "Guardando..." : "Guardar nota"}
                </button>

                {actionNotice && <p className="text-sm font-medium text-cyan-700">{actionNotice}</p>}
            </div>
        </section>
    );
}

function ContextPanel({
    item,
    messages,
    humanControl,
    humanControlReady,
    currentUserId,
    humanActionBusy,
    sendBusy,
    messagesReady,
    identityBridge,
    multiContext,
    activeContextResolution,
    draftReply,
    productCoherence,
    operatorNote,
    operatorNoteLoading,
    savingNote,
    copyingDraft,
    actionNotice,
    onDraftReplyChange,
    onOperatorNoteChange,
    onResetDraft,
    onCopyDraftReply,
    onCreateSuggestedAction,
    onCreateDraftReplyAction,
    onHumanControlAction,
    onSendHumanReply,
    onCreateActiveContextDecisionAction,
    onSaveOperatorNote,
    quickAnswers,
    conversationClosure,
    onCloseConversation,
    onReopenConversation,
}: {
    item: InboxConversation;
    messages: Message[];
    humanControl: HumanControl;
    humanControlReady: boolean;
    currentUserId: string | null;
    humanActionBusy: boolean;
    sendBusy: boolean;
    messagesReady: boolean;
    identityBridge?: StorefrontIdentityBridge | null;
    multiContext?: MultiContextState | null;
    activeContextResolution?: ActiveContextResolution | null;
    draftReply: string;
    productCoherence: ProductThreadCoherence;
    operatorNote: string;
    operatorNoteLoading: boolean;
    savingNote: boolean;
    copyingDraft: boolean;
    actionNotice?: string | null;
    onDraftReplyChange: (value: string) => void;
    onOperatorNoteChange: (value: string) => void;
    onResetDraft: () => void;
    onCopyDraftReply: () => void;
    onCreateSuggestedAction: () => void;
    onCreateDraftReplyAction: () => void;
    onHumanControlAction: (action: "claim" | "release") => void;
    onSendHumanReply: () => void;
    onCreateActiveContextDecisionAction: (focus: ActiveContextFocus) => void;
    onSaveOperatorNote: () => void;
    quickAnswers: QuickAnswer[];
    conversationClosure: ConversationClosure | null;
    onCloseConversation: (conversationId: string, reason: string) => void;
    onReopenConversation: (conversationId: string, reason?: string) => void;
}) {
    const product = item.active_product;
    const order = item.order;
    const fulfillment = item.fulfillment;
    const productHint = getProductContextHint(product);
    const orderHint = getOrderContextHint(order);

    return (
        <div className="space-y-4">
            <ContextBriefPanel
                item={item}
                identityBridge={identityBridge}
                productCoherence={productCoherence}
                multiContext={multiContext}
                activeContextResolution={activeContextResolution}
            />

            <IdentityBridgePanel bridge={identityBridge} item={item} />

            <OperatorPanel
                item={item}
                messages={messages}
                humanControl={humanControl}
                humanControlReady={humanControlReady}
                currentUserId={currentUserId}
                humanActionBusy={humanActionBusy}
                sendBusy={sendBusy}
                messagesReady={messagesReady}
                draftReply={draftReply}
                productCoherence={productCoherence}
                multiContext={multiContext}
                activeContextResolution={activeContextResolution}
                operatorNote={operatorNote}
                operatorNoteLoading={operatorNoteLoading}
                savingNote={savingNote}
                copyingDraft={copyingDraft}
                actionNotice={actionNotice}
                onDraftReplyChange={onDraftReplyChange}
                onOperatorNoteChange={onOperatorNoteChange}
                onResetDraft={onResetDraft}
                onCopyDraftReply={onCopyDraftReply}
                onCreateSuggestedAction={onCreateSuggestedAction}
                onCreateDraftReplyAction={onCreateDraftReplyAction}
                onHumanControlAction={onHumanControlAction}
                onSendHumanReply={onSendHumanReply}
                onCreateActiveContextDecisionAction={onCreateActiveContextDecisionAction}
                onSaveOperatorNote={onSaveOperatorNote}
                quickAnswers={quickAnswers}
                conversationClosure={conversationClosure}
                onCloseConversation={onCloseConversation}
                onReopenConversation={onReopenConversation}
            />

            <PanelBlock icon={UserRound} title="Cliente">
                <DataRow label="Nombre" value={item.customer_name || "-"} />
                <DataRow label="Teléfono" value={item.phone_e164 || "-"} />
                <DataRow label="Ciudad" value={item.customer_profile?.city || "-"} />
                <DataRow label="Tallas" value={(item.customer_profile?.preferred_sizes || []).join(", ") || "-"} />
                <DataRow label="Marcas" value={(item.customer_profile?.preferred_brands || []).join(", ") || "-"} />
            </PanelBlock>

            <PanelBlock icon={ShoppingBag} title={getProductPanelTitle(item, identityBridge)}>
                <ContextHint tone={!productCoherence.ok || product?.context_warning ? "red" : product?.display_name ? "cyan" : "amber"}>
                    {!productCoherence.ok ? productCoherence.reason : productHint}
                </ContextHint>
                <DataRow label="Modelo" value={product?.display_name || "-"} />
                <DataRow label="Talla" value={formatValue(product?.size)} />
                <DataRow label={hasOperationalPaidOrder(item) ? "Stock actual" : "Disponible"} value={formatValue(product?.available_units)} />
                <DataRow label="Precio" value={formatCents(product?.price_cents)} />
                <DataRow label="Fuente" value={humanizeStage(product?.context_source)} />
                <DataRow label="Calidad" value={humanizeStage(product?.context_quality)} />
                {product?.context_warning && <DataRow label="Alerta" value={product.context_warning} />}
            </PanelBlock>

            <PanelBlock icon={CreditCard} title="Pedido y pago">
                <ContextHint tone={order?.context_source === "customer_fallback" ? "amber" : "slate"}>{orderHint}</ContextHint>
                <DataRow label="Orden" value={order?.order_id ? shortId(order.order_id) : "-"} />
                <DataRow label="Estado" value={humanizeStage(order?.status)} />
                <DataRow label="Referencia" value={order?.total_cents == null ? "Solo owner/admin" : order.payment_reference || "-"} />
                <DataRow label="Total" value={order?.total_cents == null ? "Solo owner/admin" : formatCents(order.total_cents)} />
                <DataRow label="Pago" value={humanizeStage(item.payment?.status)} />
                <DataRow label="Fuente" value={humanizeStage(order?.context_source)} />
            </PanelBlock>

            <PanelBlock icon={Truck} title="Logística">
                <DataRow label="Estado" value={humanizeStage(fulfillment?.status)} />
                <DataRow label="Transportadora" value={fulfillment?.carrier_name || "-"} />
                <DataRow label="Guía" value={fulfillment?.tracking_number || "-"} />
                <DataRow label="Despachado" value={formatDateTime(fulfillment?.shipped_at)} />
                <DataRow label="Entregado" value={formatDateTime(fulfillment?.delivered_at)} />
            </PanelBlock>

            <PanelBlock icon={Bot} title="AI Ops">
                <DataRow label="Abiertas" value={formatValue(item.agent_actions?.open_count)} />
                <DataRow label="Primera" value={item.agent_actions?.first_summary || "-"} />
                <DataRow label="Riesgo" value={humanizeStage(item.agent_actions?.highest_risk)} />
                <Link to="/ai-ops" className="block py-3 text-xs font-semibold text-cyan-700 hover:underline">Abrir AI Ops para revisar propuestas →</Link>
            </PanelBlock>
        </div>
    );
}

function IdentityBridgePanel({
    bridge,
    item,
}: {
    bridge?: StorefrontIdentityBridge | null;
    item: InboxConversation;
}) {
    const productLabel = bridge ? storefrontObservedProductLabel(bridge) : "";
    const status = bridge?.status || null;
    const identityStatus = bridgeIdentityStatus(bridge, item);
    const tone = status === "linked" ? "green" : bridge ? "amber" : "slate";
    const source = bridge?.source_surface ? humanizeStage(bridge.source_surface) : "-";

    return (
        <PanelBlock icon={Link2} title="Puente web/WhatsApp">
            <div className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                        <p className="text-sm font-bold text-slate-950">
                            {bridge?.handoff_code || "Sin código enlazado"}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-slate-500">
                            {identityStatus}
                        </p>
                    </div>
                    <MiniBadge tone={tone}>{bridge ? humanizeStage(status) : "sin puente"}</MiniBadge>
                </div>

                <ContextHint tone={status === "linked" ? "cyan" : bridge ? "amber" : "slate"}>
                    {bridge
                        ? "Este código correlaciona una sesión web con WhatsApp. Sirve como evidencia auditada, no como autenticación ni autorización para crear orden, cobrar o despachar."
                        : "No hay handoff WEB-* enlazado a esta conversación. No fusiones señales anónimas del storefront con Customer 360 sin identidad WhatsApp."}
                </ContextHint>
            </div>
            <DataRow label="Origen" value={source} />
            <DataRow label="Sesión" value={bridge?.storefront_session_id ? shortId(bridge.storefront_session_id) : "-"} />
            <DataRow label="Producto web" value={productLabel || "-"} />
            <DataRow label="Talla web" value={formatValue(bridge?.size_requested)} />
            <DataRow label="Intención" value={humanizeStage(bridge?.intent)} />
            <DataRow label="Etapa web" value={humanizeStage(bridge?.funnel_stage)} />
            <DataRow label="Enlazado" value={formatDateTime(bridge?.linked_at)} />
            <DataRow label="Expira" value={formatDateTime(bridge?.expires_at)} />
        </PanelBlock>
    );
}

function ContextBriefPanel({
    item,
    identityBridge,
    productCoherence,
    multiContext,
    activeContextResolution,
}: {
    item: InboxConversation;
    identityBridge?: StorefrontIdentityBridge | null;
    productCoherence: ProductThreadCoherence;
    multiContext?: MultiContextState | null;
    activeContextResolution?: ActiveContextResolution | null;
}) {
    const product = item.active_product;
    const order = item.order;
    const fulfillment = item.fulfillment;
    const customerMeta = [
        item.phone_e164,
        item.customer_profile?.city,
        (item.customer_profile?.preferred_sizes || []).length
            ? `Tallas ${(item.customer_profile?.preferred_sizes || []).join(", ")}`
            : null,
    ]
        .filter(Boolean)
        .join(" · ");
    const productMeta = buildProductMeta(item);
    const orderMeta = (order?.total_cents == null ? [] : [
        order.payment_reference,
        formatCents(order.total_cents),
        order.paid_at ? `Pagado ${formatDateTime(order.paid_at)}` : null,
    ])
        .filter((value) => value && value !== "-")
        .join(" · ");
    const logisticsMeta = [
        fulfillment?.paid_over_sla ? "+24h sin despacho" : null,
        fulfillment?.carrier_name,
        fulfillment?.tracking_number ? `Guía ${fulfillment.tracking_number}` : null,
    ]
        .filter(Boolean)
        .join(" · ");
    const risk = item.commercial?.risk_level || "low";

    return (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
                <div className="min-w-0">
                    <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Lectura rápida</p>
                    <p className="mt-1 text-sm font-bold text-slate-950">
                        {humanizeStage(item.commercial?.next_best_action || item.commercial?.stage || "seguimiento")}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <RiskBadge risk={risk} />
                    {activeContextResolution ? (
                        <MiniBadge tone="green">contexto fijado</MiniBadge>
                    ) : (
                        multiContext && <MiniBadge tone="amber">2 contextos</MiniBadge>
                    )}
                    {item.fulfillment?.paid_over_sla && <MiniBadge tone="red">SLA</MiniBadge>}
                </div>
            </div>

            <div className="space-y-2 p-3">
                {activeContextResolution ? (
                    <ContextHint tone="green">
                        Contexto activo fijado: {activeContextLabel(activeContextResolution.active_context)}.
                        {" "}
                        {activeContextResolution.resolution_reason || "Mantén separadas las demás líneas hasta una nueva decisión auditada."}
                    </ContextHint>
                ) : multiContext ? (
                    <ContextHint tone="amber">{multiContext.summary}</ContextHint>
                ) : (
                    !productCoherence.ok && <ContextHint tone="red">{productCoherence.reason}</ContextHint>
                )}

                <div className="grid grid-cols-2 gap-2">
                    <BriefFact
                        icon={UserRound}
                        label="Cliente"
                        value={item.customer_name || item.phone_e164 || "Cliente sin nombre"}
                        meta={customerMeta || "Sin perfil enriquecido"}
                    />
                    <BriefFact
                        icon={ShoppingBag}
                        label={getProductDecisionLabel(item, identityBridge)}
                        value={product?.display_name || "Sin producto confirmado"}
                        meta={product?.context_warning || productMeta || getProductContextHint(product)}
                        tone={
                            multiContext
                                ? "amber"
                                : !productCoherence.ok || product?.context_warning
                                  ? "red"
                                  : product?.display_name
                                    ? "cyan"
                                    : "amber"
                        }
                    />
                    <BriefFact
                        icon={CreditCard}
                        label="Pedido/Pago"
                        value={item.payment?.status || order?.status ? humanizeStage(item.payment?.status || order?.status) : "Sin pedido activo"}
                        meta={orderMeta || getOrderContextHint(order)}
                        tone={item.payment?.status === "approved" || order?.status === "paid" ? "green" : "slate"}
                    />
                    <BriefFact
                        icon={Truck}
                        label="Logística"
                        value={fulfillment?.paid_over_sla ? "Despacho atrasado" : fulfillment?.status ? humanizeStage(fulfillment.status) : "Sin envío activo"}
                        meta={logisticsMeta || "Sin guía activa"}
                        tone={fulfillment?.paid_over_sla ? "red" : fulfillment?.status === "shipped" ? "cyan" : "slate"}
                    />
                </div>
            </div>
        </section>
    );
}

function BriefFact({
    icon: Icon,
    label,
    value,
    meta,
    tone = "slate",
}: {
    icon: LucideIcon;
    label: string;
    value?: string | number | null;
    meta?: string | null;
    tone?: "slate" | "cyan" | "amber" | "red" | "green";
}) {
    return (
        <div className={cn("min-w-0 rounded-md border p-2", briefToneClass(tone))}>
            <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 shrink-0" />
                <p className="truncate text-[10px] font-bold uppercase tracking-wide">{label}</p>
            </div>
            <p className="mt-1.5 line-clamp-2 text-xs font-bold leading-snug text-slate-950">{value || "-"}</p>
            <p className="mt-1 line-clamp-1 text-[11px] leading-relaxed text-slate-500">{meta || "-"}</p>
        </div>
    );
}

function MessageBubble({ message }: { message: Message }) {
    const outbound = message.direction === "outbound" || message.role === "assistant";

    return (
        <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
            <div
                className={cn(
                    "max-w-[78%] rounded-lg px-4 py-3 text-sm shadow-sm",
                    outbound ? "bg-slate-950 text-white" : "border border-slate-200 bg-white text-slate-800"
                )}
            >
                <p className="whitespace-pre-wrap leading-relaxed">{message.body || "Mensaje sin texto."}</p>
                <p className={cn("mt-2 text-[11px]", outbound ? "text-slate-300" : "text-slate-400")}>
                    {formatDateTime(message.created_at)}
                </p>
                {outbound && message.delivery_status && (
                    <p className={cn(
                        "mt-1 text-[11px] font-semibold",
                        message.delivery_status === "accepted" ? "text-emerald-300"
                            : message.delivery_status === "failed" ? "text-red-300"
                            : message.delivery_status === "unknown" ? "text-amber-200"
                            : "text-cyan-200",
                    )}>
                        {message.delivery_status === "read" ? "Leído en WhatsApp"
                            : message.delivery_status === "delivered" ? "Entregado en WhatsApp"
                            : message.delivery_status === "accepted" ? "Aceptado por WhatsApp · entrega pendiente"
                            : message.delivery_status === "failed" ? "No enviado · proveedor lo rechazó"
                            : message.delivery_status === "unknown" ? "Resultado incierto · verifica antes de reenviar"
                            : "Enviando…"}
                    </p>
                )}
            </div>
        </div>
    );
}

function ConversationFallback({ item }: { item: InboxConversation }) {
    return (
        <div role="status" className="rounded-lg border border-dashed border-slate-300 bg-white p-6">
            <MessageSquareText className="h-8 w-8 text-slate-400" />
            <p className="mt-3 text-sm font-semibold text-slate-900">No hay mensajes en el historial cargado.</p>
            {item.last_message?.preview ? (
                <p className="mt-2 text-sm text-slate-600">
                    <span className="font-semibold">Resumen reciente del Inbox:</span> {item.last_message.preview}
                </p>
            ) : (
                <p className="mt-2 text-sm text-slate-600">No hay contenido reciente disponible.</p>
            )}
        </div>
    );
}

function PanelBlock({
    icon: Icon,
    title,
    children,
}: {
    icon: LucideIcon;
    title: string;
    children: ReactNode;
}) {
    return (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white">
            <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
                <Icon className="h-4 w-4 text-cyan-600" />
                <h3 className="text-sm font-bold text-slate-950">{title}</h3>
            </div>
            <div className="divide-y divide-slate-100 px-4">{children}</div>
        </section>
    );
}

function DataRow({ label, value }: { label: string; value?: string | number | null }) {
    return (
        <div className="grid min-w-0 grid-cols-[96px_minmax(0,1fr)] gap-3 py-2 text-sm">
            <span className="min-w-0 text-slate-500">{label}</span>
            <span className="min-w-0 break-words font-medium text-slate-900">{value ?? "-"}</span>
        </div>
    );
}

function OperatorFact({ label, value }: { label: string; value?: string | number | null }) {
    return (
        <div className="min-w-0">
            <p className="font-bold uppercase tracking-wide text-slate-400">{label}</p>
            <p className="mt-0.5 truncate font-semibold text-slate-800">{value || "-"}</p>
        </div>
    );
}

function ContextHint({
    children,
    tone = "slate",
}: {
    children?: ReactNode;
    tone?: "slate" | "cyan" | "amber" | "red" | "green";
}) {
    if (!children) return null;

    return (
        <div className="py-3">
            <p
                className={cn(
                    "rounded-md border px-3 py-2 text-xs font-medium leading-relaxed",
                    tone === "cyan" && "border-cyan-100 bg-cyan-50 text-cyan-800",
                    tone === "amber" && "border-amber-100 bg-amber-50 text-amber-800",
                    tone === "red" && "border-red-200 bg-red-50 text-red-800",
                    tone === "green" && "border-emerald-100 bg-emerald-50 text-emerald-800",
                    tone === "slate" && "border-slate-100 bg-slate-50 text-slate-600"
                )}
            >
                {children}
            </p>
        </div>
    );
}

function MetricCard({
    label,
    value,
    tone = "slate",
}: {
    label: string;
    value: number;
    tone?: "slate" | "cyan" | "amber" | "red" | "indigo";
}) {
    const Icon = tone === "red" ? AlertTriangle : tone === "cyan" ? MessageSquareText : tone === "amber" ? Clock : tone === "indigo" ? Bot : PackageCheck;

    return (
        <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="flex items-center justify-between">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
                <Icon className={cn("h-4 w-4", toneClass(tone))} />
            </div>
            <p className="mt-1 text-2xl font-bold text-slate-950 xl:text-xl">{value}</p>
        </div>
    );
}

function EmptyState({ text }: { text: string }) {
    return (
        <div className="flex min-h-[180px] items-center justify-center p-6 text-center text-sm font-medium text-slate-500">
            {text}
        </div>
    );
}

function StageBadge({ stage }: { stage?: string | null }) {
    return <MiniBadge tone={stageTone(stage)}>{humanizeStage(stage)}</MiniBadge>;
}

function RiskBadge({ risk }: { risk?: string | null }) {
    const normalized = risk || "low";
    return <MiniBadge tone={riskTone(normalized)}>{humanizeStage(normalized)}</MiniBadge>;
}

function MiniBadge({
    children,
    tone = "slate",
}: {
    children: ReactNode;
    tone?: "slate" | "cyan" | "amber" | "red" | "green" | "indigo";
}) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold",
                tone === "cyan" && "bg-cyan-50 text-cyan-700",
                tone === "amber" && "bg-amber-50 text-amber-700",
                tone === "red" && "bg-red-50 text-red-700",
                tone === "green" && "bg-emerald-50 text-emerald-700",
                tone === "indigo" && "bg-indigo-50 text-indigo-700",
                tone === "slate" && "bg-slate-100 text-slate-600"
            )}
        >
            {children}
        </span>
    );
}

function stageTone(stage?: string | null) {
    if (stage === "fulfillment_pending" || stage === "payment_pending") return "amber";
    if (stage === "paid" || stage === "delivered") return "green";
    if (stage === "shipped") return "cyan";
    if (stage === "lost") return "red";
    return "slate";
}

function riskTone(risk?: string | null) {
    if (risk === "critical" || risk === "high") return "red";
    if (risk === "medium") return "amber";
    return "green";
}

function toneClass(tone: string) {
    if (tone === "cyan") return "text-cyan-600";
    if (tone === "amber") return "text-amber-600";
    if (tone === "red") return "text-red-600";
    if (tone === "indigo") return "text-indigo-600";
    return "text-slate-400";
}

function decisionToneClass(tone: string) {
    if (tone === "cyan") return "text-cyan-700";
    if (tone === "amber") return "text-amber-700";
    if (tone === "red") return "text-red-700";
    if (tone === "green") return "text-emerald-700";
    return "text-slate-950";
}

function briefToneClass(tone: string) {
    if (tone === "cyan") return "border-cyan-100 bg-cyan-50/60 text-cyan-700";
    if (tone === "amber") return "border-amber-100 bg-amber-50/70 text-amber-700";
    if (tone === "red") return "border-red-100 bg-red-50 text-red-700";
    if (tone === "green") return "border-emerald-100 bg-emerald-50/70 text-emerald-700";
    return "border-slate-100 bg-slate-50 text-slate-500";
}

function dotToneClass(tone: string) {
    if (tone === "cyan") return "bg-cyan-500";
    if (tone === "amber") return "bg-amber-500";
    if (tone === "red") return "bg-red-500";
    if (tone === "green") return "bg-emerald-500";
    if (tone === "indigo") return "bg-indigo-500";
    return "bg-slate-300";
}

function getAssignmentState(item: InboxConversation, operatorNote: string, humanControl: HumanControl): AssignmentState {
    const openActions = number(item.agent_actions?.open_count);
    const hasOperatorContext = Boolean(operatorNote.trim() || item.customer_profile?.has_operator_notes);

    if (humanControl.status === "human") {
        return {
            ownerLabel: humanControl.owner_email || "Operador asignado",
            statusLabel: "Bot pausado",
            helper: "La asignación está persistida. El bot solo vuelve a responder cuando el operador libera el caso.",
            tone: "green",
        };
    }

    if (item.commercial?.handoff_required) {
        return {
            ownerLabel: "Pendiente de toma humana",
            statusLabel: "Requiere humano",
            helper: "El cliente espera atención. Toma el caso para asignarte la conversación y pausar el bot.",
            tone: "amber",
        };
    }

    if (openActions > 0) {
        return {
            ownerLabel: "AI Ops pendiente",
            statusLabel: "Revisar acción",
            helper: "Hay acciones abiertas que deben revisarse antes de responder, despachar o cambiar datos operativos.",
            tone: "indigo",
        };
    }

    if (hasOperatorContext) {
        return {
            ownerLabel: "Operación humana",
            statusLabel: "Con nota interna",
            helper: "Este cliente tiene contexto manual guardado. Revisa la nota antes de copiar o ajustar una respuesta.",
            tone: "cyan",
        };
    }

    return {
        ownerLabel: "Sin asignar",
        statusLabel: "Seguimiento",
        helper: "El bot puede seguir atendiendo. El operador toma el caso si detecta riesgo, pago, despacho o fricción comercial.",
        tone: "slate",
    };
}

function humanActionError(code: string) {
    const messages: Record<string, string> = {
        claimed_by_another_operator: "Otra persona ya tomó esta conversación. Coordina con ella antes de intervenir.",
        not_conversation_owner: "Solo quien tomó la conversación puede devolverla al bot.",
        conversation_not_owned: "Primero toma esta conversación; el bot debe quedar pausado antes de enviar.",
        send_in_progress: "Hay un envío en curso. Espera a que el estado se resuelva antes de continuar.",
        conversation_not_open: "Esta conversación está cerrada y no puede tomarse para atención.",
        channel_not_identified: "No pude identificar con seguridad el canal de origen. No envié el mensaje.",
        invalid_customer_phone: "El teléfono del cliente no es válido. No envié el mensaje.",
        invalid_message: "El mensaje está vacío o supera el límite permitido.",
        idempotency_key_conflict: "La clave de este intento ya pertenece a otra solicitud. Genera un nuevo intento.",
        handoff_update_failed: "No se pudo guardar el cambio de responsable. El bot conserva su estado actual.",
        conversation_not_found: "La conversación ya no existe o no está disponible.",
        admin_required: "Tu usuario no tiene permisos de administrador para atender esta conversación.",
    };
    return messages[code] || `No se pudo completar la acción (${code}). Actualiza el Inbox y verifica el estado.`;
}

async function readFunctionErrorCode(error: unknown): Promise<string | null> {
    const response = (error as { context?: unknown } | null)?.context;
    if (!(response instanceof Response)) return null;
    try {
        const payload = await response.clone().json() as { code?: unknown };
        return typeof payload.code === "string" ? payload.code : null;
    } catch {
        return null;
    }
}

function buildHumanTimeline(
    item: InboxConversation,
    messages: Message[],
    operatorNote: string,
    operatorEvents: NonNullable<HumanControl["events"]> = [],
): HumanTimelineEntry[] {
    const entries: HumanTimelineEntry[] = [];
    const eventLabels: Record<string, { label: string; tone: HumanTimelineEntry["tone"] }> = {
        claimed: { label: "Operador tomó la conversación · bot pausado", tone: "green" },
        released: { label: "Conversación devuelta al bot", tone: "slate" },
        message_send_started: { label: "Respuesta humana en proceso", tone: "cyan" },
        message_send_accepted: { label: "WhatsApp aceptó el mensaje", tone: "green" },
        provider_delivered: { label: "WhatsApp confirmó la entrega", tone: "green" },
        provider_read: { label: "El cliente leyó el mensaje", tone: "green" },
        message_send_failed: { label: "WhatsApp no aceptó el mensaje", tone: "red" },
        message_send_unknown: { label: "Resultado de envío incierto", tone: "amber" },
    };
    for (const event of operatorEvents.slice(0, 6)) {
        const display = eventLabels[event.event_type];
        if (!display) continue;
        const details = event.details || {};
        const outcome = typeof details.provider_status === "string" ? details.provider_status : null;
        entries.push({
            label: display.label,
            meta: [event.actor_email || null, formatDateTime(event.created_at), outcome].filter(Boolean).join(" · "),
            tone: display.tone,
        });
    }
    const newestMessages = [...messages].reverse();
    const lastInbound = newestMessages.find((message) => message.direction === "inbound" || message.role === "user");
    const lastOutbound = newestMessages.find((message) => message.direction === "outbound" || message.role === "assistant");
    const openActions = number(item.agent_actions?.open_count);

    if (lastInbound) {
        entries.push({
            label: "Último mensaje del cliente",
            meta: `${formatDateTime(lastInbound.created_at)} · ${truncateText(lastInbound.body || "Sin texto", 80)}`,
            tone: "cyan",
        });
    }

    if (lastOutbound) {
        entries.push({
            label: "Última respuesta del bot/tienda",
            meta: `${formatDateTime(lastOutbound.created_at)} · ${truncateText(lastOutbound.body || "Sin texto", 80)}`,
            tone: "slate",
        });
    }

    if (item.order?.paid_at || item.payment?.approved_at || item.payment?.status === "approved" || item.order?.status === "paid") {
        entries.push({
            label: "Pago aprobado o pedido pagado",
            meta: formatDateTime(item.order?.paid_at || item.payment?.approved_at),
            tone: "green",
        });
    }

    if (item.fulfillment?.paid_over_sla || item.commercial?.stage === "fulfillment_pending") {
        entries.push({
            label: item.fulfillment?.paid_over_sla ? "Despacho fuera de SLA" : "Pedido listo para despacho",
            meta: item.fulfillment?.paid_over_sla ? "Prioridad logística: supera 24h sin despacho." : "Revisar transportadora, guía y confirmación al cliente.",
            tone: item.fulfillment?.paid_over_sla ? "red" : "amber",
        });
    }

    if (operatorNote.trim() || item.customer_profile?.has_operator_notes) {
        entries.push({
            label: "Nota interna disponible",
            meta: operatorNote.trim() ? truncateText(operatorNote.trim(), 90) : "Revisar nota guardada del cliente.",
            tone: "indigo",
        });
    }

    if (openActions > 0) {
        entries.push({
            label: "Acción AI Ops abierta",
            meta: `${openActions} acción(es) pendiente(s). ${item.agent_actions?.first_summary || "Revisar antes de ejecutar."}`,
            tone: "indigo",
        });
    }

    if (entries.length === 0) {
        entries.push({
            label: "Sin intervención humana registrada",
            meta: "El caso se mantiene en seguimiento del bot y contexto comercial.",
            tone: "slate",
        });
    }

    return entries.slice(0, 6);
}

function number(value?: number | null) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatCents(cents?: number | null) {
    if (typeof cents !== "number" || !Number.isFinite(cents)) return "-";

    return new Intl.NumberFormat("es-CO", {
        style: "currency",
        currency: "COP",
        maximumFractionDigits: 0,
    }).format(cents / 100);
}

function formatDateTime(value?: string | null) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "-";
    return new Intl.DateTimeFormat("es-CO", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function formatValue(value?: string | number | null) {
    if (value === null || value === undefined || value === "") return "-";
    return String(value);
}

function shortId(value: string) {
    return value.length > 10 ? `${value.slice(0, 8)}...` : value;
}

function formatAgentMode(value?: string | null) {
    if (!value || value === "suggest_only") return "seguro";
    return humanizeStage(value);
}

function emptyFilterText(filter: InboxFilter, search: string) {
    const query = search.trim();
    if (query) return `No hay conversaciones que coincidan con "${query}".`;
    return EMPTY_FILTER_COPY[filter];
}

function humanizeStage(value?: string | null) {
    const labels: Record<string, string> = {
        new: "Nuevo",
        monitor: "Seguimiento",
        browsing: "Explorando",
        product_identified: "Producto",
        size_validated: "Talla validada",
        customer_data_pending: "Datos",
        payment_link_sent: "Link enviado",
        payment_pending: "Pago pendiente",
        fulfillment_pending: "Por despachar",
        paid: "Pagado",
        approved: "Aprobado",
        shipped: "Enviado",
        delivered: "Entregado",
        support: "Soporte",
        lost: "Perdido",
        low: "Bajo",
        medium: "Medio",
        high: "Alto",
        critical: "Crítico",
        pending_dispatch: "Por despachar",
        conversation_event: "Conversación",
        conversation_order: "Orden conversacional",
        conversation_payment_reference: "Referencia conversacional",
        conversation_product_match: "Producto coincidente",
        recent_message_match: "Mensaje reciente",
        conversation_size_only: "Solo talla",
        customer_profile: "Memoria cliente",
        customer_fallback: "Cliente",
        direct: "Directo",
        dispatch_overdue_paid_order: "Despacho atrasado",
        dispatch_review: "Revisar despacho",
        ready_to_fulfill: "Listo para preparar",
        review_conversation: "Revisar conversación",
        prepare_next_customer_step: "Preparar siguiente paso",
        review_customer_reply_draft: "Revisar respuesta",
        assign_human_owner: "Tomar caso",
        inferred_from_recent_messages: "Inferido del hilo",
        size_only: "Solo talla",
        order_linked: "Orden vinculada",
        customer_memory: "Memoria cliente",
        missing: "Sin contexto",
        suggest_only: "Seguro",
        linked: "Enlazado",
        created: "Creado",
        opened_whatsapp: "WhatsApp abierto",
        expired: "Vencido",
        unresolved: "No resuelto",
        discarded: "Descartado",
        product_card: "Ficha producto",
        storefront_chat: "Chat web",
        nav_whatsapp: "Botón WhatsApp",
        footer_whatsapp: "Footer WhatsApp",
        recommendation_button: "Recomendación",
    };

    if (!value) return "-";
    return labels[value] || value.replaceAll("_", " ");
}

function activeContextLabel(value?: string | null) {
    const labels: Record<string, string> = {
        dispatch_pending_order: "Despacho pendiente",
        new_storefront_purchase: "Compra web reciente",
        manual_review: "Revisión manual",
    };

    if (!value) return "Contexto";
    return labels[value] || humanizeStage(value);
}

function isPaymentApproved(item: InboxConversation) {
    return item.payment?.status === "approved" || item.order?.status === "paid";
}

function hasOperationalPaidOrder(item: InboxConversation) {
    return Boolean(
        isPaymentApproved(item) ||
        item.commercial?.stage === "fulfillment_pending" ||
        item.fulfillment?.paid_over_sla
    );
}

function getProductDecisionLabel(
    item: InboxConversation,
    identityBridge?: StorefrontIdentityBridge | null
) {
    const bridge = getVerifiedBridgeForConversation(identityBridge, item);
    if (hasOperationalPaidOrder(item)) return bridge ? "Producto del pedido" : "Producto operativo";
    return "Producto";
}

function getProductPanelTitle(
    item: InboxConversation,
    identityBridge?: StorefrontIdentityBridge | null
) {
    const bridge = getVerifiedBridgeForConversation(identityBridge, item);
    if (hasOperationalPaidOrder(item)) {
        return bridge ? "Producto del pedido operativo" : "Producto operativo";
    }
    return "Producto en conversación";
}

function buildProductMeta(item: InboxConversation) {
    const product = item.active_product;
    if (!product?.display_name) return "";

    const pieces = [
        product.size ? `Talla ${product.size}` : null,
        hasOperationalPaidOrder(item)
            ? isPaymentApproved(item)
                ? "pedido aprobado"
                : "pedido por despachar"
            : null,
        typeof product.available_units === "number"
            ? hasOperationalPaidOrder(item)
                ? `stock actual ${product.available_units}`
                : `${product.available_units} disponibles`
            : null,
        formatCents(product.price_cents),
    ];

    return pieces
        .filter((value) => value && value !== "-")
        .join(" · ");
}

function getMultiContextState(
    item: InboxConversation,
    identityBridge?: StorefrontIdentityBridge | null
): MultiContextState | null {
    const bridge = getVerifiedBridgeForConversation(identityBridge, item);
    const product = item.active_product;
    const orderProductName = product?.display_name || "";
    const bridgeProductName = storefrontObservedProductLabel(bridge);

    if (!bridge || !hasOperationalPaidOrder(item) || !orderProductName || !bridgeProductName) {
        return null;
    }

    const productTokens = getProductIdentityTokens(product);
    const bridgeTokens = tokenizeProductText(bridgeProductName);
    const matchedBridgeTokens = productTokens.filter((token) => bridgeTokens.includes(token));
    const sameProduct = bridgeTokens.length === 0 || matchedBridgeTokens.length > 0;
    const orderSize = product?.size == null ? null : String(product.size);
    const bridgeSize = bridge.size_requested == null ? null : String(bridge.size_requested);
    const sizeDiffers = Boolean(orderSize && bridgeSize && orderSize !== bridgeSize);

    if (sameProduct && !sizeDiffers) {
        return null;
    }

    const bridgeLabel = [bridgeProductName, bridgeSize ? `talla ${bridgeSize}` : null]
        .filter(Boolean)
        .join(" ");
    const orderLabel = [orderProductName, orderSize ? `talla ${orderSize}` : null]
        .filter(Boolean)
        .join(" ");

    return {
        bridgeProductName,
        bridgeSize,
        orderProductName,
        orderSize,
        summary: `Mismo WhatsApp con dos líneas abiertas: compra web reciente por ${bridgeLabel} y pedido operativo pendiente por ${orderLabel}.`,
        operatorGuidance:
            "Antes de responder, decide si el cliente está preguntando por la compra nueva o por el pedido ya pagado/pendiente. No cobres, reserves ni despaches hasta separar explícitamente la intención vigente.",
    };
}

function getProductContextHint(product?: InboxConversation["active_product"]) {
    if (!product?.display_name) {
        return "Sin producto confirmado en esta conversación. Usa la memoria del cliente solo como pista, no como decisión.";
    }

    if (product.context_warning) {
        return product.context_warning;
    }

    const source = product.context_source;

    if (source === "conversation_event") {
        return "Producto tomado del último evento comercial de esta conversación.";
    }

    if (source === "recent_message_match") {
        return "Producto inferido desde los últimos mensajes del hilo; valida si hay varios modelos cercanos.";
    }

    if (source === "conversation_size_only") {
        return "El hilo reciente solo confirma talla; falta modelo explícito.";
    }

    if (source === "conversation_order") {
        return "Producto tomado de una orden relacionada con esta conversación.";
    }

    if (source === "conversation_payment_reference") {
        return "Producto tomado de una referencia de pago mencionada en esta conversación.";
    }

    if (source === "conversation_product_match") {
        return "Producto inferido por coincidencia con lo conversado; valida antes de ejecutar cambios.";
    }

    if (source === "customer_profile") {
        return "Producto estimado desde la memoria del cliente; puede no ser el producto del hilo actual.";
    }

    return "Producto asociado al contexto disponible; valida el hilo antes de actuar.";
}

function getOrderContextHint(order?: InboxConversation["order"]) {
    if (!order?.order_id) {
        return "Sin orden activa vinculada. La conversación puede estar todavía en exploración o preventa.";
    }

    const source = order.context_source;

    if (source === "customer_fallback") {
        return "Orden operativa del cliente. Puede ser pendiente real, pero no necesariamente pertenece al hilo seleccionado.";
    }

    if (source === "conversation_order") {
        return "Orden relacionada directamente con esta conversación.";
    }

    if (source === "conversation_payment_reference") {
        return "Orden vinculada por referencia de pago conversacional.";
    }

    if (source === "conversation_product_match") {
        return "Orden elegida por coincidencia de producto. Verifica antes de despachar o cobrar.";
    }

    return "Orden asociada al mejor contexto disponible.";
}

const PRODUCT_THREAD_STOP_WORDS = new Set([
    "air",
    "black",
    "blanco",
    "blue",
    "bred",
    "brown",
    "calzado",
    "green",
    "gris",
    "infrared",
    "light",
    "low",
    "negro",
    "red",
    "rojo",
    "shoe",
    "shoes",
    "sneaker",
    "sneakers",
    "toe",
    "white",
    "zapatilla",
    "zapatillas",
    "zapato",
    "zapatos",
]);

const PRODUCT_THREAD_SIGNAL_TOKENS = new Set([
    "adidas",
    "armour",
    "asics",
    "converse",
    "jordan",
    "max",
    "metcon",
    "nike",
    "pegasus",
    "puma",
    "reebok",
    "revolution",
    "ultraboost",
    "under",
    "vans",
]);

function getProductThreadCoherence(
    item: InboxConversation,
    messages: Message[],
    identityBridge?: StorefrontIdentityBridge | null
): ProductThreadCoherence {
    const product = item.active_product;
    const productName = product?.display_name || null;

    if (!productName) {
        return {
            ok: true,
            severity: "none",
            productName,
            reason: "Sin producto activo que contrastar con el hilo.",
            matchedTokens: [],
            recentProductSignals: [],
        };
    }

    const linkedBridge = getVerifiedBridgeForConversation(identityBridge, item);
    if (linkedBridge) {
        const bridgeProductName = storefrontObservedProductLabel(linkedBridge);
        const productTokens = getProductIdentityTokens(product);
        const bridgeTokens = tokenizeProductText(bridgeProductName);
        const matchedBridgeTokens = productTokens.filter((token) => bridgeTokens.includes(token));
        const productSize = product?.size == null ? null : String(product.size);
        const bridgeSize = linkedBridge.size_requested == null ? null : String(linkedBridge.size_requested);
        const isOperationalOrder = hasOperationalPaidOrder(item);

        if (productSize && bridgeSize && productSize !== bridgeSize) {
            return {
                ok: false,
                severity: "high",
                productName,
                reason: isOperationalOrder
                    ? `Hay dos contextos activos: el puente web reciente apunta a talla ${bridgeSize}, pero el pedido operativo quedó en talla ${productSize}. No mezcles venta nueva con despacho; confirma cuál caso está resolviendo el cliente.`
                    : `El puente web enlazado apunta a talla ${bridgeSize}, pero el producto activo quedó en talla ${productSize}. Valida antes de responder o cobrar.`,
                matchedTokens: matchedBridgeTokens,
                recentProductSignals: bridgeTokens,
            };
        }

        if (matchedBridgeTokens.length > 0 || bridgeTokens.length === 0) {
            return {
                ok: true,
                severity: "none",
                productName,
                reason: bridgeProductName
                    ? `Producto validado por puente web/WhatsApp enlazado (${bridgeProductName}). Los mensajes antiguos pueden contener intereses previos.`
                    : "La conversación tiene puente web/WhatsApp enlazado; valida el detalle comercial si falta producto web.",
                matchedTokens: matchedBridgeTokens,
                recentProductSignals: bridgeTokens,
            };
        }

        return {
            ok: false,
            severity: "high",
            productName,
            reason: isOperationalOrder
                ? `Hay dos contextos activos: el puente web reciente apunta a ${bridgeProductName}, pero el pedido operativo pendiente es ${productName}. No mezcles una nueva intención de compra con un despacho/pago anterior; confirma prioridad antes de sugerir respuesta.`
                : `El puente web enlazado apunta a ${bridgeProductName}, pero el producto activo es ${productName}. Revisa cuál interés sigue vigente antes de sugerir respuesta.`,
            matchedTokens: matchedBridgeTokens,
            recentProductSignals: bridgeTokens,
        };
    }

    const recentText = normalizeSearchText(
        [
            item.last_message?.preview,
            ...(messages.length > 0 ? messages.slice(-8).map((message) => message.body || "") : []),
        ]
            .filter(Boolean)
            .join(" ")
    );
    const productTokens = getProductIdentityTokens(product);

    if (!recentText || productTokens.length === 0) {
        return {
            ok: true,
            severity: "none",
            productName,
            reason: "No hay texto reciente suficiente para contrastar el producto activo.",
            matchedTokens: [],
            recentProductSignals: [],
        };
    }

    const matchedTokens = productTokens.filter((token) => recentText.includes(token));
    const dynamicSignals = [
        ...tokenizeProductText(product?.brand),
        ...(item.customer_profile?.preferred_brands || []).flatMap((brand) => tokenizeProductText(brand)),
        ...(item.customer_profile?.preferred_models || []).flatMap((model) => tokenizeProductText(model)),
    ];
    const recentProductSignals = uniqueValues(tokenizeProductText(recentText))
        .filter((token) => PRODUCT_THREAD_SIGNAL_TOKENS.has(token) || dynamicSignals.includes(token))
        .slice(0, 8);

    if (matchedTokens.length > 0 || recentProductSignals.length === 0) {
        return {
            ok: true,
            severity: "none",
            productName,
            reason: "El producto activo no contradice los últimos mensajes relevantes del hilo.",
            matchedTokens,
            recentProductSignals,
        };
    }

    return {
        ok: false,
        severity: "high",
        productName,
        reason: `El producto activo (${productName}) no aparece en los últimos mensajes, que contienen señales de otro modelo o marca: ${recentProductSignals.join(", ")}.`,
        matchedTokens,
        recentProductSignals,
    };
}

function buildProductThreadWarnings(coherence: ProductThreadCoherence): Record<string, unknown>[] {
    if (coherence.ok) return [];

    return [
        {
            code: "product_thread_mismatch",
            severity: coherence.severity,
            message: coherence.reason,
            product_name: coherence.productName,
            matched_tokens: coherence.matchedTokens,
            recent_product_signals: coherence.recentProductSignals,
        },
    ];
}

function buildProductContextWarnings(
    item: InboxConversation,
    coherence: ProductThreadCoherence
): Record<string, unknown>[] {
    const warnings = buildProductThreadWarnings(coherence);

    if (item.active_product?.context_warning) {
        warnings.push({
            code: "active_product_context_warning",
            severity: "medium",
            message: item.active_product.context_warning,
            context_source: item.active_product.context_source,
            context_quality: item.active_product.context_quality,
        });
    }

    return warnings;
}

function getContextWarningsFromActionContext(inputContext: Record<string, unknown>): Record<string, unknown>[] {
    return Array.isArray(inputContext.context_warnings)
        ? (inputContext.context_warnings as Record<string, unknown>[])
        : [];
}

function getProductIdentityTokens(product?: InboxConversation["active_product"]) {
    if (!product) return [];

    const modelTokens = tokenizeProductText(product.model);
    if (modelTokens.length > 0) return modelTokens;

    const brandTokens = new Set(tokenizeProductText(product.brand));
    const displayTokens = tokenizeProductText(product.display_name).filter((token) => !brandTokens.has(token));

    return displayTokens.length > 0 ? uniqueValues(displayTokens) : tokenizeProductText(product.display_name);
}

function tokenizeProductText(value?: string | number | null) {
    if (value === null || value === undefined) return [];

    return uniqueValues(
        normalizeSearchText(String(value))
            .split(/[^a-z0-9]+/)
            .filter((token) => token.length >= 3 && !PRODUCT_THREAD_STOP_WORDS.has(token))
    );
}

function normalizeSearchText(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

function uniqueValues(values: string[]) {
    return Array.from(new Set(values));
}

function storefrontObservedProductLabel(bridge?: StorefrontIdentityBridge | null) {
    if (!bridge) return "";

    return [bridge.product_brand, bridge.product_model].filter(Boolean).join(" ").trim();
}

function getVerifiedBridgeForConversation(
    bridge: StorefrontIdentityBridge | null | undefined,
    item: InboxConversation
) {
    if (!bridge || bridge.status !== "linked") return null;

    const linkedToCurrentConversation = bridge.linked_conversation_id === item.conversation_id;
    const linkedToCurrentCustomer = Boolean(item.customer_id && bridge.linked_customer_id === item.customer_id);

    return linkedToCurrentConversation || linkedToCurrentCustomer ? bridge : null;
}

function bridgeIdentityStatus(bridge: StorefrontIdentityBridge | null | undefined, item: InboxConversation) {
    if (!bridge) return "La conversación no tiene correlación storefront confirmada.";

    if (bridge.status === "linked") {
        const linkedToCurrentConversation = bridge.linked_conversation_id === item.conversation_id;
        const linkedToCurrentCustomer = bridge.linked_customer_id === item.customer_id;

        if (linkedToCurrentConversation || linkedToCurrentCustomer) {
            return "Identidad enlazada por WhatsApp: sesión web correlacionada con esta conversación.";
        }

        return "Código enlazado, pero no coincide completamente con la conversación visible. Revisar antes de actuar.";
    }

    if (bridge.status === "expired" || bridge.status === "unresolved") {
        return "Handoff no resuelto. Mantener como señal anónima y no mezclar con Customer 360.";
    }

    return "Handoff abierto o pendiente. Aún requiere inbound WhatsApp válido para confirmar identidad.";
}

function buildIdentityBridgeAudit(bridge?: StorefrontIdentityBridge | null): Record<string, unknown> | null {
    if (!bridge) return null;

    return {
        source: "storefront_handoffs",
        handoff_id: bridge.id,
        handoff_code: bridge.handoff_code,
        status: bridge.status,
        storefront_session_ref: bridge.storefront_session_id ? shortId(bridge.storefront_session_id) : null,
        source_surface: bridge.source_surface,
        observed_product: storefrontObservedProductLabel(bridge) || null,
        observed_size: bridge.size_requested || null,
        intent: bridge.intent,
        funnel_stage: bridge.funnel_stage,
        linked_customer_id: bridge.linked_customer_id,
        linked_conversation_id: bridge.linked_conversation_id,
        linked_message_id: bridge.linked_message_id,
        created_at: bridge.created_at,
        linked_at: bridge.linked_at,
        expires_at: bridge.expires_at,
        guardrail: "correlation_not_authentication",
    };
}

function buildInboxEvidence(
    item: InboxConversation,
    identityBridge?: StorefrontIdentityBridge | null
): Record<string, unknown> {
    return {
        source: "admin_conversation_inbox_snapshot",
        conversation_id: item.conversation_id,
        stage: item.commercial?.stage,
        intent: item.commercial?.intent,
        risk_level: item.commercial?.risk_level,
        product: item.active_product?.display_name,
        size: item.active_product?.size,
        available_units: item.active_product?.available_units,
        product_context_source: item.active_product?.context_source,
        product_context_quality: item.active_product?.context_quality,
        product_context_warning: item.active_product?.context_warning,
        order_id: item.order?.order_id,
        payment_status: item.payment?.status,
        fulfillment_status: item.fulfillment?.status,
        paid_over_sla: item.fulfillment?.paid_over_sla,
        last_message_at: item.last_message_at,
        identity_bridge: buildIdentityBridgeAudit(identityBridge),
    };
}

function buildInboxActionContext(
    item: InboxConversation,
    actionType: string,
    messages: Message[],
    identityBridge?: StorefrontIdentityBridge | null,
    activeContextResolution?: ActiveContextResolution | null
): Record<string, unknown> {
    const productCoherence = getProductThreadCoherence(item, messages, identityBridge);
    const contextWarnings = buildProductContextWarnings(item, productCoherence);
    const recentMessages = messages.slice(-5).map((message) => ({
        direction: message.direction,
        role: message.role,
        preview: truncateText(message.body || "", 260),
        created_at: message.created_at,
    }));

    return {
        source: "admin_inbox",
        action_type: actionType,
        mode: "suggest_only",
        generated_at: new Date().toISOString(),
        guardrails: {
            no_auto_send: true,
            no_stock_mutation: true,
            no_payment_or_dispatch_execution: true,
            operator_approval_required: true,
            validate_product_thread_coherence: true,
            no_customer_profile_merge_without_identity_bridge: !identityBridge || identityBridge.status !== "linked",
        },
        context_warnings: contextWarnings,
        active_context_resolution: buildActiveContextResolutionAudit(activeContextResolution),
        conversation: {
            id: item.conversation_id,
            channel: item.channel,
            last_message_at: item.last_message_at,
            last_message_preview: item.last_message?.preview,
            recent_messages: recentMessages,
        },
        customer: {
            id: item.customer_id,
            name: item.customer_name,
            phone: item.phone_e164,
            city: item.customer_profile?.city,
            preferred_sizes: item.customer_profile?.preferred_sizes || [],
            preferred_brands: item.customer_profile?.preferred_brands || [],
            identity_bridge_status: identityBridge?.status || null,
        },
        identity_bridge: buildIdentityBridgeAudit(identityBridge),
        commercial: {
            stage: item.commercial?.stage,
            intent: item.commercial?.intent,
            risk_level: item.commercial?.risk_level,
            next_best_action: item.commercial?.next_best_action,
            handoff_required: item.commercial?.handoff_required,
            handoff_reason: item.commercial?.handoff_reason,
        },
        product: {
            id: item.active_product?.product_id,
            variant_id: item.active_product?.variant_id,
            name: item.active_product?.display_name,
            size: item.active_product?.size,
            available_units: item.active_product?.available_units,
            context_source: item.active_product?.context_source,
            context_quality: item.active_product?.context_quality,
            context_warning: item.active_product?.context_warning,
            thread_coherence: productCoherence,
        },
        order: {
            id: item.order?.order_id,
            status: item.order?.status,
            reference: item.order?.payment_reference,
            total_cents: item.order?.total_cents,
            context_source: item.order?.context_source,
        },
        fulfillment: {
            shipment_id: item.fulfillment?.shipment_id,
            status: item.fulfillment?.status,
            carrier_name: item.fulfillment?.carrier_name,
            tracking_number: item.fulfillment?.tracking_number,
            paid_over_sla: item.fulfillment?.paid_over_sla,
        },
    };
}

function truncateText(value: string, maxLength: number) {
    if (value.length <= maxLength) return value;
    return `${value.slice(0, maxLength - 3)}...`;
}

function buildSuggestedReply(
    item: InboxConversation,
    messages: Message[] = [],
    identityBridge?: StorefrontIdentityBridge | null,
    activeContextResolution?: ActiveContextResolution | null
) {
    const customerName = item.customer_name?.split(" ")[0] || "";
    const greeting = customerName ? `Hola ${customerName}, ` : "Hola, ";
    const product = item.active_product;
    const price = formatCents(product?.price_cents);
    const size = product?.size ? ` en talla ${product.size}` : "";
    const productCoherence = getProductThreadCoherence(item, messages, identityBridge);
    const linkedBridge = getVerifiedBridgeForConversation(identityBridge, item);
    const bridgeProductName = storefrontObservedProductLabel(linkedBridge);
    const bridgeSize = linkedBridge?.size_requested ? ` talla ${linkedBridge.size_requested}` : "";
    const activeContextReply = buildActiveContextSuggestedReply(
        item,
        linkedBridge,
        activeContextResolution,
        greeting
    );

    if (activeContextReply) return activeContextReply;

    if (!productCoherence.ok || product?.context_warning) {
        if (!productCoherence.ok && hasOperationalPaidOrder(item) && bridgeProductName) {
            return `${greeting}veo dos temas activos: un pedido ya aprobado pendiente de despacho y una consulta reciente por ${bridgeProductName}${bridgeSize}. Para ayudarte bien, ¿quieres que revisemos primero el despacho pendiente o continuamos con esa nueva compra?`;
        }

        return `${greeting}antes de avanzar quiero confirmar el modelo exacto que estás mirando ahora para no mezclar pedidos. ¿Me confirmas modelo y talla?`;
    }

    if (item.commercial?.stage === "fulfillment_pending" || item.fulfillment?.paid_over_sla) {
        return `${greeting}ya tenemos el pago registrado y estoy revisando el despacho de tu pedido. Te confirmo por este medio apenas quede la guía o novedad logística.`;
    }

    if (item.commercial?.stage === "payment_pending" || item.commercial?.stage === "payment_link_sent") {
        return `${greeting}tu pedido está listo para pago. Si tienes alguna duda antes de finalizar, te ayudo a revisarla por aquí.`;
    }

    if (product?.display_name && product?.available_units && Number(product.available_units) > 0) {
        const priceText = price === "-" ? "" : ` por ${price}`;
        return `${greeting}sí tenemos ${product.display_name}${size}${priceText}. Si quieres, puedo ayudarte a confirmar los datos de envío y dejar el pedido listo para pago.`;
    }

    if (product?.display_name) {
        return `${greeting}estoy revisando disponibilidad para ${product.display_name}${size}. Si me confirmas la talla o una alternativa, te respondo con las opciones reales en inventario.`;
    }

    return `${greeting}claro. ¿Tienes en mente alguna marca, modelo, talla o presupuesto? Con eso reviso opciones disponibles y te propongo las mejores alternativas.`;
}

async function copyTextToClipboard(value: string) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(value);
            return;
        } catch {
            // Some browser contexts deny Clipboard API writes even after a user click.
            // The textarea fallback keeps the operator flow usable without sending anything.
        }
    }

    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, value.length);

    try {
        const copied = document.execCommand("copy");
        if (!copied) throw new Error("copy command failed");
    } finally {
        document.body.removeChild(textarea);
    }
}

function selectVisibleDraftReply() {
    const textarea = document.querySelector<HTMLTextAreaElement>('[data-testid="inbox-draft-reply"]');
    if (!textarea) return false;

    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return true;
}

function normalizeRisk(value?: string | null): RiskLevel {
    if (value === "low" || value === "medium" || value === "high" || value === "critical") return value;
    return "medium";
}

function humanizeAction(value?: string | null) {
    const labels: Record<string, string> = {
        take_human_handoff: "tomar la conversación",
        dispatch_overdue_paid_order: "despachar una orden atrasada",
        prepare_dispatch: "preparar despacho",
        recover_payment: "recuperar pago pendiente",
        reply_with_product_context: "responder con contexto de producto",
        reply_to_customer: "responder al cliente",
        review_agent_actions: "revisar acciones AI Ops",
        monitor: "monitorear",
        review_conversation: "revisar conversación",
    };

    if (!value) return "monitorear";
    return labels[value] || value.replaceAll("_", " ");
}
