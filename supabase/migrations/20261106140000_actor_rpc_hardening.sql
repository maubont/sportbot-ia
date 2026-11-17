-- Hardening de identidad para RPC de Inbox y Agent Actions.
-- Version posterior al security_order_hardening local; no implica despliegue.
-- Las firmas públicas se conservan para no romper el cliente actual.

BEGIN;

-- Conservar las implementaciones de negocio como funciones internas no invocables
-- por roles cliente. Los wrappers públicos validan la identidad antes de delegar.
DO $rename_unsafe_functions$
BEGIN
    IF to_regprocedure('public.admin_mark_conversation_read(uuid,uuid)') IS NOT NULL
       AND to_regprocedure('public.admin_mark_conversation_read_unchecked(uuid,uuid)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_mark_conversation_read(uuid,uuid) RENAME TO admin_mark_conversation_read_unchecked';
    END IF;
    IF to_regprocedure('public.admin_create_quick_answer(uuid,text,text,boolean)') IS NOT NULL
       AND to_regprocedure('public.admin_create_quick_answer_unchecked(uuid,text,text,boolean)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_create_quick_answer(uuid,text,text,boolean) RENAME TO admin_create_quick_answer_unchecked';
    END IF;
    IF to_regprocedure('public.admin_update_quick_answer(uuid,uuid,text,text,boolean)') IS NOT NULL
       AND to_regprocedure('public.admin_update_quick_answer_unchecked(uuid,uuid,text,text,boolean)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_update_quick_answer(uuid,uuid,text,text,boolean) RENAME TO admin_update_quick_answer_unchecked';
    END IF;
    IF to_regprocedure('public.admin_delete_quick_answer(uuid,uuid)') IS NOT NULL
       AND to_regprocedure('public.admin_delete_quick_answer_unchecked(uuid,uuid)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_delete_quick_answer(uuid,uuid) RENAME TO admin_delete_quick_answer_unchecked';
    END IF;
    IF to_regprocedure('public.admin_close_conversation(uuid,uuid,text)') IS NOT NULL
       AND to_regprocedure('public.admin_close_conversation_unchecked(uuid,uuid,text)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_close_conversation(uuid,uuid,text) RENAME TO admin_close_conversation_unchecked';
    END IF;
    IF to_regprocedure('public.admin_reopen_conversation(uuid,uuid,text)') IS NOT NULL
       AND to_regprocedure('public.admin_reopen_conversation_unchecked(uuid,uuid,text)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_reopen_conversation(uuid,uuid,text) RENAME TO admin_reopen_conversation_unchecked';
    END IF;
    IF to_regprocedure('public.admin_inbox_activity_log(uuid,uuid,text,text,text)') IS NOT NULL
       AND to_regprocedure('public.admin_inbox_activity_log_unchecked(uuid,uuid,text,text,text)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.admin_inbox_activity_log(uuid,uuid,text,text,text) RENAME TO admin_inbox_activity_log_unchecked';
    END IF;
    IF to_regprocedure('public.review_agent_action(uuid,text,text)') IS NOT NULL
       AND to_regprocedure('public.review_agent_action_unchecked(uuid,text,text)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.review_agent_action(uuid,text,text) RENAME TO review_agent_action_unchecked';
    END IF;
    IF to_regprocedure('public.record_agent_action_execution(uuid,text,jsonb,text)') IS NOT NULL
       AND to_regprocedure('public.record_agent_action_execution_unchecked(uuid,text,jsonb,text)') IS NULL THEN
        EXECUTE 'ALTER FUNCTION public.record_agent_action_execution(uuid,text,jsonb,text) RENAME TO record_agent_action_execution_unchecked';
    END IF;
END;
$rename_unsafe_functions$;

DO $assert_original_functions$
BEGIN
    IF to_regprocedure('public.admin_mark_conversation_read_unchecked(uuid,uuid)') IS NULL
       OR to_regprocedure('public.admin_create_quick_answer_unchecked(uuid,text,text,boolean)') IS NULL
       OR to_regprocedure('public.admin_update_quick_answer_unchecked(uuid,uuid,text,text,boolean)') IS NULL
       OR to_regprocedure('public.admin_delete_quick_answer_unchecked(uuid,uuid)') IS NULL
       OR to_regprocedure('public.admin_close_conversation_unchecked(uuid,uuid,text)') IS NULL
       OR to_regprocedure('public.admin_reopen_conversation_unchecked(uuid,uuid,text)') IS NULL
       OR to_regprocedure('public.admin_inbox_activity_log_unchecked(uuid,uuid,text,text,text)') IS NULL
       OR to_regprocedure('public.review_agent_action_unchecked(uuid,text,text)') IS NULL
       OR to_regprocedure('public.record_agent_action_execution_unchecked(uuid,text,jsonb,text)') IS NULL THEN
        RAISE EXCEPTION 'Actor hardening requires the expected prior RPCs; aborting without partial changes';
    END IF;
END;
$assert_original_functions$;

CREATE OR REPLACE FUNCTION public._assert_rpc_actor(p_actor_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
    -- Solo backend con service-role JWT puede actuar en nombre de otro usuario.
    IF auth.role() = 'service_role' THEN
        RETURN;
    END IF;

    IF auth.uid() IS NULL OR p_actor_user_id IS NULL
       OR p_actor_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'RPC actor must match the authenticated user'
            USING ERRCODE = '42501';
    END IF;

    IF NOT COALESCE(public.is_admin(), FALSE) THEN
        RAISE EXCEPTION 'RPC requires an authenticated admin user'
            USING ERRCODE = '42501';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._assert_rpc_actor(UUID) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.admin_mark_conversation_read(
    p_conversation_id UUID,
    p_actor_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public._assert_rpc_actor(p_actor_user_id);
    RETURN public.admin_mark_conversation_read_unchecked(p_conversation_id, p_actor_user_id);
END;
$$;

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
BEGIN
    PERFORM public._assert_rpc_actor(p_user_id);
    RETURN public.admin_create_quick_answer_unchecked(p_user_id, p_shortcut, p_body, p_is_global);
END;
$$;

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
BEGIN
    PERFORM public._assert_rpc_actor(p_user_id);
    RETURN public.admin_update_quick_answer_unchecked(
        p_quick_answer_id, p_user_id, p_shortcut, p_body, p_is_global
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_quick_answer(
    p_quick_answer_id UUID,
    p_user_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public._assert_rpc_actor(p_user_id);
    RETURN public.admin_delete_quick_answer_unchecked(p_quick_answer_id, p_user_id);
END;
$$;

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
BEGIN
    PERFORM public._assert_rpc_actor(p_actor_user_id);
    RETURN public.admin_close_conversation_unchecked(
        p_conversation_id, p_actor_user_id, p_close_reason
    );
END;
$$;

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
BEGIN
    PERFORM public._assert_rpc_actor(p_actor_user_id);
    RETURN public.admin_reopen_conversation_unchecked(
        p_conversation_id, p_actor_user_id, p_reopen_reason
    );
END;
$$;

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
BEGIN
    PERFORM public._assert_rpc_actor(p_actor_user_id);
    RETURN public.admin_inbox_activity_log_unchecked(
        p_conversation_id, p_actor_user_id, p_event_type, p_match_type, p_match_preview
    );
END;
$$;

-- Las RPC existentes hacen sus validaciones de transición y fijan actor/timestamps
-- con auth.uid(); elevar solo la ejecución, no los privilegios del llamador.
CREATE OR REPLACE FUNCTION public.review_agent_action(
    p_action_id UUID,
    p_decision TEXT,
    p_review_note TEXT DEFAULT NULL
)
RETURNS public.agent_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public._assert_rpc_actor(auth.uid());
    RETURN public.review_agent_action_unchecked(p_action_id, p_decision, p_review_note);
END;
$$;

CREATE OR REPLACE FUNCTION public.record_agent_action_execution(
    p_action_id UUID,
    p_status TEXT,
    p_execution_result JSONB DEFAULT '{}'::jsonb,
    p_error_message TEXT DEFAULT NULL
)
RETURNS public.agent_actions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public._assert_rpc_actor(auth.uid());
    RETURN public.record_agent_action_execution_unchecked(
        p_action_id, p_status, p_execution_result, p_error_message
    );
END;
$$;

-- La API no puede insertar estados preaprobados ni actualizar auditoría directa.
-- Creación, revisión y registro de ejecución pasan por RPC controladas.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.agent_actions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.agent_actions TO authenticated;
GRANT ALL ON TABLE public.agent_actions TO service_role;

-- Ocultar las implementaciones originales renombradas a todos los roles cliente.
REVOKE ALL ON FUNCTION public.admin_mark_conversation_read_unchecked(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_quick_answer_unchecked(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_update_quick_answer_unchecked(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_quick_answer_unchecked(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_close_conversation_unchecked(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_reopen_conversation_unchecked(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_inbox_activity_log_unchecked(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.review_agent_action_unchecked(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_agent_action_execution_unchecked(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.admin_mark_conversation_read(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_create_quick_answer(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_update_quick_answer(UUID, UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_quick_answer(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_close_conversation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_reopen_conversation(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_inbox_activity_log(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.review_agent_action(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.admin_mark_conversation_read(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_create_quick_answer(UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_update_quick_answer(UUID, UUID, TEXT, TEXT, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_delete_quick_answer(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_close_conversation(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_reopen_conversation(UUID, UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_inbox_activity_log(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.review_agent_action(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT) TO authenticated;

COMMENT ON FUNCTION public._assert_rpc_actor(UUID) IS
    'Internal guard: client actor must equal auth.uid(); service_role is the only delegated-actor exception.';

NOTIFY pgrst, 'reload schema';
COMMIT;
