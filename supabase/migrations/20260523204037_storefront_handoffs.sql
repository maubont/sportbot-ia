-- Migration: Storefront handoffs
-- Date: 2026-05-23
-- Description:
--   Adds the identity bridge foundation between anonymous storefront sessions
--   and verified WhatsApp conversations. The handoff code is a correlation
--   handle, not an authentication secret.

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
        'recovery_opportunity_detected',
        'storefront_handoff_created',
        'storefront_handoff_opened',
        'storefront_handoff_linked',
        'storefront_handoff_unresolved',
        'customer_profile_refresh_requested'
    )
);

CREATE TABLE IF NOT EXISTS public.storefront_handoffs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    handoff_code TEXT NOT NULL CHECK (
        handoff_code = upper(trim(handoff_code))
        AND handoff_code ~ '^WEB-[A-Z0-9]{6,10}$'
    ),
    storefront_session_id TEXT NOT NULL CHECK (
        length(trim(storefront_session_id)) > 0
        AND length(trim(storefront_session_id)) <= 128
    ),
    status TEXT NOT NULL DEFAULT 'created' CHECK (
        status IN (
            'created',
            'opened_whatsapp',
            'linked',
            'expired',
            'discarded',
            'unresolved'
        )
    ),
    source_surface TEXT NOT NULL DEFAULT 'unknown' CHECK (
        length(trim(source_surface)) > 0
        AND length(trim(source_surface)) <= 64
    ),
    product_id UUID REFERENCES public.products(id) ON DELETE SET NULL,
    variant_id UUID REFERENCES public.product_variants(id) ON DELETE SET NULL,
    product_brand TEXT,
    product_model TEXT,
    size_requested NUMERIC,
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
    linked_customer_id UUID REFERENCES public.customers(id) ON DELETE SET NULL,
    linked_conversation_id UUID REFERENCES public.conversations(id) ON DELETE SET NULL,
    linked_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    created_event_id UUID REFERENCES public.conversation_events(id) ON DELETE SET NULL,
    linked_event_id UUID REFERENCES public.conversation_events(id) ON DELETE SET NULL,
    dedupe_key TEXT,
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
    linked_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT storefront_handoffs_code_unique UNIQUE (handoff_code),
    CONSTRAINT storefront_handoffs_dedupe_unique UNIQUE (dedupe_key),
    CONSTRAINT storefront_handoffs_expires_after_created CHECK (expires_at > created_at),
    CONSTRAINT storefront_handoffs_linked_requires_identity CHECK (
        status <> 'linked'
        OR (
            linked_customer_id IS NOT NULL
            AND linked_conversation_id IS NOT NULL
            AND linked_at IS NOT NULL
        )
    ),
    CONSTRAINT storefront_handoffs_linked_at_consistency CHECK (
        linked_at IS NULL
        OR (
            linked_customer_id IS NOT NULL
            AND linked_conversation_id IS NOT NULL
        )
    )
);

CREATE INDEX IF NOT EXISTS idx_storefront_handoffs_session_created
ON public.storefront_handoffs (storefront_session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_handoffs_status_expires
ON public.storefront_handoffs (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_storefront_handoffs_active_code
ON public.storefront_handoffs (handoff_code, expires_at)
WHERE status IN ('created', 'opened_whatsapp');

CREATE INDEX IF NOT EXISTS idx_storefront_handoffs_customer_linked
ON public.storefront_handoffs (linked_customer_id, linked_at DESC)
WHERE linked_customer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_storefront_handoffs_conversation_linked
ON public.storefront_handoffs (linked_conversation_id, linked_at DESC)
WHERE linked_conversation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_storefront_handoffs_product_created
ON public.storefront_handoffs (product_id, created_at DESC)
WHERE product_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_storefront_handoffs_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS storefront_handoffs_touch_updated_at ON public.storefront_handoffs;
CREATE TRIGGER storefront_handoffs_touch_updated_at
BEFORE UPDATE ON public.storefront_handoffs
FOR EACH ROW
EXECUTE FUNCTION public.touch_storefront_handoffs_updated_at();

ALTER TABLE public.storefront_handoffs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.storefront_handoffs FROM PUBLIC;
REVOKE ALL ON public.storefront_handoffs FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.storefront_handoffs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.storefront_handoffs TO service_role;

DROP POLICY IF EXISTS "Admins read storefront handoffs" ON public.storefront_handoffs;
CREATE POLICY "Admins read storefront handoffs"
ON public.storefront_handoffs
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create storefront handoffs" ON public.storefront_handoffs;
CREATE POLICY "Admins create storefront handoffs"
ON public.storefront_handoffs
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins update storefront handoffs" ON public.storefront_handoffs;
CREATE POLICY "Admins update storefront handoffs"
ON public.storefront_handoffs
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.storefront_handoffs IS 'Auditable correlation records between anonymous storefront sessions and verified WhatsApp conversations.';
COMMENT ON COLUMN public.storefront_handoffs.handoff_code IS 'Short customer-visible correlation code, for example WEB-8F3A2C. It is not an authentication secret.';
COMMENT ON COLUMN public.storefront_handoffs.storefront_session_id IS 'Anonymous browser session id generated by the storefront. Must not contain phone, email or PII.';
COMMENT ON COLUMN public.storefront_handoffs.status IS 'Operational bridge state: created, opened_whatsapp, linked, expired, discarded or unresolved.';
COMMENT ON COLUMN public.storefront_handoffs.metadata IS 'Small non-secret metadata. Do not store raw Twilio/Wompi payloads, tokens, phones, emails or addresses.';

NOTIFY pgrst, 'reload schema';
