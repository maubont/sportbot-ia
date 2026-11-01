-- E3.8 - El comprobante como primer filtro
--
-- Antes: un comprobante con monto distinto solo dejaba un veredicto para el
-- humano. El cliente no sabia cuanto le faltaba y la reserva quedaba quieta.
--
-- Ahora:
--   1. Se lee el monto del comprobante (vision) y se calcula el faltante exacto.
--   2. El bot le dice al cliente cuanto falta para completar el pago y hasta
--      cuando tiene.
--   3. Si no completa, el barrido de E4 libera el pedido al vencer el plazo.
--   4. La aprobacion sigue siendo humana: esto no mueve dinero ni marca pagos.
--
-- La aritmetica del faltante es determinista (total del pedido - monto leido).
-- El modelo solo lee el comprobante; no decide.

-- ---------------------------------------------------------------------------
-- 1. Estado del abono en el pedido
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS payment_received_cents INTEGER,
    ADD COLUMN IF NOT EXISTS payment_shortfall_cents INTEGER,
    ADD COLUMN IF NOT EXISTS payment_shortfall_at TIMESTAMPTZ;

COMMENT ON COLUMN public.orders.payment_received_cents IS
    'Suma leida de los comprobantes del pedido. Solo guia al cliente; no acredita el pago.';
COMMENT ON COLUMN public.orders.payment_shortfall_cents IS
    'Lo que falta para cubrir total_cents segun los comprobantes. NULL = sin faltante conocido.';
COMMENT ON COLUMN public.orders.payment_shortfall_at IS
    'Cuando se reporto el faltante vigente. Reinicia el plazo para completar el pago.';

