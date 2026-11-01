-- Remove the legacy PUBLIC write policy on product media and enforce
-- invoker privileges plus an explicit admin predicate for the Inbox view.
BEGIN;

DROP POLICY IF EXISTS "Admin Manage Product Media" ON storage.objects;

CREATE OR REPLACE VIEW public.inbox_first_response_pending
WITH (security_invoker = true)
AS
SELECT
    c.id AS conversation_id,
    c.customer_id,
    cust.name AS customer_name,
    cust.phone_e164,
    c.last_message_at,
    MIN(m.created_at) AS first_inbound_at,
    EXTRACT(EPOCH FROM (NOW() - MIN(m.created_at)))::INTEGER AS seconds_pending
FROM public.conversations c
JOIN public.customers cust ON cust.id = c.customer_id
JOIN public.messages m ON m.conversation_id = c.id
    AND m.direction = 'inbound' AND m.role = 'user'
WHERE c.status = 'open'
  AND public.is_admin()
  AND NOT EXISTS (
      SELECT 1 FROM public.messages r
      WHERE r.conversation_id = c.id
        AND m.created_at < r.created_at
        AND r.direction = 'outbound' AND r.role = 'agent'
  )
GROUP BY c.id, c.customer_id, cust.name, cust.phone_e164, c.last_message_at;

REVOKE ALL ON TABLE public.inbox_first_response_pending FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.inbox_first_response_pending TO authenticated, service_role;

COMMENT ON VIEW public.inbox_first_response_pending IS
    'Conversaciones abiertas esperando primera respuesta. security_invoker y is_admin restringen filas a administradores autorizados.';

NOTIFY pgrst, 'reload schema';
COMMIT;
