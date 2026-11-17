#!/usr/bin/env node
// Regression tests for operator-safe order columns and Inbox snapshot access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(join(root, 'supabase/migrations/20261106190000_operator_order_column_hardening.sql'), 'utf8');
const db = new PGlite();
const ADMIN = '00000000-0000-4000-8000-000000000001';
const OPERATOR = '00000000-0000-4000-8000-000000000002';
const OUTSIDER = '00000000-0000-4000-8000-000000000003';

await db.exec(`
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO authenticated, service_role;
CREATE TABLE public.admin_users (user_id UUID PRIMARY KEY, role TEXT NOT NULL CHECK (role IN ('owner','admin','operator')));
INSERT INTO public.admin_users VALUES ('${ADMIN}','admin'),('${OPERATOR}','operator');
CREATE FUNCTION public.current_admin_role() RETURNS TEXT LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,auth,pg_temp AS $$
  SELECT au.role FROM public.admin_users au WHERE au.user_id=auth.uid()
$$;
CREATE FUNCTION public.is_admin() RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,auth,pg_temp AS $$
  SELECT COALESCE(public.current_admin_role() IN ('owner','admin'),FALSE)
$$;
CREATE FUNCTION public.is_operator() RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,auth,pg_temp AS $$
  SELECT COALESCE(public.current_admin_role()='operator',FALSE)
$$;
CREATE FUNCTION public.is_staff() RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER
SET search_path=pg_catalog,public,auth,pg_temp AS $$
  SELECT COALESCE(public.current_admin_role() IN ('owner','admin','operator'),FALSE)
$$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated, service_role;
CREATE TABLE public.orders (
 id UUID PRIMARY KEY, customer_id UUID, status TEXT, shipping_name TEXT,
 shipping_phone TEXT, shipping_address TEXT, shipping_city TEXT, shipping_region TEXT,
 shipping_cost_cents INTEGER, subtotal_cents INTEGER, total_cents INTEGER,
 payment_reference TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
 tracking_number TEXT, carrier_name TEXT, shipped_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ,
 paid_at TIMESTAMPTZ, idempotency_key TEXT, payment_method TEXT,
 payment_rejection_reason TEXT, payment_rejected_at TIMESTAMPTZ, payment_approved_by UUID,
 payment_received_cents INTEGER, payment_shortfall_cents INTEGER, payment_shortfall_at TIMESTAMPTZ
);
CREATE TABLE public.order_items (
 id UUID PRIMARY KEY, order_id UUID, product_id UUID, variant_id UUID,
 qty INTEGER, unit_price_cents INTEGER, unit_cost_cents INTEGER, created_at TIMESTAMPTZ
);
CREATE TABLE public.product_variants (id UUID PRIMARY KEY, product_id UUID, size NUMERIC);
CREATE TABLE public.products (id UUID PRIMARY KEY, brand TEXT, model TEXT, sku TEXT);
INSERT INTO public.orders (
 id, customer_id, status, shipping_name, shipping_phone, shipping_address,
 shipping_city, shipping_region, shipping_cost_cents, subtotal_cents, total_cents,
 payment_reference, created_at, updated_at, paid_at, payment_method,
 payment_approved_by, payment_received_cents, payment_shortfall_cents
) VALUES (
 '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000101',
 'paid', 'A Cliente', '+12025550101', 'Calle 1', 'Bogotá', 'Cundinamarca',
 12000, 150000, 162000, 'PAY-SECRET', '2026-10-30T10:00:00Z', '2026-10-30T12:00:00Z',
 '2026-10-30T12:00:00Z', 'nequi', '${ADMIN}', 162000, 0
);
INSERT INTO public.order_items VALUES (
 '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
 1, 162000, 71000, '2026-10-30T10:00:00Z'
);
INSERT INTO public.product_variants VALUES ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',42);
INSERT INTO public.products VALUES ('30000000-0000-4000-8000-000000000001','Marca','Modelo','SKU-1');
GRANT SELECT ON public.orders, public.order_items TO authenticated;
CREATE FUNCTION public.admin_conversation_inbox_snapshot(timestamptz,timestamptz,text,integer,integer)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $function$
DECLARE snapshot JSONB;
BEGIN
 IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin required' USING ERRCODE='42501'; END IF;
 snapshot := jsonb_build_object('conversations',jsonb_build_array(jsonb_build_object('order',jsonb_build_object('order_id','x','status','paid','total_cents',162000,'payment_reference','PAY-SECRET','paid_at','2026-10-30','unit_cost_cents',71000,'amount_cents',162000,'context_source','test'))));
 RETURN snapshot;
END;
$function$;
CREATE FUNCTION public.admin_dashboard_snapshot(timestamptz,timestamptz,text,integer)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $function$
BEGIN IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin required' USING ERRCODE='42501'; END IF; RETURN '{}'::jsonb; END;
$function$;
CREATE FUNCTION public.admin_logistics_operations_snapshot(timestamptz,timestamptz,text,integer,integer)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $function$
DECLARE snapshot JSONB;
BEGIN IF NOT public.is_staff() THEN RAISE EXCEPTION 'staff required' USING ERRCODE='42501'; END IF; snapshot := jsonb_build_object('paid_at','2026-10-30','total_cents',162000,'paid_pending_dispatch_count',1); RETURN snapshot; END;
$function$;
CREATE TYPE public.conversation_context_resolutions AS (id UUID);
CREATE FUNCTION public.resolve_conversation_active_context(uuid,text,uuid,text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)
RETURNS public.conversation_context_resolutions LANGUAGE plpgsql SET search_path=public,pg_temp AS $function$
BEGIN IF NOT public.is_admin() THEN RAISE EXCEPTION 'admin required' USING ERRCODE='42501'; END IF; RETURN NULL; END;
$function$;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff read orders" ON public.orders FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY "Staff read order items" ON public.order_items FOR SELECT TO authenticated USING (public.is_staff());
`);

