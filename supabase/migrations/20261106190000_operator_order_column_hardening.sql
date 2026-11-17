-- Operator Inbox access and least-privilege order columns.
-- Owner/admin retain complete order data through guarded RPCs; staff receives
-- only explicitly granted operational columns. Operators never receive financial
-- columns from direct PostgREST table reads.
BEGIN;

CREATE OR REPLACE FUNCTION public._redact_operator_order_fields(p_value JSONB)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_result JSONB;
BEGIN
    CASE jsonb_typeof(p_value)
        WHEN 'object' THEN
            SELECT COALESCE(jsonb_object_agg(e.key, public._redact_operator_order_fields(e.value)), '{}'::jsonb)
            INTO v_result
            FROM jsonb_each(p_value) AS e(key, value)
            WHERE e.key <> ALL (ARRAY[
                'payment_reference', 'total_cents', 'subtotal_cents',
                'shipping_cost_cents', 'discount_cents', 'paid_at',
                'payment_approved_at', 'approved_at', 'payment_id',
                'unit_price_cents', 'unit_cost_cents', 'amount_cents',
                'revenue_cents', 'cogs_cents', 'gross_margin_cents',
                'contribution_margin_cents', 'payment_fee_cents'
            ]::TEXT[]);
            RETURN COALESCE(v_result, '{}'::jsonb);
        WHEN 'array' THEN
            SELECT COALESCE(jsonb_agg(public._redact_operator_order_fields(e.value) ORDER BY e.ordinality), '[]'::jsonb)
            INTO v_result
            FROM jsonb_array_elements(p_value) WITH ORDINALITY AS e(value, ordinality);
            RETURN COALESCE(v_result, '[]'::jsonb);
        ELSE
            RETURN p_value;
    END CASE;
END;
$$;
REVOKE ALL ON FUNCTION public._redact_operator_order_fields(JSONB) FROM PUBLIC, anon, authenticated, service_role;

DO $secure_privileged_order_routines$
DECLARE
    v_signature TEXT;
    v_function_oid OID;
    v_definition TEXT;
    v_changed BOOLEAN;
    v_signatures TEXT[] := ARRAY[
        'public.admin_conversation_inbox_snapshot(timestamptz,timestamptz,text,integer,integer)',
        'public.admin_dashboard_snapshot(timestamptz,timestamptz,text,integer)',
        'public.admin_logistics_operations_snapshot(timestamptz,timestamptz,text,integer,integer)',
        'public.resolve_conversation_active_context(uuid,text,uuid,text,uuid,uuid,text,text,text,text,text,text,jsonb,jsonb)'
    ];
BEGIN
    FOREACH v_signature IN ARRAY v_signatures LOOP
        v_function_oid := to_regprocedure(v_signature);
        IF v_function_oid IS NULL THEN
            RAISE EXCEPTION 'Required routine missing for order column hardening: %', v_signature;
        END IF;
        v_definition := pg_get_functiondef(v_function_oid);

        IF position('SECURITY DEFINER' IN v_definition) = 0 THEN
            IF position(E'\n LANGUAGE plpgsql\n' IN v_definition) = 0 THEN
                RAISE EXCEPTION 'Unexpected language declaration in %', v_signature;
            END IF;
            v_definition := replace(v_definition, E'\n LANGUAGE plpgsql\n', E'\n LANGUAGE plpgsql\n SECURITY DEFINER\n');
        END IF;
        IF position('SET search_path TO ''public'', ''pg_temp''' IN v_definition) > 0 THEN
            v_definition := replace(v_definition,
                'SET search_path TO ''public'', ''pg_temp''',
                'SET search_path TO ''pg_catalog'', ''public'', ''auth'', ''pg_temp''');
        ELSIF position('SET search_path TO ''pg_catalog'', ''public'', ''auth'', ''pg_temp''' IN v_definition) = 0 THEN
            RAISE EXCEPTION 'Unexpected or unsafe search_path in %', v_signature;
        END IF;

        IF v_signature = 'public.admin_conversation_inbox_snapshot(timestamptz,timestamptz,text,integer,integer)' THEN
            IF position('IF NOT public.is_admin() THEN' IN v_definition) > 0 THEN
                v_definition := replace(v_definition, 'IF NOT public.is_admin() THEN', 'IF NOT public.is_staff() THEN');
                v_definition := replace(v_definition, 'admin_conversation_inbox_snapshot requires an admin user', 'admin_conversation_inbox_snapshot requires an authorized staff user');
            ELSIF position('IF NOT public.is_staff() THEN' IN v_definition) = 0 THEN
                RAISE EXCEPTION 'Inbox snapshot has no recognized authorization guard';
            END IF;
            IF position('RETURN snapshot;' IN v_definition) > 0 THEN
                v_definition := replace(v_definition, 'RETURN snapshot;',
                    'RETURN CASE WHEN public.is_operator() THEN public._redact_operator_order_fields(snapshot) ELSE snapshot END;');
            ELSIF position('public._redact_operator_order_fields(snapshot)' IN v_definition) = 0 THEN
                RAISE EXCEPTION 'Inbox snapshot has no recognized return path for operator redaction';
            END IF;
            IF position('IF NOT public.is_staff() THEN' IN v_definition) = 0
               OR position('public._redact_operator_order_fields(snapshot)' IN v_definition) = 0 THEN
                RAISE EXCEPTION 'Inbox snapshot transformation incomplete';
            END IF;
        ELSIF v_signature = 'public.admin_logistics_operations_snapshot(timestamptz,timestamptz,text,integer,integer)' THEN
            IF position('IF NOT public.is_staff() THEN' IN v_definition) = 0
               AND position('IF NOT public.is_admin() THEN' IN v_definition) = 0 THEN
                RAISE EXCEPTION 'Logistics snapshot has no recognized role guard';
            END IF;
            IF position('RETURN snapshot;' IN v_definition) > 0 THEN
                v_definition := replace(v_definition, 'RETURN snapshot;',
                    'RETURN CASE WHEN public.is_operator() THEN public._redact_operator_order_fields(snapshot) ELSE snapshot END;');
            ELSIF position('public._redact_operator_order_fields(snapshot)' IN v_definition) = 0 THEN
                RAISE EXCEPTION 'Logistics snapshot has no recognized return path for operator redaction';
            END IF;
        END IF;
        EXECUTE v_definition;
    END LOOP;