-- ---------------------------------------------------------------------------
-- 2. Registrar el avance del pago (lo llama el bot, no una persona)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_payment_progress(
    p_order_id UUID,
    p_received_cents INTEGER,
    p_source TEXT DEFAULT 'vision'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order RECORD;
    v_received INTEGER := GREATEST(COALESCE(p_received_cents, 0), 0);
    v_shortfall INTEGER;
    v_previous INTEGER;
    v_advanced BOOLEAN;
    v_conversation UUID;
BEGIN
    SELECT o.id,
           o.status,
           o.total_cents,
           o.payment_reference,
           o.customer_id,
           o.payment_received_cents
      INTO v_order
      FROM public.orders o
     WHERE o.id = p_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status <> 'awaiting_payment' THEN
        RETURN jsonb_build_object(
            'applied', false,
            'reason', 'order_not_payable',
            'status', v_order.status
        );
    END IF;

    v_previous := COALESCE(v_order.payment_received_cents, 0);
    v_shortfall := GREATEST(COALESCE(v_order.total_cents, 0) - v_received, 0);
    v_advanced := v_received > v_previous;

    IF v_shortfall = 0 THEN
        UPDATE public.orders
           SET payment_received_cents = v_received,
               payment_shortfall_cents = NULL,
               payment_shortfall_at = NULL,
               updated_at = NOW()
         WHERE id = p_order_id;
    ELSE
        UPDATE public.orders
           SET payment_received_cents = v_received,
               payment_shortfall_cents = v_shortfall,
               -- El plazo solo se reinicia si el cliente abono algo nuevo.
               -- Reintentos del mismo comprobante no lo estiran.
               payment_shortfall_at = CASE
                   WHEN v_advanced OR v_order.payment_received_cents IS NULL THEN NOW()
                   ELSE payment_shortfall_at
               END,
               updated_at = NOW()
         WHERE id = p_order_id;

        SELECT c.id
          INTO v_conversation
          FROM public.conversations c
         WHERE c.customer_id = v_order.customer_id
         ORDER BY c.last_message_at DESC NULLS LAST
         LIMIT 1;

        INSERT INTO public.conversation_events (
            conversation_id,
            customer_id,
            order_id,
            actor_type,
            direction,
            event_type,
            funnel_stage,
            intent,
            amount_cents,
            source,
            dedupe_key,
            metadata
        )
        VALUES (
            v_conversation,
            v_order.customer_id,
            v_order.id,
            'system',
            'internal',
            'payment_shortfall_registered',
            'payment_review',
            'payment',
            v_shortfall,
            COALESCE(NULLIF(BTRIM(p_source), ''), 'vision'),
            'order:' || v_order.id::text || ':shortfall:' || v_received::text,
            jsonb_build_object(
                'payment_reference', v_order.payment_reference,
                'total_cents', v_order.total_cents,
                'received_cents', v_received,
                'shortfall_cents', v_shortfall,
                'advanced', v_advanced
            )
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
    END IF;

    RETURN jsonb_build_object(
        'applied', true,
        'total_cents', v_order.total_cents,
        'received_cents', v_received,
        'shortfall_cents', v_shortfall,
        'advanced', v_advanced
    );
END;
$$;

REVOKE ALL ON FUNCTION public.record_payment_progress(UUID, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_payment_progress(UUID, INTEGER, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. El barrido entiende el abono parcial
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.expire_stale_payment_orders(
    p_limit INTEGER DEFAULT 50,
    p_now TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
    order_id UUID,
    payment_reference TEXT,
    customer_id UUID,
    customer_name TEXT,
    customer_phone TEXT,
    conversation_id UUID,
    total_cents INTEGER,
    hours_waiting INTEGER,
    expired_now BOOLEAN,
    should_notify BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_window INTEGER;
    v_order RECORD;
    v_conversation UUID;
    v_expired UUID[] := ARRAY[]::UUID[];
    v_released INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 THEN
        p_limit := 50;
    ELSIF p_limit > 500 THEN
        p_limit := 500;
    END IF;

    SELECT COALESCE(NULLIF(s.payment_receipt_window_hours, 0), 24)
      INTO v_window
      FROM public.settings s
     WHERE s.id = 1;

    v_window := COALESCE(v_window, 24);

    -- La ventana corre desde el ultimo evento que le dio una oportunidad al
    -- cliente: un rechazo o un abono parcial. Si no hubo ninguno, desde la
    -- creacion del pedido.
    FOR v_order IN
        SELECT o.id,
               o.customer_id,
               GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at) AS base_at
          FROM public.orders o
         WHERE o.status = 'awaiting_payment'
           AND GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at)
               < p_now - make_interval(hours => v_window)
           -- Un comprobante completo esperando revision protege el pedido.
           -- Un abono parcial NO lo protege: si no completa, la reserva se libera.
           AND NOT (
               o.payment_shortfall_cents IS NULL
               AND EXISTS (
                   SELECT 1
                     FROM public.payment_receipts pr
                    WHERE pr.order_id = o.id
                      AND pr.status IN ('received', 'prevalidated')
               )
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM public.payments pay
                WHERE pay.order_id = o.id
                  AND pay.status = 'approved'
           )
         ORDER BY base_at ASC
         LIMIT p_limit
         FOR UPDATE OF o SKIP LOCKED
    LOOP
        v_released := public.release_order_stock(v_order.id);

        UPDATE public.orders
           SET status = 'expired',
               updated_at = p_now
         WHERE id = v_order.id
           AND status = 'awaiting_payment';

        IF FOUND THEN
            v_expired := v_expired || v_order.id;

            SELECT c.id
              INTO v_conversation
              FROM public.conversations c
             WHERE c.customer_id = v_order.customer_id
             ORDER BY c.last_message_at DESC NULLS LAST
             LIMIT 1;

            INSERT INTO public.conversation_events (
                conversation_id,
                customer_id,
                order_id,
                actor_type,
                direction,
                event_type,
                funnel_stage,
                intent,
                source,
                dedupe_key,
                occurred_at,
                metadata
            )
            VALUES (
                v_conversation,
                v_order.customer_id,
                v_order.id,
                'system',
                'internal',
                'payment_expired',
                'payment_failed',
                'payment',
                'ops_sweep',
                'order:' || v_order.id::text || ':expired',
                p_now,
                jsonb_build_object(
                    'window_hours', v_window,
                    'units_released', v_released
                )
            )
            ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING;
        END IF;
    END LOOP;

    RETURN QUERY
        SELECT o.id,
               o.payment_reference,
               o.customer_id,
               cu.name,
               cu.phone_e164,
               conv.id,
               o.total_cents,
               GREATEST(
                   0,
                   FLOOR(EXTRACT(EPOCH FROM (
                       p_now - GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at)
                   )) / 3600)
               )::INTEGER,
               (o.id = ANY (v_expired)),
               (GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at)
                   >= p_now - INTERVAL '48 hours')
                   AND NOT EXISTS (
                       SELECT 1
                         FROM public.conversation_events e
                        WHERE e.dedupe_key = 'order:' || o.id::text || ':expired_notified'
                   )
          FROM public.orders o
          LEFT JOIN public.customers cu ON cu.id = o.customer_id
          LEFT JOIN LATERAL (
              SELECT c.id
                FROM public.conversations c
               WHERE c.customer_id = o.customer_id
               ORDER BY c.last_message_at DESC NULLS LAST
               LIMIT 1
          ) conv ON TRUE
         WHERE o.status = 'expired'
           AND (o.id = ANY (v_expired) OR o.updated_at >= p_now - INTERVAL '24 hours')
           AND NOT EXISTS (
               SELECT 1
                 FROM public.conversation_events e
                WHERE e.dedupe_key = 'order:' || o.id::text || ':expired_notified'
           )
         ORDER BY o.updated_at ASC
         LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.expire_stale_payment_orders(INTEGER, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_stale_payment_orders(INTEGER, TIMESTAMPTZ) TO service_role;

-- ---------------------------------------------------------------------------
-- 4. La cola del panel muestra el abono
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_payment_queue(p_limit INTEGER DEFAULT 60)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit, 60), 1), 200);
    v_orders JSONB;
    v_config_complete BOOLEAN;
