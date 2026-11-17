-- E3 - Pagos manuales Nequi / Bre-B con aprobacion humana
-- ---------------------------------------------------------------------------
-- Regla que este archivo hace cumplir:
--   * El monto y la referencia nacen en la base (create_order_atomic).
--   * La IA puede leer un comprobante y dejar un veredicto, pero NO cambia
--     estados ni aprueba nada.
--   * Solo `approve_payment(...)`, llamada por un administrador autenticado,
--     puede mover un pedido a `paid`. Un trigger lo impide por cualquier otra
--     via, incluido un UPDATE manual o una funcion futura.
--   * Rechazar deja el pedido en `awaiting_payment` (pendiente de pago) con el
--     motivo visible para el cliente y el equipo.
--
-- Estados: el resto del sistema ya usa `awaiting_payment` para "pendiente de
-- pago". No se renombra para no romper KPIs, inbox ni logistica. En este
-- documento "pending_payment" == `awaiting_payment`.

-- ---------------------------------------------------------------------------
-- 1. Configuracion de recaudo
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS payment_nequi_number TEXT,
    ADD COLUMN IF NOT EXISTS payment_nequi_holder TEXT,
    ADD COLUMN IF NOT EXISTS payment_breb_key TEXT,
    ADD COLUMN IF NOT EXISTS payment_breb_holder TEXT,
    ADD COLUMN IF NOT EXISTS payment_instructions TEXT,
    ADD COLUMN IF NOT EXISTS payment_receipt_window_hours INTEGER NOT NULL DEFAULT 24;

COMMENT ON COLUMN public.settings.payment_nequi_number IS
    'Numero Nequi del negocio para recaudo manual. Nunca la cuenta personal.';
COMMENT ON COLUMN public.settings.payment_breb_key IS
    'Llave Bre-B del negocio para recaudo manual.';
COMMENT ON COLUMN public.settings.payment_instructions IS
    'Texto libre opcional con instrucciones adicionales de pago.';
COMMENT ON COLUMN public.settings.payment_receipt_window_hours IS
    'Horas que se mantiene la reserva mientras se espera el comprobante (E4).';

-- ---------------------------------------------------------------------------
-- 2. Pedido: metodo, motivo de rechazo y aprobador
-- ---------------------------------------------------------------------------
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS payment_method TEXT NOT NULL DEFAULT 'nequi',
    ADD COLUMN IF NOT EXISTS payment_rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS payment_rejected_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS payment_approved_by UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'orders_payment_method_check'
          AND conrelid = 'public.orders'::regclass
    ) THEN
        ALTER TABLE public.orders
            ADD CONSTRAINT orders_payment_method_check
            CHECK (payment_method IN ('nequi', 'bre_b', 'cash', 'other'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS orders_payment_rejection_idx
    ON public.orders (payment_rejected_at DESC)
    WHERE payment_rejected_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Comprobantes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
    message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    media_file_id UUID REFERENCES public.media_files(id) ON DELETE SET NULL,
    storage_bucket TEXT NOT NULL DEFAULT 'whatsapp-media',
    storage_path TEXT NOT NULL,
    content_type TEXT,
    bytes INTEGER CHECK (bytes IS NULL OR bytes >= 0),
    sha256 TEXT,
    caption TEXT,
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN ('received', 'prevalidated', 'approved', 'rejected', 'superseded')
    ),
    ai_verdict TEXT CHECK (
        ai_verdict IS NULL OR ai_verdict IN ('match', 'mismatch', 'uncertain', 'not_run')
    ),
    ai_confidence NUMERIC(4, 3) CHECK (
        ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)
    ),
    ai_extracted JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ai_extracted) = 'object'),
    ai_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(ai_evidence) = 'array'),
    ai_model TEXT,
    ai_checked_at TIMESTAMPTZ,
    reviewed_by_user_id UUID,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT payment_receipts_storage_unique UNIQUE (order_id, storage_path)
);

