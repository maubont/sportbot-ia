#!/usr/bin/env node
// Role-aware RLS/RPC regression tests for owner, admin, operator and non-member.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(join(root, 'supabase/migrations/20261106180000_role_scope_hardening.sql'), 'utf8');
const db = new PGlite();
const OWNER = '00000000-0000-4000-8000-000000000001';
const ADMIN = '00000000-0000-4000-8000-000000000002';
const OPERATOR = '00000000-0000-4000-8000-000000000003';
const OUTSIDER = '00000000-0000-4000-8000-000000000004';
const QA_OPERATOR = '10000000-0000-4000-8000-000000000001';
const QA_ADMIN = '10000000-0000-4000-8000-000000000002';
const QA_GLOBAL = '10000000-0000-4000-8000-000000000003';

await db.exec(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.role', true), '') $$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO authenticated, service_role;

CREATE TABLE public.admin_users (user_id UUID PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('owner','admin','operator')));
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION public.current_admin_role() RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$ SELECT COALESCE((SELECT role FROM public.admin_users WHERE user_id=auth.uid()),'admin') $$;
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path=public,pg_temp AS $$ SELECT EXISTS(SELECT 1 FROM public.admin_users WHERE user_id=auth.uid()) $$;
CREATE POLICY "Admins read admin users" ON public.admin_users FOR SELECT TO authenticated USING (public.is_admin());
GRANT SELECT ON public.admin_users TO authenticated;

CREATE TABLE public.quick_answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID, shortcut TEXT NOT NULL,
  body TEXT NOT NULL, is_global BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.quick_answers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read own and global quick answers" ON public.quick_answers FOR SELECT TO authenticated
  USING (public.is_admin() AND (user_id=auth.uid() OR is_global=TRUE));
CREATE POLICY "Admins manage own quick answers" ON public.quick_answers FOR ALL TO authenticated
  USING (public.is_admin() AND user_id=auth.uid()) WITH CHECK (public.is_admin() AND user_id=auth.uid());
CREATE UNIQUE INDEX idx_quick_answers_user_shortcut ON public.quick_answers(user_id,shortcut) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_quick_answers_global_shortcut ON public.quick_answers(shortcut) WHERE user_id IS NULL AND is_global=TRUE;
GRANT SELECT ON public.quick_answers TO authenticated;

