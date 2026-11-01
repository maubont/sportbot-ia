-- SB-109: Cierre con disposición, reapertura y despedida.
--
-- Diseño:
--  * `conversation_closures` guarda el motivo de cierre, quién cerró, cuándo, y
--    los datos de reapertura (quién la reabrió y cuándo). Una conversación solo
--    puede tener una fila de cierre; reabrir la actualiza en lugar de duplicar.
--  * `admin_close_conversation` cierra una conversación abierta con motivo
--    obligatorio; rechaza si ya está cerrada.
--  * `admin_reopen_conversation` reabre una conversación cerrada, registra quién
--    la reabrió y por qué; no exige motivo (el cliente puede escribir de nuevo).
--  * RLS: los autenticados leen los cierres; service_role gestiona.
--  * La despedida al cliente es opt-in: el operador la envía manualmente como un
--    mensaje humano normal desde el Inbox, no se envía automáticamente al cerrar.

BEGIN;

CREATE TABLE IF NOT EXISTS public.conversation_closures (
    conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
    closed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_by UUID REFERENCES public.admin_users(user_id) ON DELETE SET NULL,
    close_reason TEXT NOT NULL CHECK (length(trim(close_reason)) > 0),
    reopened_at TIMESTAMPTZ,
    reopened_by UUID REFERENCES public.admin_users(user_id) ON DELETE SET NULL,
    reopen_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.conversation_closures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.conversation_closures FROM PUBLIC, anon;
GRANT SELECT ON public.conversation_closures TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.conversation_closures TO service_role;

-- Cualquier autenticado (admin) puede leer los cierres.
DROP POLICY IF EXISTS "Admins read conversation closures" ON public.conversation_closures;
CREATE POLICY "Admins read conversation closures"
    ON public.conversation_closures FOR SELECT
    TO authenticated
    USING (public.is_admin());

-- service_role gestiona las filas (llamado desde los RPCs SECURITY DEFINER).
DROP POLICY IF EXISTS "Service role manages conversation closures" ON public.conversation_closures;
CREATE POLICY "Service role manages conversation closures"
    ON public.conversation_closures FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_conversation_closures_closed_at
    ON public.conversation_closures (closed_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_closures_closed_by
    ON public.conversation_closures (closed_by, closed_at DESC);

-- Cierra una conversación abierta con motivo obligatorio.
CREATE OR REPLACE FUNCTION public.admin_close_conversation(
    p_conversation_id UUID,
    p_actor_user_id UUID,
    p_close_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_status TEXT;
    v_existing UUID;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    IF length(trim(COALESCE(p_close_reason, ''))) = 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'close_reason_required');
    END IF;

    -- Una conversación ya cerrada tiene fila en conversation_closures.
    SELECT conversation_id INTO v_existing FROM public.conversation_closures
    WHERE conversation_id = p_conversation_id;
    IF v_existing IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_already_closed');
    END IF;

    PERFORM 1 FROM public.conversations
    WHERE id = p_conversation_id AND status = 'open'
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_open');
    END IF;

    UPDATE public.conversations
       SET status = 'closed', updated_at = NOW()
     WHERE id = p_conversation_id;

    INSERT INTO public.conversation_closures (
        conversation_id, closed_at, closed_by, close_reason, updated_at
    ) VALUES (
        p_conversation_id, NOW(), p_actor_user_id, trim(p_close_reason), NOW()
    );

    INSERT INTO public.conversation_operator_events (
        conversation_id, actor_user_id, event_type, details
    ) VALUES (
        p_conversation_id, p_actor_user_id, 'closed',
        jsonb_build_object('reason', trim(p_close_reason))
    );

    RETURN jsonb_build_object(
        'success', true,
        'conversation_id', p_conversation_id,
        'status', 'closed',
        'closed_at', NOW(),
        'close_reason', trim(p_close_reason)
    );
END;
$$;

-- Reabre una conversación cerrada (motivo opcional, auditoría de quién y cuándo).
CREATE OR REPLACE FUNCTION public.admin_reopen_conversation(
    p_conversation_id UUID,
    p_actor_user_id UUID,
    p_reopen_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_status TEXT;
    v_closed_at TIMESTAMPTZ;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_actor_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    PERFORM 1 FROM public.conversations
    WHERE id = p_conversation_id AND status = 'closed'
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'conversation_not_closed');
    END IF;

    UPDATE public.conversations
       SET status = 'open', updated_at = NOW()
     WHERE id = p_conversation_id;

    UPDATE public.conversation_closures
       SET reopened_at = NOW(),
           reopened_by = p_actor_user_id,
           reopen_reason = trim(COALESCE(p_reopen_reason, '')),
           updated_at = NOW()
     WHERE conversation_id = p_conversation_id;

    INSERT INTO public.conversation_operator_events (
        conversation_id, actor_user_id, event_type, details
    ) VALUES (
        p_conversation_id, p_actor_user_id, 'reopened',
        jsonb_build_object('reason', trim(COALESCE(p_reopen_reason, '')))
    );

    RETURN jsonb_build_object(
        'success', true,
        'conversation_id', p_conversation_id,
        'status', 'open',
        'reopened_at', NOW(),
        'reopen_reason', trim(COALESCE(p_reopen_reason, ''))
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_close_conversation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_reopen_conversation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_close_conversation(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reopen_conversation(UUID, UUID, TEXT) TO authenticated, service_role;

COMMENT ON TABLE public.conversation_closures IS
    'Cierre y reapertura de conversaciones con motivo, actor y auditoría. Una fila por conversación.';
COMMENT ON COLUMN public.conversation_closures.close_reason IS
    'Motivo obligatorio del cierre (disposición).';
COMMENT ON COLUMN public.conversation_closures.reopen_reason IS
    'Motivo opcional de la reapertura (por qué el caso vuelve a abrirse).';

COMMENT ON FUNCTION public.admin_close_conversation(UUID, UUID, TEXT) IS
    'Cierra una conversación abierta con motivo obligatorio y registra el cierre.';
COMMENT ON FUNCTION public.admin_reopen_conversation(UUID, UUID, TEXT) IS
    'Reabre una conversación cerrada, registrando quién la reabre y por qué.';

NOTIFY pgrst, 'reload schema';
