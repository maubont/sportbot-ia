import { test } from "node:test";
import assert from "node:assert/strict";
import {
    TOOLS,
    CURRENT_PROTOCOL,
    SUPPORTED_PROTOCOLS,
    authorizeRequest,
    handleJsonRpc,
    negotiateProtocol,
    validateMcpHttpRequest,
    validateToolArgs,
} from "./agent-mcp-core.ts";

function request(headers = {}) {
    return new Request("https://example.test/functions/v1/agent_mcp", { method: "POST", headers });
}

test("auth: fail-closed y acepta bearer o x-agent-secret", () => {
    assert.equal(authorizeRequest(request(), ""), false, "sin secreto configurado no se acepta");
    assert.equal(authorizeRequest(request(), "s3cret"), false, "sin credencial no se acepta");
    assert.equal(authorizeRequest(request({ authorization: "Bearer s3cret" }), "s3cret"), true);
    assert.equal(authorizeRequest(request({ "x-agent-secret": "s3cret" }), "s3cret"), true);
    assert.equal(authorizeRequest(request({ authorization: "Bearer otro" }), "s3cret"), false);
});

test("protocolo: negocia versión soportada y cae a la más reciente", () => {
    assert.equal(negotiateProtocol("2025-06-18"), "2025-06-18");
    assert.equal(negotiateProtocol("2026-07-28"), "2026-07-28");
    assert.equal(negotiateProtocol("1999-01-01"), "2026-07-28");
    assert.equal(negotiateProtocol(undefined), "2026-07-28");
});

function modernRequest(method, params = {}, overrides = {}) {
    const payload = {
        jsonrpc: "2.0",
        id: 10,
        method,
        params: {
            ...params,
            _meta: {
                "io.modelcontextprotocol/protocolVersion": CURRENT_PROTOCOL,
                "io.modelcontextprotocol/clientCapabilities": {},
                "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            },
        },
    };
    const headers = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": CURRENT_PROTOCOL,
        "mcp-method": method,
        ...(method === "tools/call" && typeof params.name === "string" ? { "mcp-name": params.name } : {}),
        ...overrides,
    };
    return { request: new Request("https://example.test/mcp", { method: "POST", headers }), payload };
}

test("Streamable HTTP moderno valida metadata, headers y Origin", () => {
    const valid = modernRequest("tools/list");
    assert.deepEqual(validateMcpHttpRequest(valid.request, valid.payload), {
        ok: true,
        era: "modern",
        protocolVersion: CURRENT_PROTOCOL,
        isNotification: false,
    });

    const missingMethod = modernRequest("tools/list", {}, { "mcp-method": "tools/call" });
    const methodResult = validateMcpHttpRequest(missingMethod.request, missingMethod.payload);
    assert.equal(methodResult.ok, false);
    assert.equal(methodResult.response.error.code, -32020);

    const unsupported = modernRequest("tools/list", {}, { "mcp-protocol-version": "2099-01-01" });
    const unsupportedPayload = structuredClone(unsupported.payload);
    unsupportedPayload.params._meta["io.modelcontextprotocol/protocolVersion"] = "2099-01-01";
    const unsupportedResult = validateMcpHttpRequest(unsupported.request, unsupportedPayload);
    assert.equal(unsupportedResult.ok, false);
    assert.equal(unsupportedResult.response.error.code, -32022);

    const wrongOrigin = modernRequest("tools/list");
    const originRequest = new Request("https://example.test/mcp", {
        method: "POST",
        headers: { ...Object.fromEntries(wrongOrigin.request.headers), origin: "https://evil.example" },
    });
    const originResult = validateMcpHttpRequest(originRequest, wrongOrigin.payload, ["https://sportbot-admin.netlify.app"]);
    assert.equal(originResult.ok, false);
    assert.equal(originResult.status, 403);

    const badAccept = modernRequest("tools/list", {}, { accept: "application/json" });
    assert.equal(validateMcpHttpRequest(badAccept.request, badAccept.payload).status, 406);

    const badName = modernRequest("tools/call", { name: "get_order", arguments: {} }, { "mcp-name": "list_payment_queue" });
    const nameResult = validateMcpHttpRequest(badName.request, badName.payload);
    assert.equal(nameResult.ok, false);
    assert.equal(nameResult.response.error.code, -32020);
});

test("tools/list expone seis herramientas y separa lectura de propuesta", () => {
    assert.equal(TOOLS.length, 6);
    const names = TOOLS.map((tool) => tool.name);
    assert.deepEqual(names, [
        "get_operations_brief",
        "list_payment_queue",
        "get_order",
        "list_inventory_alerts",
        "list_logistics_queue",
        "create_agent_action",
    ]);

    const proposal = TOOLS.find((tool) => tool.name === "create_agent_action");
    assert.equal(proposal.annotations.readOnlyHint, false);
    assert.equal(proposal.inputSchema.additionalProperties, false);

    for (const tool of TOOLS.filter((item) => item.name !== "create_agent_action")) {
        assert.equal(tool.annotations.readOnlyHint, true);
        assert.equal(tool.inputSchema.additionalProperties, false);
    }
});

