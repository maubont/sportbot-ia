-- E4 - Operacion y vigilancia
--
-- Objetivo: que nada se quede trabado.
--   1. Las reservas de pedidos sin pago vencen solas y el stock vuelve a estar
--      disponible. La ventana sale de `settings.payment_receipt_window_hours`.
--   2. Un pedido con comprobante esperando revision humana NUNCA vence: el
--      cliente ya pago. Se avisa en el panel de vigilancia.
--   3. El panel tiene un solo lugar con las alertas del dia.
--
-- Regla de dinero: la IA y los jobs no aprueban pagos. Esto solo expira
-- reservas sin pago y libera stock; no toca pedidos pagados ni cobros.

-- ---------------------------------------------------------------------------
-- 1. Barrido de pedidos vencidos
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

    -- 1a. Vencer los que ya pasaron la ventana.
    --
    -- La ventana se cuenta desde el ultimo rechazo si hubo uno: un cliente
    -- cuyo comprobante se rechazo merece otro plazo para reintentar.
    FOR v_order IN
        SELECT o.id,
               o.customer_id,
               COALESCE(o.payment_rejected_at, o.created_at) AS base_at
          FROM public.orders o
         WHERE o.status = 'awaiting_payment'
           AND COALESCE(o.payment_rejected_at, o.created_at)
               < p_now - make_interval(hours => v_window)
           -- Un comprobante esperando revision humana protege el pedido: si el
           -- cliente ya pago, vencerlo seria perder el dinero y el pedido.
           AND NOT EXISTS (
               SELECT 1
                 FROM public.payment_receipts pr
                WHERE pr.order_id = o.id
                  AND pr.status IN ('received', 'prevalidated')
           )
           -- Defensa en profundidad: nunca vencer algo ya cobrado.
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

            -- El evento se escribe aqui para que quede aunque el aviso al
            -- cliente falle despues.
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

    -- 1b. Devolver lo que hay que avisar.
    --
    -- Incluye lo que acaba de vencer y tambien lo que vencio antes pero nunca
    -- se aviso (por ejemplo si el job murio a mitad de camino). Asi el aviso se
    -- auto-repara en la siguiente corrida sin duplicarse.
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
                   FLOOR(EXTRACT(EPOCH FROM (p_now - COALESCE(o.payment_rejected_at, o.created_at))) / 3600)
               )::INTEGER,
               (o.id = ANY (v_expired)),
               -- No avisar pedidos antiguos (limpieza de arrastre historico):
               -- nadie quiere un mensaje por un pedido de hace cinco meses.
               (COALESCE(o.payment_rejected_at, o.created_at) >= p_now - INTERVAL '48 hours')
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
-- 2. Vigilancia: un solo lugar con lo que puede salir mal hoy
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
           COALESCE(MAX(EXTRACT(EPOCH FROM (now() - COALESCE(o.payment_rejected_at, o.created_at))) / 3600), 0),
           COUNT(*) FILTER (
               WHERE COALESCE(o.payment_rejected_at, o.created_at)
                   > now() - make_interval(hours => v_window)
                 AND COALESCE(o.payment_rejected_at, o.created_at)
                   <= now() - make_interval(hours => v_window) + INTERVAL '6 hours'
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
