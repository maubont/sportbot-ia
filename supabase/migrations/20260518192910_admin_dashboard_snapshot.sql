-- Admin dashboard canonical KPI snapshot.
-- Date: 2026-05-18
-- Purpose:
--   Centralize operational, commercial, logistics, inventory and financial
--   metrics so the Admin UI and future internal agents read the same source.

CREATE INDEX IF NOT EXISTS idx_orders_status_paid_at
ON public.orders (status, paid_at DESC)
WHERE paid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_orders_status_created
ON public.orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payments_status_approved_at
ON public.payments (status, approved_at DESC)
WHERE approved_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.admin_dashboard_snapshot(
    p_from TIMESTAMPTZ DEFAULT (NOW() - INTERVAL '30 days'),
    p_to TIMESTAMPTZ DEFAULT NOW(),
    p_timezone TEXT DEFAULT 'America/Bogota',
    p_fulfillment_sla_hours INTEGER DEFAULT 24
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    snapshot JSONB;
    previous_from TIMESTAMPTZ;
    current_duration INTERVAL;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_dashboard_snapshot requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
        RAISE EXCEPTION 'Invalid dashboard window'
            USING ERRCODE = '22007';
    END IF;

    IF p_fulfillment_sla_hours IS NULL OR p_fulfillment_sla_hours < 1 THEN
        p_fulfillment_sla_hours := 24;
    END IF;

    current_duration := p_to - p_from;
    previous_from := p_from - current_duration;

    WITH
    paid_orders AS (
        SELECT o.*
        FROM public.orders o
        WHERE o.status IN ('paid', 'shipped', 'delivered')
          AND o.paid_at >= p_from
          AND o.paid_at < p_to
    ),
    previous_paid_orders AS (
        SELECT o.*
        FROM public.orders o
        WHERE o.status IN ('paid', 'shipped', 'delivered')
          AND o.paid_at >= previous_from
          AND o.paid_at < p_from
    ),
    economics AS (
        SELECT
            COALESCE(SUM(oe.revenue_cents), 0)::INTEGER AS revenue_cents,
            COALESCE(SUM(oe.cogs_cents), 0)::INTEGER AS cogs_cents,
            COALESCE(SUM(oe.payment_fee_cents), 0)::INTEGER AS payment_fee_cents,
            COALESCE(SUM(oe.shipping_real_cost_cents), 0)::INTEGER AS shipping_real_cost_cents,
            COALESCE(SUM(oe.packaging_cost_cents), 0)::INTEGER AS packaging_cost_cents,
            COALESCE(SUM(oe.discount_cents), 0)::INTEGER AS discount_cents,
            COALESCE(SUM(oe.twilio_cost_cents), 0)::INTEGER AS twilio_cost_cents,
            COALESCE(SUM(oe.ai_cost_cents), 0)::INTEGER AS ai_cost_cents,
            COALESCE(SUM(oe.other_variable_cost_cents), 0)::INTEGER AS other_variable_cost_cents,
            COALESCE(SUM(oe.variable_cost_cents), 0)::INTEGER AS variable_cost_cents,
            COALESCE(SUM(oe.gross_margin_cents), 0)::INTEGER AS gross_margin_cents,
            COALESCE(SUM(oe.contribution_margin_cents), 0)::INTEGER AS contribution_margin_cents,
            COUNT(*) FILTER (WHERE oe.data_quality_flags && ARRAY['missing_cogs'])::INTEGER AS missing_cogs_order_count,
            COUNT(*) FILTER (WHERE oe.data_quality_flags && ARRAY['missing_payment_fee'])::INTEGER AS missing_payment_fee_order_count,
            COUNT(*) FILTER (WHERE oe.data_quality_flags && ARRAY['missing_shipping_real_cost'])::INTEGER AS missing_shipping_real_cost_order_count,
            COUNT(*) FILTER (WHERE oe.data_quality_flags && ARRAY['negative_contribution_margin'])::INTEGER AS negative_margin_order_count
        FROM paid_orders o
        LEFT JOIN public.order_economics oe ON oe.order_id = o.id
    ),
    paid_summary AS (
        SELECT
            COUNT(*)::INTEGER AS paid_orders_count,
            COALESCE(SUM(o.total_cents), 0)::INTEGER AS revenue_cents,
            COALESCE(ROUND(AVG(o.total_cents)), 0)::INTEGER AS average_order_value_cents
        FROM paid_orders o
    ),
    previous_paid_summary AS (
        SELECT
            COUNT(*)::INTEGER AS paid_orders_count,
            COALESCE(SUM(o.total_cents), 0)::INTEGER AS revenue_cents
        FROM previous_paid_orders o
    ),
    commercial_summary AS (
        SELECT
            (SELECT COUNT(*) FROM public.conversations WHERE status = 'open')::INTEGER AS open_conversations_count,
            (SELECT COUNT(*) FROM public.messages WHERE direction = 'inbound' AND created_at >= p_from AND created_at < p_to)::INTEGER AS inbound_messages_count,
            (SELECT COUNT(*) FROM public.messages WHERE direction = 'outbound' AND created_at >= p_from AND created_at < p_to)::INTEGER AS outbound_messages_count,
            (SELECT COUNT(*) FROM public.orders WHERE created_at >= p_from AND created_at < p_to)::INTEGER AS orders_created_count,
            (SELECT COUNT(*) FROM public.orders WHERE payment_reference IS NOT NULL AND created_at >= p_from AND created_at < p_to)::INTEGER AS payment_links_count,
            (SELECT COUNT(*) FROM public.payments WHERE LOWER(status) = 'approved' AND COALESCE(approved_at, updated_at, created_at) >= p_from AND COALESCE(approved_at, updated_at, created_at) < p_to)::INTEGER AS payments_approved_count,
            (SELECT COUNT(*) FROM public.payments WHERE LOWER(status) IN ('declined', 'error', 'voided', 'failed') AND COALESCE(updated_at, created_at) >= p_from AND COALESCE(updated_at, created_at) < p_to)::INTEGER AS payments_rejected_count
    ),
    logistics_summary AS (
        SELECT
            (
                SELECT COUNT(*)
                FROM public.orders o
                WHERE o.status = 'paid'
                  AND o.paid_at IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.shipments s
                      WHERE s.order_id = o.id
                        AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
                  )
            )::INTEGER AS paid_pending_dispatch_count,
            (
                SELECT COUNT(*)
                FROM public.orders o
                WHERE o.status = 'paid'
                  AND o.paid_at IS NOT NULL
                  AND o.paid_at < NOW() - make_interval(hours => p_fulfillment_sla_hours)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.shipments s
                      WHERE s.order_id = o.id
                        AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
                  )
            )::INTEGER AS paid_over_sla_count,
            (
                SELECT COUNT(*)
                FROM public.shipments s
                WHERE s.status IN ('shipped', 'in_transit', 'out_for_delivery')
            )::INTEGER AS active_shipments_count,
            (
                SELECT COUNT(*)
                FROM public.shipments s
                WHERE s.status = 'delivered'
                  AND s.delivered_at >= p_from
                  AND s.delivered_at < p_to
            )::INTEGER AS delivered_count,
            (
                SELECT COUNT(*)
                FROM public.shipments s
                WHERE s.status IN ('shipped', 'in_transit', 'out_for_delivery')
                  AND NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NULL
            )::INTEGER AS missing_tracking_count,
            (
                SELECT COUNT(*)
                FROM public.logistics_notifications ln
                WHERE ln.status IN ('failed', 'undelivered')
                  AND ln.created_at >= p_from
                  AND ln.created_at < p_to
            )::INTEGER AS failed_notification_count,
            (
                SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (s.shipped_at - o.paid_at)) / 3600)), 0)::INTEGER
                FROM public.shipments s
                JOIN public.orders o ON o.id = s.order_id
                WHERE s.shipped_at IS NOT NULL
                  AND o.paid_at IS NOT NULL
                  AND s.shipped_at >= p_from
                  AND s.shipped_at < p_to
            ) AS avg_payment_to_dispatch_hours,
            (
                SELECT COALESCE(ROUND(AVG(EXTRACT(EPOCH FROM (s.delivered_at - s.shipped_at)) / 3600)), 0)::INTEGER
                FROM public.shipments s
                WHERE s.shipped_at IS NOT NULL
                  AND s.delivered_at IS NOT NULL
                  AND s.delivered_at >= p_from
                  AND s.delivered_at < p_to
            ) AS avg_dispatch_to_delivery_hours
    ),
    inventory_summary AS (
        SELECT
            COALESCE(SUM(pv.stock), 0)::INTEGER AS physical_units,
            COALESCE(SUM(pv.reserved), 0)::INTEGER AS reserved_units,
            COALESCE(SUM(pv.stock - pv.reserved), 0)::INTEGER AS available_units,
            COUNT(*) FILTER (WHERE pv.stock - pv.reserved < 3)::INTEGER AS low_stock_variants_count,
            COUNT(*) FILTER (WHERE pv.stock - pv.reserved <= 0)::INTEGER AS sold_out_variants_count
        FROM public.product_variants pv
        JOIN public.products p ON p.id = pv.product_id
        WHERE COALESCE(p.active, TRUE)
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window', jsonb_build_object(
            'from', p_from,
            'to', p_to,
            'timezone', p_timezone,
            'previous_from', previous_from,
            'previous_to', p_from,
            'fulfillment_sla_hours', p_fulfillment_sla_hours
        ),
        'executive', jsonb_build_object(
            'revenue_cents', ps.revenue_cents,
            'previous_revenue_cents', pps.revenue_cents,
            'revenue_delta_bps', CASE
                WHEN pps.revenue_cents = 0 THEN NULL
                ELSE ROUND(((ps.revenue_cents - pps.revenue_cents)::NUMERIC / pps.revenue_cents::NUMERIC) * 10000)::INTEGER
            END,
            'paid_orders_count', ps.paid_orders_count,
            'previous_paid_orders_count', pps.paid_orders_count,
            'average_order_value_cents', ps.average_order_value_cents,
            'contribution_margin_cents', e.contribution_margin_cents,
            'contribution_margin_bps', CASE
                WHEN e.revenue_cents = 0 THEN 0
                ELSE ROUND((e.contribution_margin_cents::NUMERIC / e.revenue_cents::NUMERIC) * 10000)::INTEGER
            END,
            'gross_margin_cents', e.gross_margin_cents,
            'gross_margin_bps', CASE
                WHEN e.revenue_cents = 0 THEN 0
                ELSE ROUND((e.gross_margin_cents::NUMERIC / e.revenue_cents::NUMERIC) * 10000)::INTEGER
            END,
            'open_conversations_count', cs.open_conversations_count
        ),
        'commercial', jsonb_build_object(
            'open_conversations_count', cs.open_conversations_count,
            'inbound_messages_count', cs.inbound_messages_count,
            'outbound_messages_count', cs.outbound_messages_count,
            'orders_created_count', cs.orders_created_count,
            'payment_links_count', cs.payment_links_count,
            'payments_approved_count', cs.payments_approved_count,
            'payments_rejected_count', cs.payments_rejected_count,
            'link_to_approved_bps', CASE
                WHEN cs.payment_links_count = 0 THEN 0
                ELSE ROUND((cs.payments_approved_count::NUMERIC / cs.payment_links_count::NUMERIC) * 10000)::INTEGER
            END
        ),
        'logistics', jsonb_build_object(
            'paid_pending_dispatch_count', ls.paid_pending_dispatch_count,
            'paid_over_sla_count', ls.paid_over_sla_count,
            'active_shipments_count', ls.active_shipments_count,
            'delivered_count', ls.delivered_count,
            'missing_tracking_count', ls.missing_tracking_count,
            'failed_notification_count', ls.failed_notification_count,
            'avg_payment_to_dispatch_hours', ls.avg_payment_to_dispatch_hours,
            'avg_dispatch_to_delivery_hours', ls.avg_dispatch_to_delivery_hours
        ),
        'finance', jsonb_build_object(
            'revenue_cents', e.revenue_cents,
            'cogs_cents', e.cogs_cents,
            'payment_fee_cents', e.payment_fee_cents,
            'shipping_real_cost_cents', e.shipping_real_cost_cents,
            'packaging_cost_cents', e.packaging_cost_cents,
            'discount_cents', e.discount_cents,
            'twilio_cost_cents', e.twilio_cost_cents,
            'ai_cost_cents', e.ai_cost_cents,
            'other_variable_cost_cents', e.other_variable_cost_cents,
            'variable_cost_cents', e.variable_cost_cents,
            'gross_margin_cents', e.gross_margin_cents,
            'contribution_margin_cents', e.contribution_margin_cents,
            'missing_cogs_order_count', e.missing_cogs_order_count,
            'missing_payment_fee_order_count', e.missing_payment_fee_order_count,
            'missing_shipping_real_cost_order_count', e.missing_shipping_real_cost_order_count,
            'negative_margin_order_count', e.negative_margin_order_count
        ),
        'inventory', jsonb_build_object(
            'physical_units', inv.physical_units,
            'reserved_units', inv.reserved_units,
            'available_units', inv.available_units,
            'low_stock_variants_count', inv.low_stock_variants_count,
            'sold_out_variants_count', inv.sold_out_variants_count
        ),
        'queues', jsonb_build_object(
            'paid_to_dispatch', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY paid_at ASC)
                FROM (
                    SELECT
                        o.paid_at,
                        jsonb_build_object(
                            'order_id', o.id,
                            'customer_name', c.name,
                            'shipping_city', o.shipping_city,
                            'total_cents', o.total_cents,
                            'paid_at', o.paid_at,
                            'hours_waiting', COALESCE(ROUND(EXTRACT(EPOCH FROM (NOW() - o.paid_at)) / 3600), 0)::INTEGER,
                            'over_sla', o.paid_at < NOW() - make_interval(hours => p_fulfillment_sla_hours)
                        ) AS row_payload
                    FROM public.orders o
                    LEFT JOIN public.customers c ON c.id = o.customer_id
                    WHERE o.status = 'paid'
                      AND o.paid_at IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1
                          FROM public.shipments s
                          WHERE s.order_id = o.id
                            AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
                      )
                    ORDER BY o.paid_at ASC
                    LIMIT 10
                ) q
            ), '[]'::jsonb),
            'inventory_alerts', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY available ASC, brand ASC, model ASC)
                FROM (
                    SELECT
                        p.brand,
                        p.model,
                        (pv.stock - pv.reserved) AS available,
                        jsonb_build_object(
                            'variant_id', pv.id,
                            'product_id', p.id,
                            'brand', p.brand,
                            'model', p.model,
                            'size', pv.size,
                            'stock', pv.stock,
                            'reserved', pv.reserved,
                            'available', pv.stock - pv.reserved,
                            'status', CASE WHEN pv.stock - pv.reserved <= 0 THEN 'sold_out' ELSE 'low_stock' END
                        ) AS row_payload
                    FROM public.product_variants pv
                    JOIN public.products p ON p.id = pv.product_id
                    WHERE COALESCE(p.active, TRUE)
                      AND pv.stock - pv.reserved < 3
                    ORDER BY available ASC, p.brand ASC, p.model ASC
                    LIMIT 10
                ) q
            ), '[]'::jsonb),
            'data_quality_alerts', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY created_at DESC)
                FROM (
                    SELECT
                        o.created_at,
                        jsonb_build_object(
                            'order_id', o.id,
                            'status', o.status,
                            'total_cents', o.total_cents,
                            'flags', COALESCE(oe.data_quality_flags, ARRAY[]::TEXT[])
                        ) AS row_payload
                    FROM public.orders o
                    JOIN public.order_economics oe ON oe.order_id = o.id
                    WHERE o.status IN ('paid', 'shipped', 'delivered')
                      AND array_length(oe.data_quality_flags, 1) IS NOT NULL
                    ORDER BY o.created_at DESC
                    LIMIT 10
                ) q
            ), '[]'::jsonb),
            'recent_orders', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY created_at DESC)
                FROM (
                    SELECT
                        o.created_at,
                        jsonb_build_object(
                            'order_id', o.id,
                            'status', o.status,
                            'total_cents', o.total_cents,
                            'created_at', o.created_at,
                            'paid_at', o.paid_at,
                            'customer_name', c.name,
                            'contribution_margin_cents', oe.contribution_margin_cents,
                            'contribution_margin_bps', oe.contribution_margin_bps
                        ) AS row_payload
                    FROM public.orders o
                    LEFT JOIN public.customers c ON c.id = o.customer_id
                    LEFT JOIN public.order_economics oe ON oe.order_id = o.id
                    ORDER BY o.created_at DESC
                    LIMIT 8
                ) q
            ), '[]'::jsonb)
        ),
        'agent_context', jsonb_build_object(
            'mode', 'suggest_only',
            'top_priorities', jsonb_build_array(
                jsonb_build_object(
                    'key', 'paid_over_sla',
                    'count', ls.paid_over_sla_count,
                    'severity', CASE WHEN ls.paid_over_sla_count > 0 THEN 'high' ELSE 'ok' END
                ),
                jsonb_build_object(
                    'key', 'missing_costs',
                    'count', e.missing_cogs_order_count,
                    'severity', CASE WHEN e.missing_cogs_order_count > 0 THEN 'medium' ELSE 'ok' END
                ),
                jsonb_build_object(
                    'key', 'negative_margin',
                    'count', e.negative_margin_order_count,
                    'severity', CASE WHEN e.negative_margin_order_count > 0 THEN 'high' ELSE 'ok' END
                ),
                jsonb_build_object(
                    'key', 'failed_logistics_notifications',
                    'count', ls.failed_notification_count,
                    'severity', CASE WHEN ls.failed_notification_count > 0 THEN 'medium' ELSE 'ok' END
                )
            )
        )
    )
    INTO snapshot
    FROM paid_summary ps
    CROSS JOIN previous_paid_summary pps
    CROSS JOIN economics e
    CROSS JOIN commercial_summary cs
    CROSS JOIN logistics_summary ls
    CROSS JOIN inventory_summary inv;

    RETURN snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_dashboard_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.admin_dashboard_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER)
IS 'Canonical admin KPI snapshot for dashboard, operations and future suggest-only internal agents.';

NOTIFY pgrst, 'reload schema';
