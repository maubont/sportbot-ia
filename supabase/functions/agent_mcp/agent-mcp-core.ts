/**
 * Agent Proxy MCP core (Streamable HTTP, stateless).
 *
 * Pure protocol + schemas + validation. The Deno edge function injects the
 * database executor, so this file is testable with Node.
 *
 * Security posture:
 *   - Fail-closed bearer secret.
 *   - Read-only tools plus "create proposal" (never executes money/stock).
 *   - Strict JSON Schemas and unknown-key rejection.
 *   - Every call is audited by the edge function.
 */

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
    jsonrpc?: string;
    id?: JsonRpcId;
    method?: string;
    params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
};

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
};

export const SUPPORTED_PROTOCOLS = [
    "2026-07-28",
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
] as const;

export const CURRENT_PROTOCOL = "2026-07-28";
export const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

export const SERVER_INFO = {
    name: "sportbot-agent-proxy",
    version: "1.0.0",
};

export const SERVER_INSTRUCTIONS = [
    "SportBot Agent Proxy. Solo lectura y propuestas auditadas.",
    "No aprueba pagos, no mueve dinero, no cambia stock, no despacha y no envía mensajes.",
    "Toda acción sensible se registra en agent_actions como pending_approval y se decide en /ai-ops.",
    "Los datos de contacto se devuelven enmascarados; la ficha completa vive en el Admin.",
].join(" ");

const READ_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

const PROPOSAL_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

const limitSchema = (maximum: number) => ({
    type: "integer",
    minimum: 1,
    maximum,
    description: `Máximo de resultados (1-${maximum}). Default 10.`,
});

export const TOOLS: ToolDefinition[] = [
    {
        name: "get_operations_brief",
        description:
            "Resumen operativo del día en America/Bogota: pedidos creados, recaudo, pagos esperando comprobante, despachos pendientes y atrasados, stock bajo y propuestas abiertas. Solo lectura.",
        inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
        },
        annotations: READ_ANNOTATIONS,
    },
    {
        name: "list_payment_queue",
        description:
            "Pedidos esperando pago, con último comprobante y última decisión humana. No aprueba ni rechaza; solo informa.",
        inputSchema: {
            type: "object",
            properties: { limit: limitSchema(20) },
            additionalProperties: false,
        },
        annotations: READ_ANNOTATIONS,
    },
    {
        name: "get_order",
        description:
            "Ficha compacta de un pedido por UUID o por referencia ORD-...; incluye items, envío, comprobantes y decisiones. El teléfono se devuelve enmascarado.",
        inputSchema: {
            type: "object",
            properties: {
                order_id: { type: "string", description: "UUID exacto del pedido." },
                payment_reference: { type: "string", description: "Referencia exacta, por ejemplo ORD-20261026215040-7CCB8B." },
            },
            anyOf: [{ required: ["order_id"] }, { required: ["payment_reference"] }],
            additionalProperties: false,
        },
        annotations: READ_ANNOTATIONS,
    },
    {
        name: "list_inventory_alerts",
        description:
            "Variantes de productos activos con stock disponible menor a 3 (stock menos reservado). Solo lectura.",
        inputSchema: {
            type: "object",
            properties: { limit: limitSchema(30) },
            additionalProperties: false,
        },
        annotations: READ_ANNOTATIONS,
    },
    {
        name: "list_logistics_queue",
        description:
            "Pedidos pagados sin despacho, envíos activos sin guía y notificaciones logísticas fallidas. Solo lectura.",
        inputSchema: {
            type: "object",
            properties: { limit: limitSchema(20) },
            additionalProperties: false,
        },
        annotations: READ_ANNOTATIONS,
    },
    {
        name: "create_agent_action",
        description:
            "Crea una propuesta auditada en AI Ops. NO ejecuta nada: no cobra, no despacha, no cambia stock y no envía mensajes. Un humano la aprueba o rechaza en /ai-ops.",
        inputSchema: {
            type: "object",
            properties: {
                action_type: {
                    type: "string",
                    pattern: "^[a-z][a-z0-9_]{2,60}$",
                    description: "Tipo estable en snake_case, por ejemplo dispatch_review, margin_data_review, payment_follow_up.",
                },
                summary: {
                    type: "string",
                    minLength: 8,
                    maxLength: 600,
                    description: "Qué se propone y por qué, en una frase accionable.",
                },
                risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
                target_type: { type: "string", maxLength: 80, description: "order, product_variant, conversation, logistics..." },
                target_id: { type: "string", maxLength: 200 },
                target_ref: { type: "string", maxLength: 200, description: "Referencia humana, por ejemplo ORD-... o talla." },
                proposed_payload: {
                    type: "object",
                    description: "Datos de la propuesta. El ejecutor los valida antes de actuar.",
                },
                evidence: {
                    type: "array",
                    maxItems: 20,
                    items: { type: "object" },
                    description: "Evidencia usada (snapshot, IDs, métricas).",
                },
                expires_in_hours: { type: "integer", minimum: 1, maximum: 72, description: "Default 24." },
            },
            required: ["action_type", "summary", "risk_level"],
            additionalProperties: false,
        },
        annotations: PROPOSAL_ANNOTATIONS,
    },
];

