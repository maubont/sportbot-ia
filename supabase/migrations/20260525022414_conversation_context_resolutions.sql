-- Migration: Conversation active context resolutions
-- Date: 2026-05-25
-- Description:
--   Persists the operator-approved active context for conversations that have
--   more than one operational line, for example a paid dispatch pending order
--   and a newer storefront purchase intent on the same WhatsApp identity.
--   This is an internal AI Ops state only: it does not send WhatsApp messages,
--   mutate stock, create payments or execute dispatch.

CREATE TABLE IF NOT EXISTS public.conversation_context_resolutions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
    resolved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    source_action_id UUID REFERENCES public.agent_actions(id) ON DELETE SET NULL,
    active_context TEXT NOT NULL CHECK (
        active_context IN (
            'dispatch_pending_order',
            'new_storefront_purchase',
            'manual_review'
        )
    ),
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN (
            'active',
            'superseded',
            'cancelled'
        )
    ),
    resolution_reason TEXT CHECK (
        resolution_reason IS NULL
        OR length(trim(resolution_reason)) > 0
    ),
    dispatch_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
    dispatch_payment_reference TEXT,
    dispatch_product_name TEXT,
    dispatch_size TEXT,
    storefront_handoff_id UUID REFERENCES public.storefront_handoffs(id) ON DELETE SET NULL,
    storefront_handoff_code TEXT,
    storefront_product_name TEXT,
    storefront_size TEXT,
    guardrails JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(guardrails) = 'object'),
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_context_resolutions_one_active
ON public.conversation_context_resolutions (conversation_id)
WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_conversation_context_resolutions_conversation_created
ON public.conversation_context_resolutions (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_context_resolutions_action
ON public.conversation_context_resolutions (source_action_id)
WHERE source_action_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_context_resolutions_status_created
ON public.conversation_context_resolutions (status, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_conversation_context_resolutions_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversation_context_resolutions_touch_updated_at
ON public.conversation_context_resolutions;

CREATE TRIGGER conversation_context_resolutions_touch_updated_at
BEFORE UPDATE ON public.conversation_context_resolutions
FOR EACH ROW
EXECUTE FUNCTION public.touch_conversation_context_resolutions_updated_at();

CREATE OR REPLACE FUNCTION public.resolve_conversation_active_context(
    p_conversation_id UUID,
    p_active_context TEXT,
    p_source_action_id UUID DEFAULT NULL,
    p_resolution_reason TEXT DEFAULT NULL,
    p_customer_id UUID DEFAULT NULL,
    p_dispatch_order_id UUID DEFAULT NULL,
    p_dispatch_payment_reference TEXT DEFAULT NULL,
    p_dispatch_product_name TEXT DEFAULT NULL,
    p_dispatch_size TEXT DEFAULT NULL,
    p_storefront_handoff_code TEXT DEFAULT NULL,
    p_storefront_product_name TEXT DEFAULT NULL,
    p_storefront_size TEXT DEFAULT NULL,
    p_guardrails JSONB DEFAULT '{}'::jsonb,
    p_evidence JSONB DEFAULT '{}'::jsonb
)
RETURNS public.conversation_context_resolutions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    normalized_context TEXT;
    normalized_handoff_code TEXT;
    conversation_customer_id UUID;
    resolved_customer_id UUID;
    linked_handoff public.storefront_handoffs%ROWTYPE;
    source_action public.agent_actions%ROWTYPE;
    inserted_resolution public.conversation_context_resolutions;
    clean_guardrails JSONB := COALESCE(p_guardrails, '{}'::jsonb);
    clean_evidence JSONB := COALESCE(p_evidence, '{}'::jsonb);
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'resolve_conversation_active_context requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    normalized_context := lower(trim(COALESCE(p_active_context, '')));

    IF normalized_context NOT IN ('dispatch_pending_order', 'new_storefront_purchase', 'manual_review') THEN
        RAISE EXCEPTION 'active context must be dispatch_pending_order, new_storefront_purchase or manual_review'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(clean_guardrails) <> 'object' THEN
        RAISE EXCEPTION 'guardrails must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(clean_evidence) <> 'object' THEN
        RAISE EXCEPTION 'evidence must be a JSON object'
            USING ERRCODE = '22023';
    END IF;

    SELECT c.customer_id
    INTO conversation_customer_id
    FROM public.conversations AS c
    WHERE c.id = p_conversation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Conversation not found'
            USING ERRCODE = '02000';
    END IF;

    IF p_customer_id IS NOT NULL
       AND conversation_customer_id IS NOT NULL
       AND p_customer_id <> conversation_customer_id THEN
        RAISE EXCEPTION 'Customer does not match conversation'
            USING ERRCODE = '22023';
    END IF;

    resolved_customer_id := COALESCE(p_customer_id, conversation_customer_id);

    IF p_dispatch_order_id IS NOT NULL THEN
        PERFORM 1
        FROM public.orders AS o
        WHERE o.id = p_dispatch_order_id
          AND (
              resolved_customer_id IS NULL
              OR o.customer_id IS NULL
              OR o.customer_id = resolved_customer_id
          );

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Dispatch order not found for conversation customer'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    normalized_handoff_code := NULLIF(upper(trim(COALESCE(p_storefront_handoff_code, ''))), '');

    IF normalized_handoff_code IS NOT NULL THEN
        SELECT *
        INTO linked_handoff
        FROM public.storefront_handoffs AS sh
        WHERE sh.handoff_code = normalized_handoff_code
        LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Storefront handoff not found'
                USING ERRCODE = '02000';
        END IF;

        IF linked_handoff.linked_conversation_id IS NOT NULL
           AND linked_handoff.linked_conversation_id <> p_conversation_id THEN
            RAISE EXCEPTION 'Storefront handoff belongs to another conversation'
                USING ERRCODE = '22023';
        END IF;

        IF linked_handoff.linked_customer_id IS NOT NULL
           AND resolved_customer_id IS NOT NULL
           AND linked_handoff.linked_customer_id <> resolved_customer_id THEN
            RAISE EXCEPTION 'Storefront handoff belongs to another customer'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    IF p_source_action_id IS NOT NULL THEN
        SELECT *
        INTO source_action
        FROM public.agent_actions AS aa
        WHERE aa.id = p_source_action_id
        LIMIT 1;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Source agent action not found'
                USING ERRCODE = '02000';
        END IF;

        IF source_action.action_type <> 'resolve_active_context' THEN
            RAISE EXCEPTION 'Source agent action must be resolve_active_context'
                USING ERRCODE = '22023';
        END IF;

        IF source_action.status <> 'approved' THEN
            RAISE EXCEPTION 'Source agent action must be approved before resolving context'
                USING ERRCODE = '22023';
        END IF;

        IF source_action.target_type IS DISTINCT FROM 'conversation'
           OR source_action.target_id IS DISTINCT FROM p_conversation_id::TEXT THEN
            RAISE EXCEPTION 'Source agent action target does not match conversation'
                USING ERRCODE = '22023';
        END IF;
    END IF;

    UPDATE public.conversation_context_resolutions
    SET
        status = 'superseded',
        resolution_reason = COALESCE(resolution_reason, 'Superseded by a newer active context resolution.')
    WHERE conversation_id = p_conversation_id
      AND status = 'active';

    INSERT INTO public.conversation_context_resolutions (
        conversation_id,
        customer_id,
        resolved_by_user_id,
        source_action_id,
        active_context,
        resolution_reason,
        dispatch_order_id,
        dispatch_payment_reference,
        dispatch_product_name,
        dispatch_size,
        storefront_handoff_id,
        storefront_handoff_code,
        storefront_product_name,
        storefront_size,
        guardrails,
        evidence
    )
    VALUES (
        p_conversation_id,
        resolved_customer_id,
        auth.uid(),
        p_source_action_id,
        normalized_context,
        NULLIF(trim(COALESCE(p_resolution_reason, '')), ''),
        p_dispatch_order_id,
        NULLIF(trim(COALESCE(p_dispatch_payment_reference, '')), ''),
        NULLIF(trim(COALESCE(p_dispatch_product_name, '')), ''),
        NULLIF(trim(COALESCE(p_dispatch_size, '')), ''),
        CASE WHEN normalized_handoff_code IS NOT NULL THEN linked_handoff.id ELSE NULL END,
        normalized_handoff_code,
        NULLIF(trim(COALESCE(p_storefront_product_name, '')), ''),
        NULLIF(trim(COALESCE(p_storefront_size, '')), ''),
        clean_guardrails,
        clean_evidence
    )
    RETURNING * INTO inserted_resolution;

    RETURN inserted_resolution;
END;
$$;

ALTER TABLE public.conversation_context_resolutions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_context_resolutions FROM PUBLIC;
REVOKE ALL ON public.conversation_context_resolutions FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.conversation_context_resolutions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversation_context_resolutions TO service_role;

REVOKE ALL ON FUNCTION public.touch_conversation_context_resolutions_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_conversation_active_context(
    UUID,
    TEXT,
    UUID,
    TEXT,
    UUID,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    JSONB
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.resolve_conversation_active_context(
    UUID,
    TEXT,
    UUID,
    TEXT,
    UUID,
    UUID,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    TEXT,
    JSONB,
    JSONB
) TO authenticated;

DROP POLICY IF EXISTS "Admins read conversation context resolutions"
ON public.conversation_context_resolutions;

CREATE POLICY "Admins read conversation context resolutions"
ON public.conversation_context_resolutions
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create conversation context resolutions"
ON public.conversation_context_resolutions;

CREATE POLICY "Admins create conversation context resolutions"
ON public.conversation_context_resolutions
FOR INSERT
TO authenticated
WITH CHECK (
    public.is_admin()
    AND (
        resolved_by_user_id IS NULL
        OR resolved_by_user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Admins update conversation context resolutions"
ON public.conversation_context_resolutions;

CREATE POLICY "Admins update conversation context resolutions"
ON public.conversation_context_resolutions
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.conversation_context_resolutions IS 'Auditable active context decisions for conversations with multiple operational lines.';
COMMENT ON COLUMN public.conversation_context_resolutions.active_context IS 'Current operator-approved focus: dispatch_pending_order, new_storefront_purchase or manual_review.';
COMMENT ON COLUMN public.conversation_context_resolutions.source_action_id IS 'AI Ops action that proposed the resolution. If present, it must be approved before persistence.';
COMMENT ON COLUMN public.conversation_context_resolutions.guardrails IS 'Non-secret operational limits enforced when resolving context. This does not execute customer-facing actions.';
COMMENT ON COLUMN public.conversation_context_resolutions.evidence IS 'Non-secret snapshot of dispatch/storefront evidence used to resolve the active context.';

NOTIFY pgrst, 'reload schema';
