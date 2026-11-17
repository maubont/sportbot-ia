-- Security hardening for the deployed baseline and order write boundary.
-- Version 20261106130000 follows the latest checked-in migration stamp
-- (20261106120000); this version is an ordering key, not evidence of deployment.

-- Keep the existing role contract: all users registered in admin_users may
-- operate these tables; authenticated users outside that allowlist may not.

-- Remove the permissive 2025 baseline policies. Adding a restrictive policy
-- alone is insufficient because permissive policies are OR-combined.
ALTER TABLE public.product_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_variable_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_economics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin Full Access Product Costs" ON public.product_costs;
DROP POLICY IF EXISTS "Public Full Access Product Costs" ON public.product_costs;
DROP POLICY IF EXISTS "Admins manage product costs" ON public.product_costs;
CREATE POLICY "Admins manage product costs"
    ON public.product_costs
    FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admin Full Access Order Variable Costs" ON public.order_variable_costs;
DROP POLICY IF EXISTS "Public Full Access Order Variable Costs" ON public.order_variable_costs;
DROP POLICY IF EXISTS "Admins manage order variable costs" ON public.order_variable_costs;
CREATE POLICY "Admins manage order variable costs"
    ON public.order_variable_costs
    FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admin Full Access Order Economics" ON public.order_economics;
DROP POLICY IF EXISTS "Public Full Access Order Economics" ON public.order_economics;
DROP POLICY IF EXISTS "Admins manage order economics" ON public.order_economics;
CREATE POLICY "Admins manage order economics"
    ON public.order_economics
    FOR ALL
    TO authenticated
    USING (public.is_admin())
    WITH CHECK (public.is_admin());

REVOKE ALL ON TABLE public.product_costs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.order_variable_costs FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.order_economics FROM PUBLIC, anon;

-- Browser clients can inspect operational orders, but cannot bypass the
-- transactional/state-transition RPCs with direct INSERT/UPDATE/DELETE.
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admin Full Access Orders" ON public.orders;
DROP POLICY IF EXISTS "Public Full Access Orders" ON public.orders;
DROP POLICY IF EXISTS "Admins manage orders" ON public.orders;
DROP POLICY IF EXISTS "Admins read orders" ON public.orders;
CREATE POLICY "Admins read orders"
    ON public.orders
    FOR SELECT
    TO authenticated
    USING (public.is_admin());

DROP POLICY IF EXISTS "Admin Full Access Order Items" ON public.order_items;
DROP POLICY IF EXISTS "Public Full Access Order Items" ON public.order_items;
DROP POLICY IF EXISTS "Admins manage order items" ON public.order_items;
DROP POLICY IF EXISTS "Admins read order items" ON public.order_items;
CREATE POLICY "Admins read order items"
    ON public.order_items
    FOR SELECT
    TO authenticated
    USING (public.is_admin());

DROP POLICY IF EXISTS "Admin Full Access Payments" ON public.payments;
DROP POLICY IF EXISTS "Public Full Access Payments" ON public.payments;
DROP POLICY IF EXISTS "Admins manage payments" ON public.payments;
DROP POLICY IF EXISTS "Admins read payments" ON public.payments;
CREATE POLICY "Admins read payments"
    ON public.payments
    FOR SELECT
    TO authenticated
    USING (public.is_admin());

REVOKE ALL ON TABLE public.orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.order_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.orders, public.order_items, public.payments TO authenticated;

-- Order creation and inbound deduplication are backend-only. Keep their
-- security boundary explicit even if default grants change in the future.
REVOKE ALL ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT)
    TO service_role;
