#!/usr/bin/env node
// Regresión de la frontera de identidad de RPC privilegiadas.
// El fixture stubea las implementaciones de negocio originales para probar el
// wrapper de seguridad; los verificadores propios de cada migración cubren su
// lógica transaccional y de autorización.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
    join(root, "supabase/migrations/20261106140000_actor_rpc_hardening.sql"),
    "utf8",
);
const db = new PGlite();

const ACTOR = "00000000-0000-4000-8000-000000000001";
const OTHER_ADMIN = "00000000-0000-4000-8000-000000000002";
const NON_ADMIN = "00000000-0000-4000-8000-000000000003";
const ACTION_REVIEW = "00000000-0000-4000-8000-000000000101";
const ACTION_EXECUTE = "00000000-0000-4000-8000-000000000102";

await db.exec(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS TEXT
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO authenticated, service_role;

CREATE TABLE public.admin_users (
    user_id UUID PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('owner','admin','operator'))
);
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (SELECT 1 FROM public.admin_users WHERE user_id = auth.uid())
$$;

CREATE TABLE public.agent_actions (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    approved_by_user_id UUID,
    approved_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,
    execution_result JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.agent_actions TO authenticated;
GRANT ALL ON public.agent_actions TO service_role;

-- Implementaciones originales mínimas: el nuevo migration las renombra y los
-- wrappers deben validar identidad antes de delegar.
CREATE FUNCTION public.admin_mark_conversation_read(UUID, UUID) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $2) $$;
CREATE FUNCTION public.admin_create_quick_answer(UUID, TEXT, TEXT, BOOLEAN) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $1) $$;
CREATE FUNCTION public.admin_update_quick_answer(UUID, UUID, TEXT, TEXT, BOOLEAN) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $2) $$;
CREATE FUNCTION public.admin_delete_quick_answer(UUID, UUID) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $2) $$;
CREATE FUNCTION public.admin_close_conversation(UUID, UUID, TEXT) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $2) $$;
CREATE FUNCTION public.admin_reopen_conversation(UUID, UUID, TEXT) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $2) $$;
CREATE FUNCTION public.admin_inbox_activity_log(UUID, UUID, TEXT, TEXT, TEXT) RETURNS JSONB
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT jsonb_build_object('success', true, 'actor', $2) $$;

CREATE FUNCTION public.review_agent_action(UUID, TEXT, TEXT)
RETURNS public.agent_actions LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_action public.agent_actions;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires admin' USING ERRCODE='42501'; END IF;
    UPDATE public.agent_actions
       SET status=$2, reviewed_at=now(), review_note=$3,
           approved_by_user_id=CASE WHEN $2='approved' THEN auth.uid() ELSE NULL END,
           approved_at=CASE WHEN $2='approved' THEN now() ELSE NULL END
     WHERE id=$1 AND status IN ('suggested','pending_approval')
     RETURNING * INTO v_action;
    IF v_action.id IS NULL THEN RAISE EXCEPTION 'not reviewable' USING ERRCODE='02000'; END IF;
    RETURN v_action;
END $$;
CREATE FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT)
RETURNS public.agent_actions LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE v_action public.agent_actions;
BEGIN
    IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires admin' USING ERRCODE='42501'; END IF;
    UPDATE public.agent_actions
       SET status=$2, executed_at=now(), execution_result=COALESCE($3,'{}'::jsonb), error_message=$4
     WHERE id=$1 AND status='approved'
     RETURNING * INTO v_action;
    IF v_action.id IS NULL THEN RAISE EXCEPTION 'not approved' USING ERRCODE='02000'; END IF;
    RETURN v_action;
