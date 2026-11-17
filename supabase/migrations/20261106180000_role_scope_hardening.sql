-- Role-aware access model:
--   owner/admin: privileged business, financial, configuration and AI-ops access.
--   operator: Inbox workflow, own preferences/quick answers, and operational reads.
--   unaffiliated authenticated users: no staff access.
BEGIN;

-- Return the caller's actual role. A non-member must never default to admin.
CREATE OR REPLACE FUNCTION public.current_admin_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
    SELECT au.role
    FROM public.admin_users au
    WHERE au.user_id = auth.uid()
$$;

CREATE OR REPLACE FUNCTION public.is_owner()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
    SELECT COALESCE(public.current_admin_role() = 'owner', FALSE)
$$;

-- Admin means owner or admin; operator is intentionally not an admin.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
    SELECT COALESCE(public.current_admin_role() IN ('owner', 'admin'), FALSE)
$$;

CREATE OR REPLACE FUNCTION public.is_operator()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
    SELECT COALESCE(public.current_admin_role() = 'operator', FALSE)
$$;

CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
    SELECT COALESCE(public.current_admin_role() IN ('owner', 'admin', 'operator'), FALSE)
$$;

REVOKE ALL ON FUNCTION public.current_admin_role() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_owner() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_operator() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_admin_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_owner() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_operator() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_staff() TO authenticated, service_role;

COMMENT ON FUNCTION public.current_admin_role() IS
    'Returns only the authenticated caller role; returns NULL for non-members (never defaults to admin).';
COMMENT ON FUNCTION public.is_owner() IS 'True only for the owner role.';
COMMENT ON FUNCTION public.is_admin() IS 'True for owner/admin; false for operator and unaffiliated users.';
COMMENT ON FUNCTION public.is_operator() IS 'True only for operator role.';
COMMENT ON FUNCTION public.is_staff() IS 'True for owner, admin, or operator; use only for operational workflows.';

