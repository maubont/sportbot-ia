-- SB-110: Búsqueda server-side en el Inbox.
--
-- RPC admin_search_conversations permite buscar conversaciones abiertas y
-- cerradas por telefono, nombre de cliente, cuerpo de mensaje, referencia de
-- orden, ID de orden o numero de guia. Devuelve resultados paginados con el
-- tipo de coincidencia y una vista previa para render en la lista del Inbox.
--
-- Diseño:
--  * Busca en customers (phone_e164, name), messages (body),
--    orders (payment_reference, id), shipments (tracking_number).
--  * Coincidencia parcial (ILIKE) con %, case-insensitive.
--  * Tipo de coincidencia: customer, message, order, shipment.
--  * Preview: cuerpo del mensaje coincidente o referencia de orden/guia.
--  * RLS: autenticados pueden leer.
--  * p95 objetivo < 300 ms: indices sobre phone_e164, body, payment_reference,
--    tracking_number.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_search_conversations(
    p_query TEXT,
    p_limit INTEGER DEFAULT 20,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    conversation_id UUID,
    customer_id UUID,
    customer_name TEXT,
    phone_e164 TEXT,
    last_message_at TIMESTAMPTZ,
    match_type TEXT,
    match_preview TEXT,
    conversation_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_query TEXT;
    v_limit INTEGER;
    v_offset INTEGER;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_search_conversations requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    v_query := '%' || trim(COALESCE(p_query, '')) || '%';
    v_limit := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100);
    v_offset := GREATEST(COALESCE(p_offset, 0), 0);

    RETURN QUERY
    WITH matches AS (
        -- Coincidencia por telefono o nombre de cliente
        SELECT DISTINCT c.id AS conversation_id,
               c.customer_id,
               cust.name AS customer_name,
               cust.phone_e164,
               c.last_message_at,
               c.status AS conversation_status,
               'customer' AS match_type,
               cust.phone_e164 AS match_preview,
               GREATEST(COALESCE(c.last_message_at, c.created_at)) AS sort_at,
               NULL::timestamptz AS message_created_at,
               NULL::timestamptz AS order_updated_at,
               NULL::timestamptz AS shipment_updated_at
        FROM public.conversations c
        JOIN public.customers cust ON cust.id = c.customer_id
        WHERE cust.phone_e164 ILIKE v_query
           OR cust.name ILIKE v_query

        UNION

        -- Coincidencia por cuerpo de mensaje
        SELECT DISTINCT c.id AS conversation_id,
               c.customer_id,
               cust.name AS customer_name,
               cust.phone_e164,
               c.last_message_at,
               c.status AS conversation_status,
               'message' AS match_type,
               LEFT(REGEXP_REPLACE(m.body, '\s+', ' ', 'g'), 180) AS match_preview,
               GREATEST(COALESCE(c.last_message_at, c.created_at), m.created_at) AS sort_at,
               m.created_at AS message_created_at,
               NULL::timestamptz AS order_updated_at,
               NULL::timestamptz AS shipment_updated_at
        FROM public.conversations c
        JOIN public.customers cust ON cust.id = c.customer_id
        JOIN public.messages m ON m.conversation_id = c.id
        WHERE m.body ILIKE v_query

        UNION

        -- Coincidencia por referencia o ID de orden
        SELECT DISTINCT c.id AS conversation_id,
               c.customer_id,
               cust.name AS customer_name,
               cust.phone_e164,
               c.last_message_at,
               c.status AS conversation_status,
               'order' AS match_type,
               COALESCE(o.payment_reference, o.id::TEXT) AS match_preview,
               GREATEST(COALESCE(c.last_message_at, c.created_at), COALESCE(o.updated_at, o.created_at)) AS sort_at,
               NULL::timestamptz AS message_created_at,
               COALESCE(o.updated_at, o.created_at) AS order_updated_at,
               NULL::timestamptz AS shipment_updated_at
        FROM public.conversations c
        JOIN public.customers cust ON cust.id = c.customer_id
        JOIN public.orders o ON o.customer_id = c.customer_id
        WHERE o.payment_reference ILIKE v_query
           OR o.id::TEXT ILIKE v_query

        UNION

        -- Coincidencia por numero de guia
        SELECT DISTINCT c.id AS conversation_id,
               c.customer_id,
               cust.name AS customer_name,
               cust.phone_e164,
               c.last_message_at,
               c.status AS conversation_status,
               'shipment' AS match_type,
               s.tracking_number AS match_preview,
               GREATEST(COALESCE(c.last_message_at, c.created_at), COALESCE(s.updated_at, s.created_at)) AS sort_at,
               NULL::timestamptz AS message_created_at,
               NULL::timestamptz AS order_updated_at,
               COALESCE(s.updated_at, s.created_at) AS shipment_updated_at
        FROM public.conversations c
        JOIN public.customers cust ON cust.id = c.customer_id
        JOIN public.orders o ON o.customer_id = c.customer_id
        JOIN public.shipments s ON s.order_id = o.id
        WHERE s.tracking_number ILIKE v_query
    )
    SELECT
        m.conversation_id,
        m.customer_id,
        m.customer_name,
        m.phone_e164,
        m.last_message_at,
        m.match_type,
        m.match_preview,
        m.conversation_status
    FROM matches m
    ORDER BY m.sort_at DESC NULLS LAST, m.conversation_id
    LIMIT v_limit OFFSET v_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_search_conversations(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_conversations(TEXT, INTEGER, INTEGER) TO authenticated, service_role;

-- Indices para busqueda rapida (p95 < 300 ms).
CREATE INDEX IF NOT EXISTS idx_customers_phone_e164_ilike
    ON public.customers (phone_e164 TEXT_PATTERN_OPS);
CREATE INDEX IF NOT EXISTS idx_customers_name_ilike
    ON public.customers (name TEXT_PATTERN_OPS);
CREATE INDEX IF NOT EXISTS idx_messages_body_ilike
    ON public.messages (body TEXT_PATTERN_OPS);
CREATE INDEX IF NOT EXISTS idx_orders_payment_reference_ilike
    ON public.orders (payment_reference TEXT_PATTERN_OPS);
CREATE INDEX IF NOT EXISTS idx_shipments_tracking_number_ilike
    ON public.shipments (tracking_number TEXT_PATTERN_OPS);

COMMENT ON FUNCTION public.admin_search_conversations(TEXT, INTEGER, INTEGER) IS
    'Busqueda server-side de conversaciones por telefono, nombre, mensaje, orden o guia. Paginado.';

NOTIFY pgrts, 'reload schema';
