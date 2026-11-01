-- SB-108: Respuestas rápidas con `/` y variables.
--
-- Plantillas de respuesta para operadores. Cada operador tiene las suyas y ve
-- las globales. Las plantillas globales solo las crea el owner/admin.
--
-- Diseño:
--  * user_id NULL = plantilla global (visible para todos los operadores).
--  * user_id distinto de NULL = plantilla propia del operador.
--  * shortcut es el texto que dispara la plantilla (ej. "/hola", "/precio").
--  * RLS: un autenticado lee las suyas y las globales; escribe solo las suyas.
--    Las globales solo las gestiona el owner/admin.

BEGIN;

CREATE TABLE IF NOT EXISTS public.quick_answers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.admin_users(user_id) ON DELETE CASCADE,
    shortcut TEXT NOT NULL CHECK (length(trim(shortcut)) > 0),
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    is_global BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.quick_answers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.quick_answers FROM PUBLIC, anon;
GRANT SELECT ON public.quick_answers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.quick_answers TO service_role;

-- Un autenticado lee sus propias plantillas y las globales.
DROP POLICY IF EXISTS "Admins read own and global quick answers" ON public.quick_answers;
CREATE POLICY "Admins read own and global quick answers"
    ON public.quick_answers FOR SELECT
    TO authenticated
    USING (public.is_admin() AND (user_id = auth.uid() OR is_global = TRUE));

-- Un autenticado gestiona solo sus propias plantillas (no globales a menos que sea owner/admin).
DROP POLICY IF EXISTS "Admins manage own quick answers" ON public.quick_answers;
CREATE POLICY "Admins manage own quick answers"
    ON public.quick_answers FOR ALL
    TO authenticated
    USING (public.is_admin() AND user_id = auth.uid())
    WITH CHECK (public.is_admin() AND user_id = auth.uid());

-- Atajos únicos por operador y únicos entre las globales.
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_answers_user_shortcut
    ON public.quick_answers (user_id, shortcut) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_answers_global_shortcut
    ON public.quick_answers (shortcut) WHERE user_id IS NULL AND is_global = TRUE;

CREATE INDEX IF NOT EXISTS idx_quick_answers_user_updated
    ON public.quick_answers (user_id, updated_at DESC);

-- Listar plantillas disponibles para un operador (suyas + globales).
CREATE OR REPLACE FUNCTION public.admin_list_quick_answers(
    p_user_id UUID
)
RETURNS TABLE (
    id UUID,
    shortcut TEXT,
    body TEXT,
    is_global BOOLEAN,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'admin_list_quick_answers only accepts the caller own user id'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'admin_list_quick_answers requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT qa.id, qa.shortcut, qa.body, qa.is_global, qa.created_at
    FROM public.quick_answers qa
    WHERE qa.user_id = p_user_id OR qa.is_global = TRUE
    ORDER BY qa.is_global DESC, qa.updated_at DESC;
END;
$$;

-- Crear una plantilla. Las globales solo pueden crearlas owner/admin (ver RLS).
CREATE OR REPLACE FUNCTION public.admin_create_quick_answer(
    p_user_id UUID,
    p_shortcut TEXT,
    p_body TEXT,
    p_is_global BOOLEAN DEFAULT FALSE
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
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    IF length(trim(COALESCE(p_shortcut, ''))) = 0 OR length(trim(COALESCE(p_body, ''))) = 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_quick_answer');
    END IF;

    -- Solo owner/admin puede crear plantillas globales.
    IF p_is_global AND v_role NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'code', 'global_quick_answer_admin_only');
    END IF;

    INSERT INTO public.quick_answers (user_id, shortcut, body, is_global, updated_at)
    VALUES (p_user_id, trim(p_shortcut), trim(p_body), p_is_global, NOW())
    RETURNING id INTO v_id;

    RETURN jsonb_build_object(
        'success', true,
        'id', v_id,
        'shortcut', trim(p_shortcut),
        'body', trim(p_body),
        'is_global', p_is_global
    );
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'quick_answer_duplicate_shortcut');
END;
$$;

