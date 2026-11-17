import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRateLimit, beginToolCall, createAgentToolExecutor, finishToolCall, recordToolCall } from "./agent-tools.ts";

function auditClient({ insertError = null, updateError = null, count = 0, countError = null } = {}) {
    const state = { inserted: null, updated: null, filteredActor: null, updatedId: null };
    const client = {
        from(table) {
            assert.equal(table, "agent_tool_calls");
            return {
                insert(row) {
                    state.inserted = row;
                    const promise = Promise.resolve({ error: insertError });
                    promise.select = () => ({
                        single: async () => ({ data: { id: "audit-row-id" }, error: insertError }),
                    });
                    return promise;
                },
                update(row) {
                    state.updated = row;
                    return {
                        eq(column, value) {
                            assert.equal(column, "id");
                            state.updatedId = value;
                            return {
                                select: () => ({
                                    single: async () => ({ data: { id: value }, error: updateError }),
                                }),
                            };
                        },
                    };
                },
                select(_columns, options) {
                    assert.equal(options.head, true);
                    return {
                        eq(column, value) {
                            assert.equal(column, "actor_user_id");
                            state.filteredActor = value;
                            return {
                                gte: async () => ({ count, error: countError }),
                            };
                        },
                    };
                },
            };
        },
    };
    return { client, state };
}

test("recordToolCall persiste sólo identidad verificada y request correlation", async () => {
    const { client, state } = auditClient();
    await recordToolCall(client, {
        toolName: "list_inventory_alerts",
        args: { limit: 5 },
        status: "ok",
        actorUserId: "verified-user-id",
        actorRole: "operator",
        requestId: 17,
    });
    assert.equal(state.inserted.actor_user_id, "verified-user-id");
    assert.equal(state.inserted.actor_role, "operator");
    assert.equal(state.inserted.request_id, "17");
    assert.equal(state.inserted.channel, "agent_mcp_user");
    assert.deepEqual(state.inserted.arguments, { limit: 5 });
});

test("recordToolCall falla cerrado cuando la auditoría no se escribe", async () => {
    const { client } = auditClient({ insertError: new Error("audit unavailable") });
    await assert.rejects(
        () => recordToolCall(client, {
            toolName: "list_inventory_alerts",
            args: {},
            status: "ok",
            actorUserId: "verified-user-id",
            actorRole: "operator",
        }),
        /auditoría MCP/,
    );
});

test("beginToolCall persiste identidad antes de negocio y finishToolCall actualiza el evento", async () => {
    const { client, state } = auditClient();
    const id = await beginToolCall(client, {
        toolName: "list_inventory_alerts",
        args: { limit: 5 },
        actorUserId: "verified-user-id",
        actorRole: "operator",
        requestId: "rpc-7",
    });
    assert.equal(id, "audit-row-id");
    assert.equal(state.inserted.status, "started");
    assert.equal(state.inserted.actor_user_id, "verified-user-id");
    assert.equal(state.inserted.actor_role, "operator");
    assert.equal(state.inserted.channel, "agent_mcp_user");

    await finishToolCall(client, id, { status: "ok", latencyMs: 14 });
    assert.equal(state.updatedId, id);
    assert.equal(state.updated.status, "ok");
    assert.equal(state.updated.latency_ms, 14);
});

test("beginToolCall bloquea antes de negocio cuando falla la inserción inicial", async () => {
    const { client } = auditClient({ insertError: new Error("audit unavailable") });
    await assert.rejects(
        () => beginToolCall(client, {
            toolName: "list_inventory_alerts",
            args: {},
            actorUserId: "verified-user-id",
            actorRole: "operator",
        }),
        /operación bloqueada/,
    );
});

test("finishToolCall reporta el fallo y deja detectable el estado started", async () => {
    const { client } = auditClient({ updateError: new Error("update unavailable") });
    await assert.rejects(
        () => finishToolCall(client, "audit-row-id", { status: "ok", latencyMs: 1 }),
        /registro permanece como started/,
    );
});

test("assertRateLimit limita por actor y rechaza error de cuota", async () => {
    const below = auditClient({ count: 59 });
    await assertRateLimit(below.client, "user-a", 60);
    assert.equal(below.state.filteredActor, "user-a");

    const atLimit = auditClient({ count: 60 });
    await assert.rejects(() => assertRateLimit(atLimit.client, "user-a", 60), /Rate limit/);

    const failed = auditClient({ countError: new Error("database unavailable") });
    await assert.rejects(() => assertRateLimit(failed.client, "user-a", 60), /operación bloqueada/);
});

test("el executor no consulta negocio fuera de su allowlist", async () => {
    let queried = false;
    const executor = createAgentToolExecutor({
        from() {
            queried = true;
            throw new Error("no debe alcanzar la base");
        },
    }, {
        adminBaseUrl: "https://example.test",
        allowedTools: ["list_inventory_alerts"],
    });
    await assert.rejects(
        () => executor("list_payment_queue", { limit: 1 }),
        /no habilitada/,
    );
    assert.equal(queried, false);
});
