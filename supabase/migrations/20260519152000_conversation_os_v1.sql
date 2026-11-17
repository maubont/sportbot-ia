-- Migration: Conversation OS v1
-- Date: 2026-05-19
-- Description:
--   Adds the canonical conversation event log and lightweight customer
--   profile memory. This is the foundation for commercial funnel metrics,
--   Customer 360, AI Ops context, QA and selective conversation scoring.
--   No LLM scoring or webhook instrumentation is added in this migration.

CREATE TABLE IF NOT EXISTS public.conversation_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
    message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
    payment_id UUID REFERENCES public.payments(id) ON DELETE SET NULL,
    shipment_id UUID REFERENCES public.shipments(id) ON DELETE SET NULL,
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,

    channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (length(trim(channel)) > 0),
    actor_type TEXT NOT NULL CHECK (
        actor_type IN (
            'customer',
            'bot',
            'human_admin',
            'system',
            'agent'
        )
    ),
    direction TEXT CHECK (
        direction IS NULL
        OR direction IN (
            'inbound',
            'outbound',
            'internal'
        )
    ),

    event_type TEXT NOT NULL CHECK (
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
            'payment_approved',
            'payment_rejected',
            'payment_expired',
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
            'recovery_opportunity_detected'
        )
    ),
    funnel_stage TEXT CHECK (
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
            'payment_failed',
            'paid',
            'shipped',
            'delivered',
            'support',
            'post_sale_risk',
            'exception_future',
            'lost'
        )
    ),
    intent TEXT CHECK (
        intent IS NULL
        OR intent IN (
            'greeting',
            'product_search',
            'product_image',
            'size_availability',
            'price_question',
            'buy_intent',
            'payment',
            'shipping_status',
            'support',
            'complaint',
            'reorder',
            'unknown'
        )
    ),
    sentiment TEXT CHECK (
        sentiment IS NULL
        OR sentiment IN (
            'positive',
            'neutral',
            'frustrated',
            'urgent',
            'mixed',
            'unknown'
        )
    ),
    revenue_risk TEXT CHECK (
        revenue_risk IS NULL
        OR revenue_risk IN (
            'low',
            'medium',
            'high'
        )
    ),
    handoff_required BOOLEAN NOT NULL DEFAULT FALSE,
    handoff_reason TEXT,

    size_requested NUMERIC,
    quantity_requested INTEGER CHECK (quantity_requested IS NULL OR quantity_requested > 0),
    amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'COP' CHECK (length(trim(currency)) = 3),

    source TEXT NOT NULL DEFAULT 'system' CHECK (length(trim(source)) > 0),
    confidence NUMERIC CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),

    dedupe_key TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT conversation_events_handoff_reason CHECK (
        NOT handoff_required
        OR NULLIF(trim(COALESCE(handoff_reason, '')), '') IS NOT NULL
    )
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_customer_time
ON public.conversation_events (customer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_time
ON public.conversation_events (conversation_id, occurred_at ASC);

CREATE INDEX IF NOT EXISTS idx_conversation_events_type_time
ON public.conversation_events (event_type, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversation_events_stage_time
ON public.conversation_events (funnel_stage, occurred_at DESC)
WHERE funnel_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_intent_time
ON public.conversation_events (intent, occurred_at DESC)
WHERE intent IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_product_time
ON public.conversation_events (product_id, occurred_at DESC)
WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_order_time
ON public.conversation_events (order_id, occurred_at DESC)
WHERE order_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_events_dedupe
ON public.conversation_events (dedupe_key)
WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.customer_profiles (
    customer_id UUID PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
    preferred_name TEXT,
    default_city TEXT,
    default_region TEXT,
    default_address_hint TEXT,

    preferred_sizes NUMERIC[] NOT NULL DEFAULT ARRAY[]::NUMERIC[],
    preferred_brands TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    preferred_models TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    price_min_cents INTEGER CHECK (price_min_cents IS NULL OR price_min_cents >= 0),
    price_max_cents INTEGER CHECK (price_max_cents IS NULL OR price_max_cents >= 0),

    last_intent TEXT,
    last_funnel_stage TEXT,
    last_product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    last_variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
    last_order_id UUID REFERENCES public.orders(id) ON DELETE SET NULL,
    last_conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,

    lifetime_orders_count INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_orders_count >= 0),
    lifetime_paid_orders_count INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_paid_orders_count >= 0),
    lifetime_revenue_cents BIGINT NOT NULL DEFAULT 0 CHECK (lifetime_revenue_cents >= 0),
    last_paid_at TIMESTAMPTZ,
    last_contact_at TIMESTAMPTZ,

    conversation_summary TEXT,
    operator_notes TEXT,
    ai_memory JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ai_memory) = 'object'),
    data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    profile_source TEXT NOT NULL DEFAULT 'derived' CHECK (
        profile_source IN (
            'manual',
            'derived',
            'ai_suggested',
            'imported'
        )
    ),
    profile_confidence NUMERIC CHECK (
        profile_confidence IS NULL
        OR (profile_confidence >= 0 AND profile_confidence <= 1)
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT customer_profiles_price_range CHECK (
        price_min_cents IS NULL
        OR price_max_cents IS NULL
        OR price_max_cents >= price_min_cents
    )
);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_last_contact
ON public.customer_profiles (last_contact_at DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_customer_profiles_stage
ON public.customer_profiles (last_funnel_stage, last_contact_at DESC)
WHERE last_funnel_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customer_profiles_last_order
ON public.customer_profiles (last_order_id)
WHERE last_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_customer_profiles_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_profiles_touch_updated_at ON public.customer_profiles;
CREATE TRIGGER customer_profiles_touch_updated_at
BEFORE UPDATE ON public.customer_profiles
FOR EACH ROW
EXECUTE FUNCTION public.touch_customer_profiles_updated_at();

CREATE OR REPLACE FUNCTION public.refresh_customer_profile(
    p_customer_id UUID
)
RETURNS public.customer_profiles
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_customer public.customers%ROWTYPE;
    v_existing public.customer_profiles%ROWTYPE;
    v_last_event public.conversation_events%ROWTYPE;
    v_recent_order public.orders%ROWTYPE;
    v_updated public.customer_profiles%ROWTYPE;
    v_preferred_sizes NUMERIC[] := ARRAY[]::NUMERIC[];
    v_preferred_brands TEXT[] := ARRAY[]::TEXT[];
    v_preferred_models TEXT[] := ARRAY[]::TEXT[];
    v_quality_flags TEXT[] := ARRAY[]::TEXT[];
    v_lifetime_orders_count INTEGER := 0;
    v_lifetime_paid_orders_count INTEGER := 0;
    v_lifetime_revenue_cents BIGINT := 0;
    v_last_paid_at TIMESTAMPTZ;
    v_last_event_at TIMESTAMPTZ;
    v_last_message_at TIMESTAMPTZ;
    v_last_contact_at TIMESTAMPTZ;
    v_event_count INTEGER := 0;
    v_price_min_cents INTEGER;
    v_price_max_cents INTEGER;
    v_last_product_id UUID;
    v_last_variant_id UUID;
    v_fallback_product_id UUID;
    v_fallback_variant_id UUID;
    v_default_city TEXT;
    v_default_region TEXT;
    v_default_address_hint TEXT;
BEGIN
    IF COALESCE(auth.role(), '') <> 'service_role' AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'refresh_customer_profile requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    SELECT *
    INTO v_customer
    FROM public.customers
    WHERE id = p_customer_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Customer not found'
            USING ERRCODE = '02000';
    END IF;

    SELECT *
    INTO v_existing
    FROM public.customer_profiles
    WHERE customer_id = p_customer_id;

    SELECT *
    INTO v_last_event
    FROM public.conversation_events
    WHERE customer_id = p_customer_id
    ORDER BY occurred_at DESC, created_at DESC
    LIMIT 1;

    v_last_product_id := v_last_event.product_id;
    v_last_variant_id := v_last_event.variant_id;

    SELECT *
    INTO v_recent_order
    FROM public.orders
    WHERE customer_id = p_customer_id
    ORDER BY created_at DESC
    LIMIT 1;

    SELECT
        COUNT(*)::INTEGER,
        COUNT(*) FILTER (WHERE status IN ('paid', 'shipped', 'delivered'))::INTEGER,
        COALESCE(SUM(total_cents) FILTER (WHERE status IN ('paid', 'shipped', 'delivered')), 0)::BIGINT,
        MAX(paid_at)
    INTO
        v_lifetime_orders_count,
        v_lifetime_paid_orders_count,
        v_lifetime_revenue_cents,
        v_last_paid_at
    FROM public.orders
    WHERE customer_id = p_customer_id;

    SELECT MIN(oi.unit_price_cents), MAX(oi.unit_price_cents)
    INTO v_price_min_cents, v_price_max_cents
    FROM public.orders o
    JOIN public.order_items oi ON oi.order_id = o.id
    WHERE o.customer_id = p_customer_id
      AND oi.unit_price_cents IS NOT NULL;

    SELECT MAX(occurred_at), COUNT(*)::INTEGER
    INTO v_last_event_at, v_event_count
    FROM public.conversation_events
    WHERE customer_id = p_customer_id;

    SELECT MAX(m.created_at)
    INTO v_last_message_at
    FROM public.conversations c
    JOIN public.messages m ON m.conversation_id = c.id
    WHERE c.customer_id = p_customer_id;

    v_last_contact_at := CASE
        WHEN v_last_event_at IS NULL THEN v_last_message_at
        WHEN v_last_message_at IS NULL THEN v_last_event_at
        ELSE GREATEST(v_last_event_at, v_last_message_at)
    END;

    WITH size_votes AS (
        SELECT
            pv.size::NUMERIC AS value,
            (COUNT(*)::INTEGER * 2) AS weight
        FROM public.orders o
        JOIN public.order_items oi ON oi.order_id = o.id
        JOIN public.product_variants pv ON pv.id = oi.variant_id
        WHERE o.customer_id = p_customer_id
          AND pv.size IS NOT NULL
        GROUP BY pv.size

        UNION ALL

        SELECT
            ce.size_requested::NUMERIC AS value,
            COUNT(*)::INTEGER AS weight
        FROM public.conversation_events ce
        WHERE ce.customer_id = p_customer_id
          AND ce.size_requested IS NOT NULL
        GROUP BY ce.size_requested
    ),
    ranked_sizes AS (
        SELECT value, SUM(weight) AS total_weight
        FROM size_votes
        GROUP BY value
        ORDER BY total_weight DESC, value ASC
        LIMIT 5
    )
    SELECT COALESCE(array_agg(value ORDER BY total_weight DESC, value ASC), ARRAY[]::NUMERIC[])
    INTO v_preferred_sizes
    FROM ranked_sizes;

    WITH brand_votes AS (
        SELECT
            p.brand AS value,
            (COUNT(*)::INTEGER * 2) AS weight
        FROM public.orders o
        JOIN public.order_items oi ON oi.order_id = o.id
        JOIN public.products p ON p.id = oi.product_id
        WHERE o.customer_id = p_customer_id
          AND NULLIF(trim(p.brand), '') IS NOT NULL
        GROUP BY p.brand

        UNION ALL

        SELECT
            p.brand AS value,
            COUNT(*)::INTEGER AS weight
        FROM public.conversation_events ce
        JOIN public.products p ON p.id = ce.product_id
        WHERE ce.customer_id = p_customer_id
          AND NULLIF(trim(p.brand), '') IS NOT NULL
        GROUP BY p.brand
    ),
    ranked_brands AS (
        SELECT value, SUM(weight) AS total_weight
        FROM brand_votes
        GROUP BY value
        ORDER BY total_weight DESC, value ASC
        LIMIT 5
    )
    SELECT COALESCE(array_agg(value ORDER BY total_weight DESC, value ASC), ARRAY[]::TEXT[])
    INTO v_preferred_brands
    FROM ranked_brands;

    WITH model_votes AS (
        SELECT
            trim(p.brand || ' ' || p.model) AS value,
            (COUNT(*)::INTEGER * 2) AS weight
        FROM public.orders o
        JOIN public.order_items oi ON oi.order_id = o.id
        JOIN public.products p ON p.id = oi.product_id
        WHERE o.customer_id = p_customer_id
          AND NULLIF(trim(p.model), '') IS NOT NULL
        GROUP BY trim(p.brand || ' ' || p.model)

        UNION ALL

        SELECT
            trim(p.brand || ' ' || p.model) AS value,
            COUNT(*)::INTEGER AS weight
        FROM public.conversation_events ce
        JOIN public.products p ON p.id = ce.product_id
        WHERE ce.customer_id = p_customer_id
          AND NULLIF(trim(p.model), '') IS NOT NULL
        GROUP BY trim(p.brand || ' ' || p.model)
    ),
    ranked_models AS (
        SELECT value, SUM(weight) AS total_weight
        FROM model_votes
        GROUP BY value
        ORDER BY total_weight DESC, value ASC
        LIMIT 5
    )
    SELECT COALESCE(array_agg(value ORDER BY total_weight DESC, value ASC), ARRAY[]::TEXT[])
    INTO v_preferred_models
    FROM ranked_models;

    IF v_last_product_id IS NULL OR v_last_variant_id IS NULL THEN
        SELECT oi.product_id, oi.variant_id
        INTO v_fallback_product_id, v_fallback_variant_id
        FROM public.orders o
        JOIN public.order_items oi ON oi.order_id = o.id
        WHERE o.customer_id = p_customer_id
        ORDER BY o.created_at DESC, oi.created_at DESC
        LIMIT 1;

        v_last_product_id := COALESCE(v_last_product_id, v_fallback_product_id);
        v_last_variant_id := COALESCE(v_last_variant_id, v_fallback_variant_id);
    END IF;

    v_default_city := COALESCE(
        NULLIF(trim(v_customer.city), ''),
        NULLIF(trim(v_recent_order.shipping_city), '')
    );
    v_default_region := NULLIF(trim(v_recent_order.shipping_region), '');
    v_default_address_hint := LEFT(NULLIF(trim(v_recent_order.shipping_address), ''), 140);

    IF NULLIF(trim(COALESCE(v_customer.name, '')), '') IS NULL THEN
        v_quality_flags := array_append(v_quality_flags, 'missing_name');
    END IF;

    IF NULLIF(trim(COALESCE(v_default_city, '')), '') IS NULL THEN
        v_quality_flags := array_append(v_quality_flags, 'missing_city');
    END IF;

    IF v_event_count = 0 THEN
        v_quality_flags := array_append(v_quality_flags, 'no_conversation_events');
    END IF;

    IF v_existing.customer_id IS NOT NULL
       AND NULLIF(trim(COALESCE(v_existing.conversation_summary, '')), '') IS NULL
       AND v_event_count > 0 THEN
        v_quality_flags := array_append(v_quality_flags, 'missing_conversation_summary');
    END IF;

    INSERT INTO public.customer_profiles (
        customer_id,
        preferred_name,
        default_city,
        default_region,
        default_address_hint,
        preferred_sizes,
        preferred_brands,
        preferred_models,
        price_min_cents,
        price_max_cents,
        last_intent,
        last_funnel_stage,
        last_product_id,
        last_variant_id,
        last_order_id,
        last_conversation_id,
        lifetime_orders_count,
        lifetime_paid_orders_count,
        lifetime_revenue_cents,
        last_paid_at,
        last_contact_at,
        data_quality_flags,
        profile_source,
        profile_confidence
    )
    VALUES (
        p_customer_id,
        NULLIF(trim(v_customer.name), ''),
        v_default_city,
        v_default_region,
        v_default_address_hint,
        COALESCE(v_preferred_sizes, ARRAY[]::NUMERIC[]),
        COALESCE(v_preferred_brands, ARRAY[]::TEXT[]),
        COALESCE(v_preferred_models, ARRAY[]::TEXT[]),
        v_price_min_cents,
        v_price_max_cents,
        v_last_event.intent,
        v_last_event.funnel_stage,
        v_last_product_id,
        v_last_variant_id,
        v_recent_order.id,
        v_last_event.conversation_id,
        COALESCE(v_lifetime_orders_count, 0),
        COALESCE(v_lifetime_paid_orders_count, 0),
        COALESCE(v_lifetime_revenue_cents, 0),
        v_last_paid_at,
        v_last_contact_at,
        COALESCE(v_quality_flags, ARRAY[]::TEXT[]),
        'derived',
        CASE
            WHEN v_event_count > 0 THEN 0.75
            WHEN v_lifetime_orders_count > 0 THEN 0.65
            ELSE 0.45
        END
    )
    ON CONFLICT (customer_id)
    DO UPDATE SET
        preferred_name = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND NULLIF(trim(COALESCE(public.customer_profiles.preferred_name, '')), '') IS NOT NULL
                THEN public.customer_profiles.preferred_name
            ELSE COALESCE(EXCLUDED.preferred_name, public.customer_profiles.preferred_name)
        END,
        default_city = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND NULLIF(trim(COALESCE(public.customer_profiles.default_city, '')), '') IS NOT NULL
                THEN public.customer_profiles.default_city
            ELSE COALESCE(EXCLUDED.default_city, public.customer_profiles.default_city)
        END,
        default_region = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND NULLIF(trim(COALESCE(public.customer_profiles.default_region, '')), '') IS NOT NULL
                THEN public.customer_profiles.default_region
            ELSE COALESCE(EXCLUDED.default_region, public.customer_profiles.default_region)
        END,
        default_address_hint = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND NULLIF(trim(COALESCE(public.customer_profiles.default_address_hint, '')), '') IS NOT NULL
                THEN public.customer_profiles.default_address_hint
            ELSE COALESCE(EXCLUDED.default_address_hint, public.customer_profiles.default_address_hint)
        END,
        preferred_sizes = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND cardinality(public.customer_profiles.preferred_sizes) > 0
                THEN public.customer_profiles.preferred_sizes
            ELSE EXCLUDED.preferred_sizes
        END,
        preferred_brands = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND cardinality(public.customer_profiles.preferred_brands) > 0
                THEN public.customer_profiles.preferred_brands
            ELSE EXCLUDED.preferred_brands
        END,
        preferred_models = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND cardinality(public.customer_profiles.preferred_models) > 0
                THEN public.customer_profiles.preferred_models
            ELSE EXCLUDED.preferred_models
        END,
        price_min_cents = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND public.customer_profiles.price_min_cents IS NOT NULL
                THEN public.customer_profiles.price_min_cents
            ELSE EXCLUDED.price_min_cents
        END,
        price_max_cents = CASE
            WHEN public.customer_profiles.profile_source = 'manual'
             AND public.customer_profiles.price_max_cents IS NOT NULL
                THEN public.customer_profiles.price_max_cents
            ELSE EXCLUDED.price_max_cents
        END,
        last_intent = EXCLUDED.last_intent,
        last_funnel_stage = EXCLUDED.last_funnel_stage,
        last_product_id = EXCLUDED.last_product_id,
        last_variant_id = EXCLUDED.last_variant_id,
        last_order_id = EXCLUDED.last_order_id,
        last_conversation_id = EXCLUDED.last_conversation_id,
        lifetime_orders_count = EXCLUDED.lifetime_orders_count,
        lifetime_paid_orders_count = EXCLUDED.lifetime_paid_orders_count,
        lifetime_revenue_cents = EXCLUDED.lifetime_revenue_cents,
        last_paid_at = EXCLUDED.last_paid_at,
        last_contact_at = EXCLUDED.last_contact_at,
        conversation_summary = public.customer_profiles.conversation_summary,
        operator_notes = public.customer_profiles.operator_notes,
        ai_memory = public.customer_profiles.ai_memory,
        data_quality_flags = EXCLUDED.data_quality_flags,
        profile_source = public.customer_profiles.profile_source,
        profile_confidence = EXCLUDED.profile_confidence,
        updated_at = NOW()
    RETURNING * INTO v_updated;

    RETURN v_updated;
END;
$$;

ALTER TABLE public.conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_events FROM PUBLIC;
REVOKE ALL ON public.conversation_events FROM anon;
GRANT SELECT, INSERT ON public.conversation_events TO authenticated;
GRANT SELECT, INSERT ON public.conversation_events TO service_role;

REVOKE ALL ON public.customer_profiles FROM PUBLIC;
REVOKE ALL ON public.customer_profiles FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.customer_profiles TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.customer_profiles TO service_role;

REVOKE ALL ON FUNCTION public.refresh_customer_profile(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_customer_profile(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.refresh_customer_profile(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_customer_profile(UUID) TO service_role;

DROP POLICY IF EXISTS "Admins read conversation events" ON public.conversation_events;
CREATE POLICY "Admins read conversation events"
ON public.conversation_events
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create conversation events" ON public.conversation_events;
CREATE POLICY "Admins create conversation events"
ON public.conversation_events
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins read customer profiles" ON public.customer_profiles;
CREATE POLICY "Admins read customer profiles"
ON public.customer_profiles
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create customer profiles" ON public.customer_profiles;
CREATE POLICY "Admins create customer profiles"
ON public.customer_profiles
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins update customer profiles" ON public.customer_profiles;
CREATE POLICY "Admins update customer profiles"
ON public.customer_profiles
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.conversation_events IS 'Canonical append-only event log for conversation, commerce, payment, logistics, QA and AI Ops facts.';
COMMENT ON COLUMN public.conversation_events.event_type IS 'Controlled v1 event name. Add new values intentionally through migrations.';
COMMENT ON COLUMN public.conversation_events.funnel_stage IS 'Small canonical funnel stage used by dashboards and AI Ops.';
COMMENT ON COLUMN public.conversation_events.metadata IS 'Small sanitized metadata object. Do not store secrets or raw sensitive payloads.';
COMMENT ON COLUMN public.conversation_events.dedupe_key IS 'Optional idempotency key for webhook and tool instrumentation.';
COMMENT ON COLUMN public.conversation_events.cost_cents IS 'Estimated direct processing cost in COP cents for AI/Twilio analysis related to this event.';
COMMENT ON TABLE public.customer_profiles IS 'Lightweight editable customer memory derived from orders and conversation events.';
COMMENT ON COLUMN public.customer_profiles.ai_memory IS 'Structured non-secret AI memory. Human-editable fields remain authoritative.';
COMMENT ON COLUMN public.customer_profiles.operator_notes IS 'Manual operator notes that refresh_customer_profile must not overwrite.';
COMMENT ON FUNCTION public.refresh_customer_profile(UUID) IS 'Refreshes lightweight customer memory from canonical events, orders, messages and customer data without overwriting manual notes.';

NOTIFY pgrst, 'reload schema';