-- Actualizar una plantilla propia.
CREATE OR REPLACE FUNCTION public.admin_update_quick_answer(
    p_quick_answer_id UUID,
    p_user_id UUID,
    p_shortcut TEXT,
    p_body TEXT,
    p_is_global BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_owner UUID;
    v_is_global BOOLEAN;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    SELECT user_id, is_global INTO v_owner, v_is_global
    FROM public.quick_answers
    WHERE id = p_quick_answer_id;
    IF v_owner IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'quick_answer_not_found');
    END IF;

    -- Solo el dueño de la plantilla (o owner/admin sobre globales) puede editar.
    IF v_owner <> p_user_id AND NOT (v_is_global AND v_role IN ('owner', 'admin')) THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_quick_answer_owner');
    END IF;

    IF p_is_global AND v_role NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'code', 'global_quick_answer_admin_only');
    END IF;

    UPDATE public.quick_answers
       SET shortcut = trim(p_shortcut),
           body = trim(p_body),
           is_global = p_is_global,
           updated_at = NOW()
     WHERE id = p_quick_answer_id;

    RETURN jsonb_build_object('success', true, 'id', p_quick_answer_id);
END;
$$;

-- Eliminar una plantilla propia.
CREATE OR REPLACE FUNCTION public.admin_delete_quick_answer(
    p_quick_answer_id UUID,
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role TEXT;
    v_owner UUID;
    v_is_global BOOLEAN;
BEGIN
    SELECT role INTO v_role FROM public.admin_users WHERE user_id = p_user_id;
    IF v_role IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'admin_required');
    END IF;

    SELECT user_id, is_global INTO v_owner, v_is_global
    FROM public.quick_answers
    WHERE id = p_quick_answer_id;
    IF v_owner IS NULL THEN
        RETURN jsonb_build_object('success', false, 'code', 'quick_answer_not_found');
    END IF;

    IF v_owner <> p_user_id AND NOT (v_is_global AND v_role IN ('owner', 'admin')) THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_quick_answer_owner');
    END IF;

    DELETE FROM public.quick_answers WHERE id = p_quick_answer_id;

    RETURN jsonb_build_object('success', true, 'id', p_quick_answer_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_quick_answers(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_create_quick_answer(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_update_quick_answer(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_quick_answer(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_quick_answers(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_quick_answer(UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_quick_answer(UUID, UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_quick_answer(UUID, UUID) TO authenticated, service_role;

COMMENT ON TABLE public.quick_answers IS
    'Plantillas de respuesta rápida para operadores. user_id NULL es global.';
COMMENT ON COLUMN public.quick_answers.shortcut IS
    'Atajo que dispara la plantilla (ej. "/hola", "/precio", "/estado").';
COMMENT ON COLUMN public.quick_answers.body IS
    'Cuerpo de la plantilla. Puede llevar variables {cliente}, {producto}, {talla}, {pedido}, {total}.';
COMMENT ON COLUMN public.quick_answers.is_global IS
    'TRUE si la plantilla es visible para todos los operadores.';

COMMENT ON FUNCTION public.admin_list_quick_answers(UUID) IS
    'Devuelve las plantillas propias del operador y las globales.';
COMMENT ON FUNCTION public.admin_create_quick_answer(UUID, TEXT, TEXT, BOOLEAN) IS
    'Crea una plantilla de respuesta rápida. Globales solo para owner/admin.';
COMMENT ON FUNCTION public.admin_update_quick_answer(UUID, UUID, TEXT, TEXT, BOOLEAN) IS
    'Actualiza una plantilla propia (o global si es owner/admin).';
COMMENT ON FUNCTION public.admin_delete_quick_answer(UUID, UUID) IS
    'Elimina una plantilla propia (o global si es owner/admin).';

NOTIFY pgrst, 'reload schema';
