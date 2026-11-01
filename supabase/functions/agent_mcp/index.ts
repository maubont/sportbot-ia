import { createClient } from "npm:@supabase/supabase-js@2";
import { authorizeRequest, handleJsonRpc, validateMcpHttpRequest } from "./agent-mcp-core.ts";
import { assertRateLimit, createAgentToolExecutor, recordToolCall } from "./agent-tools.ts";

function allowedOrigins(): string[] {
    return (Deno.env.get("AGENT_MCP_ALLOWED_ORIGINS") ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function corsHeadersFor(req: Request, origins: string[]) {
    const headers: Record<string, string> = {
        "Access-Control-Allow-Headers": "authorization, content-type, accept, x-agent-secret, mcp-protocol-version, mcp-method, mcp-name",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Vary": "Origin",
    };
    const origin = req.headers.get("origin");
    if (origin && origins.includes(origin)) headers["Access-Control-Allow-Origin"] = origin;
    return headers;
}

function json(body: unknown, headers: Record<string, string>, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...headers, "Content-Type": "application/json" },
    });
}

async function readJsonBody(req: Request, maximumBytes = 64 * 1024): Promise<unknown> {
    if (!req.body) throw new SyntaxError("Empty request body");
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maximumBytes) {
                await reader.cancel();
                throw new RangeError("Request body too large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
}

function serviceClient() {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new Error("Supabase environment is not configured");
    return createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false },
    });
}

const adminBaseUrl = (Deno.env.get("ADMIN_BASE_URL") ?? "https://sportbot-admin.netlify.app").trim();

Deno.serve(async (req) => {
    const origins = allowedOrigins();
    const corsHeaders = corsHeadersFor(req, origins);

    const requestOrigin = req.headers.get("origin");
    if (requestOrigin && !origins.includes(requestOrigin)) {
        return json({ error: "Origin not allowed" }, corsHeaders, 403);
    }

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

    if (req.method !== "POST") {
        return json({ error: "Method Not Allowed" }, corsHeaders, 405);
    }

    if (!authorizeRequest(req, Deno.env.get("AGENT_MCP_SECRET"))) {
        return json({ error: "Unauthorized" }, corsHeaders, 401);
    }

    let payload: unknown;
    try {
        payload = await readJsonBody(req);
    } catch (error) {
        const tooLarge = error instanceof RangeError;
        return json({ jsonrpc: "2.0", id: null, error: { code: tooLarge ? -32600 : -32700, message: tooLarge ? "Request body too large" : "Parse error" } }, corsHeaders, tooLarge ? 413 : 400);
    }

    const validation = validateMcpHttpRequest(req, payload, origins);
    if (!validation.ok) return json(validation.response, corsHeaders, validation.status);

    if (validation.isNotification) return new Response(null, { status: 202, headers: corsHeaders });

    const supabase = serviceClient();
    const execute = createAgentToolExecutor(supabase, { adminBaseUrl });

    const response = await handleJsonRpc(payload, async (name, args) => {
        const startedAt = Date.now();
        try {
            await assertRateLimit(supabase);
            const result = await execute(name, args);
            await recordToolCall(supabase, {
                toolName: name,
                args,
                status: "ok",
                latencyMs: Date.now() - startedAt,
            });
            return result;
        } catch (error) {
            await recordToolCall(supabase, {
                toolName: name,
                args,
                status: "error",
                error: error instanceof Error ? error.message : String(error),
                latencyMs: Date.now() - startedAt,
            });
            throw error;
        }
    }, { era: validation.era, protocolVersion: validation.protocolVersion });

    if (response === null) {
        return new Response(null, { status: 202, headers: corsHeaders });
    }

    const status = response.error?.code === -32601
        ? 404
        : response.error?.code === -32600 || response.error?.code === -32602 || response.error?.code === -32020 || response.error?.code === -32022
          ? 400
          : 200;
    return json(response, corsHeaders, status);
});
