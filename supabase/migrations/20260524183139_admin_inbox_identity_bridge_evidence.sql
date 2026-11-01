-- Admin identity bridge evidence for storefront -> WhatsApp handoffs.
-- Date: 2026-05-24
-- Purpose:
--   Give Admin/AI Ops a compact, auditable view of WEB-* handoffs without
--   treating anonymous storefront intent as confirmed customer identity.

CREATE OR REPLACE FUNCTION public.admin_storefront_handoff_evidence(
    p_from TIMESTAMPTZ DEFAULT (NOW() - INTERVAL '14 days'),
    p_to TIMESTAMPTZ DEFAULT NOW(),
    p_timezone TEXT DEFAULT 'America/Bogota',
    p_limit INTEGER DEFAULT 50
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    snapshot JSONB;
    effective_limit INTEGER;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_storefront_handoff_evidence requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
        RAISE EXCEPTION 'Invalid storefront handoff evidence window'
            USING ERRCODE = '22007';
    END IF;

    effective_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);

    WITH scoped_handoffs AS (
        SELECT
            sfh.*,
            cust.name AS linked_customer_name,
            cust.phone_e164 AS linked_phone_e164
        FROM public.storefront_handoffs sfh
        LEFT JOIN public.customers cust ON cust.id = sfh.linked_customer_id
        WHERE sfh.created_at >= p_from
          AND sfh.created_at < p_to
    ),
    row_payloads AS (
        SELECT
            COALESCE(sfh.linked_at, sfh.updated_at, sfh.created_at) AS sort_at,
            jsonb_strip_nulls(jsonb_build_object(
                'handoff_id', sfh.id,
                'handoff_code', sfh.handoff_code,
                'status', sfh.status,
                'identity_status', CASE
                    WHEN sfh.status = 'linked' THEN 'verified_whatsapp'
                    WHEN sfh.status IN ('created', 'opened_whatsapp') AND sfh.expires_at >= NOW() THEN 'anonymous_pending_whatsapp'
                    WHEN sfh.status IN ('expired', 'unresolved') THEN 'unresolved'
                    ELSE sfh.status
                END,
                'review_flag', CASE
                    WHEN sfh.status IN ('expired', 'unresolved') THEN 'needs_review'
                    WHEN sfh.status IN ('created', 'opened_whatsapp') AND sfh.expires_at < NOW() THEN 'expired_pending_review'
                    ELSE NULL
                END,
                'storefront_session_id', sfh.storefront_session_id,
                'source_surface', sfh.source_surface,
                'observed_product', jsonb_strip_nulls(jsonb_build_object(
                    'product_id', sfh.product_id,
                    'variant_id', sfh.variant_id,
                    'brand', sfh.product_brand,
                    'model', sfh.product_model,
                    'display_name', NULLIF(BTRIM(CONCAT_WS(' ', sfh.product_brand, sfh.product_model)), ''),
                    'size_requested', sfh.size_requested,
                    'intent', sfh.intent,
                    'funnel_stage', sfh.funnel_stage
                )),
                'linked_customer_id', sfh.linked_customer_id,
                'linked_customer_name', sfh.linked_customer_name,
                'linked_phone_e164', sfh.linked_phone_e164,
                'linked_conversation_id', sfh.linked_conversation_id,
                'linked_message_id', sfh.linked_message_id,
                'created_at', sfh.created_at,
                'linked_at', sfh.linked_at,
                'expires_at', sfh.expires_at,
                'metadata', sfh.metadata
            )) AS row_payload
        FROM scoped_handoffs sfh
        ORDER BY COALESCE(sfh.linked_at, sfh.updated_at, sfh.created_at) DESC
        LIMIT effective_limit
    ),
    summary AS (
        SELECT
            COUNT(*)::INTEGER AS total_count,
            COUNT(*) FILTER (WHERE status = 'linked')::INTEGER AS linked_count,
            COUNT(*) FILTER (WHERE status IN ('created', 'opened_whatsapp') AND expires_at >= NOW())::INTEGER AS active_pending_count,
            COUNT(*) FILTER (WHERE status IN ('expired', 'unresolved') OR (status IN ('created', 'opened_whatsapp') AND expires_at < NOW()))::INTEGER AS unresolved_count,
            COUNT(*) FILTER (WHERE status = 'opened_whatsapp')::INTEGER AS opened_whatsapp_count
        FROM scoped_handoffs
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window', jsonb_build_object(
            'from', p_from,
            'to', p_to,
            'timezone', p_timezone,
            'limit', effective_limit
        ),
        'summary', jsonb_build_object(
            'total_count', s.total_count,
            'linked_count', s.linked_count,
            'active_pending_count', s.active_pending_count,
            'unresolved_count', s.unresolved_count,
            'opened_whatsapp_count', s.opened_whatsapp_count
        ),
        'handoffs', COALESCE((
            SELECT jsonb_agg(rp.row_payload ORDER BY rp.sort_at DESC)
            FROM row_payloads rp
        ), '[]'::jsonb),
        'agent_context', jsonb_build_object(
            'mode', 'suggest_only',
            'recommended_focus', CASE
                WHEN s.unresolved_count > 0 THEN 'review_unresolved_storefront_handoffs'
                WHEN s.active_pending_count > 0 THEN 'monitor_pending_storefront_handoffs'
                WHEN s.linked_count > 0 THEN 'audit_linked_storefront_handoffs'
                ELSE 'monitor'
            END,
            'guardrails', jsonb_build_array(
                'handoff_code_is_correlation_not_authentication',
                'do_not_merge_customer_360_without_whatsapp_identity',
                'do_not_create_order_payment_or_dispatch_from_handoff_only'
            )
        )
    )
    INTO snapshot
    FROM summary s;

    RETURN snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_storefront_handoff_evidence(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_storefront_handoff_evidence(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.admin_storefront_handoff_evidence(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER)
IS 'Admin-only snapshot of storefront WEB-* handoff evidence. It separates anonymous storefront signals from verified WhatsApp identity.';

NOTIFY pgrst, 'reload schema';