BEGIN
    IF NOT COALESCE(public.is_admin(), FALSE) THEN
        RAISE EXCEPTION 'NOT_ADMIN';
    END IF;

    SELECT (COALESCE(NULLIF(trim(payment_nequi_number), ''), NULLIF(trim(payment_breb_key), '')) IS NOT NULL)
      INTO v_config_complete
      FROM public.settings
     WHERE id = 1;

    SELECT COALESCE(jsonb_agg(entry ORDER BY entry->>'created_at' DESC), '[]'::jsonb)
      INTO v_orders
      FROM (
        SELECT jsonb_build_object(
            'order_id', o.id,
            'payment_reference', o.payment_reference,
            'total_cents', o.total_cents,
            'status', o.status,
            'payment_method', o.payment_method,
            'created_at', o.created_at,
            'waiting_hours', ROUND(EXTRACT(EPOCH FROM (NOW() - o.created_at)) / 3600.0, 1),
            'rejection_reason', o.payment_rejection_reason,
            'rejected_at', o.payment_rejected_at,
            'payment_received_cents', o.payment_received_cents,
            'payment_shortfall_cents', o.payment_shortfall_cents,
            'payment_shortfall_at', o.payment_shortfall_at,
            'customer', jsonb_build_object(
                'id', c.id,
                'name', c.name,
                'phone', c.phone_e164
            ),
            'items', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'product', COALESCE(p.brand || ' ' || p.model, 'Producto'),
                    'size', pv.size,
                    'qty', oi.qty,
                    'unit_price_cents', oi.unit_price_cents
                ) ORDER BY oi.created_at)
                FROM public.order_items oi
                LEFT JOIN public.products p ON p.id = oi.product_id
                LEFT JOIN public.product_variants pv ON pv.id = oi.variant_id
                WHERE oi.order_id = o.id
            ), '[]'::jsonb),
            'receipts', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                    'id', pr.id,
                    'status', pr.status,
                    'ai_verdict', pr.ai_verdict,
                    'ai_confidence', pr.ai_confidence,
                    'ai_extracted', pr.ai_extracted,
                    'ai_evidence', pr.ai_evidence,
                    'ai_checked_at', pr.ai_checked_at,
                    'storage_bucket', pr.storage_bucket,
                    'storage_path', pr.storage_path,
                    'content_type', pr.content_type,
                    'created_at', pr.created_at,
                    'review_note', pr.review_note
                ) ORDER BY pr.created_at DESC)
                FROM public.payment_receipts pr
                WHERE pr.order_id = o.id
            ), '[]'::jsonb)
        ) AS entry
        FROM public.orders o
        LEFT JOIN public.customers c ON c.id = o.customer_id
        WHERE o.status = 'awaiting_payment'
          AND o.created_at > NOW() - INTERVAL '14 days'
        ORDER BY o.created_at DESC
        LIMIT v_limit
      ) q;

    RETURN jsonb_build_object(
        'generated_at', NOW(),
        'payment_config_complete', COALESCE(v_config_complete, FALSE),
        'orders', v_orders
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_payment_queue(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_payment_queue(INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.admin_payment_queue(INTEGER) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. El watchdog avisa de los abonos sin completar
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_ops_watchdog(
    p_stale_receipt_hours INTEGER DEFAULT 2,
    p_timezone TEXT DEFAULT 'America/Bogota'
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_window INTEGER;
    v_stale_hours INTEGER;
    v_tz TEXT;
    v_day_start TIMESTAMPTZ;
    v_awaiting INTEGER;
    v_awaiting_oldest NUMERIC;
    v_expiring_soon INTEGER;
    v_receipts_pending INTEGER;
    v_receipts_oldest NUMERIC;
    v_receipts_stale INTEGER;
    v_partial INTEGER;
    v_partial_oldest NUMERIC;
    v_rejected_7d INTEGER;
    v_paid_no_dispatch INTEGER;
    v_paid_over_sla INTEGER;
    v_failed_notifications INTEGER;
    v_reserved INTEGER;
    v_low_stock INTEGER;
    v_orders_today INTEGER;
    v_paid_today INTEGER;
    v_revenue_today BIGINT;
    v_alerts JSONB := '[]'::JSONB;
BEGIN
    IF NOT COALESCE(public.is_admin(), FALSE) THEN
        RAISE EXCEPTION 'admin_ops_watchdog requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    v_tz := COALESCE(NULLIF(BTRIM(p_timezone), ''), 'America/Bogota');
    v_stale_hours := GREATEST(COALESCE(p_stale_receipt_hours, 2), 1);

    SELECT COALESCE(NULLIF(s.payment_receipt_window_hours, 0), 24)
      INTO v_window
      FROM public.settings s
     WHERE s.id = 1;
    v_window := COALESCE(v_window, 24);

    v_day_start := date_trunc('day', now() AT TIME ZONE v_tz) AT TIME ZONE v_tz;

    SELECT COUNT(*),
           COALESCE(MAX(EXTRACT(EPOCH FROM (now() - GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at))) / 3600), 0),
           COUNT(*) FILTER (
               WHERE GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at)
                   > now() - make_interval(hours => v_window)
                 AND GREATEST(o.payment_rejected_at, o.payment_shortfall_at, o.created_at)
                   <= now() - make_interval(hours => v_window) + INTERVAL '6 hours'
                 AND o.payment_shortfall_cents IS NULL
                 AND NOT EXISTS (
                     SELECT 1
                       FROM public.payment_receipts pr
                      WHERE pr.order_id = o.id
                        AND pr.status IN ('received', 'prevalidated')
                 )
                 AND NOT EXISTS (
                     SELECT 1
                       FROM public.payments pay
                      WHERE pay.order_id = o.id
                        AND pay.status = 'approved'
                 )
           )
      INTO v_awaiting, v_awaiting_oldest, v_expiring_soon
      FROM public.orders o
     WHERE o.status = 'awaiting_payment';

    SELECT COUNT(*),
           COALESCE(MAX(EXTRACT(EPOCH FROM (now() - pr.created_at)) / 3600), 0),
           COUNT(*) FILTER (
               WHERE pr.created_at < now() - make_interval(hours => v_stale_hours)
           )
      INTO v_receipts_pending, v_receipts_oldest, v_receipts_stale
      FROM public.payment_receipts pr
     WHERE pr.status IN ('received', 'prevalidated');

    SELECT COUNT(*),
           COALESCE(MAX(EXTRACT(EPOCH FROM (now() - o.payment_shortfall_at)) / 3600), 0)
      INTO v_partial, v_partial_oldest
      FROM public.orders o
     WHERE o.status = 'awaiting_payment'
       AND COALESCE(o.payment_shortfall_cents, 0) > 0;

    SELECT COUNT(*)
      INTO v_rejected_7d
      FROM public.payment_decisions pd
     WHERE pd.decision = 'rejected'
       AND pd.created_at >= now() - INTERVAL '7 days';

    SELECT COUNT(*) FILTER (
               WHERE NOT EXISTS (
                   SELECT 1
                     FROM public.shipments s
                    WHERE s.order_id = o.id
                      AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
               )
           ),
           COUNT(*) FILTER (
               WHERE o.paid_at < now() - INTERVAL '24 hours'
                 AND NOT EXISTS (
                     SELECT 1
                       FROM public.shipments s
                      WHERE s.order_id = o.id
                        AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
                 )
           )
      INTO v_paid_no_dispatch, v_paid_over_sla
      FROM public.orders o
     WHERE o.status = 'paid';

    SELECT COUNT(*)
      INTO v_failed_notifications
      FROM public.logistics_notifications ln
     WHERE ln.status IN ('failed', 'undelivered')
       AND ln.created_at >= now() - INTERVAL '24 hours';

    SELECT COALESCE(SUM(pv.reserved), 0)::INTEGER,
           COUNT(*) FILTER (WHERE pv.stock - pv.reserved < 3)::INTEGER
      INTO v_reserved, v_low_stock
      FROM public.product_variants pv
      JOIN public.products p ON p.id = pv.product_id
     WHERE COALESCE(p.active, TRUE);

    SELECT COUNT(*),
           COUNT(*) FILTER (WHERE o.paid_at >= v_day_start),
           COALESCE(SUM(o.total_cents) FILTER (WHERE o.paid_at >= v_day_start), 0)::BIGINT
      INTO v_orders_today, v_paid_today, v_revenue_today
      FROM public.orders o
     WHERE o.created_at >= v_day_start
        OR o.paid_at >= v_day_start;

    IF v_receipts_stale > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'receipts_stale',
            'severity', 'high',
            'count', v_receipts_stale,
            'message', 'Hay comprobantes esperando revision hace mas de '
                || v_stale_hours || ' h. El cliente ya pago.'
        );
    END IF;

    IF v_partial > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'partial_payments',
            'severity', CASE WHEN v_partial_oldest >= v_window THEN 'high' ELSE 'medium' END,
            'count', v_partial,
            'message', 'Pedidos con abono parcial esperando el saldo.'
        );
    END IF;

    IF v_receipts_pending > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'receipts_pending',
            'severity', CASE WHEN v_receipts_stale > 0 THEN 'high' ELSE 'medium' END,
            'count', v_receipts_pending,
            'message', 'Comprobantes por revisar en /payments.'
        );
    END IF;

    IF v_expiring_soon > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'expiring_soon',
            'severity', 'medium',
            'count', v_expiring_soon,
            'message', 'Pedidos sin pago que vencen en las proximas 6 h.'
        );
    END IF;

    IF v_paid_over_sla > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'paid_over_sla',
            'severity', 'high',
            'count', v_paid_over_sla,
            'message', 'Pedidos pagados sin despachar hace mas de 24 h.'
        );
    END IF;

    IF v_failed_notifications > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'failed_notifications',
            'severity', 'medium',
            'count', v_failed_notifications,
            'message', 'Avisos de envio que fallaron en las ultimas 24 h.'
        );
    END IF;

    IF v_low_stock > 0 THEN
        v_alerts := v_alerts || jsonb_build_object(
            'key', 'low_stock',
            'severity', 'low',
            'count', v_low_stock,
            'message', 'Variantes con menos de 3 pares disponibles.'
        );
    END IF;

    RETURN jsonb_build_object(
        'generated_at', now(),
        'timezone', v_tz,
        'window_hours', v_window,
        'stale_receipt_hours', v_stale_hours,
        'today', jsonb_build_object(
            'start', v_day_start,
            'orders_created', v_orders_today,
            'orders_paid', v_paid_today,
            'revenue_cents', v_revenue_today
        ),
        'payments', jsonb_build_object(
            'awaiting_count', v_awaiting,
            'awaiting_oldest_hours', ROUND(v_awaiting_oldest)::INTEGER,
            'expiring_within_6h_count', v_expiring_soon,
            'receipts_pending_count', v_receipts_pending,
            'receipts_pending_oldest_hours', ROUND(v_receipts_oldest)::INTEGER,
            'receipts_stale_count', v_receipts_stale,
            'partial_count', v_partial,
            'partial_oldest_hours', ROUND(v_partial_oldest)::INTEGER,
            'rejected_last_7d_count', v_rejected_7d
        ),
        'logistics', jsonb_build_object(
            'paid_pending_dispatch_count', v_paid_no_dispatch,
            'paid_over_sla_count', v_paid_over_sla,
            'failed_notification_count_24h', v_failed_notifications
        ),
        'inventory', jsonb_build_object(
            'reserved_units', v_reserved,
            'low_stock_variants_count', v_low_stock
        ),
        'alerts', v_alerts
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ops_watchdog(INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ops_watchdog(INTEGER, TEXT) TO authenticated, service_role;