let checks = 0;
async function check(name, run) {
  await run();
  checks++;
  console.log(`PASS ${name}`);
}
async function asUser(userId, fn) {
  await db.exec('BEGIN');
  try {
    await db.exec('SET LOCAL ROLE authenticated');
    await db.query(`SELECT set_config('request.jwt.claim.role','authenticated',true), set_config('request.jwt.claim.sub',$1,true)`, [userId]);
    const value = await fn();
    await db.exec('COMMIT');
    return value;
  } catch (error) {
    await db.exec('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

await db.exec(migration);
await check('snapshot promotes only staff access and adds operator redaction under SECURITY DEFINER', async () => {
  const metadata = await db.query(`SELECT p.prosecdef AS definer, position('IF NOT public.is_staff() THEN' in p.prosrc)>0 AS staff_guard, position('public._redact_operator_order_fields(snapshot)' in p.prosrc)>0 AS redacts FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='admin_conversation_inbox_snapshot'`);
  assert.deepEqual(metadata.rows[0], { definer: true, staff_guard: true, redacts: true });
  const anonExec = await db.query(`SELECT proname, has_function_privilege('anon',oid,'EXECUTE') AS allowed FROM pg_proc WHERE proname IN ('admin_conversation_inbox_snapshot','admin_dashboard_snapshot','admin_logistics_operations_snapshot','resolve_conversation_active_context') ORDER BY proname`);
  assert.deepEqual(anonExec.rows, [
    { proname: 'admin_conversation_inbox_snapshot', allowed: false },
    { proname: 'admin_dashboard_snapshot', allowed: false },
    { proname: 'admin_logistics_operations_snapshot', allowed: false },
    { proname: 'resolve_conversation_active_context', allowed: false },
  ]);
});
await check('operator Inbox snapshot preserves operations while recursively removing order/payment amounts, refs and cost', async () => {
  const result = await asUser(OPERATOR, () => db.query(`SELECT public.admin_conversation_inbox_snapshot(now()-interval '1 day',now(),'America/Bogota',10,24) AS payload`));
  const json = JSON.stringify(result.rows[0].payload);
  for (const key of ['payment_reference','total_cents','paid_at','unit_cost_cents','amount_cents']) assert.equal(json.includes(key), false, `leaked ${key}`);
  assert.equal(result.rows[0].payload.conversations[0].order.status, 'paid');
  assert.equal(result.rows[0].payload.conversations[0].order.context_source, 'test');
});
await check('owner/admin snapshot retains full order context', async () => {
  const result = await asUser(ADMIN, () => db.query(`SELECT public.admin_conversation_inbox_snapshot(now()-interval '1 day',now(),'America/Bogota',10,24) AS payload`));
  assert.equal(result.rows[0].payload.conversations[0].order.total_cents, 162000);
  assert.equal(result.rows[0].payload.conversations[0].order.payment_reference, 'PAY-SECRET');
});
await check('operator can select explicitly granted operational order columns', async () => {
  const result = await asUser(OPERATOR, () => db.query('SELECT status, shipping_city FROM public.orders'));
  assert.deepEqual(result.rows, [{ status: 'paid', shipping_city: 'Bogotá' }]);
});
await check('operator is denied order amount/reference/payment timestamp columns', async () => {
  for (const column of ['total_cents','subtotal_cents','shipping_cost_cents','payment_reference','paid_at','payment_method','payment_received_cents','payment_shortfall_cents','payment_shortfall_at','payment_approved_by','payment_rejected_at','payment_rejection_reason']) {
    await assert.rejects(asUser(OPERATOR, () => db.query(`SELECT ${column} FROM public.orders`)), /permission denied/);
  }
});
await check('operator is denied order-item price and cost while retaining quantity/product metadata', async () => {
  const safe = await asUser(OPERATOR, () => db.query('SELECT order_id, product_id, qty FROM public.order_items'));
  assert.equal(safe.rows.length, 1);
  for (const column of ['unit_price_cents','unit_cost_cents']) {
    await assert.rejects(asUser(OPERATOR, () => db.query(`SELECT ${column} FROM public.order_items`)), /permission denied/);
  }
});
await check('full order listing and economics detail are owner/admin-only RPCs', async () => {
  const orders = await asUser(ADMIN, () => db.query('SELECT id,total_cents,payment_reference FROM public.admin_list_orders()'));
  assert.equal(orders.rows[0].total_cents, 162000);
  const items = await asUser(ADMIN, () => db.query(`SELECT unit_cost_cents,variant_size,product_sku FROM public.admin_order_items_detail('10000000-0000-4000-8000-000000000001')`));
  assert.deepEqual(items.rows[0], { unit_cost_cents: 71000, variant_size: '42', product_sku: 'SKU-1' });
  await assert.rejects(asUser(OPERATOR, () => db.query('SELECT * FROM public.admin_list_orders()')), /owner\/admin/);
  await assert.rejects(asUser(OPERATOR, () => db.query(`SELECT * FROM public.admin_order_items_detail('10000000-0000-4000-8000-000000000001')`)), /owner\/admin/);
});
await check('staff logistics snapshot is SECURITY DEFINER and strips financial fields for operators', async () => {
  const result = await asUser(OPERATOR, () => db.query(`SELECT public.admin_logistics_operations_snapshot(now()-interval '1 day',now(),'America/Bogota',24,72) AS payload`));
  const json = JSON.stringify(result.rows[0].payload);
  assert.equal(json.includes('total_cents'), false);
  assert.equal(json.includes('paid_at'), false);
  assert.equal(result.rows[0].payload.paid_pending_dispatch_count, 1);
});
await check('admin financial dashboard and context resolver stay guarded owner/admin SECURITY DEFINER routines', async () => {
  const rows = await db.query(`SELECT proname, prosecdef FROM pg_proc WHERE proname IN ('admin_dashboard_snapshot','resolve_conversation_active_context') ORDER BY proname`);
  assert.deepEqual(rows.rows, [{ proname: 'admin_dashboard_snapshot', prosecdef: true }, { proname: 'resolve_conversation_active_context', prosecdef: true }]);
  await assert.rejects(asUser(OPERATOR, () => db.query(`SELECT public.admin_dashboard_snapshot(now()-interval '1 day',now(),'America/Bogota',24)`)), /admin required/);
});
await check('corrective migration is idempotent', async () => {
  await db.exec(migration);
  const result = await asUser(OPERATOR, () => db.query(`SELECT public.admin_conversation_inbox_snapshot(now()-interval '1 day',now(),'America/Bogota',10,24) AS payload`));
  assert.equal(JSON.stringify(result.rows[0].payload).includes('payment_reference'), false);
});

console.log(`PASS ${checks} operator order hardening checks`);