export function negotiateProtocol(requested: unknown): string {
    if (typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)) {
        return requested;
    }
    return SUPPORTED_PROTOCOLS[0];
}

function timingSafeEqual(left: string, right: string): boolean {
    const a = new TextEncoder().encode(left);
    const b = new TextEncoder().encode(right);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
}

export function authorizeRequest(req: Request, expectedSecret: string | null | undefined): boolean {
    const secret = (expectedSecret ?? "").trim();
    if (!secret) return false;

    const authorization = req.headers.get("authorization") ?? "";
    const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? "";
    const provided = bearer || (req.headers.get("x-agent-secret") ?? "").trim();
    if (!provided) return false;

    return timingSafeEqual(provided, secret);
}

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
    return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function completeResult(id: JsonRpcId, value: Record<string, unknown>, modern: boolean): JsonRpcResponse {
    if (!modern) return jsonRpcResult(id, value);
    return jsonRpcResult(id, {
        resultType: "complete",
        ...value,
        _meta: { "io.modelcontextprotocol/serverInfo": SERVER_INFO },
    });
}

export type McpHttpValidation =
    | { ok: true; era: "modern" | "legacy"; protocolVersion: string; isNotification: boolean }
    | { ok: false; status: number; response: JsonRpcResponse };

function parseAccept(value: string | null): Set<string> {
    return new Set((value ?? "").split(",").map((entry) => entry.split(";")[0].trim().toLowerCase()).filter(Boolean));
}

