-- P0.3: migrate logistics notices to Evolution and make retries explicit/audited.
BEGIN;

ALTER TABLE public.logistics_notifications
    DROP CONSTRAINT IF EXISTS logistics_notifications_provider_check,
    DROP CONSTRAINT IF EXISTS logistics_notifications_status_check;

ALTER TABLE public.logistics_notifications
    ADD CONSTRAINT logistics_notifications_provider_check
        CHECK (provider IN ('twilio', 'evolution')),
    ADD CONSTRAINT logistics_notifications_status_check
        CHECK (status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'skipped', 'unknown')),
    ADD COLUMN IF NOT EXISTS attempt_number INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS retry_of_notification_id UUID
        REFERENCES public.logistics_notifications(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS retry_request_id UUID,
    ADD COLUMN IF NOT EXISTS unknown_at TIMESTAMPTZ;

ALTER TABLE public.logistics_notifications
    DROP CONSTRAINT IF EXISTS logistics_notifications_attempt_number_check;
ALTER TABLE public.logistics_notifications
    ADD CONSTRAINT logistics_notifications_attempt_number_check CHECK (attempt_number >= 1);

-- The browser may inspect attempts but must not forge provider results, insert
-- retries, or delete audit history. Mutations stay behind service-role edges.
ALTER TABLE public.logistics_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.logistics_notifications FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE ON public.logistics_notifications FROM authenticated;
GRANT SELECT ON public.logistics_notifications TO authenticated;
DROP POLICY IF EXISTS "Admins manage logistics notifications" ON public.logistics_notifications;
DROP POLICY IF EXISTS "Admins read logistics notifications" ON public.logistics_notifications;
CREATE POLICY "Admins read logistics notifications"
    ON public.logistics_notifications FOR SELECT TO authenticated
    USING (public.is_admin());

CREATE UNIQUE INDEX IF NOT EXISTS idx_logistics_notifications_retry_request
    ON public.logistics_notifications (retry_request_id)
    WHERE retry_request_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_logistics_notifications_one_active_retry
    ON public.logistics_notifications (order_id, purpose)
    WHERE retry_of_notification_id IS NOT NULL
      AND status IN ('pending', 'queued', 'unknown');

COMMENT ON COLUMN public.logistics_notifications.provider_message_sid IS
    'Provider message ID (Twilio SID or Evolution/Baileys message ID).';
COMMENT ON COLUMN public.logistics_notifications.retry_of_notification_id IS
    'Previous failed attempt. Every retry is a new auditable row and never repeats the shipment transition.';
COMMENT ON COLUMN public.logistics_notifications.retry_request_id IS
    'Client-generated idempotency key for a manual retry request.';

ALTER TABLE public.shipment_events
    DROP CONSTRAINT IF EXISTS shipment_events_event_type_check,
    DROP CONSTRAINT IF EXISTS shipment_events_source_check;
ALTER TABLE public.shipment_events
    ADD CONSTRAINT shipment_events_event_type_check CHECK (event_type IN (
        'created', 'ready_to_fulfill', 'picking', 'packed', 'label_created',
        'shipped', 'in_transit', 'out_for_delivery', 'delivered', 'exception',
        'notification_sent', 'notification_delivered', 'notification_failed',
        'notification_read', 'notification_unknown', 'note', 'cancelled'
    )),
    ADD CONSTRAINT shipment_events_source_check CHECK (
        source IN ('admin', 'system', 'twilio', 'evolution', 'carrier', 'wompi', 'migration')
    );

CREATE OR REPLACE FUNCTION public.begin_logistics_notification_retry(
    p_notification_id UUID,
    p_actor_user_id UUID,
    p_retry_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_parent public.logistics_notifications%ROWTYPE;
    v_existing public.logistics_notifications%ROWTYPE;
    v_child public.logistics_notifications%ROWTYPE;
    v_shipment_status TEXT;
    v_order_status TEXT;
    v_attempt INTEGER;
    v_id UUID;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;
    IF p_retry_request_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'retry_id_required');
    END IF;

    -- Serialize all attempts for the same notification before checking whether
    -- this request key already created a child attempt.
    SELECT * INTO v_parent FROM public.logistics_notifications
     WHERE id = p_notification_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'notification_not_found');
    END IF;

    SELECT * INTO v_existing FROM public.logistics_notifications
     WHERE retry_request_id = p_retry_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.retry_of_notification_id IS DISTINCT FROM p_notification_id
            OR v_existing.created_by IS DISTINCT FROM p_actor_user_id THEN
            RETURN jsonb_build_object('success', false, 'code', 'retry_id_conflict');
        END IF;
        IF v_existing.status = 'pending' AND v_existing.created_at < NOW() - INTERVAL '90 seconds' THEN
            UPDATE public.logistics_notifications
               SET status = 'unknown', unknown_at = NOW(),
                   error_message = 'retry_attempt_stale: verify WhatsApp before another retry',
                   raw_payload = raw_payload || jsonb_build_object('stale_retry', true)
             WHERE id = v_existing.id;
            RETURN jsonb_build_object('success', true, 'existing', true,
                'notification_id', v_existing.id, 'status', 'unknown');
        END IF;
        RETURN jsonb_build_object('success', true, 'existing', true,
            'notification_id', v_existing.id, 'status', v_existing.status);
    END IF;

    IF v_parent.status = 'unknown' OR v_parent.status = 'pending' OR v_parent.status = 'queued' THEN
        RETURN jsonb_build_object('success', false, 'code', 'notification_outcome_unknown', 'status', v_parent.status);
    END IF;
    IF v_parent.status NOT IN ('failed', 'undelivered') THEN
        RETURN jsonb_build_object('success', false, 'code', 'notification_not_retryable', 'status', v_parent.status);
    END IF;
    IF COALESCE(trim(v_parent.recipient_phone), '') = '' OR COALESCE(trim(v_parent.message_body), '') = '' THEN
        RETURN jsonb_build_object('success', false, 'code', 'notification_payload_incomplete');
    END IF;

    SELECT * INTO v_child FROM public.logistics_notifications
     WHERE retry_of_notification_id = p_notification_id
     ORDER BY attempt_number DESC, created_at DESC
     LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        IF v_child.status = 'pending' AND v_child.created_at < NOW() - INTERVAL '90 seconds' THEN
            UPDATE public.logistics_notifications
               SET status = 'unknown', unknown_at = NOW(),
                   error_message = 'retry_attempt_stale: verify WhatsApp before another retry',
                   raw_payload = raw_payload || jsonb_build_object('stale_retry', true)
             WHERE id = v_child.id;
            RETURN jsonb_build_object('success', false, 'code', 'notification_outcome_unknown', 'status', 'unknown');
        END IF;
        IF v_child.status NOT IN ('failed', 'undelivered') THEN
            RETURN jsonb_build_object('success', false, 'code', 'retry_already_attempted',
                'status', v_child.status, 'notification_id', v_child.id);
        END IF;
    END IF;

    IF v_parent.shipment_id IS NOT NULL THEN
        SELECT status INTO v_shipment_status FROM public.shipments
         WHERE id = v_parent.shipment_id FOR UPDATE;
        IF NOT FOUND OR v_shipment_status = 'cancelled' THEN
            RETURN jsonb_build_object('success', false, 'code', 'shipment_not_active');
        END IF;
        IF v_parent.purpose = 'dispatch' AND v_shipment_status NOT IN ('shipped', 'in_transit', 'out_for_delivery') THEN
            RETURN jsonb_build_object('success', false, 'code', 'dispatch_notification_stale');
        END IF;
        IF v_parent.purpose = 'delivery' AND v_shipment_status <> 'delivered' THEN
            RETURN jsonb_build_object('success', false, 'code', 'delivery_not_confirmed');
        END IF;
    ELSE
        SELECT status INTO v_order_status FROM public.orders WHERE id = v_parent.order_id;
        IF v_parent.purpose = 'dispatch' AND v_order_status NOT IN ('shipped', 'delivered') THEN
            RETURN jsonb_build_object('success', false, 'code', 'dispatch_notification_stale');
        END IF;
        IF v_parent.purpose = 'delivery' AND v_order_status <> 'delivered' THEN
            RETURN jsonb_build_object('success', false, 'code', 'delivery_not_confirmed');
        END IF;
    END IF;

    SELECT COALESCE(MAX(attempt_number), 1) + 1 INTO v_attempt
      FROM public.logistics_notifications
     WHERE id = p_notification_id OR retry_of_notification_id = p_notification_id;

    INSERT INTO public.logistics_notifications (
        order_id, shipment_id, purpose, channel, recipient_phone, message_body,
        status, provider, retry_of_notification_id, retry_request_id,
        attempt_number, raw_payload, created_by
    ) VALUES (
        v_parent.order_id, v_parent.shipment_id, v_parent.purpose, 'whatsapp',
        v_parent.recipient_phone, v_parent.message_body, 'pending', 'evolution',
        p_notification_id, p_retry_request_id, v_attempt,
        jsonb_build_object('source', 'retry_logistics_notification', 'retry_of', p_notification_id),
        p_actor_user_id
    ) ON CONFLICT DO NOTHING
    RETURNING id INTO v_id;

    -- Unique indexes arbitrate concurrent calls that target different attempts
    -- of the same purpose, as well as accidental reuse of a request key.
    IF v_id IS NULL THEN
        SELECT * INTO v_existing FROM public.logistics_notifications
         WHERE retry_request_id = p_retry_request_id FOR UPDATE;
        IF FOUND THEN
            IF v_existing.retry_of_notification_id IS DISTINCT FROM p_notification_id
                OR v_existing.created_by IS DISTINCT FROM p_actor_user_id THEN
                RETURN jsonb_build_object('success', false, 'code', 'retry_id_conflict');
            END IF;
            RETURN jsonb_build_object('success', true, 'existing', true,
                'notification_id', v_existing.id, 'status', v_existing.status);
        END IF;

        SELECT * INTO v_child FROM public.logistics_notifications
         WHERE order_id = v_parent.order_id
           AND purpose = v_parent.purpose
           AND retry_of_notification_id IS NOT NULL
           AND status IN ('pending', 'queued', 'unknown')
         ORDER BY attempt_number DESC, created_at DESC
         LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('success', false, 'code', 'retry_already_attempted',
                'status', v_child.status, 'notification_id', v_child.id);
        END IF;
        RETURN jsonb_build_object('success', false, 'code', 'retry_id_conflict');
    END IF;

    RETURN jsonb_build_object('success', true, 'existing', false,
        'notification_id', v_id, 'order_id', v_parent.order_id,
        'shipment_id', v_parent.shipment_id, 'purpose', v_parent.purpose,
        'recipient_phone', v_parent.recipient_phone, 'message_body', v_parent.message_body,
        'attempt_number', v_attempt, 'status', 'pending');
END;
$$;

REVOKE ALL ON FUNCTION public.begin_logistics_notification_retry(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_logistics_notification_retry(UUID, UUID, UUID) TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.logistics_notifications TO service_role;
GRANT SELECT, INSERT ON public.shipment_events TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