CREATE INDEX IF NOT EXISTS payment_receipts_order_idx
    ON public.payment_receipts (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS payment_receipts_pending_idx
    ON public.payment_receipts (created_at DESC)
    WHERE status IN ('received', 'prevalidated');

COMMENT ON TABLE public.payment_receipts IS
    'Comprobantes recibidos por WhatsApp, ligados a un pedido. La IA deja un veredicto; no decide.';

ALTER TABLE public.payment_receipts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read payment receipts" ON public.payment_receipts;
CREATE POLICY "Admins read payment receipts"
    ON public.payment_receipts
    FOR SELECT
    TO authenticated
    USING (public.is_admin());

-- El bot escribe con service_role. Un admin no inserta ni edita comprobantes a mano.
REVOKE INSERT, UPDATE, DELETE ON public.payment_receipts FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE ON public.payment_receipts FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Pagos: aprobador y comprobante
-- ---------------------------------------------------------------------------
ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS receipt_id UUID REFERENCES public.payment_receipts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS approved_by_user_id UUID,
    ADD COLUMN IF NOT EXISTS review_note TEXT,
    ADD COLUMN IF NOT EXISTS approved_via TEXT;

ALTER TABLE public.payments
    ALTER COLUMN provider SET DEFAULT 'manual';

-- ---------------------------------------------------------------------------
-- 5. Auditoria de decisiones (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.payment_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    receipt_id UUID REFERENCES public.payment_receipts(id) ON DELETE SET NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    payment_reference TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    actor_user_id UUID NOT NULL,
    actor_email TEXT,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_decisions_order_idx
    ON public.payment_decisions (order_id, created_at DESC);

ALTER TABLE public.payment_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read payment decisions" ON public.payment_decisions;
CREATE POLICY "Admins read payment decisions"
    ON public.payment_decisions
    FOR SELECT
    TO authenticated
    USING (public.is_admin());

REVOKE UPDATE, DELETE ON public.payment_decisions FROM PUBLIC;
REVOKE UPDATE, DELETE ON public.payment_decisions FROM anon, authenticated;
REVOKE INSERT ON public.payment_decisions FROM PUBLIC;
REVOKE INSERT ON public.payment_decisions FROM anon, authenticated;

COMMENT ON TABLE public.payment_decisions IS
    'Registro inmutable de quien aprobo o rechazo cada pago. No se actualiza ni se borra.';

-- ---------------------------------------------------------------------------
-- 6. Trigger: nadie llega a `paid` sin aprobacion humana
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_orders_paid_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status = 'paid'
       AND COALESCE(OLD.status, '') <> 'paid'
       AND current_setting('sportbot.payment_approval', TRUE) IS DISTINCT FROM 'human'
    THEN
        RAISE EXCEPTION
            'PAYMENT_APPROVAL_REQUIRED: solo approve_payment puede marcar un pedido como pagado';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_guard_paid_transition ON public.orders;
CREATE TRIGGER orders_guard_paid_transition
    BEFORE UPDATE ON public.orders
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_orders_paid_transition();

COMMENT ON FUNCTION public.guard_orders_paid_transition() IS
    'Impide mover un pedido a paid fuera de approve_payment. Cierra el camino automatico a paid (E3.7).';

-- ---------------------------------------------------------------------------
-- 7. Aprobar pago (atomico e idempotente)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_payment(
    p_order_id UUID,
    p_payment_reference TEXT,
    p_amount_cents INTEGER,
    p_receipt_id UUID DEFAULT NULL,
    p_note TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_receipt_id UUID;
    v_payment_id UUID;
    v_email TEXT;
    v_already BOOLEAN := FALSE;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'NOT_ADMIN: solo un administrador puede aprobar pagos';
    END IF;

    SELECT * INTO v_order
      FROM public.orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    -- Idempotencia: reintentar la aprobacion no duplica dinero ni stock.
    IF v_order.status = 'paid' THEN
        SELECT id INTO v_payment_id
          FROM public.payments
         WHERE reference = v_order.payment_reference
         LIMIT 1;

        RETURN jsonb_build_object(
            'success', TRUE,
            'already_approved', TRUE,
            'order_id', v_order.id,
            'payment_reference', v_order.payment_reference,
            'total_cents', v_order.total_cents,
            'payment_id', v_payment_id
        );
    END IF;

    IF v_order.status <> 'awaiting_payment' THEN
        RAISE EXCEPTION 'ORDER_NOT_PAYABLE: estado actual %', v_order.status;
    END IF;

    IF v_order.payment_reference IS NULL
       OR trim(COALESCE(p_payment_reference, '')) <> v_order.payment_reference THEN
        RAISE EXCEPTION 'REFERENCE_MISMATCH: la referencia no coincide con el pedido';
    END IF;

    IF p_amount_cents IS NULL OR p_amount_cents <> v_order.total_cents THEN
        RAISE EXCEPTION 'AMOUNT_MISMATCH: esperado %, recibido %',
            v_order.total_cents, p_amount_cents;
    END IF;

    -- El comprobante es obligatorio: no se aprueba un pago "de palabra".
    IF p_receipt_id IS NOT NULL THEN
        SELECT id INTO v_receipt_id
          FROM public.payment_receipts
         WHERE id = p_receipt_id
           AND order_id = p_order_id
           AND status IN ('received', 'prevalidated');

        IF v_receipt_id IS NULL THEN
            RAISE EXCEPTION 'RECEIPT_NOT_FOUND: el comprobante no pertenece al pedido o ya fue revisado';
        END IF;
    ELSE
        SELECT id INTO v_receipt_id
          FROM public.payment_receipts
         WHERE order_id = p_order_id
           AND status IN ('received', 'prevalidated')
         ORDER BY created_at DESC
         LIMIT 1;

        IF v_receipt_id IS NULL THEN
            RAISE EXCEPTION 'RECEIPT_REQUIRED: el pedido no tiene comprobante por revisar';
        END IF;
    END IF;

    v_email := (SELECT email FROM public.admin_users WHERE user_id = auth.uid());

    -- Unica llave que abre el trigger del paso 6. Es local a esta transaccion.
    PERFORM set_config('sportbot.payment_approval', 'human', TRUE);

    UPDATE public.orders
       SET status = 'paid',
           paid_at = NOW(),
           payment_approved_by = auth.uid(),
           payment_rejection_reason = NULL,
           payment_rejected_at = NULL,
           updated_at = NOW()
     WHERE id = p_order_id;

    INSERT INTO public.payments (
        order_id,
        provider,
        reference,
        status,
        approved_at,
        approved_by_user_id,
        receipt_id,
        review_note,
        approved_via,
        raw_event
    )
    VALUES (
        p_order_id,
        'manual',
        v_order.payment_reference,
        'approved',
        NOW(),
        auth.uid(),
        v_receipt_id,
        NULLIF(trim(COALESCE(p_note, '')), ''),
        'admin_whatsapp_receipt',
        jsonb_build_object(
            'source', 'approve_payment',
            'amount_cents', p_amount_cents,
            'receipt_id', v_receipt_id,
            'actor_user_id', auth.uid()
        )
    )
    ON CONFLICT (reference) DO UPDATE
       SET order_id = EXCLUDED.order_id,
           provider = EXCLUDED.provider,
           status = 'approved',
           approved_at = EXCLUDED.approved_at,
           approved_by_user_id = EXCLUDED.approved_by_user_id,
           receipt_id = EXCLUDED.receipt_id,
           review_note = EXCLUDED.review_note,
           approved_via = EXCLUDED.approved_via,
           raw_event = EXCLUDED.raw_event,
           updated_at = NOW()
     WHERE public.payments.status <> 'approved'
        OR public.payments.order_id = EXCLUDED.order_id
    RETURNING id INTO v_payment_id;

    IF v_payment_id IS NULL THEN
        SELECT id INTO v_payment_id
          FROM public.payments
         WHERE reference = v_order.payment_reference
         LIMIT 1;

        -- La referencia ya estaba aprobada para otro pedido: no se toca nada.
        IF v_payment_id IS NULL THEN
            RAISE EXCEPTION 'PAYMENT_REFERENCE_CONFLICT';
        END IF;
    END IF;

    PERFORM public.commit_order_stock(p_order_id);

    UPDATE public.payment_receipts
       SET status = 'approved',
           reviewed_by_user_id = auth.uid(),
           reviewed_at = NOW(),
           review_note = NULLIF(trim(COALESCE(p_note, '')), ''),
           updated_at = NOW()
     WHERE id = v_receipt_id;

    INSERT INTO public.payment_decisions (
        order_id, receipt_id, decision, payment_reference,
        amount_cents, actor_user_id, actor_email, note
    )
    VALUES (
        p_order_id, v_receipt_id, 'approved', v_order.payment_reference,
        p_amount_cents, auth.uid(), v_email, NULLIF(trim(COALESCE(p_note, '')), '')
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'already_approved', v_already,
        'order_id', p_order_id,
        'payment_reference', v_order.payment_reference,
        'total_cents', v_order.total_cents,
        'payment_id', v_payment_id,
        'receipt_id', v_receipt_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_payment(UUID, TEXT, INTEGER, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_payment(UUID, TEXT, INTEGER, UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.approve_payment(UUID, TEXT, INTEGER, UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION public.approve_payment(UUID, TEXT, INTEGER, UUID, TEXT) IS
    'Aprueba un pago manual de forma atomica e idempotente. Exige referencia, monto exacto y comprobante.';

-- ---------------------------------------------------------------------------
-- 8. Rechazar pago (el pedido sigue pendiente de pago)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_payment(
    p_order_id UUID,
    p_reason TEXT,
    p_receipt_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.orders%ROWTYPE;
    v_receipt_id UUID;
    v_email TEXT;
    v_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'NOT_ADMIN: solo un administrador puede rechazar pagos';
    END IF;

    IF v_reason IS NULL OR length(v_reason) < 5 THEN
        RAISE EXCEPTION 'REASON_REQUIRED: el motivo debe ser visible para el cliente';
    END IF;

    SELECT * INTO v_order
      FROM public.orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'ORDER_NOT_FOUND';
    END IF;

    IF v_order.status = 'paid' THEN
        RAISE EXCEPTION 'PAYMENT_ALREADY_APPROVED: un pago aprobado no se rechaza';
    END IF;

    IF v_order.status <> 'awaiting_payment' THEN
        RAISE EXCEPTION 'ORDER_NOT_REVIEWABLE: estado actual %', v_order.status;
    END IF;

    IF p_receipt_id IS NOT NULL THEN
        SELECT id INTO v_receipt_id
          FROM public.payment_receipts
         WHERE id = p_receipt_id
           AND order_id = p_order_id;
    ELSE
        SELECT id INTO v_receipt_id
          FROM public.payment_receipts
         WHERE order_id = p_order_id
           AND status IN ('received', 'prevalidated')
         ORDER BY created_at DESC
         LIMIT 1;
    END IF;

    v_email := (SELECT email FROM public.admin_users WHERE user_id = auth.uid());

    UPDATE public.orders
       SET payment_rejection_reason = v_reason,
           payment_rejected_at = NOW(),
           updated_at = NOW()
     WHERE id = p_order_id;

    IF v_receipt_id IS NOT NULL THEN
        UPDATE public.payment_receipts
           SET status = 'rejected',
               reviewed_by_user_id = auth.uid(),
               reviewed_at = NOW(),
               review_note = v_reason,
               updated_at = NOW()
         WHERE id = v_receipt_id;
    END IF;

    INSERT INTO public.payments (
        order_id, provider, reference, status, receipt_id, review_note, approved_via, raw_event
    )
    VALUES (
        p_order_id,
        'manual',
        v_order.payment_reference,
        'rejected',
        v_receipt_id,
        v_reason,
        'admin_whatsapp_receipt',
        jsonb_build_object('source', 'reject_payment', 'actor_user_id', auth.uid())
    )
    ON CONFLICT (reference) DO UPDATE
       SET status = 'rejected',
           receipt_id = EXCLUDED.receipt_id,
           review_note = EXCLUDED.review_note,
           approved_via = EXCLUDED.approved_via,
           raw_event = EXCLUDED.raw_event,
           updated_at = NOW()
     WHERE public.payments.status <> 'approved';

    INSERT INTO public.payment_decisions (
        order_id, receipt_id, decision, payment_reference,
        amount_cents, actor_user_id, actor_email, note
    )
    VALUES (
        p_order_id, v_receipt_id, 'rejected', v_order.payment_reference,
        v_order.total_cents, auth.uid(), v_email, v_reason
    );

    RETURN jsonb_build_object(
        'success', TRUE,
        'order_id', p_order_id,
        'status', 'awaiting_payment',
        'payment_reference', v_order.payment_reference,
        'receipt_id', v_receipt_id,
        'reason', v_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reject_payment(UUID, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reject_payment(UUID, TEXT, UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.reject_payment(UUID, TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.reject_payment(UUID, TEXT, UUID) IS
    'Rechaza un comprobante sin sacar el pedido de awaiting_payment; el motivo queda visible.';

-- ---------------------------------------------------------------------------
-- 9. Cola de revision para el admin
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
    IF NOT public.is_admin() THEN
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

COMMENT ON FUNCTION public.admin_payment_queue(INTEGER) IS
    'Cola de pedidos pendientes de pago con comprobantes y veredicto de la IA.';

-- ---------------------------------------------------------------------------
-- 10. Eventos del camino del dinero
-- ---------------------------------------------------------------------------
ALTER TABLE public.conversation_events
DROP CONSTRAINT IF EXISTS conversation_events_event_type_check;

ALTER TABLE public.conversation_events
ADD CONSTRAINT conversation_events_event_type_check CHECK (
    event_type IN (
        'message_inbound_received',
        'message_outbound_sent',
        'message_status_updated',
        'audio_transcribed',
        'audio_transcription_failed',
        'customer_greeted',
        'product_search_requested',
        'product_search_results',
        'product_image_requested',
        'product_image_sent',
        'stock_check_requested',
        'stock_available',
        'stock_unavailable',
        'order_details_collected',
        'order_created',
        'payment_link_sent',
        'payment_receipt_received',
        'payment_receipt_prevalidated',
        'payment_approved',
        'payment_rejected',
        'payment_expired',
        'payment_decision_notified',
        'payment_decision_notification_failed',
        'dispatch_pending',
        'order_shipped',
        'tracking_sent',
        'order_delivered',
        'delivery_notification_failed',
        'customer_support_requested',
        'return_or_exchange_requested',
        'conversation_scored',
        'handoff_suggested',
        'agent_action_suggested',
        'bot_quality_issue_detected',
        'recovery_opportunity_detected',
        'storefront_handoff_created',
        'storefront_handoff_opened',
        'storefront_handoff_linked',
        'storefront_handoff_unresolved',
        'customer_profile_refresh_requested'
    )
);

ALTER TABLE public.conversation_events
DROP CONSTRAINT IF EXISTS conversation_events_funnel_stage_check;

ALTER TABLE public.conversation_events
ADD CONSTRAINT conversation_events_funnel_stage_check CHECK (
    funnel_stage IS NULL
    OR funnel_stage IN (
        'new',
        'exploring',
        'interested',
        'stock_validated',
        'blocked_stock',
        'ready_to_order',
        'order_created',
        'payment_link_sent',
        'payment_review',
        'payment_failed',
        'paid',
        'shipped',
        'delivered',
        'support',
        'post_sale_risk',
        'exception_future',
        'lost'
    )
);

-- ---------------------------------------------------------------------------
-- 11. PostgREST recarga el esquema
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