function decodeMcpNameHeader(value: string): string | null {
    if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
    const encoded = value.slice("=?base64?".length, -2);
    try {
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
}

function validationFailure(status: number, id: JsonRpcId, code: number, message: string, data?: unknown): McpHttpValidation {
    return { ok: false, status, response: jsonRpcError(id, code, message, data) };
}

/** Validate the Streamable HTTP envelope before dispatching JSON-RPC. */
export function validateMcpHttpRequest(
    req: Request,
    payload: unknown,
    allowedOrigins: readonly string[] = [],
): McpHttpValidation {
    const candidate = isPlainObject(payload) ? payload : null;
    const id: JsonRpcId = candidate && (typeof candidate.id === "string" || typeof candidate.id === "number")
        ? candidate.id as string | number
        : null;

    const origin = req.headers.get("origin");
    if (origin && !allowedOrigins.includes(origin)) {
        return validationFailure(403, id, -32600, "Origin not allowed");
    }

    if (req.method !== "POST") return validationFailure(405, id, -32600, "Method Not Allowed");

    const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (contentType !== "application/json") return validationFailure(415, id, -32600, "Content-Type must be application/json");

    const accepts = parseAccept(req.headers.get("accept"));
    if (!accepts.has("application/json") || !accepts.has("text/event-stream")) {
        return validationFailure(406, id, -32600, "Accept must include application/json and text/event-stream");
    }

    if (!candidate || candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") {
        return validationFailure(400, id, -32600, "Invalid Request");
    }
    const isNotification = !Object.prototype.hasOwnProperty.call(candidate, "id");
    if (!isNotification && !(typeof candidate.id === "string" || (typeof candidate.id === "number" && Number.isSafeInteger(candidate.id)))) {
        return validationFailure(400, null, -32600, "Request id must be a string or safe integer");
    }
    const params = candidate.params === undefined ? {} : isPlainObject(candidate.params) ? candidate.params : null;
    if (!params) return validationFailure(400, id, -32602, "params must be an object");

    const metadata = isPlainObject(params._meta) ? params._meta : null;
    const bodyVersion = metadata?.["io.modelcontextprotocol/protocolVersion"];
    const headerVersion = req.headers.get("mcp-protocol-version");
    const isModern = typeof bodyVersion === "string";

    if (isModern) {
        if (!headerVersion || headerVersion !== bodyVersion) {
            return validationFailure(400, id, -32020, "Header mismatch: MCP-Protocol-Version must match request metadata");
        }
        if (bodyVersion !== CURRENT_PROTOCOL) {
            return validationFailure(400, id, -32022, "Unsupported protocol version", {
                supported: [CURRENT_PROTOCOL],
                requested: bodyVersion,
            });
        }
        if (!isPlainObject(metadata?.["io.modelcontextprotocol/clientCapabilities"])) {
            return validationFailure(400, id, -32602, "Missing or invalid clientCapabilities in request metadata");
        }
        const clientInfo = metadata?.["io.modelcontextprotocol/clientInfo"];
        if (clientInfo !== undefined && (!isPlainObject(clientInfo) || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string")) {
            return validationFailure(400, id, -32602, "Invalid clientInfo in request metadata");
        }
        const methodHeader = req.headers.get("mcp-method");
        if (!methodHeader || methodHeader !== candidate.method) {
            return validationFailure(400, id, -32020, "Header mismatch: Mcp-Method must match request method");
        }
        const expectedName = candidate.method === "tools/call" && typeof params.name === "string" ? params.name : null;
        const nameHeader = req.headers.get("mcp-name");
        if (candidate.method === "tools/call") {
            const decodedName = nameHeader ? decodeMcpNameHeader(nameHeader) : null;
            if (!expectedName || !decodedName || decodedName !== expectedName) {
                return validationFailure(400, id, -32020, "Header mismatch: Mcp-Name must match tool name");
            }
        }
        return { ok: true, era: "modern", protocolVersion: CURRENT_PROTOCOL, isNotification };
    }

    // Legacy clients use initialize once, then the protocol-version header.
    // Keep compatibility while OpenClaw clients migrate to per-request _meta.
    let legacyVersion: unknown = headerVersion;
    if (candidate.method === "initialize") {
        legacyVersion = params.protocolVersion ?? headerVersion;
        if (legacyVersion === CURRENT_PROTOCOL) {
            return validationFailure(400, id, -32022, "Use per-request metadata for protocol 2026-07-28", {
                supported: [CURRENT_PROTOCOL],
                requested: legacyVersion,
            });
        }
        if (headerVersion && params.protocolVersion && headerVersion !== params.protocolVersion) {
            return validationFailure(400, id, -32020, "Header mismatch: MCP-Protocol-Version does not match initialize version");
        }
    }
    if (typeof legacyVersion !== "string" || !(LEGACY_PROTOCOLS as readonly string[]).includes(legacyVersion)) {
        return validationFailure(400, id, -32602, "Missing or unsupported MCP per-request metadata");
    }
    const methodHeader = req.headers.get("mcp-method");
    if (methodHeader && methodHeader !== candidate.method) {
        return validationFailure(400, id, -32020, "Header mismatch: Mcp-Method must match request method");
    }
    return { ok: true, era: "legacy", protocolVersion: legacyVersion, isNotification };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownKeys(args: Record<string, unknown>, allowed: string[]): void {
    const unknown = Object.keys(args).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new Error(`Parámetros no permitidos: ${unknown.join(", ")}`);
}

function readLimit(args: Record<string, unknown>, maximum: number, fallback = 10): number {
    if (args.limit === undefined) return fallback;
    if (typeof args.limit !== "number" || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > maximum) {
        throw new Error(`limit debe ser un entero entre 1 y ${maximum}`);
    }
    return args.limit;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYMENT_REFERENCE_RE = /^ORD-[A-Z0-9-]{8,40}$/;

export type ToolValidation = { ok: true; args: Record<string, unknown> } | { ok: false; message: string };

export function validateToolArgs(name: string, rawArgs: unknown): ToolValidation {
    try {
        if (!isPlainObject(rawArgs)) throw new Error("arguments debe ser un objeto");
        const args = rawArgs;

        switch (name) {
            case "get_operations_brief":
                rejectUnknownKeys(args, []);
                return { ok: true, args: {} };

            case "list_payment_queue":
                rejectUnknownKeys(args, ["limit"]);
                return { ok: true, args: { limit: readLimit(args, 20) } };

            case "list_inventory_alerts":
                rejectUnknownKeys(args, ["limit"]);
                return { ok: true, args: { limit: readLimit(args, 30) } };

            case "list_logistics_queue":
                rejectUnknownKeys(args, ["limit"]);
                return { ok: true, args: { limit: readLimit(args, 20) } };

            case "get_order": {
                rejectUnknownKeys(args, ["order_id", "payment_reference"]);
                const hasId = typeof args.order_id === "string" && args.order_id.trim() !== "";
                const hasRef = typeof args.payment_reference === "string" && args.payment_reference.trim() !== "";
                if (hasId === hasRef) throw new Error("Indica exactamente uno: order_id o payment_reference");
                if (hasId && !UUID_RE.test(String(args.order_id))) throw new Error("order_id debe ser un UUID válido");
                if (hasRef && !PAYMENT_REFERENCE_RE.test(String(args.payment_reference))) {
                    throw new Error("payment_reference debe tener la forma ORD-...");
                }
                return {
                    ok: true,
                    args: hasId
                        ? { order_id: String(args.order_id).trim() }
                        : { payment_reference: String(args.payment_reference).trim() },
                };
            }

            case "create_agent_action": {
                rejectUnknownKeys(args, [
                    "action_type",
                    "summary",
                    "risk_level",
                    "target_type",
                    "target_id",
                    "target_ref",
                    "proposed_payload",
                    "evidence",
                    "expires_in_hours",
                ]);

                const actionType = typeof args.action_type === "string" ? args.action_type.trim() : "";
                if (!/^[a-z][a-z0-9_]{2,60}$/.test(actionType)) {
                    throw new Error("action_type debe ser snake_case (3-61 caracteres)");
                }

                const summary = typeof args.summary === "string" ? args.summary.trim() : "";
                if (summary.length < 8 || summary.length > 600) throw new Error("summary debe tener entre 8 y 600 caracteres");

                const risk = args.risk_level;
                if (!["low", "medium", "high", "critical"].includes(String(risk))) {
                    throw new Error("risk_level inválido");
                }

                for (const key of ["target_type", "target_id", "target_ref"] as const) {
                    if (args[key] !== undefined && (typeof args[key] !== "string" || String(args[key]).length > 200)) {
                        throw new Error(`${key} debe ser texto de hasta 200 caracteres`);
                    }
                }

                if (args.proposed_payload !== undefined && !isPlainObject(args.proposed_payload)) {
                    throw new Error("proposed_payload debe ser un objeto");
                }

                if (args.evidence !== undefined) {
                    if (!Array.isArray(args.evidence) || args.evidence.length > 20 || args.evidence.some((item) => !isPlainObject(item))) {
                        throw new Error("evidence debe ser un arreglo de hasta 20 objetos");
                    }
                }

                const expires = args.expires_in_hours === undefined ? 24 : args.expires_in_hours;
                if (typeof expires !== "number" || !Number.isInteger(expires) || expires < 1 || expires > 72) {
                    throw new Error("expires_in_hours debe ser un entero entre 1 y 72");
                }

                const normalized = {
                    action_type: actionType,
                    summary,
                    risk_level: String(risk),
                    ...(args.target_type === undefined ? {} : { target_type: String(args.target_type) }),
                    ...(args.target_id === undefined ? {} : { target_id: String(args.target_id) }),
                    ...(args.target_ref === undefined ? {} : { target_ref: String(args.target_ref) }),
                    ...(args.proposed_payload === undefined ? {} : { proposed_payload: args.proposed_payload }),
                    ...(args.evidence === undefined ? {} : { evidence: args.evidence }),
                    expires_in_hours: expires,
                };

                if (JSON.stringify(normalized).length > 20_000) throw new Error("La propuesta excede 20 KB");
                return { ok: true, args: normalized };
            }

            default:
                throw new Error(`Herramienta desconocida: ${name}`);
        }
    } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : "Argumentos inválidos" };
    }
}

export async function handleJsonRpc(
    payload: unknown,
    execute: ToolExecutor,
    options: { era?: "modern" | "legacy"; protocolVersion?: string } = {},
): Promise<JsonRpcResponse | null> {
    if (!isPlainObject(payload)) {
        return jsonRpcError(null, -32600, "Invalid Request");
    }

    const request = payload as JsonRpcRequest;
    const id = request.id ?? null;
    const method = request.method;
    const modern = options.era === "modern";

    if (typeof method !== "string" || method.length === 0) {
        return jsonRpcError(id, -32600, "Invalid Request");
    }

    if (method.startsWith("notifications/")) {
        return null;
    }

    switch (method) {
        case "server/discover":
            if (!modern) return jsonRpcError(id, -32601, "Method not found: server/discover");
            return completeResult(id, {
                supportedVersions: [...SUPPORTED_PROTOCOLS],
                capabilities: { tools: { listChanged: false } },
                instructions: SERVER_INSTRUCTIONS,
                ttlMs: 3_600_000,
                cacheScope: "public",
            }, true);

        case "initialize": {
            if (modern) return jsonRpcError(id, -32601, "Method not found: initialize");
            const requested = isPlainObject(request.params) ? request.params.protocolVersion : undefined;
            const protocolVersion = options.protocolVersion ?? negotiateProtocol(requested);
            return jsonRpcResult(id, {
                protocolVersion,
                capabilities: { tools: { listChanged: false } },
                serverInfo: SERVER_INFO,
                instructions: SERVER_INSTRUCTIONS,
            });
        }

        case "ping":
            return completeResult(id, {}, modern);

        case "tools/list":
            return completeResult(id, {
                tools: TOOLS,
                ...(modern ? { ttlMs: 300_000, cacheScope: "public" } : {}),
            }, modern);

        case "tools/call": {
            const params = isPlainObject(request.params) ? request.params : {};
            const name = typeof params.name === "string" ? params.name : "";
            const tool = TOOLS.find((item) => item.name === name);
            if (!tool) return jsonRpcError(id, -32602, `Herramienta desconocida: ${name || "(vacía)"}`);

            const validation = validateToolArgs(name, params.arguments ?? {});
            if (!validation.ok) {
                return completeResult(id, {
                    content: [{ type: "text", text: validation.message }],
                    isError: true,
                }, modern);
            }

            try {
                const result = await execute(name, validation.args);
                return completeResult(id, {
                    content: [{ type: "text", text: JSON.stringify(result) }],
                    structuredContent: result,
                    isError: false,
                }, modern);
            } catch (error) {
                const message = error instanceof Error ? error.message : "Error ejecutando la herramienta";
                return completeResult(id, {
                    content: [{ type: "text", text: `Error: ${message}` }],
                    isError: true,
                }, modern);
            }
        }

        default:
            return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
}
