-- Logistics / Operations command center snapshot.
-- Date: 2026-05-18
-- Purpose:
--   Provide a dedicated server-side KPI source for fulfillment operations,
--   including configurable SLA, p50/p90 timing and actionable queues.

ALTER TABLE public.settings
ADD COLUMN IF NOT EXISTS fulfillment_sla_hours INTEGER;

ALTER TABLE public.settings
ADD COLUMN IF NOT EXISTS delivery_sla_hours INTEGER;

UPDATE public.settings
SET
    fulfillment_sla_hours = COALESCE(fulfillment_sla_hours, 24),
    delivery_sla_hours = COALESCE(delivery_sla_hours, 72)
WHERE id = 1;

ALTER TABLE public.settings
ALTER COLUMN fulfillment_sla_hours SET DEFAULT 24;

ALTER TABLE public.settings
ALTER COLUMN delivery_sla_hours SET DEFAULT 72;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'settings_fulfillment_sla_hours_positive'
          AND conrelid = 'public.settings'::regclass
    ) THEN
        ALTER TABLE public.settings
        ADD CONSTRAINT settings_fulfillment_sla_hours_positive
        CHECK (fulfillment_sla_hours IS NULL OR fulfillment_sla_hours > 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'settings_delivery_sla_hours_positive'
          AND conrelid = 'public.settings'::regclass
    ) THEN
        ALTER TABLE public.settings
        ADD CONSTRAINT settings_delivery_sla_hours_positive
        CHECK (delivery_sla_hours IS NULL OR delivery_sla_hours > 0);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shipments_shipped_active
ON public.shipments (shipped_at DESC)
WHERE status IN ('shipped', 'in_transit', 'out_for_delivery');

CREATE INDEX IF NOT EXISTS idx_shipments_delivered_at
ON public.shipments (delivered_at DESC)
WHERE delivered_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_logistics_notifications_failed
ON public.logistics_notifications (created_at DESC)
WHERE status IN ('failed', 'undelivered');