test("validación: get_order exige exactamente un identificador", () => {
    assert.equal(validateToolArgs("get_order", {}).ok, false);
    assert.equal(validateToolArgs("get_order", { order_id: "abc" }).ok, false);
    assert.equal(validateToolArgs("get_order", {
        order_id: "8071fd8b-b0ba-4ae9-ac3d-360348965059",
        payment_reference: "ORD-20261026215040-7CCB8B",
    }).ok, false);
    assert.equal(validateToolArgs("get_order", {
        order_id: "8071fd8b-b0ba-4ae9-ac3d-360348965059",
    }).ok, true);
    assert.equal(validateToolArgs("get_order", {
        payment_reference: "ORD-20261026215040-7CCB8B",
    }).ok, true);
    assert.equal(validateToolArgs("get_order", { payment_reference: "otra-cosa" }).ok, false);
});

test("validación: create_agent_action rechaza extras y limita tamaño", () => {
    const valid = validateToolArgs("create_agent_action", {
        action_type: "dispatch_review",
        summary: "Revisar el despacho del pedido ORD-20261026215040-7CCB8B.",
        risk_level: "medium",
        target_type: "order",
        target_id: "8071fd8b-b0ba-4ae9-ac3d-360348965059",
        proposed_payload: { next_step: "review_dispatch" },
        evidence: [{ source: "list_logistics_queue" }],
    });
    assert.equal(valid.ok, true);
    assert.equal(valid.args.expires_in_hours, 24);

    assert.equal(validateToolArgs("create_agent_action", {
        action_type: "Dispatch Review",
        summary: "Resumen suficientemente largo",
        risk_level: "medium",
    }).ok, false);
    assert.equal(validateToolArgs("create_agent_action", {
        action_type: "dispatch_review",
        summary: "corto",
        risk_level: "medium",
    }).ok, false);
    assert.equal(validateToolArgs("create_agent_action", {
        action_type: "dispatch_review",
        summary: "Resumen suficientemente largo",
        risk_level: "medium",
        status: "approved",
    }).ok, false);
    assert.equal(validateToolArgs("create_agent_action", {
        action_type: "dispatch_review",
        summary: "Resumen suficientemente largo",
        risk_level: "medium",
        evidence: Array.from({ length: 21 }, () => ({})),
    }).ok, false);
});

test("MCP moderno: server/discover, tools/list y tools/call", async () => {
    const execute = async (name, args) => ({ tool: name, args });

    const discover = await handleJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {},
    }, execute, { era: "modern", protocolVersion: CURRENT_PROTOCOL });
    assert.equal(discover.result.resultType, "complete");
    assert.deepEqual(discover.result.supportedVersions, SUPPORTED_PROTOCOLS);
    assert.equal(discover.result._meta["io.modelcontextprotocol/serverInfo"].name, "sportbot-agent-proxy");
    assert.equal(discover.result.capabilities.tools.listChanged, false);

    const list = await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, execute, {
        era: "modern",
        protocolVersion: CURRENT_PROTOCOL,
    });
    assert.equal(list.result.resultType, "complete");
    assert.equal(list.result.tools.length, 6);

    const call = await handleJsonRpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_operations_brief", arguments: {} },
    }, execute, { era: "modern", protocolVersion: CURRENT_PROTOCOL });
    assert.equal(call.result.resultType, "complete");
    assert.equal(call.result.isError, false);
    assert.deepEqual(call.result.structuredContent, { tool: "get_operations_brief", args: {} });
});

test("legacy Streamable HTTP sigue aceptando initialize y protocol-version", async () => {
    const execute = async (name, args) => ({ tool: name, args });
    const initialize = await handleJsonRpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } },
    }, execute, { era: "legacy", protocolVersion: "2025-11-25" });
    assert.equal(initialize.result.protocolVersion, "2025-11-25");
    assert.equal(initialize.result.serverInfo.name, "sportbot-agent-proxy");

    const legacyList = await handleJsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, execute, {
        era: "legacy",
        protocolVersion: "2025-11-25",
    });
    assert.equal(legacyList.result.tools.length, 6);
});

test("JSON-RPC: errores de protocolo y de herramienta", async () => {
    const execute = async () => ({ ok: true });

    const unknownMethod = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "nope" }, execute);
    assert.equal(unknownMethod.error.code, -32601);

    const unknownTool = await handleJsonRpc({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rm_rf", arguments: {} },
    }, execute);
    assert.equal(unknownTool.error.code, -32602);

    const invalidArgs = await handleJsonRpc({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_order", arguments: {} },
    }, execute, { era: "modern", protocolVersion: CURRENT_PROTOCOL });
    assert.equal(invalidArgs.result.resultType, "complete");
    assert.equal(invalidArgs.result.isError, true);
    assert.match(invalidArgs.result.content[0].text, /Indica exactamente uno/);

    const failing = await handleJsonRpc({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_operations_brief", arguments: {} },
    }, async () => { throw new Error("db down"); }, { era: "modern", protocolVersion: CURRENT_PROTOCOL });
    assert.equal(failing.result.resultType, "complete");
    assert.equal(failing.result.isError, true);
    assert.match(failing.result.content[0].text, /db down/);

    assert.equal(await handleJsonRpc({ jsonrpc: "2.0", method: "notifications/initialized" }, execute, { era: "legacy", protocolVersion: "2025-11-25" }), null);
    assert.equal((await handleJsonRpc([], execute)).error.code, -32600);
});
