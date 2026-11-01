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

const db = new PGlite();
let checks = 0;

try {
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role;

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

    await db.exec(migration);
    const again = await db.query("select count(*)::int as n from public.agent_actions where channel='agent_proxy'");
    assert.equal(again.rows[0].n, 1, "reaplicar no duplica ni rompe el CHECK");
    checks++;

    console.log(`Agent MCP SQL: ${checks} checks OK`);
} finally {
    await db.close();
}