CREATE TABLE public.customers (id UUID PRIMARY KEY, label TEXT);
CREATE TABLE public.conversations (id UUID PRIMARY KEY, status TEXT);
CREATE TABLE public.messages (id UUID PRIMARY KEY, body TEXT);
CREATE TABLE public.media_files (id UUID PRIMARY KEY, path TEXT);
CREATE TABLE public.conversation_closures (conversation_id UUID PRIMARY KEY);
CREATE TABLE public.conversation_context_resolutions (id UUID PRIMARY KEY, resolved_by_user_id UUID);
CREATE TABLE public.conversation_events (id UUID PRIMARY KEY);
CREATE TABLE public.conversation_operator_assignments (id UUID PRIMARY KEY);
CREATE TABLE public.conversation_operator_events (id UUID PRIMARY KEY);
CREATE TABLE public.conversation_reads (id UUID PRIMARY KEY, user_id UUID);
CREATE TABLE public.conversation_state (conversation_id UUID PRIMARY KEY);
CREATE TABLE public.customer_profiles (id UUID PRIMARY KEY);
CREATE TABLE public.inbox_activity_feed (id UUID PRIMARY KEY);
CREATE TABLE public.inbox_notification_preferences (user_id UUID PRIMARY KEY);
CREATE TABLE public.storefront_handoffs (id UUID PRIMARY KEY);
CREATE TABLE public.orders (id UUID PRIMARY KEY);
CREATE TABLE public.order_items (id UUID PRIMARY KEY);
CREATE TABLE public.shipments (id UUID PRIMARY KEY);
CREATE TABLE public.shipment_events (id UUID PRIMARY KEY);
CREATE TABLE public.logistics_notifications (id UUID PRIMARY KEY);
CREATE TABLE public.settings (id INTEGER PRIMARY KEY, marker TEXT);
CREATE TABLE public.payments (id UUID PRIMARY KEY, marker TEXT);
CREATE TABLE public.agent_actions (id UUID PRIMARY KEY, marker TEXT);
CREATE TABLE public.product_costs (id UUID PRIMARY KEY, marker TEXT);
CREATE TABLE public.order_economics (id UUID PRIMARY KEY, marker TEXT);
CREATE FUNCTION public.review_agent_action_unchecked(p_action_id UUID,p_decision TEXT,p_review_note TEXT)
RETURNS public.agent_actions LANGUAGE plpgsql SECURITY DEFINER
AS $$ DECLARE v_action public.agent_actions; BEGIN SELECT * INTO v_action FROM public.agent_actions WHERE id=p_action_id; RETURN v_action; END $$;
CREATE FUNCTION public.record_agent_action_execution_unchecked(p_action_id UUID,p_status TEXT,p_execution_result JSONB,p_error_message TEXT)
RETURNS public.agent_actions LANGUAGE plpgsql SECURITY DEFINER
AS $$ DECLARE v_action public.agent_actions; BEGIN SELECT * INTO v_action FROM public.agent_actions WHERE id=p_action_id; RETURN v_action; END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'customers','conversations','messages','media_files','conversation_closures',
    'conversation_context_resolutions','conversation_events','conversation_operator_assignments',
    'conversation_operator_events','conversation_reads','conversation_state','customer_profiles',
    'inbox_activity_feed','inbox_notification_preferences','storefront_handoffs','orders',
    'order_items','shipments','shipment_events','logistics_notifications','settings','payments',
    'agent_actions','product_costs','order_economics'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Existing owner/admin-only policy baseline; the migration selectively widens
