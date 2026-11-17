-- Atención humana real desde admin por el canal de la conversación.
-- La toma/soltar del caso y la creación de un intento de envío son atómicas.

BEGIN;

CREATE TABLE IF NOT EXISTS public.conversation_operator_assignments (
    conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'bot'
        CHECK (status IN ('bot', 'human')),
    owner_user_id UUID REFERENCES public.admin_users(user_id) ON DELETE SET NULL,
    claimed_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    last_action_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT conversation_operator_owner_consistency CHECK (
        (status = 'human' AND owner_user_id IS NOT NULL AND claimed_at IS NOT NULL)
        OR (status = 'bot' AND owner_user_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_conversation_operator_active
    ON public.conversation_operator_assignments (status, claimed_at DESC)
    WHERE status = 'human';

CREATE TABLE IF NOT EXISTS public.conversation_operator_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'claimed', 'released', 'message_send_started', 'message_send_accepted',
        'message_send_failed', 'message_send_unknown', 'provider_delivered', 'provider_read'
    )),
    message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    channel TEXT CHECK (channel IS NULL OR channel IN ('evolution', 'twilio')),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conversation_operator_events_timeline
    ON public.conversation_operator_events (conversation_id, created_at DESC);

ALTER TABLE public.conversation_operator_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_operator_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_operator_assignments FROM PUBLIC, anon;
REVOKE ALL ON public.conversation_operator_events FROM PUBLIC, anon;
GRANT SELECT ON public.conversation_operator_assignments TO authenticated;
GRANT SELECT ON public.conversation_operator_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversation_operator_assignments TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.conversation_operator_events TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.messages TO service_role;

DROP POLICY IF EXISTS "Admins read conversation operator assignments" ON public.conversation_operator_assignments;
CREATE POLICY "Admins read conversation operator assignments"
    ON public.conversation_operator_assignments FOR SELECT TO authenticated
    USING (public.is_admin());

DROP POLICY IF EXISTS "Admins read conversation operator events" ON public.conversation_operator_events;
CREATE POLICY "Admins read conversation operator events"
    ON public.conversation_operator_events FOR SELECT TO authenticated
    USING (public.is_admin());

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS client_send_id UUID,
    ADD COLUMN IF NOT EXISTS delivery_status TEXT,
    ADD COLUMN IF NOT EXISTS delivery_error TEXT,
    ADD COLUMN IF NOT EXISTS sent_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS delivery_updated_at TIMESTAMPTZ;

ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE public.messages
    ADD CONSTRAINT messages_delivery_status_check
    CHECK (delivery_status IS NULL OR delivery_status IN ('sending', 'accepted', 'delivered', 'read', 'failed', 'unknown'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_send_id
    ON public.messages (client_send_id)
    WHERE client_send_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_operator_inflight
    ON public.messages (conversation_id, created_at)
    WHERE delivery_status = 'sending';

COMMENT ON TABLE public.conversation_operator_assignments IS
    'Persistent human ownership of a conversation; status human pauses the bot until explicitly released.';
COMMENT ON TABLE public.conversation_operator_events IS
    'Audit timeline for operator claim/release and provider send outcomes.';
COMMENT ON COLUMN public.messages.delivery_status IS
    'Operator send state: sending, accepted by provider, definitive failure, or uncertain provider outcome.';
COMMENT ON COLUMN public.messages.client_send_id IS
    'Client-generated idempotency key. Replaying a request never sends the same message twice.';

CREATE OR REPLACE FUNCTION public.admin_claim_conversation(
    p_conversation_id UUID,
    p_actor_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_owner UUID;
    v_status TEXT;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    PERFORM 1 FROM public.conversations
    WHERE id = p_conversation_id AND status = 'open'
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_open');
    END IF;

    INSERT INTO public.conversation_operator_assignments (conversation_id)
    VALUES (p_conversation_id)
    ON CONFLICT (conversation_id) DO NOTHING;

    SELECT status, owner_user_id INTO v_status, v_owner
    FROM public.conversation_operator_assignments
    WHERE conversation_id = p_conversation_id
    FOR UPDATE;

    IF v_status = 'human' THEN
        IF v_owner = p_actor_user_id THEN
            RETURN jsonb_build_object('success', true, 'already_claimed', true,
                'status', 'human', 'owner_user_id', v_owner);
        END IF;
        RETURN jsonb_build_object('success', false, 'code', 'claimed_by_another_operator',
            'status', 'human', 'owner_user_id', v_owner);
    END IF;

    UPDATE public.conversation_operator_assignments
       SET status = 'human', owner_user_id = p_actor_user_id,
           claimed_at = NOW(), released_at = NULL,
           last_action_by = p_actor_user_id, updated_at = NOW()
     WHERE conversation_id = p_conversation_id;

    INSERT INTO public.conversation_state (conversation_id, handoff_status, bot_paused_until)
    VALUES (p_conversation_id, 'human', NULL)
    ON CONFLICT (conversation_id) DO UPDATE
       SET handoff_status = 'human', bot_paused_until = NULL, updated_at = NOW();

    INSERT INTO public.conversation_operator_events (conversation_id, actor_user_id, event_type)
    VALUES (p_conversation_id, p_actor_user_id, 'claimed');

    RETURN jsonb_build_object('success', true, 'already_claimed', false,
        'status', 'human', 'owner_user_id', p_actor_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_release_conversation(
    p_conversation_id UUID,
    p_actor_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_owner UUID;
    v_status TEXT;
    v_inflight INTEGER;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    PERFORM 1 FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_found');
    END IF;

    INSERT INTO public.conversation_operator_assignments (conversation_id)
    VALUES (p_conversation_id)
    ON CONFLICT (conversation_id) DO NOTHING;

    SELECT status, owner_user_id INTO v_status, v_owner
    FROM public.conversation_operator_assignments
    WHERE conversation_id = p_conversation_id
    FOR UPDATE;

    -- A hung provider call must not be silently released or resent. Mark it
    -- uncertain after headroom beyond both providers' request timeout.
    UPDATE public.messages
       SET delivery_status = 'unknown',
           delivery_error = 'send_attempt_stale: verify WhatsApp before retrying',
           delivery_updated_at = NOW()
     WHERE conversation_id = p_conversation_id
       AND delivery_status = 'sending'
       AND created_at < NOW() - INTERVAL '90 seconds';

    SELECT COUNT(*) INTO v_inflight FROM public.messages
     WHERE conversation_id = p_conversation_id AND delivery_status = 'sending';
    IF v_inflight > 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'send_in_progress');
    END IF;

    IF v_status = 'human' AND v_owner <> p_actor_user_id AND v_role NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_conversation_owner',
            'status', v_status, 'owner_user_id', v_owner);
    END IF;

    IF v_status <> 'human' THEN
        UPDATE public.conversation_state
           SET handoff_status = 'bot', bot_paused_until = NULL,
               stage = CASE WHEN stage = 'human_takeover' THEN 'browsing' ELSE stage END,
               updated_at = NOW()
         WHERE conversation_id = p_conversation_id
           AND handoff_status <> 'bot';
        RETURN jsonb_build_object('success', true, 'already_released', true, 'status', 'bot');
    END IF;

    UPDATE public.conversation_operator_assignments
       SET status = 'bot', owner_user_id = NULL, released_at = NOW(),
           last_action_by = p_actor_user_id, updated_at = NOW()
     WHERE conversation_id = p_conversation_id;

    UPDATE public.conversation_state
       SET handoff_status = 'bot', bot_paused_until = NULL,
           stage = CASE WHEN stage = 'human_takeover' THEN 'browsing' ELSE stage END,
           updated_at = NOW()
     WHERE conversation_id = p_conversation_id;

    INSERT INTO public.conversation_operator_events (conversation_id, actor_user_id, event_type)
    VALUES (p_conversation_id, p_actor_user_id, 'released');

    RETURN jsonb_build_object('success', true, 'already_released', false, 'status', 'bot');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_prepare_operator_message(
    p_conversation_id UUID,
    p_actor_user_id UUID,
    p_client_send_id UUID,
    p_body TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_owner UUID;
    v_assignment_status TEXT;
    v_conversation_status TEXT;
    v_channel TEXT;
    v_phone TEXT;
    v_existing public.messages%ROWTYPE;
    v_message_id UUID;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;
    IF p_client_send_id IS NULL OR length(trim(COALESCE(p_body, ''))) = 0 OR length(p_body) > 4096 THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_message');
    END IF;

    SELECT status INTO v_conversation_status FROM public.conversations
     WHERE id = p_conversation_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_found');
    END IF;
    IF v_conversation_status <> 'open' THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_open');
    END IF;

    SELECT status, owner_user_id INTO v_assignment_status, v_owner
      FROM public.conversation_operator_assignments
     WHERE conversation_id = p_conversation_id
     FOR UPDATE;
    IF NOT FOUND OR v_assignment_status <> 'human' OR v_owner <> p_actor_user_id THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_owned');
    END IF;

    SELECT * INTO v_existing FROM public.messages WHERE client_send_id = p_client_send_id FOR UPDATE;
    IF FOUND THEN
        IF v_existing.conversation_id <> p_conversation_id OR v_existing.sent_by_user_id <> p_actor_user_id THEN
            RETURN jsonb_build_object('success', false, 'code', 'idempotency_key_conflict');
        END IF;
        RETURN jsonb_build_object('success', true, 'existing', true,
            'message_id', v_existing.id, 'delivery_status', v_existing.delivery_status);
    END IF;

    UPDATE public.messages
       SET delivery_status = 'unknown',
           delivery_error = 'send_attempt_stale: verify WhatsApp before retrying',
           delivery_updated_at = NOW()
     WHERE conversation_id = p_conversation_id
       AND delivery_status = 'sending'
       AND created_at < NOW() - INTERVAL '90 seconds';

    IF EXISTS (SELECT 1 FROM public.messages WHERE conversation_id = p_conversation_id AND delivery_status = 'sending') THEN
        RETURN jsonb_build_object('success', false, 'code', 'send_in_progress');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.messages m
         WHERE m.conversation_id = p_conversation_id
           AND m.direction = 'inbound' AND m.role = 'user'
    ) THEN
        RETURN jsonb_build_object('success', false, 'code', 'channel_not_identified');
    END IF;
    -- SportBot's active MVP rail is Evolution. Do not route old Twilio history
    -- back to the retired provider when an established customer returns.
    v_channel := 'evolution';

    SELECT c.phone_e164 INTO v_phone
      FROM public.conversations cv
      JOIN public.customers c ON c.id = cv.customer_id
     WHERE cv.id = p_conversation_id;
    IF v_phone IS NULL OR v_phone !~ '^\+[0-9]{8,15}$' THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_customer_phone');
    END IF;

    INSERT INTO public.messages (
        conversation_id, direction, role, body, channel, client_send_id,
        delivery_status, sent_by_user_id, delivery_updated_at
    ) VALUES (
        p_conversation_id, 'outbound', 'agent', trim(p_body), v_channel,
        p_client_send_id, 'sending', p_actor_user_id, NOW()
    ) RETURNING id INTO v_message_id;

    UPDATE public.conversations SET last_message_at = NOW(), updated_at = NOW()
     WHERE id = p_conversation_id;

    INSERT INTO public.conversation_operator_events (
        conversation_id, actor_user_id, event_type, message_id, channel
    ) VALUES (p_conversation_id, p_actor_user_id, 'message_send_started', v_message_id, v_channel);

    RETURN jsonb_build_object('success', true, 'existing', false,
        'message_id', v_message_id, 'delivery_status', 'sending',
        'channel', v_channel, 'to', v_phone, 'body', trim(p_body));
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_finish_operator_message(
    p_conversation_id UUID,
    p_message_id UUID,
    p_actor_user_id UUID,
    p_delivery_status TEXT,
    p_provider_message_id TEXT DEFAULT NULL,
    p_delivery_error TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_message public.messages%ROWTYPE;
    v_event TEXT;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;
    IF p_delivery_status NOT IN ('accepted', 'failed', 'unknown') THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_delivery_status');
    END IF;

    SELECT * INTO v_message FROM public.messages
     WHERE id = p_message_id AND conversation_id = p_conversation_id
     FOR UPDATE;
    IF NOT FOUND OR v_message.sent_by_user_id <> p_actor_user_id THEN
        RETURN jsonb_build_object('success', false, 'code', 'message_not_owned');
    END IF;
    IF v_message.delivery_status <> 'sending' THEN
        RETURN jsonb_build_object('success', true, 'already_finished', true,
            'delivery_status', v_message.delivery_status);
    END IF;

    UPDATE public.messages
       SET delivery_status = p_delivery_status,
           delivery_error = CASE WHEN p_delivery_status = 'accepted' THEN NULL
                                 ELSE left(COALESCE(p_delivery_error, 'provider_send_failed'), 500) END,
           provider_message_id = COALESCE(NULLIF(p_provider_message_id, ''), provider_message_id),
           twilio_message_sid = CASE WHEN channel = 'twilio'
               THEN COALESCE(NULLIF(p_provider_message_id, ''), twilio_message_sid) ELSE twilio_message_sid END,
           delivery_updated_at = NOW()
     WHERE id = p_message_id;

    v_event := CASE p_delivery_status
        WHEN 'accepted' THEN 'message_send_accepted'
        WHEN 'failed' THEN 'message_send_failed'
        ELSE 'message_send_unknown'
    END;
    INSERT INTO public.conversation_operator_events (
        conversation_id, actor_user_id, event_type, message_id, channel,
        details
    ) VALUES (
        p_conversation_id, p_actor_user_id, v_event, p_message_id, v_message.channel,
        jsonb_build_object('delivery_error', CASE WHEN p_delivery_status = 'accepted' THEN NULL ELSE left(COALESCE(p_delivery_error, ''), 500) END)
    );

    RETURN jsonb_build_object('success', true, 'delivery_status', p_delivery_status,
        'provider_message_id', p_provider_message_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_claim_conversation(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_release_conversation(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_prepare_operator_message(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_finish_operator_message(UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_claim_conversation(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_release_conversation(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_prepare_operator_message(UUID, UUID, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.admin_finish_operator_message(UUID, UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

COMMIT;
