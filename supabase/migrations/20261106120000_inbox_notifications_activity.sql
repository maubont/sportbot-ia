-- SB-111: Notificaciones y centro de actividad del Inbox.
--
-- Diseño (evaluado con dos roles críticos):
--  1. Operador de atención: necesita saber cuándo llega un mensaje nuevo sin
--     leer para dar la primera respuesta. Requiere notificación sonora < 2s,
--     que no suene si ya está en ese hilo, y silencio configurable.
--  2. Owner/Admin: necesita ver cuántas conversaciones esperan primera
--     respuesta y cuánto tarda el equipo. Requiere centro de actividad y
--     métrica de tiempo de primera respuesta.
--
-- Tablas:
--  * inbox_notification_preferences: preferencias de sonido/silencio por usuario.
--  * inbox_activity_feed: centro de actividad (nuevos mensajes, cierres,
--    reaperturas, tomas de conversación) con timestamp para render en el Inbox.

BEGIN;

CREATE TABLE IF NOT EXISTS public.inbox_notification_preferences (
    user_id UUID PRIMARY KEY REFERENCES public.admin_users(user_id) ON DELETE CASCADE,
    sound_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sound_volume REAL NOT NULL DEFAULT 0.7 CHECK (sound_volume >= 0 AND sound_volume <= 1),
    notify_new_message BOOLEAN NOT NULL DEFAULT TRUE,
    notify_when_in_thread BOOLEAN NOT NULL DEFAULT FALSE,
    silent_mode BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.inbox_notification_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.inbox_notification_preferences FROM PUBLIC, anon;
GRANT SELECT ON public.inbox_notification_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.inbox_notification_preferences TO service_role;

DROP POLICY IF EXISTS "Admins read own notification preferences" ON public.inbox_notification_preferences;
CREATE POLICY "Admins read own notification preferences"
    ON public.inbox_notification_preferences FOR SELECT
    TO authenticated
    USING (public.is_admin() AND user_id = auth.uid());

DROP POLICY IF EXISTS "Admins manage own notification preferences" ON public.inbox_notification_preferences;
CREATE POLICY "Admins manage own notification preferences"
    ON public.inbox_notification_preferences FOR ALL
    TO authenticated
    USING (public.is_admin() AND user_id = auth.uid())
    WITH CHECK (public.is_admin() AND user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_inbox_notification_preferences_user
    ON public.inbox_notification_preferences (user_id);

-- Centro de actividad del Inbox: registro de eventos relevantes para
-- render en una lista "¿qué ha pasado?" junto al listado de conversaciones.
CREATE TABLE IF NOT EXISTS public.inbox_activity_feed (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES public.admin_users(user_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'new_message', 'message_read', 'claim', 'release', 'close', 'reopen',
        'payment_approved', 'dispatch_created', 'handoff_required'
    )),
    match_type TEXT,
    match_preview TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.inbox_activity_feed ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.inbox_activity_feed FROM PUBLIC, anon;
GRANT SELECT ON public.inbox_activity_feed TO authenticated;
GRANT SELECT, INSERT ON public.inbox_activity_feed TO service_role;

DROP POLICY IF EXISTS "Admins read activity feed" ON public.inbox_activity_feed;
CREATE POLICY "Admins read activity feed"
    ON public.inbox_activity_feed FOR SELECT
    TO authenticated
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_inbox_activity_feed_created
    ON public.inbox_activity_feed (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbox_activity_feed_conversation
    ON public.inbox_activity_feed (conversation_id, created_at DESC);

-- Función para insertar un evento en el centro de actividad.
CREATE OR REPLACE FUNCTION public.admin_inbox_activity_log(
    p_conversation_id UUID,
    p_actor_user_id UUID,
    p_event_type TEXT,
    p_match_type TEXT DEFAULT NULL,
    p_match_preview TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_id UUID;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    INSERT INTO public.inbox_activity_feed (
        conversation_id, actor_user_id, event_type, match_type, match_preview
    ) VALUES (
        p_conversation_id, p_actor_user_id, p_event_type, p_match_type, p_match_preview
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'id', v_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_inbox_activity_log(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_inbox_activity_log(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- Vista de conteo de primeras respuestas pendientes para el dashboard.
CREATE OR REPLACE VIEW public.inbox_first_response_pending AS
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
  AND NOT EXISTS (
      SELECT 1 FROM public.messages r
      WHERE r.conversation_id = c.id
        AND m.created_at < r.created_at
        AND r.direction = 'outbound' AND r.role = 'agent'
  )
GROUP BY c.id, c.customer_id, cust.name, cust.phone_e164, c.last_message_at;

COMMENT ON TABLE public.inbox_notification_preferences IS
    'Preferencias de notificación del Inbox por operador: sonido, volumen, silencio.';
COMMENT ON TABLE public.inbox_activity_feed IS
    'Centro de actividad del Inbox: eventos recientes (mensajes, cierres, tomas).';
COMMENT ON VIEW public.inbox_first_response_pending IS
    'Conversaciones abiertas esperando primera respuesta del operador, con segundos pendientes.';

COMMENT ON FUNCTION public.admin_inbox_activity_log(UUID, UUID, TEXT, TEXT, TEXT) IS
    'Registra un evento en el centro de actividad del Inbox.';

NOTIFY pgrst, 'reload schema';