-- only operational reads and own-row workflows to staff.
CREATE POLICY "Admins manage customers" ON public.customers FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins manage conversations" ON public.conversations FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read messages" ON public.messages FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins manage media files" ON public.media_files FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read conversation closures" ON public.conversation_closures FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins create conversation context resolutions" ON public.conversation_context_resolutions FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admins read conversation context resolutions" ON public.conversation_context_resolutions FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins update conversation context resolutions" ON public.conversation_context_resolutions FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins create conversation events" ON public.conversation_events FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admins read conversation events" ON public.conversation_events FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins read conversation operator assignments" ON public.conversation_operator_assignments FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins read conversation operator events" ON public.conversation_operator_events FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins read own conversation reads" ON public.conversation_reads FOR SELECT TO authenticated USING (public.is_admin() AND user_id=auth.uid());
CREATE POLICY "Admins manage own conversation reads" ON public.conversation_reads FOR ALL TO authenticated USING (public.is_admin() AND user_id=auth.uid()) WITH CHECK (public.is_admin() AND user_id=auth.uid());
CREATE POLICY "Admins read conversation state" ON public.conversation_state FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins create customer profiles" ON public.customer_profiles FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admins read customer profiles" ON public.customer_profiles FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins update customer profiles" ON public.customer_profiles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read activity feed" ON public.inbox_activity_feed FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins read own notification preferences" ON public.inbox_notification_preferences FOR SELECT TO authenticated USING (public.is_admin() AND user_id=auth.uid());
CREATE POLICY "Admins manage own notification preferences" ON public.inbox_notification_preferences FOR ALL TO authenticated USING (public.is_admin() AND user_id=auth.uid()) WITH CHECK (public.is_admin() AND user_id=auth.uid());
CREATE POLICY "Admins create storefront handoffs" ON public.storefront_handoffs FOR INSERT TO authenticated WITH CHECK (public.is_admin());
CREATE POLICY "Admins read storefront handoffs" ON public.storefront_handoffs FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins update storefront handoffs" ON public.storefront_handoffs FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read orders" ON public.orders FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins read order items" ON public.order_items FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins manage shipments" ON public.shipments FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins manage shipment events" ON public.shipment_events FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read logistics notifications" ON public.logistics_notifications FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins manage settings" ON public.settings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins read payments" ON public.payments FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins read agent actions" ON public.agent_actions FOR SELECT TO authenticated USING (public.is_admin());
CREATE POLICY "Admins manage product costs" ON public.product_costs FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY "Admins manage order economics" ON public.order_economics FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE FUNCTION public.admin_conversation_unread_counts(p_user_id UUID)
RETURNS TABLE (conversation_id UUID, unread_count INTEGER) LANGUAGE plpgsql SECURITY INVOKER
AS $$ BEGIN IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires an admin user'; END IF; RETURN QUERY SELECT p_user_id,1; END $$;
CREATE FUNCTION public.admin_search_conversations(p_query TEXT,p_limit INTEGER,p_offset INTEGER)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$ BEGIN IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires an admin user'; END IF; RETURN 1; END $$;
CREATE FUNCTION public.admin_logistics_operations_snapshot(p_from TIMESTAMPTZ,p_to TIMESTAMPTZ,p_timezone TEXT,p_fulfillment_sla_hours INTEGER,p_delivery_sla_hours INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY INVOKER
AS $$ BEGIN IF NOT public.is_admin() THEN RAISE EXCEPTION 'requires an admin user'; END IF; RETURN '{"allowed":true}'::jsonb; END $$;
GRANT EXECUTE ON FUNCTION public.admin_conversation_unread_counts(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_conversations(TEXT,INTEGER,INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_logistics_operations_snapshot(TIMESTAMPTZ,TIMESTAMPTZ,TEXT,INTEGER,INTEGER) TO authenticated;

INSERT INTO public.admin_users(user_id,role) VALUES
  ('${OWNER}','owner'),('${ADMIN}','admin'),('${OPERATOR}','operator');
INSERT INTO public.customers(id,label) VALUES ('20000000-0000-4000-8000-000000000001','customer');
INSERT INTO public.conversations(id,status) VALUES ('20000000-0000-4000-8000-000000000002','open');
INSERT INTO public.orders(id) VALUES ('20000000-0000-4000-8000-000000000003');
INSERT INTO public.settings(id,marker) VALUES (1,'sensitive');
INSERT INTO public.payments(id,marker) VALUES ('20000000-0000-4000-8000-000000000004','sensitive');
INSERT INTO public.agent_actions(id,marker) VALUES ('20000000-0000-4000-8000-000000000005','sensitive');
INSERT INTO public.product_costs(id,marker) VALUES ('20000000-0000-4000-8000-000000000006','sensitive');
INSERT INTO public.order_economics(id,marker) VALUES ('20000000-0000-4000-8000-000000000007','sensitive');
INSERT INTO public.quick_answers(id,user_id,shortcut,body,is_global) VALUES
  ('${QA_OPERATOR}','${OPERATOR}','/own','operator template',FALSE),
  ('${QA_ADMIN}','${ADMIN}','/other','other template',FALSE),
  ('${QA_GLOBAL}',NULL,'/global','global template',TRUE);

GRANT USAGE ON SCHEMA public TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.quick_answers FROM authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`);

await db.exec(migration);
await db.exec(`
CREATE OR REPLACE FUNCTION public.test_inbox_actor(p_actor UUID)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$ BEGIN PERFORM public._assert_rpc_actor(p_actor); RETURN TRUE; END $$;
CREATE OR REPLACE FUNCTION public.test_create_quick_answer(p_user UUID,p_shortcut TEXT,p_body TEXT,p_global BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$ BEGIN PERFORM public._assert_rpc_actor(p_user); RETURN public.admin_create_quick_answer_unchecked(p_user,p_shortcut,p_body,p_global); END $$;
CREATE OR REPLACE FUNCTION public.test_update_quick_answer(p_id UUID,p_user UUID,p_shortcut TEXT,p_body TEXT,p_global BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$ BEGIN PERFORM public._assert_rpc_actor(p_user); RETURN public.admin_update_quick_answer_unchecked(p_id,p_user,p_shortcut,p_body,p_global); END $$;
CREATE OR REPLACE FUNCTION public.test_delete_quick_answer(p_id UUID,p_user UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
AS $$ BEGIN PERFORM public._assert_rpc_actor(p_user); RETURN public.admin_delete_quick_answer_unchecked(p_id,p_user); END $$;
GRANT EXECUTE ON FUNCTION public.test_inbox_actor(UUID) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.test_create_quick_answer(UUID,TEXT,TEXT,BOOLEAN) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.test_update_quick_answer(UUID,UUID,TEXT,TEXT,BOOLEAN) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.test_delete_quick_answer(UUID,UUID) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_quick_answers(UUID) TO authenticated;
`);

let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`); }
async function runAs(role, subject, fn) {
  await db.exec('BEGIN');
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    await db.query(`SELECT set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)`, [role, subject ?? '']);
    const result = await fn();
    await db.exec('COMMIT');
    return result;
  } catch (error) { await db.exec('ROLLBACK').catch(() => undefined); throw error; }
}

await check('role helpers distinguish owner, admin, operator and non-member', async () => {
  const expected = [
    [OWNER,'owner',true,false,true], [ADMIN,'admin',true,false,true], [OPERATOR,'operator',false,true,true], [OUTSIDER,null,false,false,false],
  ];
  for (const [id, role, isAdmin, isOperator, isStaff] of expected) {
    const result = await runAs('authenticated', id, () => db.query(`SELECT public.current_admin_role() AS role, public.is_owner() AS owner, public.is_admin() AS admin, public.is_operator() AS operator, public.is_staff() AS staff`));
    assert.equal(result.rows[0].role, role);
    assert.equal(result.rows[0].owner, role === 'owner');
    assert.equal(result.rows[0].admin, isAdmin);
    assert.equal(result.rows[0].operator, isOperator);
    assert.equal(result.rows[0].staff, isStaff);
  }
});

await check('operator can use Inbox and operational read paths but outsider cannot', async () => {
  const op = await runAs('authenticated', OPERATOR, async () => {
    const customers = await db.query('SELECT count(*)::int AS n FROM public.customers');
    const conversations = await db.query('SELECT count(*)::int AS n FROM public.conversations');
    const orders = await db.query('SELECT count(*)::int AS n FROM public.orders');
    const search = await db.query(`SELECT public.admin_search_conversations('',20,0) AS value`);
    const logistics = await db.query(`SELECT public.admin_logistics_operations_snapshot(now()-interval '1 day',now(),'UTC',24,72) AS value`);
    return { customers: customers.rows[0].n, conversations: conversations.rows[0].n, orders: orders.rows[0].n, search: search.rows[0].value, logistics: logistics.rows[0].value };
  });
  assert.deepEqual(op, { customers: 1, conversations: 1, orders: 1, search: 1, logistics: { allowed: true } });
  const outsider = await runAs('authenticated', OUTSIDER, async () => {
    const customers = await db.query('SELECT count(*)::int AS n FROM public.customers');
    return customers.rows[0].n;
  });
  assert.equal(outsider, 0);
});

await check('operator cannot read finance, settings, cost, margin or agent-action rows', async () => {
  const counts = await runAs('authenticated', OPERATOR, async () => {
    const queries = ['settings','payments','agent_actions','product_costs','order_economics'];
    const values = {};
    for (const table of queries) values[table] = (await db.query(`SELECT count(*)::int AS n FROM public.${table}`)).rows[0].n;
    return values;
  });
  assert.deepEqual(counts, { settings: 0, payments: 0, agent_actions: 0, product_costs: 0, order_economics: 0 });
  const adminCount = await runAs('authenticated', ADMIN, async () => (await db.query('SELECT count(*)::int AS n FROM public.payments')).rows[0].n);
  assert.equal(adminCount, 1);
});

await check('operator cannot review or record execution for Agent Actions', async () => {
  await assert.rejects(
    () => runAs('authenticated', OPERATOR, () => db.query(`SELECT public.review_agent_action($1,'approve',NULL)`, ['20000000-0000-4000-8000-000000000005'])),
    /requires owner\/admin/i,
  );
  await assert.rejects(
    () => runAs('authenticated', OPERATOR, () => db.query(`SELECT public.record_agent_action_execution($1,'succeeded','{}'::jsonb,NULL)`, ['20000000-0000-4000-8000-000000000005'])),
    /requires owner\/admin/i,
  );
  const admin = await runAs('authenticated', ADMIN, () => db.query(`SELECT (public.review_agent_action($1,'approve',NULL)).id AS id`, ['20000000-0000-4000-8000-000000000005']));
  assert.equal(admin.rows[0].id, '20000000-0000-4000-8000-000000000005');
});

await check('operator sees own and global quick answers only', async () => {
  const result = await runAs('authenticated', OPERATOR, async () => db.query('SELECT id FROM public.admin_list_quick_answers($1)', [OPERATOR]));
  assert.deepEqual(new Set(result.rows.map((row) => row.id)), new Set([QA_OPERATOR, QA_GLOBAL]));
});

await check('operator may create personal quick answer but cannot create or edit global', async () => {
  await runAs('authenticated', OPERATOR, async () => {
    const own = await db.query(`SELECT public.test_create_quick_answer($1,'/new','personal',FALSE) AS result`, [OPERATOR]);
    assert.equal(own.rows[0].result.success, true);
    const global = await db.query(`SELECT public.test_create_quick_answer($1,'/forbidden','global',TRUE) AS result`, [OPERATOR]);
    assert.equal(global.rows[0].result.code, 'global_quick_answer_admin_only');
    const editGlobal = await db.query(`SELECT public.test_update_quick_answer($1,$2,'/changed','x',TRUE) AS result`, [QA_GLOBAL, OPERATOR]);
    assert.equal(editGlobal.rows[0].result.code, 'global_quick_answer_admin_only');
    const deleteGlobal = await db.query(`SELECT public.test_delete_quick_answer($1,$2) AS result`, [QA_GLOBAL, OPERATOR]);
    assert.equal(deleteGlobal.rows[0].result.code, 'global_quick_answer_admin_only');
  });
  await runAs('authenticated', ADMIN, async () => {
    const created = await db.query(`SELECT public.test_create_quick_answer($1,'/global-admin','global',TRUE) AS result`, [ADMIN]);
    assert.equal(created.rows[0].result.success, true);
    const id = created.rows[0].result.id;
    const row = await db.query('SELECT user_id, is_global FROM public.quick_answers WHERE id=$1', [id]);
    assert.deepEqual(row.rows[0], { user_id: null, is_global: true });
  });
});

await check('actor binding rejects impersonation; non-member is not staff; service_role remains trusted', async () => {
  await assert.rejects(() => runAs('authenticated', OPERATOR, () => db.query('SELECT public.test_inbox_actor($1)', [ADMIN])), /actor must match/i);
  await assert.rejects(() => runAs('authenticated', OUTSIDER, () => db.query('SELECT public.test_inbox_actor($1)', [OUTSIDER])), /authorized staff/i);
  const trusted = await runAs('service_role', null, () => db.query('SELECT public.test_inbox_actor($1) AS ok', [ADMIN]));
  assert.equal(trusted.rows[0].ok, true);
});

await check('operator DML grants on quick_answers remain revoked', async () => {
  await assert.rejects(() => runAs('authenticated', OPERATOR, () => db.query(`INSERT INTO public.quick_answers(user_id,shortcut,body) VALUES ($1,'/direct','no')`, [OPERATOR])), /permission denied/i);
});

await check('role migration reapplies without duplicating policies or breaking functions', async () => {
  await db.exec(migration);
  const role = await runAs('authenticated', OPERATOR, () => db.query('SELECT public.is_operator() AS is_operator, public.is_staff() AS is_staff'));
  assert.deepEqual(role.rows[0], { is_operator: true, is_staff: true });
});

await db.close();
console.log(`Role-aware RLS/RPC verification: ${checks} checks OK`);
