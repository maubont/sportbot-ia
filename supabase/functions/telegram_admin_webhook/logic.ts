export type AdminChannelUser = {
    id: string;
    admin_user_id: string;
    external_chat_id: string | null;
    role_scope: "owner" | "admin" | "operator" | "seller" | "read_only";
    allowed_commands: string[] | null;
    status: "active" | "paused" | "revoked";
};

export type TelegramUser = {
    id?: number;
    first_name?: string;
    last_name?: string;
    username?: string;
};

export type TelegramChat = {
    id?: number;
    type?: string;
};

export type TelegramMessage = {
    message_id?: number;
    text?: string;
    chat?: TelegramChat;
    from?: TelegramUser;
};

export type TelegramUpdate = {
    update_id?: number;
    message?: TelegramMessage;
    edited_message?: TelegramMessage;
};

export type AgentActionDraft = {
    actionType: string;
    targetType?: string | null;
    targetId?: string | null;
    targetRef?: string | null;
    riskLevel: "low" | "medium" | "high" | "critical";
    summary: string;
    evidence: Record<string, unknown>[];
    proposedPayload: Record<string, unknown>;
    approvalRequired: boolean;
};

export type CommandResult = {
    status: "processed";
    messageType: "command" | "text";
    response: string;
    normalizedIntent?: string;
    suggestedAction?: AgentActionDraft | null;
    agentActionId?: string | null;
};

export type ConversationalIntent = {
    command: string;
    label: string;
    lead: string;
};

export const COMMAND_ROLE_ALLOWLIST: Record<string, AdminChannelUser["role_scope"][]> = {
    "/ayuda": ["owner", "admin", "operator", "seller", "read_only"],
    "/help": ["owner", "admin", "operator", "seller", "read_only"],
    "/start": ["owner", "admin", "operator", "seller", "read_only"],
    "/resumen_hoy": ["owner", "admin", "operator", "read_only"],
    "/logistica": ["owner", "admin", "operator"],
    "/pagadas_sin_despacho": ["owner", "admin", "operator"],
    "/stock_critico": ["owner", "admin", "operator", "seller", "read_only"],
    "/margen_riesgo": ["owner"],
    "/acciones": ["owner", "admin"],
};

export function timingSafeEqual(left: string, right: string) {
    const leftBytes = new TextEncoder().encode(left);
    const rightBytes = new TextEncoder().encode(right);
    if (leftBytes.length !== rightBytes.length) return false;

    let diff = 0;
    for (let index = 0; index < leftBytes.length; index += 1) {
        diff |= leftBytes[index] ^ rightBytes[index];
    }

    return diff === 0;
}

export function cleanText(value: unknown) {
    if (typeof value !== "string") return "";
    return value.replace(/\s+/g, " ").trim().slice(0, 2000);
}

export function normalizeForIntent(value: string) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();
}

export function includesAny(text: string, patterns: string[]) {
    return patterns.some((pattern) => text.includes(pattern));
}

export function roleCanCreateAgentAction(row: AdminChannelUser) {
    return ["owner", "admin", "operator", "seller"].includes(row.role_scope);
}

export function shouldCreateSuggestedAction(text: string) {
    const normalized = normalizeForIntent(text);
    return includesAny(normalized, [
        "accion",
        "acciones",
        "crear",
        "crea",
        "genera",
        "generar",
        "prepara",
        "preparar",
        "deja",
        "dejame",
        "registrar",
        "registra",
        "abre",
        "abrir",
        "que hago",
        "que debo hacer",
        "primero",
        "prioridad",
        "prioridades",
        "urgente",
    ]);
}

export function normalizeCommand(text: string) {
    const firstToken = cleanText(text).split(" ")[0] || "";
    const withoutBotUsername = firstToken.split("@")[0] || firstToken;
    return withoutBotUsername.toLowerCase();
}

export function getMessage(update: TelegramUpdate) {
    return update.message || update.edited_message || null;
}

export function getAllowedCommands(row: AdminChannelUser) {
    const commands = Array.isArray(row.allowed_commands) ? row.allowed_commands : [];
    return new Set(commands.map((command) => command.toLowerCase()));
}