END;
$secure_privileged_order_routines$;

REVOKE ALL ON FUNCTION public.admin_conversation_inbox_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_conversation_inbox_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_dashboard_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_logistics_operations_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_logistics_operations_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_conversation_active_context(UUID, TEXT, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_conversation_active_context(UUID, TEXT, UUID, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO authenticated, service_role;

-- Give operators an explicit operational column allowlist; table-wide SELECT is
-- removed so PostgREST cannot project monetary/order-cost columns. RLS remains
-- responsible for row scope. Service-role access is unaffected.
REVOKE SELECT ON TABLE public.orders FROM PUBLIC, anon, authenticated;
REVOKE SELECT (payment_reference, total_cents, subtotal_cents, shipping_cost_cents, paid_at,
               payment_received_cents, payment_shortfall_cents, payment_shortfall_at,
               payment_approved_by, payment_rejected_at, payment_rejection_reason)
    ON TABLE public.orders FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, customer_id, status, shipping_name, shipping_phone, shipping_address,
              shipping_city, shipping_region, created_at, updated_at)
    ON TABLE public.orders TO authenticated;

REVOKE SELECT ON TABLE public.order_items FROM PUBLIC, anon, authenticated;
REVOKE SELECT (unit_price_cents, unit_cost_cents)
    ON TABLE public.order_items FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, order_id, product_id, variant_id, qty, created_at)
    ON TABLE public.order_items TO authenticated;

-- Keep row access limited to staff. Column grants above independently restrict
-- the fields any authenticated role can project.
DROP POLICY IF EXISTS "Staff read orders" ON public.orders;
DROP POLICY IF EXISTS "Admins read orders" ON public.orders;
CREATE POLICY "Staff read orders" ON public.orders
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Staff read order items" ON public.order_items;
DROP POLICY IF EXISTS "Admins read order items" ON public.order_items;
CREATE POLICY "Staff read order items" ON public.order_items
    FOR SELECT TO authenticated USING (public.is_staff());

-- Full orders and item economics remain available only through admin-guarded
-- RPCs for the Orders page; the UI must not query restricted table columns.
CREATE OR REPLACE FUNCTION public.admin_list_orders()
RETURNS SETOF public.orders
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_list_orders requires owner/admin' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY SELECT o.* FROM public.orders AS o ORDER BY o.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_list_orders() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_orders() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_order_items_detail(p_order_id UUID)
RETURNS TABLE (
    id UUID,
    qty INTEGER,
    unit_price_cents INTEGER,
    unit_cost_cents INTEGER,
    variant_size NUMERIC,
    product_brand TEXT,
    product_model TEXT,
    product_sku TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_order_items_detail requires owner/admin' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT oi.id, oi.qty, oi.unit_price_cents, oi.unit_cost_cents,
           pv.size, p.brand, p.model, p.sku
    FROM public.order_items AS oi
    LEFT JOIN public.product_variants AS pv ON pv.id = oi.variant_id
    LEFT JOIN public.products AS p ON p.id = oi.product_id
    WHERE oi.order_id = p_order_id
    ORDER BY oi.created_at;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_order_items_detail(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_order_items_detail(UUID) TO authenticated, service_role;

COMMENT ON FUNCTION public._redact_operator_order_fields(JSONB) IS
    'Recursively removes financial and unit-cost fields from operator-facing Inbox/logistics snapshots.';
COMMENT ON FUNCTION public.admin_list_orders() IS
    'Owner/admin-only full order listing for the Admin Orders page; direct authenticated table access is column-limited.';
COMMENT ON FUNCTION public.admin_order_items_detail(UUID) IS
    'Owner/admin-only full order-line detail for the Admin Orders page; direct authenticated table access is column-limited.';

NOTIFY pgrst, 'reload schema';
COMMIT;