CREATE OR REPLACE FUNCTION public.admin_logistics_operations_snapshot(
    p_from TIMESTAMPTZ DEFAULT (NOW() - INTERVAL '30 days'),
    p_to TIMESTAMPTZ DEFAULT NOW(),
    p_timezone TEXT DEFAULT 'America/Bogota',
    p_fulfillment_sla_hours INTEGER DEFAULT NULL,
    p_delivery_sla_hours INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    snapshot JSONB;
    effective_fulfillment_sla_hours INTEGER;
    effective_delivery_sla_hours INTEGER;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_logistics_operations_snapshot requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
        RAISE EXCEPTION 'Invalid logistics snapshot window'
            USING ERRCODE = '22007';
    END IF;

    SELECT
        COALESCE(p_fulfillment_sla_hours, s.fulfillment_sla_hours, 24),
        COALESCE(p_delivery_sla_hours, s.delivery_sla_hours, 72)
    INTO effective_fulfillment_sla_hours, effective_delivery_sla_hours
    FROM public.settings s
    WHERE s.id = 1;

    effective_fulfillment_sla_hours := COALESCE(effective_fulfillment_sla_hours, 24);
    effective_delivery_sla_hours := COALESCE(effective_delivery_sla_hours, 72);

    IF effective_fulfillment_sla_hours < 1 THEN
        effective_fulfillment_sla_hours := 24;
    END IF;

    IF effective_delivery_sla_hours < 1 THEN
        effective_delivery_sla_hours := 72;
    END IF;

    WITH
    paid_pending AS (
        SELECT
            o.id,
            o.customer_id,
            o.total_cents,
            o.shipping_city,
            o.paid_at,
            c.name AS customer_name,
            EXTRACT(EPOCH FROM (NOW() - o.paid_at)) / 3600 AS hours_waiting
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
    ),
    active_shipments AS (
        SELECT
            s.*,
            o.total_cents,
            o.paid_at,
            o.shipping_city,
            c.name AS customer_name,
            EXTRACT(EPOCH FROM (NOW() - s.shipped_at)) / 3600 AS hours_in_transit
        FROM public.shipments s
        JOIN public.orders o ON o.id = s.order_id
        LEFT JOIN public.customers c ON c.id = o.customer_id
        WHERE s.status IN ('shipped', 'in_transit', 'out_for_delivery')
    ),
    payment_to_dispatch AS (
        SELECT EXTRACT(EPOCH FROM (s.shipped_at - o.paid_at)) / 3600 AS hours_value
        FROM public.shipments s
        JOIN public.orders o ON o.id = s.order_id
        WHERE s.shipped_at IS NOT NULL
          AND o.paid_at IS NOT NULL
          AND s.shipped_at >= p_from
          AND s.shipped_at < p_to
          AND s.shipped_at >= o.paid_at
    ),
    dispatch_to_delivery AS (
        SELECT EXTRACT(EPOCH FROM (s.delivered_at - s.shipped_at)) / 3600 AS hours_value
        FROM public.shipments s
        WHERE s.shipped_at IS NOT NULL
          AND s.delivered_at IS NOT NULL
          AND s.delivered_at >= p_from
          AND s.delivered_at < p_to
          AND s.delivered_at >= s.shipped_at
    ),
    timing_summary AS (
        SELECT
            COALESCE(ROUND(AVG(hours_value))::INTEGER, 0) AS payment_to_dispatch_avg_hours,
            COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_value))::INTEGER, 0) AS payment_to_dispatch_p50_hours,
            COALESCE(ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours_value))::INTEGER, 0) AS payment_to_dispatch_p90_hours
        FROM payment_to_dispatch
    ),
    delivery_timing_summary AS (
        SELECT
            COALESCE(ROUND(AVG(hours_value))::INTEGER, 0) AS dispatch_to_delivery_avg_hours,
            COALESCE(ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY hours_value))::INTEGER, 0) AS dispatch_to_delivery_p50_hours,
            COALESCE(ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY hours_value))::INTEGER, 0) AS dispatch_to_delivery_p90_hours
        FROM dispatch_to_delivery
    ),
    delivered_in_window AS (
        SELECT s.*
        FROM public.shipments s
        WHERE s.status = 'delivered'
          AND s.delivered_at >= p_from
          AND s.delivered_at < p_to
    ),
    perfect_order_summary AS (
        SELECT
            COUNT(*)::INTEGER AS delivered_count,
            COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NOT NULL
                  AND s.shipped_at IS NOT NULL
                  AND s.delivered_at IS NOT NULL
                  AND s.delivered_at <= s.shipped_at + make_interval(hours => effective_delivery_sla_hours)
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.shipment_events se
                      WHERE se.shipment_id = s.id
                        AND se.event_type = 'exception'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.logistics_notifications ln
                      WHERE ln.shipment_id = s.id
                        AND ln.status IN ('failed', 'undelivered')
                  )
            )::INTEGER AS perfect_count
        FROM delivered_in_window s
    ),
    data_quality AS (
        SELECT
            (
                SELECT COUNT(*)
                FROM public.orders
                WHERE status IN ('paid', 'shipped', 'delivered')
                  AND paid_at IS NULL
            )::INTEGER AS paid_without_paid_at_count,
            (
                SELECT COUNT(*)
                FROM public.shipments
                WHERE status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
                  AND shipped_at IS NULL
            )::INTEGER AS shipped_without_shipped_at_count,
            (
                SELECT COUNT(*)
                FROM public.shipments
                WHERE status = 'delivered'
                  AND delivered_at IS NULL
            )::INTEGER AS delivered_without_delivered_at_count,
            (
                SELECT COUNT(*)
                FROM public.shipments
                WHERE status IN ('shipped', 'in_transit', 'out_for_delivery')
                  AND NULLIF(BTRIM(COALESCE(tracking_number, '')), '') IS NULL
            )::INTEGER AS active_without_tracking_count
    ),
    notification_summary AS (
        SELECT
            COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'read'))::INTEGER AS successful_count,
            COUNT(*) FILTER (WHERE status IN ('failed', 'undelivered'))::INTEGER AS failed_count,
            COUNT(*) FILTER (WHERE status = 'skipped')::INTEGER AS skipped_count
        FROM public.logistics_notifications
        WHERE created_at >= p_from
          AND created_at < p_to
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window', jsonb_build_object(
            'from', p_from,
            'to', p_to,
            'timezone', p_timezone,
            'fulfillment_sla_hours', effective_fulfillment_sla_hours,
            'delivery_sla_hours', effective_delivery_sla_hours
        ),
        'summary', jsonb_build_object(
            'paid_pending_dispatch_count', (SELECT COUNT(*) FROM paid_pending),
            'paid_over_sla_count', (
                SELECT COUNT(*)
                FROM paid_pending
                WHERE hours_waiting >= effective_fulfillment_sla_hours
            ),
            'active_shipments_count', (SELECT COUNT(*) FROM active_shipments),
            'shipped_over_sla_count', (
                SELECT COUNT(*)
                FROM active_shipments
                WHERE hours_in_transit >= effective_delivery_sla_hours
            ),
            'delivered_count', pos.delivered_count,
            'perfect_order_count', pos.perfect_count,
            'perfect_order_bps', CASE
                WHEN pos.delivered_count = 0 THEN 0
                ELSE ROUND((pos.perfect_count::NUMERIC / pos.delivered_count::NUMERIC) * 10000)::INTEGER
            END,
            'missing_tracking_count', dq.active_without_tracking_count,
            'failed_notification_count', ns.failed_count,
            'skipped_notification_count', ns.skipped_count
        ),
        'timing', jsonb_build_object(
            'payment_to_dispatch_avg_hours', ts.payment_to_dispatch_avg_hours,
            'payment_to_dispatch_p50_hours', ts.payment_to_dispatch_p50_hours,
            'payment_to_dispatch_p90_hours', ts.payment_to_dispatch_p90_hours,
            'dispatch_to_delivery_avg_hours', dts.dispatch_to_delivery_avg_hours,
            'dispatch_to_delivery_p50_hours', dts.dispatch_to_delivery_p50_hours,
            'dispatch_to_delivery_p90_hours', dts.dispatch_to_delivery_p90_hours
        ),
        'notifications', jsonb_build_object(
            'successful_count', ns.successful_count,
            'failed_count', ns.failed_count,
            'skipped_count', ns.skipped_count
        ),
        'data_quality', jsonb_build_object(
            'paid_without_paid_at_count', dq.paid_without_paid_at_count,
            'shipped_without_shipped_at_count', dq.shipped_without_shipped_at_count,
            'delivered_without_delivered_at_count', dq.delivered_without_delivered_at_count,
            'active_without_tracking_count', dq.active_without_tracking_count
        ),
        'queues', jsonb_build_object(
            'paid_to_dispatch', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY paid_at ASC)
                FROM (
                    SELECT
                        pp.paid_at,
                        jsonb_build_object(
                            'order_id', pp.id,
                            'customer_name', pp.customer_name,
                            'shipping_city', pp.shipping_city,
                            'total_cents', pp.total_cents,
                            'paid_at', pp.paid_at,
                            'hours_waiting', COALESCE(ROUND(pp.hours_waiting), 0)::INTEGER,
                            'over_sla', pp.hours_waiting >= effective_fulfillment_sla_hours
                        ) AS row_payload
                    FROM paid_pending pp
                    ORDER BY pp.paid_at ASC
                    LIMIT 20
                ) q
            ), '[]'::jsonb),
            'active_shipments', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY shipped_at ASC)
                FROM (
                    SELECT
                        s.shipped_at,
                        jsonb_build_object(
                            'shipment_id', s.id,
                            'order_id', s.order_id,
                            'status', s.status,
                            'customer_name', s.customer_name,
                            'shipping_city', s.shipping_city,
                            'carrier_name', s.carrier_name,
                            'tracking_number', s.tracking_number,
                            'shipped_at', s.shipped_at,
                            'hours_in_transit', COALESCE(ROUND(s.hours_in_transit), 0)::INTEGER,
                            'over_sla', s.hours_in_transit >= effective_delivery_sla_hours,
                            'missing_tracking', NULLIF(BTRIM(COALESCE(s.tracking_number, '')), '') IS NULL
                        ) AS row_payload
                    FROM active_shipments s
                    ORDER BY s.shipped_at ASC
                    LIMIT 20
                ) q
            ), '[]'::jsonb),
            'failed_notifications', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY created_at DESC)
                FROM (
                    SELECT
                        ln.created_at,
                        jsonb_build_object(
                            'notification_id', ln.id,
                            'order_id', ln.order_id,
                            'shipment_id', ln.shipment_id,
                            'purpose', ln.purpose,
                            'status', ln.status,
                            'recipient_phone', ln.recipient_phone,
                            'error_message', ln.error_message,
                            'created_at', ln.created_at
                        ) AS row_payload
                    FROM public.logistics_notifications ln
                    WHERE ln.status IN ('failed', 'undelivered')
                      AND ln.created_at >= p_from
                      AND ln.created_at < p_to
                    ORDER BY ln.created_at DESC
                    LIMIT 20
                ) q
            ), '[]'::jsonb),
            'recent_events', COALESCE((
                SELECT jsonb_agg(row_payload ORDER BY occurred_at DESC)
                FROM (
                    SELECT
                        se.occurred_at,
                        jsonb_build_object(
                            'event_id', se.id,
                            'shipment_id', se.shipment_id,
                            'order_id', se.order_id,
                            'event_type', se.event_type,
                            'status', se.status,
                            'source', se.source,
                            'description', se.description,
                            'occurred_at', se.occurred_at
                        ) AS row_payload
                    FROM public.shipment_events se
                    WHERE se.occurred_at >= p_from
                      AND se.occurred_at < p_to
                    ORDER BY se.occurred_at DESC
                    LIMIT 20
                ) q
            ), '[]'::jsonb)
        ),
        'agent_context', jsonb_build_object(
            'mode', 'suggest_only',
            'recommended_focus', CASE
                WHEN (SELECT COUNT(*) FROM paid_pending WHERE hours_waiting >= effective_fulfillment_sla_hours) > 0 THEN 'dispatch_overdue_paid_orders'
                WHEN (SELECT COUNT(*) FROM active_shipments WHERE hours_in_transit >= effective_delivery_sla_hours) > 0 THEN 'follow_up_late_shipments'
                WHEN dq.active_without_tracking_count > 0 THEN 'complete_tracking'
                WHEN ns.failed_count > 0 THEN 'recover_failed_notifications'
                ELSE 'monitor'
            END,
            'allowed_actions', jsonb_build_array(
                'explain_priorities',
                'draft_customer_message',
                'prepare_dispatch_checklist',
                'summarize_logistics_health'
            )
        )
    )
    INTO snapshot
    FROM timing_summary ts
    CROSS JOIN delivery_timing_summary dts
    CROSS JOIN perfect_order_summary pos
    CROSS JOIN data_quality dq
    CROSS JOIN notification_summary ns;

    RETURN snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_logistics_operations_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_logistics_operations_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.admin_logistics_operations_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER)
IS 'Dedicated admin-only logistics and fulfillment command center snapshot with SLA, p50/p90 and actionable queues.';

COMMENT ON COLUMN public.settings.fulfillment_sla_hours IS 'Internal SLA from payment approval to dispatch, in hours.';
COMMENT ON COLUMN public.settings.delivery_sla_hours IS 'Internal SLA from dispatch to delivery, in hours.';

NOTIFY pgrst, 'reload schema';