export function roleCanRunCommand(row: AdminChannelUser, command: string) {
    const allowedRoles = COMMAND_ROLE_ALLOWLIST[command];
    if (!allowedRoles) return false;
    return allowedRoles.includes(row.role_scope);
}

export function isHelpCommand(command: string) {
    return command === "/ayuda" || command === "/help" || command === "/start";
}

export function canRunCommand(row: AdminChannelUser, command: string) {
    if (isHelpCommand(command)) return roleCanRunCommand(row, command);
    return getAllowedCommands(row).has(command) && roleCanRunCommand(row, command);
}

export function detectConversationalIntent(text: string): ConversationalIntent {
    const normalized = normalizeForIntent(cleanText(text));

    if (!normalized || includesAny(normalized, ["ayuda", "help", "comando", "que puedes", "como funcionas"])) {
        return {
            command: "/ayuda",
            label: "help",
            lead: "Claro. Estas son las capacidades seguras disponibles ahora:",
        };
    }

    if (includesAny(normalized, ["margen", "rentabilidad", "utilidad", "costo", "costos", "perdiendo plata", "perdiendo dinero"])) {
        return {
            command: "/margen_riesgo",
            label: "margin_risk",
            lead: "Reviso margen y calidad de costos con permiso de owner:",
        };
    }

    if (includesAny(normalized, ["stock", "inventario", "agotado", "agotados", "reposicion", "reponer", "tallas criticas"])) {
        return {
            command: "/stock_critico",
            label: "critical_stock",
            lead: "Miro inventario con foco en referencias/tallas que pueden frenar ventas:",
        };
    }

    if (includesAny(normalized, ["logistica", "despacho", "despacha", "despachar", "envio", "enviar", "envia", "entrega", "tracking", "guia", "transportadora", "pagadas sin despacho", "atrasado", "atrasados"])) {
        return {
            command: "/logistica",
            label: "logistics",
            lead: "Te resumo la operacion logistica y la cola que requiere atencion:",
        };
    }

    if (
        includesAny(normalized, [
            "acciones abiertas",
            "acciones hay",
            "acciones pendientes",
            "acciones ai ops",
            "que acciones",
            "listar acciones",
            "ver acciones",
            "accion abierta",
            "ai ops",
            "openclaw",
            "pendiente aprobar",
            "aprobacion",
            "aprobaciones",
        ])
    ) {
        return {
            command: "/acciones",
            label: "agent_actions",
            lead: "Reviso las acciones AI Ops abiertas para que no se nos pierda nada:",
        };
    }

    if (includesAny(normalized, ["urgente", "prioridad", "prioridades", "primero", "que hago", "que sigue", "decision", "decisiones"])) {
        return {
            command: "/resumen_hoy",
            label: "daily_priority",
            lead: "Si lo traduzco a decision operativa, esto es lo primero que miraria:",
        };
    }

    if (includesAny(normalized, ["resumen", "hoy", "ventas", "pedidos", "dashboard", "estado", "como vamos", "como va"])) {
        return {
            command: "/resumen_hoy",
            label: "daily_summary",
            lead: "Te doy un resumen ejecutivo con los datos disponibles ahora:",
        };
    }

    return {
        command: "/resumen_hoy",
        label: "general_ops_question",
        lead: "No lo trato como orden. Lo interpreto como una pregunta operativa general y parto por el resumen seguro:",
    };
}

export function formatHelp(row: AdminChannelUser) {
    const allowed = [...getAllowedCommands(row)].sort();
    const baseCommands = allowed.length > 0 ? allowed : ["/ayuda"];
    const visibleCommands = [...new Set(baseCommands.includes("/ayuda") ? [...baseCommands, "/help"] : baseCommands)]
        .sort()
        .filter((command) => roleCanRunCommand(row, command));

    return [
        "SportBot AI Ops esta activo en modo seguro.",
        "",
        `Rol: ${row.role_scope}`,
        "Comandos permitidos:",
        ...visibleCommands.map((command) => `- ${command}`),
        "",
        "Por ahora no ejecuto despacho, cambios de stock, precios, costos ni mensajes masivos desde Telegram.",
    ].join("\n");
}