END $$;

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;
`);

await db.query(
    `INSERT INTO public.admin_users (user_id, role) VALUES ($1,'operator'),($2,'admin')`,
    [ACTOR, OTHER_ADMIN],
);
await db.query(
    `INSERT INTO public.agent_actions (id,status) VALUES ($1,'pending_approval'),($2,'approved')`,
    [ACTION_REVIEW, ACTION_EXECUTE],
);
await db.exec(migration);

let checks = 0;
async function check(name, fn) {
    await fn();
    checks++;
    console.log(`PASS ${name}`);
}

async function runAs(role, subject, fn) {
    await db.exec("BEGIN");
    try {
        await db.exec(`SET LOCAL ROLE ${role}`);
        await db.query(
            `SELECT set_config('request.jwt.claim.role',$1,true),
                    set_config('request.jwt.claim.sub',$2,true)`,
            [role, subject ?? ""],
        );
        const result = await fn();
        await db.exec("COMMIT");
        return result;
    } catch (error) {
        await db.exec("ROLLBACK").catch(() => undefined);
        throw error;
    }
}

async function expectDenied(query, params = [], pattern = /permission denied/i) {
    await db.exec("SAVEPOINT expected_denial");
    let failure;
    try {
        await db.query(query, params);
    } catch (error) {
        failure = error;
    }
    if (!failure) {
        await db.exec("RELEASE SAVEPOINT expected_denial");
        throw new Error("operation should have been denied");
    }
    await db.exec("ROLLBACK TO SAVEPOINT expected_denial");
    await db.exec("RELEASE SAVEPOINT expected_denial");
    assert.match(failure.message, pattern);
}

const spoofCases = [
    ["mark conversation read", `SELECT public.admin_mark_conversation_read(gen_random_uuid(),$1)`, [OTHER_ADMIN]],
    ["create quick answer", `SELECT public.admin_create_quick_answer($1,'/x','x',false)`, [OTHER_ADMIN]],
    ["update quick answer", `SELECT public.admin_update_quick_answer(gen_random_uuid(),$1,'/x','x',false)`, [OTHER_ADMIN]],
    ["delete quick answer", `SELECT public.admin_delete_quick_answer(gen_random_uuid(),$1)`, [OTHER_ADMIN]],
    ["close conversation", `SELECT public.admin_close_conversation(gen_random_uuid(),$1,'reason')`, [OTHER_ADMIN]],
    ["reopen conversation", `SELECT public.admin_reopen_conversation(gen_random_uuid(),$1,'reason')`, [OTHER_ADMIN]],
    ["write activity", `SELECT public.admin_inbox_activity_log(gen_random_uuid(),$1,'claim',NULL,NULL)`, [OTHER_ADMIN]],
];

for (const [name, sql, params] of spoofCases) {
    await check(`${name}: authenticated cannot spoof another admin`, async () => {
        await assert.rejects(
            () => runAs("authenticated", ACTOR, () => db.query(sql, params)),
            /actor must match|permission denied/i,
        );
    });
}

await check("valid authenticated actor can call the compatible wrappers", async () => {
    await runAs("authenticated", ACTOR, async () => {
        const read = await db.query(
            `SELECT public.admin_mark_conversation_read(gen_random_uuid(),$1) AS result`, [ACTOR],
        );
        assert.equal(read.rows[0].result.success, true);
        const answer = await db.query(
            `SELECT public.admin_create_quick_answer($1,'/ok','ok',false) AS result`, [ACTOR],
        );
        assert.equal(answer.rows[0].result.success, true);
        const closed = await db.query(
            `SELECT public.admin_close_conversation(gen_random_uuid(),$1,'ok') AS result`, [ACTOR],
        );
        assert.equal(closed.rows[0].result.success, true);
    });
});

await check("service_role remains the explicit delegated-actor exception", async () => {
    const result = await runAs("service_role", null, async () => db.query(
        `SELECT public.admin_mark_conversation_read(gen_random_uuid(),$1) AS result`, [OTHER_ADMIN],
    ));
    assert.equal(result.rows[0].result.success, true);
});

await check("non-admin cannot use a wrapper even with its own ID", async () => {
    await assert.rejects(
        () => runAs("authenticated", NON_ADMIN, () => db.query(
            `SELECT public.admin_mark_conversation_read(gen_random_uuid(),$1)`, [NON_ADMIN],
        )),
        /requires an authenticated admin/i,
    );
});

await check("Agent Actions review/execution RPCs remain usable by an admin", async () => {
    await runAs("authenticated", ACTOR, async () => {
        const reviewed = await db.query(
            `SELECT (public.review_agent_action($1,'approved','ok')).status AS status`, [ACTION_REVIEW],
        );
        assert.equal(reviewed.rows[0].status, "approved");
        const executed = await db.query(
            `SELECT (public.record_agent_action_execution($1,'executed','{"ok":true}'::jsonb,NULL)).status AS status`,
            [ACTION_REVIEW],
        );
        assert.equal(executed.rows[0].status, "executed");
    });
});

await check("Agent Actions direct client DML and unchecked RPCs are revoked", async () => {
    await runAs("authenticated", ACTOR, async () => {
        await expectDenied(`INSERT INTO public.agent_actions (id,status) VALUES (gen_random_uuid(),'approved')`);
        await expectDenied(`UPDATE public.agent_actions SET status='approved' WHERE id=$1`, [ACTION_EXECUTE]);
        await expectDenied(
            `SELECT public.admin_close_conversation_unchecked(gen_random_uuid(),$1,'x')`,
            [ACTOR],
        );
    });
});

await check("grants expose guarded wrappers, not internal implementations", async () => {
    const { rows } = await db.query(`
        SELECT
          has_function_privilege('authenticated','public.admin_mark_conversation_read(uuid,uuid)','EXECUTE') AS auth_wrapper,
          has_function_privilege('authenticated','public.admin_mark_conversation_read_unchecked(uuid,uuid)','EXECUTE') AS auth_internal,
          has_function_privilege('anon','public.admin_mark_conversation_read(uuid,uuid)','EXECUTE') AS anon_wrapper,
          has_function_privilege('service_role','public.admin_mark_conversation_read(uuid,uuid)','EXECUTE') AS service_wrapper,
          has_table_privilege('authenticated','public.agent_actions','SELECT') AS auth_select,
          has_table_privilege('authenticated','public.agent_actions','INSERT') AS auth_insert,
          has_table_privilege('authenticated','public.agent_actions','UPDATE') AS auth_update
    `);
    assert.deepEqual(rows[0], {
        auth_wrapper: true,
        auth_internal: false,
        anon_wrapper: false,
        service_wrapper: true,
        auth_select: true,
        auth_insert: false,
        auth_update: false,
    });
});

await check("hardening migration can be reapplied idempotently", async () => {
    await db.exec(migration);
    const { rows } = await db.query(`
        SELECT has_function_privilege('authenticated','public.admin_mark_conversation_read(uuid,uuid)','EXECUTE') AS wrapper,
               has_function_privilege('authenticated','public.admin_mark_conversation_read_unchecked(uuid,uuid)','EXECUTE') AS internal
    `);
    assert.deepEqual(rows[0], { wrapper: true, internal: false });
});

await db.close();
console.log(`RPC actor/Agent Actions hardening: ${checks} checks OK`);
