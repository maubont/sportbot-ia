-- Outbound messages must go through the audited operator Edge Function.
-- Browser admins can still read the timeline but cannot fabricate a sent bubble.

BEGIN;

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage messages" ON public.messages;
DROP POLICY IF EXISTS "Admins read messages" ON public.messages;
CREATE POLICY "Admins read messages"
    ON public.messages FOR SELECT TO authenticated
    USING (public.is_admin());

REVOKE INSERT, UPDATE, DELETE ON public.messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.messages TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.messages TO service_role;

COMMENT ON TABLE public.messages IS
    'Conversation timeline. Browser admins are read-only; outbound messages are written by audited service-role actions.';

COMMIT;
