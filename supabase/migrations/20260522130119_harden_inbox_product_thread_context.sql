-- Harden Admin Conversation Inbox product/thread context.
-- Date: 2026-05-22
-- Purpose:
--   The Inbox can show a long WhatsApp thread where the latest messages talk
--   about a new sneaker while an older paid order still needs dispatch. This
--   migration keeps paid orders visible for fulfillment, but separates product
--   context from payment/order context and adds a conservative recent-message
--   product match before falling back to older customer memory.

CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_context_desc
ON public.conversation_events (conversation_id, occurred_at DESC)
WHERE product_id IS NOT NULL
   OR variant_id IS NOT NULL
   OR order_id IS NOT NULL
   OR size_requested IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversation_events_conversation_payment_desc
ON public.conversation_events (conversation_id, occurred_at DESC)
WHERE order_id IS NOT NULL
   OR metadata ? 'payment_reference';

CREATE OR REPLACE FUNCTION public.admin_conversation_inbox_snapshot(
    p_from TIMESTAMPTZ DEFAULT (NOW() - INTERVAL '14 days'),
    p_to TIMESTAMPTZ DEFAULT NOW(),
    p_timezone TEXT DEFAULT 'America/Bogota',
    p_limit INTEGER DEFAULT 50,
    p_fulfillment_sla_hours INTEGER DEFAULT 24
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
    effective_fulfillment_sla_hours INTEGER;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_conversation_inbox_snapshot requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
        RAISE EXCEPTION 'Invalid conversation inbox window'
            USING ERRCODE = '22007';
    END IF;

    effective_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
    effective_fulfillment_sla_hours := COALESCE(p_fulfillment_sla_hours, 24);

    IF effective_fulfillment_sla_hours < 1 THEN
        effective_fulfillment_sla_hours := 24;
    END IF;

    WITH
    scoped_conversations AS (
        SELECT c.*
        FROM public.conversations c
        WHERE c.status = 'open'
           OR c.last_message_at >= p_from
           OR EXISTS (
                SELECT 1
                FROM public.orders o
                WHERE o.customer_id = c.customer_id
                  AND o.status IN ('draft', 'awaiting_payment', 'paid', 'shipped')
           )
           OR EXISTS (
                SELECT 1
                FROM public.conversation_events ce
                WHERE ce.conversation_id = c.id
                  AND ce.occurred_at >= p_from
           )
    ),
    enriched_rows AS (
        SELECT
            c.id AS conversation_id,
            c.customer_id,
            c.channel,
            c.status AS conversation_status,
            c.last_message_at,
            c.created_at AS conversation_created_at,
            cust.name AS customer_name,
            cust.phone_e164,
            cust.city AS customer_city,
            cp.preferred_name,
            cp.preferred_sizes,
            cp.preferred_brands,
            cp.preferred_models,
            cp.default_city,
            cp.last_intent AS profile_last_intent,
            cp.last_funnel_stage AS profile_last_funnel_stage,
            cp.conversation_summary,
            cp.operator_notes,
            lm.message_id AS last_message_id,
            lm.direction AS last_message_direction,
            lm.role AS last_message_role,
            lm.body AS last_message_body,
            lm.created_at AS last_message_created_at,
            ms.last_inbound_at,
            ms.last_outbound_at,
            COALESCE(ms.inbound_count, 0) AS inbound_count,
            COALESCE(ms.outbound_count, 0) AS outbound_count,
            le.event_id AS last_event_id,
            le.event_type AS last_event_type,
            le.funnel_stage AS last_event_funnel_stage,
            le.intent AS last_event_intent,
            le.sentiment AS last_event_sentiment,
            le.revenue_risk AS last_event_revenue_risk,
            le.handoff_required AS last_event_handoff_required,
            le.handoff_reason AS last_event_handoff_reason,
            le.occurred_at AS last_event_at,
            COALESCE(he.recent_handoff_required, FALSE) AS recent_handoff_required,
            he.last_handoff_at,
            ao.id AS order_id,
            ao.status AS order_status,
            ao.payment_reference,
            ao.total_cents AS order_total_cents,
            ao.paid_at AS order_paid_at,
            ao.created_at AS order_created_at,
            ao.updated_at AS order_updated_at,
            COALESCE(ao.order_context_rank, 9) AS order_context_rank,
            COALESCE(ao.order_context_source, 'customer_fallback') AS order_context_source,
            pay.id AS payment_id,
            pay.status AS payment_status,
            pay.approved_at AS payment_approved_at,
            sh.id AS shipment_id,
            sh.status AS shipment_status,
            sh.carrier_name,
            sh.tracking_number,
            sh.shipped_at,
            sh.delivered_at,
            COALESCE(
                mp.product_id,
                lp.product_id,
                CASE WHEN COALESCE(ao.order_context_rank, 9) <= 2 THEN oi.product_id END,
                cp.last_product_id
            ) AS active_product_id,
            CASE
                WHEN mp.product_id IS NOT NULL
                  OR mp.variant_id IS NOT NULL THEN mp.variant_id
                ELSE COALESCE(
                    lp.variant_id,
                    CASE WHEN COALESCE(ao.order_context_rank, 9) <= 2 THEN oi.variant_id END,
                    cp.last_variant_id
                )
            END AS active_variant_id,
            CASE
                WHEN mp.product_id IS NOT NULL
                  OR mp.variant_id IS NOT NULL THEN 'recent_message_match'
                WHEN lp.product_id IS NOT NULL
                  OR lp.variant_id IS NOT NULL THEN 'conversation_event'
                WHEN COALESCE(lp.size_requested, ls.size_requested) IS NOT NULL THEN 'conversation_size_only'
                WHEN COALESCE(ao.order_context_rank, 9) <= 2 THEN ao.order_context_source
                WHEN cp.last_product_id IS NOT NULL
                  OR cp.last_variant_id IS NOT NULL THEN 'customer_profile'
                ELSE NULL
            END AS active_product_context_source,
            CASE
                WHEN mp.product_id IS NOT NULL
                  OR mp.variant_id IS NOT NULL THEN 'inferred_from_recent_messages'
                WHEN lp.product_id IS NOT NULL
                  OR lp.variant_id IS NOT NULL THEN 'direct'
                WHEN COALESCE(lp.size_requested, ls.size_requested) IS NOT NULL THEN 'size_only'
                WHEN COALESCE(ao.order_context_rank, 9) <= 2 THEN 'order_linked'
                WHEN cp.last_product_id IS NOT NULL
                  OR cp.last_variant_id IS NOT NULL THEN 'customer_memory'
                ELSE 'missing'
            END AS active_product_context_quality,
            CASE
                WHEN mp.product_id IS NOT NULL
                  OR mp.variant_id IS NOT NULL THEN NULL
                WHEN COALESCE(lp.size_requested, ls.size_requested) IS NOT NULL
                 AND lp.product_id IS NULL
                 AND lp.variant_id IS NULL THEN 'Solo hay talla reciente; confirma modelo antes de responder.'
                WHEN COALESCE(ao.order_context_rank, 9) >= 9
                 AND (cp.last_product_id IS NOT NULL OR cp.last_variant_id IS NOT NULL) THEN 'Producto estimado desde memoria del cliente; puede no pertenecer al hilo actual.'
                ELSE NULL
            END AS active_product_context_warning,
            prod.brand AS active_product_brand,
            prod.model AS active_product_model,
            prod.colorway AS active_product_colorway,
            prod.price_cents AS active_product_price_cents,
            COALESCE(lp.size_requested, ls.size_requested, pv.size) AS active_size,
            pv.stock AS active_variant_stock,
            pv.reserved AS active_variant_reserved,
            GREATEST(COALESCE(pv.stock, 0) - COALESCE(pv.reserved, 0), 0) AS active_variant_available,
            COALESCE(aa.open_agent_actions_count, 0) AS open_agent_actions_count,
            aa.first_agent_action_id,
            aa.first_agent_action_summary,
            COALESCE(aa.highest_agent_risk, 'low') AS highest_agent_risk,
            GREATEST(
                COALESCE(lm.created_at, '-infinity'::timestamptz),
                COALESCE(le.occurred_at, '-infinity'::timestamptz),
                COALESCE(lp.occurred_at, '-infinity'::timestamptz),
                COALESCE(ls.occurred_at, '-infinity'::timestamptz),
                COALESCE(lo.occurred_at, '-infinity'::timestamptz),
                COALESCE(ao.updated_at, '-infinity'::timestamptz),
                COALESCE(sh.updated_at, '-infinity'::timestamptz),
                COALESCE(c.last_message_at, c.created_at)
            ) AS sort_at
        FROM scoped_conversations c
        LEFT JOIN public.customers cust ON cust.id = c.customer_id
        LEFT JOIN public.customer_profiles cp ON cp.customer_id = c.customer_id
        LEFT JOIN LATERAL (
            SELECT
                m.id AS message_id,
                m.direction,
                m.role,
                m.body,
                m.created_at
            FROM public.messages m
            WHERE m.conversation_id = c.id
            ORDER BY m.created_at DESC
            LIMIT 1
        ) lm ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                MAX(m.created_at) FILTER (WHERE m.direction = 'inbound') AS last_inbound_at,
                MAX(m.created_at) FILTER (WHERE m.direction = 'outbound') AS last_outbound_at,
                COUNT(*) FILTER (WHERE m.direction = 'inbound')::INTEGER AS inbound_count,
                COUNT(*) FILTER (WHERE m.direction = 'outbound')::INTEGER AS outbound_count
            FROM public.messages m
            WHERE m.conversation_id = c.id
              AND m.created_at >= p_from
              AND m.created_at < p_to
        ) ms ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                ce.id AS event_id,
                ce.event_type,
                ce.funnel_stage,
                ce.intent,
                ce.sentiment,
                ce.revenue_risk,
                ce.handoff_required,
                ce.handoff_reason,
                ce.occurred_at
            FROM public.conversation_events ce
            WHERE ce.conversation_id = c.id
            ORDER BY ce.occurred_at DESC
            LIMIT 1
        ) le ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                LOWER(
                    REGEXP_REPLACE(
                        STRING_AGG(COALESCE(recent_messages.body, ''), ' ' ORDER BY recent_messages.created_at DESC),
                        '[^a-z0-9]+',
                        ' ',
                        'g'
                    )
                ) AS recent_text
            FROM (
                SELECT m.body, m.created_at
                FROM public.messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC
                LIMIT 8
            ) recent_messages
        ) mt ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                ce.order_id,
                ce.product_id,
                ce.variant_id,
                ce.size_requested,
                ce.metadata,
                ce.occurred_at
            FROM public.conversation_events ce
            WHERE ce.conversation_id = c.id
              AND (
                    ce.product_id IS NOT NULL
                 OR ce.variant_id IS NOT NULL
              )
            ORDER BY ce.occurred_at DESC
            LIMIT 1
        ) lp ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                ce.size_requested,
                ce.occurred_at
            FROM public.conversation_events ce
            WHERE ce.conversation_id = c.id
              AND ce.size_requested IS NOT NULL
            ORDER BY ce.occurred_at DESC
            LIMIT 1
        ) ls ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                ranked.product_id,
                ranked.variant_id,
                ranked.match_score,
                ranked.model_token_matches
            FROM (
                SELECT
                    p.id AS product_id,
                    pv_match.id AS variant_id,
                    score.match_score,
                    score.model_token_matches
                FROM public.products p
                CROSS JOIN LATERAL (
                    SELECT
                        LOWER(REGEXP_REPLACE(COALESCE(p.brand, ''), '[^a-z0-9]+', ' ', 'g')) AS brand_text,
                        LOWER(REGEXP_REPLACE(CONCAT_WS(' ', p.model, p.colorway), '[^a-z0-9]+', ' ', 'g')) AS model_text
                ) normalized
                CROSS JOIN LATERAL (
                    SELECT
                        COUNT(*) FILTER (
                            WHERE LENGTH(tokens.token) >= 3
                              AND tokens.token NOT IN (
                                  'air', 'low', 'black', 'white', 'light', 'infrared',
                                  'bred', 'toe', 'red', 'blue', 'green', 'zapatilla',
                                  'zapatillas', 'zapato', 'zapatos', 'sneaker',
                                  'sneakers', 'shoe', 'shoes'
                              )
                              AND COALESCE(mt.recent_text, '') LIKE '%' || tokens.token || '%'
                        )::INTEGER AS model_token_matches,
                        CASE
                            WHEN NULLIF(normalized.brand_text, '') IS NOT NULL
                             AND COALESCE(mt.recent_text, '') LIKE '%' || normalized.brand_text || '%' THEN 1
                            ELSE 0
                        END AS brand_matches
                    FROM REGEXP_SPLIT_TO_TABLE(normalized.model_text, '\s+') AS tokens(token)
                ) token_score
                CROSS JOIN LATERAL (
                    SELECT
                        (token_score.model_token_matches * 10 + token_score.brand_matches * 3)::INTEGER AS match_score,
                        token_score.model_token_matches
                ) score
                LEFT JOIN LATERAL (
                    SELECT pv_inner.id
                    FROM public.product_variants pv_inner
                    WHERE pv_inner.product_id = p.id
                      AND COALESCE(lp.size_requested, ls.size_requested) IS NOT NULL
                      AND pv_inner.size = COALESCE(lp.size_requested, ls.size_requested)
                    ORDER BY pv_inner.created_at DESC NULLS LAST, pv_inner.id
                    LIMIT 1
                ) pv_match ON TRUE
                WHERE COALESCE(mt.recent_text, '') <> ''
                  AND token_score.model_token_matches > 0
            ) ranked
            ORDER BY ranked.match_score DESC, ranked.product_id
            LIMIT 1
        ) mp ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                ce.order_id,
                ce.product_id,
                ce.variant_id,
                ce.size_requested,
                ce.metadata,
                ce.occurred_at
            FROM public.conversation_events ce
            WHERE ce.conversation_id = c.id
              AND (
                    ce.order_id IS NOT NULL
                 OR ce.product_id IS NOT NULL
                 OR ce.variant_id IS NOT NULL
                 OR ce.metadata ? 'payment_reference'
              )
            ORDER BY ce.occurred_at DESC
            LIMIT 1
        ) lo ON TRUE
        LEFT JOIN LATERAL (
            SELECT
                BOOL_OR(
                    ce.handoff_required
                    OR ce.event_type = 'handoff_suggested'
                    OR ce.sentiment IN ('frustrated', 'urgent')
                ) AS recent_handoff_required,
                MAX(ce.occurred_at) FILTER (
                    WHERE ce.handoff_required
                       OR ce.event_type = 'handoff_suggested'
                       OR ce.sentiment IN ('frustrated', 'urgent')
                ) AS last_handoff_at
            FROM public.conversation_events ce
            WHERE ce.conversation_id = c.id
              AND ce.occurred_at >= p_from
              AND ce.occurred_at < p_to
        ) he ON TRUE
        LEFT JOIN LATERAL (
            SELECT ranked_orders.*
            FROM (
                SELECT
                    o.*,
                    CASE
                        WHEN lo.order_id IS NOT NULL
                         AND o.id = lo.order_id THEN 0
                        WHEN lo.metadata ? 'payment_reference'
                         AND o.payment_reference = lo.metadata->>'payment_reference' THEN 1
                        WHEN (lo.product_id IS NOT NULL OR lo.variant_id IS NOT NULL)
                         AND EXISTS (
                            SELECT 1
                            FROM public.order_items oi_match
                            WHERE oi_match.order_id = o.id
                              AND (
                                    (lo.variant_id IS NOT NULL AND oi_match.variant_id = lo.variant_id)
                                 OR (lo.product_id IS NOT NULL AND oi_match.product_id = lo.product_id)
                              )
                         ) THEN 2
                        ELSE 9
                    END AS order_context_rank,
                    CASE
                        WHEN lo.order_id IS NOT NULL
                         AND o.id = lo.order_id THEN 'conversation_order'
                        WHEN lo.metadata ? 'payment_reference'
                         AND o.payment_reference = lo.metadata->>'payment_reference' THEN 'conversation_payment_reference'
                        WHEN (lo.product_id IS NOT NULL OR lo.variant_id IS NOT NULL)
                         AND EXISTS (
                            SELECT 1
                            FROM public.order_items oi_match
                            WHERE oi_match.order_id = o.id
                              AND (
                                    (lo.variant_id IS NOT NULL AND oi_match.variant_id = lo.variant_id)
                                 OR (lo.product_id IS NOT NULL AND oi_match.product_id = lo.product_id)
                              )
                         ) THEN 'conversation_product_match'
                        ELSE 'customer_fallback'
                    END AS order_context_source
                FROM public.orders o
                WHERE o.customer_id = c.customer_id
                  AND (
                        (lo.order_id IS NOT NULL AND o.id = lo.order_id)
                     OR (lo.metadata ? 'payment_reference' AND o.payment_reference = lo.metadata->>'payment_reference')
                     OR (
                            (lo.product_id IS NOT NULL OR lo.variant_id IS NOT NULL)
                        AND EXISTS (
                            SELECT 1
                            FROM public.order_items oi_match
                            WHERE oi_match.order_id = o.id
                              AND (
                                    (lo.variant_id IS NOT NULL AND oi_match.variant_id = lo.variant_id)
                                 OR (lo.product_id IS NOT NULL AND oi_match.product_id = lo.product_id)
                              )
                        )
                     )
                     OR o.status IN ('paid', 'awaiting_payment', 'shipped', 'draft')
                  )
            ) ranked_orders
            ORDER BY
                CASE WHEN ranked_orders.order_context_rank < 9 THEN 0 ELSE 1 END,
                CASE
                    WHEN ranked_orders.status = 'paid' THEN 1
                    WHEN ranked_orders.status = 'awaiting_payment' THEN 2
                    WHEN ranked_orders.status = 'shipped' THEN 3
                    WHEN ranked_orders.status = 'draft' THEN 4
                    WHEN ranked_orders.status = 'delivered' THEN 5
                    ELSE 9
                END,
                COALESCE(ranked_orders.paid_at, ranked_orders.updated_at, ranked_orders.created_at) DESC
            LIMIT 1
        ) ao ON TRUE
        LEFT JOIN LATERAL (
            SELECT p.*
            FROM public.payments p
            WHERE p.order_id = ao.id
               OR (ao.payment_reference IS NOT NULL AND p.reference = ao.payment_reference)
            ORDER BY COALESCE(p.approved_at, p.updated_at, p.created_at) DESC
            LIMIT 1
        ) pay ON TRUE
        LEFT JOIN LATERAL (
            SELECT s.*
            FROM public.shipments s
            WHERE s.order_id = ao.id
            ORDER BY s.created_at DESC
            LIMIT 1
        ) sh ON TRUE
        LEFT JOIN LATERAL (
            SELECT oi.product_id, oi.variant_id
            FROM public.order_items oi
            WHERE oi.order_id = ao.id
            ORDER BY oi.created_at DESC
            LIMIT 1
        ) oi ON TRUE
        LEFT JOIN public.product_variants pv
            ON pv.id = CASE
                WHEN mp.product_id IS NOT NULL OR mp.variant_id IS NOT NULL THEN mp.variant_id
                ELSE COALESCE(
                    lp.variant_id,
                    CASE WHEN COALESCE(ao.order_context_rank, 9) <= 2 THEN oi.variant_id END,
                    cp.last_variant_id
                )
            END
        LEFT JOIN public.products prod
            ON prod.id = COALESCE(
                mp.product_id,
                lp.product_id,
                pv.product_id,
                CASE WHEN COALESCE(ao.order_context_rank, 9) <= 2 THEN oi.product_id END,
                cp.last_product_id
            )
        LEFT JOIN LATERAL (
            SELECT
                COUNT(*)::INTEGER AS open_agent_actions_count,
                (ARRAY_AGG(a.id ORDER BY a.created_at ASC))[1] AS first_agent_action_id,
                (ARRAY_AGG(a.summary ORDER BY a.created_at ASC))[1] AS first_agent_action_summary,
                (ARRAY_AGG(a.risk_level ORDER BY
                    CASE a.risk_level
                        WHEN 'critical' THEN 1
                        WHEN 'high' THEN 2
                        WHEN 'medium' THEN 3
                        ELSE 4
                    END,
                    a.created_at ASC
                ))[1] AS highest_agent_risk
            FROM public.agent_actions a
            WHERE a.status IN ('suggested', 'pending_approval', 'approved')
              AND (
                    (a.target_type = 'conversation' AND a.target_id = c.id::TEXT)
                 OR (a.target_type = 'customer' AND a.target_id = c.customer_id::TEXT)
                 OR (a.target_type = 'order' AND ao.id IS NOT NULL AND a.target_id = ao.id::TEXT)
              )
        ) aa ON TRUE
    ),
    classified_rows AS (
        SELECT
            er.*,
            COALESCE(er.recent_handoff_required, er.last_event_handoff_required, FALSE) AS handoff_required,
            CASE
                WHEN er.shipment_status = 'delivered' THEN 'delivered'
                WHEN er.shipment_status IN ('shipped', 'in_transit', 'out_for_delivery') THEN 'shipped'
                WHEN er.order_status = 'paid'
                 AND er.shipment_id IS NULL THEN 'fulfillment_pending'
                WHEN er.order_status = 'paid' THEN 'paid'
                WHEN er.order_status = 'awaiting_payment' THEN 'payment_pending'
                WHEN er.payment_reference IS NOT NULL THEN 'payment_link_sent'
                WHEN er.last_event_funnel_stage IS NOT NULL THEN er.last_event_funnel_stage
                WHEN er.profile_last_funnel_stage IS NOT NULL THEN er.profile_last_funnel_stage
                WHEN er.last_message_direction = 'inbound' THEN 'new'
                WHEN er.conversation_status = 'closed' THEN 'closed'
                ELSE 'monitor'
            END AS commercial_stage,
            CASE
                WHEN COALESCE(er.recent_handoff_required, er.last_event_handoff_required, FALSE) THEN 'high'
                WHEN er.order_status = 'paid'
                 AND er.order_paid_at IS NOT NULL
                 AND er.shipment_id IS NULL
                 AND er.order_paid_at < NOW() - make_interval(hours => effective_fulfillment_sla_hours) THEN 'high'
                WHEN er.highest_agent_risk IN ('critical', 'high') THEN er.highest_agent_risk
                WHEN er.order_status = 'awaiting_payment'
                 AND er.order_created_at < NOW() - INTERVAL '4 hours' THEN 'medium'
                WHEN er.last_message_direction = 'inbound' THEN 'medium'
                WHEN er.last_event_revenue_risk IS NOT NULL THEN er.last_event_revenue_risk
                ELSE 'low'
            END AS risk_level,
            CASE
                WHEN COALESCE(er.recent_handoff_required, er.last_event_handoff_required, FALSE) THEN 'take_human_handoff'
                WHEN er.order_status = 'paid'
                 AND er.order_paid_at IS NOT NULL
                 AND er.shipment_id IS NULL
                 AND er.order_paid_at < NOW() - make_interval(hours => effective_fulfillment_sla_hours) THEN 'dispatch_overdue_paid_order'
                WHEN er.order_status = 'paid'
                 AND er.shipment_id IS NULL THEN 'prepare_dispatch'
                WHEN er.order_status = 'awaiting_payment' THEN 'recover_payment'
                WHEN er.last_message_direction = 'inbound'
                 AND COALESCE(er.last_event_intent, er.profile_last_intent) IN ('product_search', 'size_availability', 'price_question', 'buy_intent') THEN 'reply_with_product_context'
                WHEN er.last_message_direction = 'inbound' THEN 'reply_to_customer'
                WHEN er.open_agent_actions_count > 0 THEN 'review_agent_actions'
                ELSE 'monitor'
            END AS next_best_action,
            (
                CASE WHEN COALESCE(er.recent_handoff_required, er.last_event_handoff_required, FALSE) THEN 100 ELSE 0 END
              + CASE
                    WHEN er.order_status = 'paid'
                     AND er.order_paid_at IS NOT NULL
                     AND er.shipment_id IS NULL
                     AND er.order_paid_at < NOW() - make_interval(hours => effective_fulfillment_sla_hours) THEN 90
                    WHEN er.order_status = 'paid' AND er.shipment_id IS NULL THEN 75
                    ELSE 0
                END
              + CASE WHEN er.last_message_direction = 'inbound' THEN 60 ELSE 0 END
              + CASE WHEN er.order_status = 'awaiting_payment' THEN 50 ELSE 0 END
              + CASE WHEN er.open_agent_actions_count > 0 THEN 25 ELSE 0 END
              + CASE WHEN er.conversation_status = 'open' THEN 10 ELSE 0 END
            )::INTEGER AS priority_score
        FROM enriched_rows er
    ),
    payload_rows AS (
        SELECT
            cr.priority_score,
            cr.sort_at,
            jsonb_strip_nulls(jsonb_build_object(
                'conversation_id', cr.conversation_id,
                'customer_id', cr.customer_id,
                'customer_name', COALESCE(cr.preferred_name, cr.customer_name, cr.phone_e164, 'Cliente sin nombre'),
                'phone_e164', cr.phone_e164,
                'channel', cr.channel,
                'conversation_status', cr.conversation_status,
                'last_message_at', cr.last_message_at,
                'last_message', jsonb_build_object(
                    'message_id', cr.last_message_id,
                    'direction', cr.last_message_direction,
                    'role', cr.last_message_role,
                    'preview', LEFT(REGEXP_REPLACE(COALESCE(cr.last_message_body, ''), '\s+', ' ', 'g'), 180),
                    'created_at', cr.last_message_created_at
                ),
                'message_activity', jsonb_build_object(
                    'last_inbound_at', cr.last_inbound_at,
                    'last_outbound_at', cr.last_outbound_at,
                    'inbound_count', cr.inbound_count,
                    'outbound_count', cr.outbound_count,
                    'needs_reply', cr.last_message_direction = 'inbound'
                ),
                'commercial', jsonb_build_object(
                    'stage', cr.commercial_stage,
                    'intent', COALESCE(cr.last_event_intent, cr.profile_last_intent),
                    'risk_level', cr.risk_level,
                    'handoff_required', cr.handoff_required,
                    'handoff_reason', cr.last_event_handoff_reason,
                    'next_best_action', cr.next_best_action,
                    'priority_score', cr.priority_score
                ),
                'customer_profile', jsonb_build_object(
                    'preferred_sizes', COALESCE(TO_JSONB(cr.preferred_sizes), '[]'::jsonb),
                    'preferred_brands', COALESCE(TO_JSONB(cr.preferred_brands), '[]'::jsonb),
                    'preferred_models', COALESCE(TO_JSONB(cr.preferred_models), '[]'::jsonb),
                    'city', COALESCE(cr.customer_city, cr.default_city),
                    'conversation_summary', cr.conversation_summary,
                    'has_operator_notes', NULLIF(BTRIM(COALESCE(cr.operator_notes, '')), '') IS NOT NULL
                ),
                'active_product', jsonb_build_object(
                    'product_id', cr.active_product_id,
                    'variant_id', cr.active_variant_id,
                    'brand', cr.active_product_brand,
                    'model', cr.active_product_model,
                    'colorway', cr.active_product_colorway,
                    'display_name', NULLIF(TRIM(CONCAT_WS(' ', cr.active_product_brand, cr.active_product_model, cr.active_product_colorway)), ''),
                    'size', cr.active_size,
                    'price_cents', cr.active_product_price_cents,
                    'available_units', cr.active_variant_available,
                    'context_source', cr.active_product_context_source,
                    'context_quality', cr.active_product_context_quality,
                    'context_warning', cr.active_product_context_warning
                ),
                'order', jsonb_build_object(
                    'order_id', cr.order_id,
                    'status', cr.order_status,
                    'payment_reference', cr.payment_reference,
                    'total_cents', cr.order_total_cents,
                    'paid_at', cr.order_paid_at,
                    'created_at', cr.order_created_at,
                    'context_source', cr.order_context_source
                ),
                'payment', jsonb_build_object(
                    'payment_id', cr.payment_id,
                    'status', COALESCE(cr.payment_status, CASE WHEN cr.order_status = 'paid' THEN 'approved' END),
                    'approved_at', cr.payment_approved_at
                ),
                'fulfillment', jsonb_build_object(
                    'shipment_id', cr.shipment_id,
                    'status', CASE
                        WHEN cr.shipment_status IS NOT NULL THEN cr.shipment_status
                        WHEN cr.order_status = 'paid' THEN 'pending_dispatch'
                    END,
                    'carrier_name', cr.carrier_name,
                    'tracking_number', cr.tracking_number,
                    'shipped_at', cr.shipped_at,
                    'delivered_at', cr.delivered_at,
                    'paid_over_sla', cr.order_status = 'paid'
                        AND cr.order_paid_at IS NOT NULL
                        AND cr.shipment_id IS NULL
                        AND cr.order_paid_at < NOW() - make_interval(hours => effective_fulfillment_sla_hours)
                ),
                'agent_actions', jsonb_build_object(
                    'open_count', cr.open_agent_actions_count,
                    'first_action_id', cr.first_agent_action_id,
                    'first_summary', cr.first_agent_action_summary,
                    'highest_risk', cr.highest_agent_risk
                ),
                'last_event', jsonb_build_object(
                    'event_id', cr.last_event_id,
                    'event_type', cr.last_event_type,
                    'funnel_stage', cr.last_event_funnel_stage,
                    'intent', cr.last_event_intent,
                    'sentiment', cr.last_event_sentiment,
                    'occurred_at', cr.last_event_at
                )
            )) AS row_payload
        FROM classified_rows cr
        ORDER BY cr.priority_score DESC, cr.sort_at DESC
        LIMIT effective_limit
    ),
    summary AS (
        SELECT
            COUNT(*)::INTEGER AS total_count,
            COUNT(*) FILTER (WHERE conversation_status = 'open')::INTEGER AS open_count,
            COUNT(*) FILTER (WHERE handoff_required)::INTEGER AS handoff_required_count,
            COUNT(*) FILTER (WHERE last_message_direction = 'inbound')::INTEGER AS needs_reply_count,
            COUNT(*) FILTER (WHERE commercial_stage = 'payment_pending')::INTEGER AS payment_pending_count,
            COUNT(*) FILTER (WHERE commercial_stage = 'fulfillment_pending')::INTEGER AS paid_pending_dispatch_count,
            COUNT(*) FILTER (
                WHERE commercial_stage = 'fulfillment_pending'
                  AND order_paid_at IS NOT NULL
                  AND order_paid_at < NOW() - make_interval(hours => effective_fulfillment_sla_hours)
            )::INTEGER AS paid_over_sla_count,
            COALESCE(SUM(open_agent_actions_count), 0)::INTEGER AS open_agent_actions_count
        FROM classified_rows
    )
    SELECT jsonb_build_object(
        'generated_at', NOW(),
        'window', jsonb_build_object(
            'from', p_from,
            'to', p_to,
            'timezone', p_timezone,
            'limit', effective_limit,
            'fulfillment_sla_hours', effective_fulfillment_sla_hours
        ),
        'summary', jsonb_build_object(
            'total_count', s.total_count,
            'open_count', s.open_count,
            'handoff_required_count', s.handoff_required_count,
            'needs_reply_count', s.needs_reply_count,
            'payment_pending_count', s.payment_pending_count,
            'paid_pending_dispatch_count', s.paid_pending_dispatch_count,
            'paid_over_sla_count', s.paid_over_sla_count,
            'open_agent_actions_count', s.open_agent_actions_count
        ),
        'conversations', COALESCE((
            SELECT jsonb_agg(pr.row_payload ORDER BY pr.priority_score DESC, pr.sort_at DESC)
            FROM payload_rows pr
        ), '[]'::jsonb),
        'agent_context', jsonb_build_object(
            'mode', 'suggest_only',
            'recommended_focus', CASE
                WHEN s.handoff_required_count > 0 THEN 'resolve_handoffs'
                WHEN s.paid_over_sla_count > 0 THEN 'dispatch_overdue_paid_orders'
                WHEN s.needs_reply_count > 0 THEN 'reply_to_waiting_customers'
                WHEN s.payment_pending_count > 0 THEN 'recover_pending_payments'
                WHEN s.open_agent_actions_count > 0 THEN 'review_agent_actions'
                ELSE 'monitor'
            END,
            'allowed_actions', jsonb_build_array(
                'summarize_conversation',
                'draft_customer_reply',
                'create_agent_action',
                'mark_handoff_required',
                'open_related_order',
                'open_logistics_context'
            )
        )
    )
    INTO snapshot
    FROM summary s;

    RETURN snapshot;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_conversation_inbox_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_conversation_inbox_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.admin_conversation_inbox_snapshot(TIMESTAMPTZ, TIMESTAMPTZ, TEXT, INTEGER, INTEGER)
IS 'Admin-only conversation inbox snapshot. Product context is separated from order/payment context, with recent-message product matching and admin-only execution.';

NOTIFY pgrst, 'reload schema';