-- RPC actor checks remain actor=auth.uid(), but permit authorized staff for
-- Inbox operations. Privileged Agent Actions still call their original admin-only
-- implementations, whose public.is_admin() check now excludes operators.
CREATE OR REPLACE FUNCTION public._assert_rpc_actor(p_actor_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public, auth, pg_temp
AS $$
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN;
    END IF;

    IF auth.uid() IS NULL OR p_actor_user_id IS NULL
       OR p_actor_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'RPC actor must match the authenticated user'
            USING ERRCODE = '42501';
    END IF;

    IF NOT COALESCE(public.is_staff(), FALSE) THEN
        RAISE EXCEPTION 'RPC requires an authorized staff user'
            USING ERRCODE = '42501';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public._assert_rpc_actor(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- The shared actor guard now admits operators for Inbox RPCs, so preserve an
-- explicit owner/admin check on privileged agent-action review and execution.
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
    IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Agent Action review requires owner/admin'
            USING ERRCODE = '42501';
    END IF;
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
    IF auth.role() <> 'service_role' AND NOT public.is_admin() THEN
        RAISE EXCEPTION 'Agent Action execution recording requires owner/admin'
            USING ERRCODE = '42501';
    END IF;
    RETURN public.record_agent_action_execution_unchecked(
        p_action_id, p_status, p_execution_result, p_error_message
    );
END;
$$;
REVOKE ALL ON FUNCTION public.review_agent_action(UUID, TEXT, TEXT) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.review_agent_action(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT) TO authenticated;

-- Inbox and operational data are available to staff. Privileged mutations remain
-- owner/admin-only; operators receive SELECT or explicitly scoped own-row access.
DO $drop_previous_staff_policies$
DECLARE
    v_policy RECORD;
BEGIN
    FOR v_policy IN
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY (ARRAY[
              'admin_users', 'customers', 'conversations', 'messages', 'media_files',
              'conversation_closures', 'conversation_context_resolutions', 'conversation_events',
              'conversation_operator_assignments', 'conversation_operator_events', 'conversation_reads',
              'conversation_state', 'customer_profiles', 'inbox_activity_feed',
              'inbox_notification_preferences', 'storefront_handoffs', 'orders', 'order_items',
              'shipments', 'shipment_events', 'logistics_notifications', 'quick_answers'
          ])
          AND policyname LIKE 'Staff %'
    LOOP
        EXECUTE format('DROP POLICY %I ON %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
    END LOOP;
END;
$drop_previous_staff_policies$;

DROP POLICY IF EXISTS "Admins read admin users" ON public.admin_users;
CREATE POLICY "Staff read admin users" ON public.admin_users
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins manage customers" ON public.customers;
CREATE POLICY "Staff read customers" ON public.customers
    FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY "Admins manage customers" ON public.customers
    FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage conversations" ON public.conversations;
CREATE POLICY "Staff read conversations" ON public.conversations
    FOR SELECT TO authenticated USING (public.is_staff());
CREATE POLICY "Admins manage conversations" ON public.conversations
    FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins read messages" ON public.messages;
CREATE POLICY "Staff read messages" ON public.messages
    FOR SELECT TO authenticated USING (public.is_staff());

-- Staff may view attachments required for Inbox support; only owner/admin may
-- mutate file metadata directly. Actual Storage writes remain admin-only.
DROP POLICY IF EXISTS "Staff read media files" ON public.media_files;
CREATE POLICY "Staff read media files" ON public.media_files
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins read conversation closures" ON public.conversation_closures;
CREATE POLICY "Staff read conversation closures" ON public.conversation_closures
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins create conversation context resolutions" ON public.conversation_context_resolutions;
CREATE POLICY "Staff create own conversation context resolutions" ON public.conversation_context_resolutions
    FOR INSERT TO authenticated
    WITH CHECK (public.is_staff() AND (resolved_by_user_id IS NULL OR resolved_by_user_id = auth.uid()));
DROP POLICY IF EXISTS "Admins read conversation context resolutions" ON public.conversation_context_resolutions;
CREATE POLICY "Staff read conversation context resolutions" ON public.conversation_context_resolutions
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Admins update conversation context resolutions" ON public.conversation_context_resolutions;
CREATE POLICY "Staff update own conversation context resolutions" ON public.conversation_context_resolutions
    FOR UPDATE TO authenticated
    USING (public.is_staff() AND resolved_by_user_id = auth.uid())
    WITH CHECK (public.is_staff() AND resolved_by_user_id = auth.uid());

DROP POLICY IF EXISTS "Admins read conversation events" ON public.conversation_events;
CREATE POLICY "Staff read conversation events" ON public.conversation_events
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins read conversation operator assignments" ON public.conversation_operator_assignments;
CREATE POLICY "Staff read conversation operator assignments" ON public.conversation_operator_assignments
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Admins read conversation operator events" ON public.conversation_operator_events;
CREATE POLICY "Staff read conversation operator events" ON public.conversation_operator_events
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins read own conversation reads" ON public.conversation_reads;
CREATE POLICY "Staff read own conversation reads" ON public.conversation_reads
    FOR SELECT TO authenticated USING (public.is_staff() AND user_id = auth.uid());
DROP POLICY IF EXISTS "Admins manage own conversation reads" ON public.conversation_reads;
CREATE POLICY "Staff manage own conversation reads" ON public.conversation_reads
    FOR ALL TO authenticated
    USING (public.is_staff() AND user_id = auth.uid())
    WITH CHECK (public.is_staff() AND user_id = auth.uid());

DROP POLICY IF EXISTS "Admins read conversation state" ON public.conversation_state;
CREATE POLICY "Staff read conversation state" ON public.conversation_state
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins create customer profiles" ON public.customer_profiles;
CREATE POLICY "Staff create customer profiles" ON public.customer_profiles
    FOR INSERT TO authenticated WITH CHECK (public.is_staff());
DROP POLICY IF EXISTS "Admins read customer profiles" ON public.customer_profiles;
CREATE POLICY "Staff read customer profiles" ON public.customer_profiles
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Admins update customer profiles" ON public.customer_profiles;
CREATE POLICY "Staff update customer profiles" ON public.customer_profiles
    FOR UPDATE TO authenticated USING (public.is_staff()) WITH CHECK (public.is_staff());

DROP POLICY IF EXISTS "Admins read activity feed" ON public.inbox_activity_feed;
CREATE POLICY "Staff read activity feed" ON public.inbox_activity_feed
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins read own notification preferences" ON public.inbox_notification_preferences;
CREATE POLICY "Staff read own notification preferences" ON public.inbox_notification_preferences
    FOR SELECT TO authenticated USING (public.is_staff() AND user_id = auth.uid());
DROP POLICY IF EXISTS "Admins manage own notification preferences" ON public.inbox_notification_preferences;
CREATE POLICY "Staff manage own notification preferences" ON public.inbox_notification_preferences
    FOR ALL TO authenticated
    USING (public.is_staff() AND user_id = auth.uid())
    WITH CHECK (public.is_staff() AND user_id = auth.uid());

DROP POLICY IF EXISTS "Admins read storefront handoffs" ON public.storefront_handoffs;
CREATE POLICY "Staff read storefront handoffs" ON public.storefront_handoffs
    FOR SELECT TO authenticated USING (public.is_staff());

DROP POLICY IF EXISTS "Admins read orders" ON public.orders;
CREATE POLICY "Staff read orders" ON public.orders
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Admins read order items" ON public.order_items;
CREATE POLICY "Staff read order items" ON public.order_items
    FOR SELECT TO authenticated USING (public.is_staff());

-- Logistics data is operational but remains read-only for operators.
DROP POLICY IF EXISTS "Staff read shipments" ON public.shipments;
CREATE POLICY "Staff read shipments" ON public.shipments
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Staff read shipment events" ON public.shipment_events;
CREATE POLICY "Staff read shipment events" ON public.shipment_events
    FOR SELECT TO authenticated USING (public.is_staff());
DROP POLICY IF EXISTS "Admins read logistics notifications" ON public.logistics_notifications;
CREATE POLICY "Staff read logistics notifications" ON public.logistics_notifications
    FOR SELECT TO authenticated USING (public.is_staff());

-- Quick answers: staff read their own and global templates; direct DML is
-- restricted to personal, non-global templates. Global edits use guarded RPCs.
DROP POLICY IF EXISTS "Admins read own and global quick answers" ON public.quick_answers;
CREATE POLICY "Staff read own and global quick answers" ON public.quick_answers
    FOR SELECT TO authenticated
    USING (public.is_staff() AND (user_id = auth.uid() OR is_global = TRUE));
DROP POLICY IF EXISTS "Admins manage own quick answers" ON public.quick_answers;
CREATE POLICY "Staff manage own personal quick answers" ON public.quick_answers
    FOR ALL TO authenticated
    USING (public.is_staff() AND user_id = auth.uid() AND is_global = FALSE)
    WITH CHECK (public.is_staff() AND user_id = auth.uid() AND is_global = FALSE);

CREATE OR REPLACE FUNCTION public.admin_list_quick_answers(p_user_id UUID)
RETURNS TABLE (id UUID, shortcut TEXT, body TEXT, is_global BOOLEAN, created_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_user_id IS DISTINCT FROM auth.uid() THEN
        RAISE EXCEPTION 'admin_list_quick_answers only accepts the caller own user id'
            USING ERRCODE = '42501';
    END IF;
    IF NOT public.is_staff() THEN
        RAISE EXCEPTION 'admin_list_quick_answers requires an authorized staff user'
            USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT qa.id, qa.shortcut, qa.body, qa.is_global, qa.created_at
    FROM public.quick_answers qa
    WHERE qa.user_id = p_user_id OR qa.is_global = TRUE
    ORDER BY qa.is_global DESC, qa.updated_at DESC;
END;
$$;

-- Keep operator-owned templates distinct from global templates; global rows use
-- user_id NULL, matching the table contract and the global uniqueness index.
CREATE OR REPLACE FUNCTION public.admin_create_quick_answer_unchecked(
    p_user_id UUID, p_shortcut TEXT, p_body TEXT, p_is_global BOOLEAN DEFAULT FALSE
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
    IF p_is_global AND v_role NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'code', 'global_quick_answer_admin_only');
    END IF;

    INSERT INTO public.quick_answers (user_id, shortcut, body, is_global, updated_at)
    VALUES (CASE WHEN p_is_global THEN NULL ELSE p_user_id END, trim(p_shortcut), trim(p_body), p_is_global, NOW())
    RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'id', v_id, 'shortcut', trim(p_shortcut),
        'body', trim(p_body), 'is_global', p_is_global);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'quick_answer_duplicate_shortcut');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_update_quick_answer_unchecked(
    p_quick_answer_id UUID, p_user_id UUID, p_shortcut TEXT, p_body TEXT, p_is_global BOOLEAN
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
    SELECT qa.user_id, qa.is_global INTO v_owner, v_is_global
    FROM public.quick_answers qa WHERE qa.id = p_quick_answer_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'quick_answer_not_found');
    END IF;
    IF v_is_global THEN
        IF v_role NOT IN ('owner', 'admin') THEN
            RETURN jsonb_build_object('success', false, 'code', 'global_quick_answer_admin_only');
        END IF;
    ELSIF v_owner IS DISTINCT FROM p_user_id THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_quick_answer_owner');
    END IF;
    IF p_is_global AND v_role NOT IN ('owner', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'code', 'global_quick_answer_admin_only');
    END IF;
    IF length(trim(COALESCE(p_shortcut, ''))) = 0 OR length(trim(COALESCE(p_body, ''))) = 0 THEN
        RETURN jsonb_build_object('success', false, 'code', 'invalid_quick_answer');
    END IF;

    UPDATE public.quick_answers
       SET user_id = CASE WHEN p_is_global THEN NULL ELSE p_user_id END,
           shortcut = trim(p_shortcut), body = trim(p_body),
           is_global = p_is_global, updated_at = NOW()
     WHERE id = p_quick_answer_id;
    RETURN jsonb_build_object('success', true, 'id', p_quick_answer_id);
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'code', 'quick_answer_duplicate_shortcut');
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_quick_answer_unchecked(
    p_quick_answer_id UUID, p_user_id UUID
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
    SELECT qa.user_id, qa.is_global INTO v_owner, v_is_global
    FROM public.quick_answers qa WHERE qa.id = p_quick_answer_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'code', 'quick_answer_not_found');
    END IF;
    IF v_is_global THEN
        IF v_role NOT IN ('owner', 'admin') THEN
            RETURN jsonb_build_object('success', false, 'code', 'global_quick_answer_admin_only');
        END IF;
    ELSIF v_owner IS DISTINCT FROM p_user_id THEN
        RETURN jsonb_build_object('success', false, 'code', 'not_quick_answer_owner');
    END IF;
    DELETE FROM public.quick_answers WHERE id = p_quick_answer_id;
    RETURN jsonb_build_object('success', true, 'id', p_quick_answer_id);
END;
$$;

-- Functions whose output is explicitly operational may be used by staff.
-- All other admin/financial RPCs retain their is_admin() guard.
DO $role_scope_functions$
DECLARE
    v_proc OID;
    v_definition TEXT;
    v_targets TEXT[] := ARRAY[
        'public.admin_conversation_unread_counts(uuid)',
        'public.admin_search_conversations(text,integer,integer)',
        'public.admin_logistics_operations_snapshot(timestamp with time zone,timestamp with time zone,text,integer,integer)'
    ];
    v_target TEXT;
BEGIN
    FOREACH v_target IN ARRAY v_targets LOOP
        v_proc := to_regprocedure(v_target)::oid;
        IF v_proc IS NULL THEN
            RAISE EXCEPTION 'Expected role-scoped RPC missing: %', v_target;
        END IF;
        v_definition := pg_get_functiondef(v_proc);
        IF position('public.is_admin()' IN v_definition) > 0 THEN
            v_definition := replace(v_definition, 'public.is_admin()', 'public.is_staff()');
            v_definition := replace(v_definition, 'requires an admin user', 'requires an authorized staff user');
            EXECUTE v_definition;
        ELSIF position('public.is_staff()' IN v_definition) = 0 THEN
            RAISE EXCEPTION 'Role-scoped RPC has no recognized authorization guard: %', v_target;
        END IF;
    END LOOP;
END;
$role_scope_functions$;

COMMENT ON FUNCTION public._assert_rpc_actor(UUID) IS
    'Internal guard: client actor must equal auth.uid(); service_role is the only delegated-actor exception; authenticated owner/admin/operator may use approved Inbox RPCs.';

NOTIFY pgrst, 'reload schema';
COMMIT;
