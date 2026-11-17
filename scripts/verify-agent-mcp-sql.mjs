#!/usr/bin/env node
/**
 * Verifica la migración del Agent Proxy:
 *   - agent_actions acepta el canal agent_proxy;
 *   - agent_tool_calls nace con RLS y permisos mínimos;
 *   - anon no lee la auditoría; authenticated sí (admin-only por política).
 *
 * Uso: node scripts/verify-agent-mcp-sql.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
    join(root, "supabase", "migrations", "20261101140000_agent_tool_calls.sql"),
    "utf8",
);
const identityMigration = readFileSync(
    join(root, "supabase", "migrations", "20261117120000_agent_mcp_delegated_identity.sql"),
    "utf8",
);

const db = new PGlite();
let checks = 0;

try {
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id UUID PRIMARY KEY);

        CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
        LANGUAGE sql STABLE AS $$ SELECT false $$;

        CREATE TABLE public.agent_actions (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            channel TEXT NOT NULL,
            action_type TEXT NOT NULL,
            summary TEXT NOT NULL,
            CONSTRAINT agent_actions_channel_check CHECK (
                channel IN ('admin', 'telegram_admin', 'whatsapp_admin', 'hook', 'system')
            )
        );
    `);

    await db.exec(migration);
    await db.exec(identityMigration);

    await db.query(
        "insert into public.agent_actions (channel, action_type, summary) values ('agent_proxy', 'dispatch_review', 'Prueba')",
    );
    checks++;
    await assert.rejects(
        () => db.query("insert into public.agent_actions (channel, action_type, summary) values ('nope', 'x', 'y')"),
        /agent_actions_channel_check|check constraint/i,
        "canal inválido debe rechazarse",
    );
    checks++;

    const rls = await db.query("select relrowsecurity from pg_class where oid = 'public.agent_tool_calls'::regclass");
    assert.equal(rls.rows[0].relrowsecurity, true, "agent_tool_calls debe tener RLS");
    checks++;

    const policy = await db.query("select policyname from pg_policies where schemaname='public' and tablename='agent_tool_calls'");
    assert.equal(policy.rows.length, 1, "una política de lectura admin");
    checks++;

    const anonSelect = await db.query("select has_table_privilege('anon', 'public.agent_tool_calls', 'SELECT') as ok");
    assert.equal(anonSelect.rows[0].ok, false, "anon no lee la auditoría");
    checks++;

    const authSelect = await db.query("select has_table_privilege('authenticated', 'public.agent_tool_calls', 'SELECT') as ok");
    assert.equal(authSelect.rows[0].ok, true, "authenticated puede leer (RLS admin)");
    checks++;

    const serviceInsert = await db.query("select has_table_privilege('service_role', 'public.agent_tool_calls', 'INSERT') as ok");
    assert.equal(serviceInsert.rows[0].ok, true, "service_role escribe la auditoría");
    checks++;

    const serviceUpdate = await db.query("select has_table_privilege('service_role', 'public.agent_tool_calls', 'UPDATE') as ok");
    assert.equal(serviceUpdate.rows[0].ok, true, "service_role cierra el evento de auditoría");
    checks++;

    const identityColumns = await db.query(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_tool_calls'
          AND column_name = ANY(ARRAY['actor_user_id', 'actor_role', 'channel', 'request_id'])
    `);
    assert.deepEqual(identityColumns.rows.map((row) => row.column_name).sort(), [
        "actor_role", "actor_user_id", "channel", "request_id",
    ]);
    checks++;

    await db.query("INSERT INTO auth.users (id) VALUES ('11111111-1111-4111-8111-111111111111')");
    await assert.rejects(
        () => db.query("INSERT INTO public.agent_tool_calls (tool_name, status, channel) VALUES ('list_inventory_alerts', 'ok', 'agent_mcp_user')"),
        /agent_tool_calls_delegated_actor_check|check constraint/i,
        "el canal delegado requiere actor y rol",
    );
    checks++;
    await db.query(`
        INSERT INTO public.agent_tool_calls (tool_name, status, channel, actor_user_id, actor_role, request_id)
        VALUES ('list_inventory_alerts', 'started', 'agent_mcp_user', '11111111-1111-4111-8111-111111111111', 'operator', 'req-1')
    `);
    await db.query("UPDATE public.agent_tool_calls SET status='ok', latency_ms=12 WHERE request_id='req-1'");
    const audit = await db.query(`
        SELECT actor_role, request_id, channel, status, latency_ms
        FROM public.agent_tool_calls
        WHERE actor_user_id = '11111111-1111-4111-8111-111111111111'
    `);
    assert.deepEqual(audit.rows[0], {
        actor_role: "operator", request_id: "req-1", channel: "agent_mcp_user", status: "ok", latency_ms: 12,
    });
    checks++;

    await assert.rejects(
        () => db.query("INSERT INTO public.agent_tool_calls (tool_name, status) VALUES ('bad', 'pending')"),
        /agent_tool_calls_status_check|check constraint/i,
        "estado fuera del ciclo MCP debe rechazarse",
    );
    checks++;

    await assert.rejects(
        () => db.query("UPDATE public.agent_tool_calls SET actor_role='root' WHERE request_id='req-1'"),
        /agent_tool_calls_actor_role_check|check constraint/i,
        "rol no permitido debe rechazarse en BD",
    );
    checks++;

    await db.exec(identityMigration);
    checks++;

    await db.exec(migration);
    const again = await db.query("select count(*)::int as n from public.agent_actions where channel='agent_proxy'");
    assert.equal(again.rows[0].n, 1, "reaplicar no duplica ni rompe el CHECK");
    checks++;

    console.log(`Agent MCP SQL: ${checks} checks OK`);
} finally {
    await db.close();
}
