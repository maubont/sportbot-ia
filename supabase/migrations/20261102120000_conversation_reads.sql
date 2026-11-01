-- SB-106: No leídos reales por operador (conversation_reads, unread_count).
-- SB-107: Toma desde la lista, "Mis chats", reasignación.
--
-- Diseño:
--  * conversation_reads guarda, por (conversación, operador), cuándo se leyó por
--    última vez y hasta qué mensaje. Abrir una conversación la marca leída solo
--    para ese operador: "abrir baja a 0 solo para mí; otro operador conserva su
--    contador".
--  * admin_mark_conversation_read registra la lectura (upsert por PK composite).
--  * admin_conversation_unread_counts devuelve, para un operador, el conteo de
--    mensajes inbound no leídos por conversación abierta. Los mensajes outbound
--    del propio operador no cuentan.
--  * RLS: un autenticado solo lee/escribe sus propias filas (user_id = auth.uid()).
--    Los RPCs los ejecuta el navegador con rol authenticated y validan admin.

BEGIN;

CREATE TABLE IF NOT EXISTS public.conversation_reads (
    conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.admin_users(user_id) ON DELETE CASCADE,
    read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_id UUID REFERENCES public.messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (conversation_id, user_id)
);

ALTER TABLE public.conversation_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_reads FROM PUBLIC, anon;
GRANT SELECT ON public.conversation_reads TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversation_reads TO service_role;

DROP POLICY IF EXISTS "Admins read own conversation reads" ON public.conversation_reads;
CREATE POLICY "Admins read own conversation reads"
    ON public.conversation_reads FOR SELECT
    TO authenticated
    USING (public.is_admin() AND user_id = auth.uid());

DROP POLICY IF EXISTS "Admins manage own conversation reads" ON public.conversation_reads;
CREATE POLICY "Admins manage own conversation reads"
    ON public.conversation_reads FOR ALL
    TO authenticated
    USING (public.is_admin() AND user_id = auth.uid())
    WITH CHECK (public.is_admin() AND user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_conversation_reads_user_conversation
    ON public.conversation_reads (user_id, conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversation_reads_user_read_at
    ON public.conversation_reads (user_id, read_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_inbound_conversation_created
    ON public.messages (conversation_id, created_at)
    WHERE direction = 'inbound' AND role = 'user';

-- Marca una conversación como leída para el operador que la abre.
CREATE OR REPLACE FUNCTION public.admin_mark_conversation_read(
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
    v_last_message_id UUID;
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

    SELECT id INTO v_last_message_id
    FROM public.messages
    WHERE conversation_id = p_conversation_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1;

    INSERT INTO public.conversation_reads (conversation_id, user_id, read_at, last_message_id, updated_at)
    VALUES (p_conversation_id, p_actor_user_id, NOW(), v_last_message_id, NOW())
    ON CONFLICT (conversation_id, user_id) DO UPDATE
        SET read_at = EXCLUDED.read_at,
            last_message_id = COALESCE(EXCLUDED.last_message_id, conversation_reads.last_message_id),
            updated_at = NOW();

    RETURN jsonb_build_object(
        'success', true,
        'conversation_id', p_conversation_id,
        'read_at', NOW(),
        'last_message_id', v_last_message_id
    );
END;
$$;

-- Conteo de no leídos por conversación abierta para un operador.
CREATE OR REPLACE FUNCTION public.admin_conversation_unread_counts(
    p_user_id UUID
)
RETURNS TABLE (conversation_id UUID, unread_count INTEGER)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'admin_conversation_unread_counts only accepts the caller own user id'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_conversation_unread_counts requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT c.id AS conversation_id,
           COALESCE((
               SELECT COUNT(*)::INTEGER
               FROM public.messages m
               WHERE m.conversation_id = c.id
                 AND m.direction = 'inbound'
                 AND m.role = 'user'
                 AND (m.created_at > COALESCE(r.read_at, '-infinity'::timestamptz))
           ), 0) AS unread_count
    FROM public.conversations c
    LEFT JOIN public.conversation_reads r
        ON r.conversation_id = c.id AND r.user_id = p_user_id
    WHERE c.status = 'open'
      AND EXISTS (
          SELECT 1
          FROM public.messages m2
          WHERE m2.conversation_id = c.id
            AND m2.direction = 'inbound'
            AND m2.role = 'user'
      );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_mark_conversation_read(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_conversation_unread_counts(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_mark_conversation_read(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_conversation_unread_counts(UUID) TO authenticated, service_role;

COMMENT ON TABLE public.conversation_reads IS
    'Lectura de conversación por operador. Marca hasta qué punto cada operador ha leído una conversación; unread_count se deriva de mensajes inbound posteriores a read_at.';
COMMENT ON COLUMN public.conversation_reads.read_at IS
    'Momento en que el operador leyó por última vez la conversación. Abrir baja a 0 solo para ese operador.';
COMMENT ON COLUMN public.conversation_reads.last_message_id IS
    'Último mensaje de la conversación en el momento de la lectura. Sirve de referencia de hasta dónde se leyó.';

COMMENT ON FUNCTION public.admin_mark_conversation_read(UUID, UUID) IS
    'Marca una conversación abierta como leída para el operador (upsert por conversación + operador).';
COMMENT ON FUNCTION public.admin_conversation_unread_counts(UUID) IS
    'Devuelve conversation_id y unread_count de conversaciones abiertas con mensajes inbound, para el operador autenticado.';

NOTIFY pgrst, 'reload schema';
