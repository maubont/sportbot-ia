-- Migration: Agent action audit log
-- Date: 2026-05-18
-- Description:
--   Creates the audit foundation for OpenClaw/AI Ops suggest-only workflows.
--   The table records suggestions, approvals, executions, actor/channel,
--   risk, evidence and execution result before any agent can perform
--   sensitive actions.

CREATE TABLE IF NOT EXISTS public.agent_actions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    agent_name TEXT NOT NULL DEFAULT 'openclaw' CHECK (length(trim(agent_name)) > 0),
    channel TEXT NOT NULL DEFAULT 'admin' CHECK (
        channel IN (
            'admin',
            'telegram_admin',
            'whatsapp_admin',
            'hook',
            'system'
        )
    ),
    created_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    role_scope TEXT NOT NULL DEFAULT 'admin' CHECK (
        role_scope IN (
            'owner',
            'admin',
            'operator',
            'seller',
            'read_only',
            'system'
        )
    ),
    action_type TEXT NOT NULL CHECK (length(trim(action_type)) > 0),
    target_type TEXT,
    target_id TEXT,
    target_ref TEXT,
    status TEXT NOT NULL DEFAULT 'suggested' CHECK (
        status IN (
            'suggested',
            'pending_approval',
            'approved',
            'rejected',
            'executed',
            'failed',
            'cancelled'
        )
    ),
    risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (
        risk_level IN (
            'low',
            'medium',
            'high',
            'critical'
        )
    ),
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
    input_context JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_context) = 'object'),
    proposed_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(proposed_payload) = 'object'),
    approval_required BOOLEAN NOT NULL DEFAULT TRUE,
    approved_by_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    approved_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    review_note TEXT,
    executed_at TIMESTAMPTZ,
    execution_result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(execution_result) = 'object'),
    error_message TEXT,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT agent_actions_approval_consistency CHECK (
        (approved_at IS NULL AND approved_by_user_id IS NULL)
        OR (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL)
    ),
    CONSTRAINT agent_actions_rejected_without_approval CHECK (
        status <> 'rejected'
        OR (approved_at IS NULL AND approved_by_user_id IS NULL)
    ),
    CONSTRAINT agent_actions_executed_has_timestamp CHECK (
        status <> 'executed'
        OR executed_at IS NOT NULL
    ),
    CONSTRAINT agent_actions_failed_has_error_or_result CHECK (
        status <> 'failed'
        OR error_message IS NOT NULL
        OR execution_result <> '{}'::jsonb
    )
);

CREATE INDEX IF NOT EXISTS idx_agent_actions_status_created
ON public.agent_actions (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_actions_risk_created
ON public.agent_actions (risk_level, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_actions_channel_created
ON public.agent_actions (channel, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_actions_actor_created
ON public.agent_actions (created_by_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_actions_target
ON public.agent_actions (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_agent_actions_pending_review
ON public.agent_actions (created_at DESC)
WHERE status IN ('suggested', 'pending_approval', 'approved');

CREATE OR REPLACE FUNCTION public.touch_agent_actions_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS agent_actions_touch_updated_at ON public.agent_actions;
CREATE TRIGGER agent_actions_touch_updated_at
BEFORE UPDATE ON public.agent_actions
FOR EACH ROW
EXECUTE FUNCTION public.touch_agent_actions_updated_at();

CREATE OR REPLACE FUNCTION public.current_admin_role()
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(
        (
            SELECT au.role
            FROM public.admin_users au
            WHERE au.user_id = auth.uid()
            LIMIT 1
        ),
        'admin'
    );
$$;

CREATE OR REPLACE FUNCTION public.create_agent_action(
    p_agent_name TEXT,
    p_channel TEXT,
    p_action_type TEXT,
    p_target_type TEXT DEFAULT NULL,
    p_target_id TEXT DEFAULT NULL,
    p_target_ref TEXT DEFAULT NULL,
    p_risk_level TEXT DEFAULT 'medium',
    p_summary TEXT DEFAULT NULL,
    p_evidence JSONB DEFAULT '[]'::jsonb,
    p_input_context JSONB DEFAULT '{}'::jsonb,
    p_proposed_payload JSONB DEFAULT '{}'::jsonb,
    p_approval_required BOOLEAN DEFAULT TRUE,
    p_expires_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    new_action_id UUID;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'create_agent_action requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    IF p_summary IS NULL OR length(trim(p_summary)) = 0 THEN
        RAISE EXCEPTION 'Action summary is required'
            USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.agent_actions (
        agent_name,
        channel,
        created_by_user_id,
        role_scope,
        action_type,
        target_type,
        target_id,
        target_ref,
        status,
        risk_level,
        summary,
        evidence,
        input_context,
        proposed_payload,
        approval_required,
        expires_at
    )
    VALUES (
        COALESCE(NULLIF(trim(p_agent_name), ''), 'openclaw'),
        COALESCE(NULLIF(trim(p_channel), ''), 'admin'),
        auth.uid(),
        public.current_admin_role(),
        p_action_type,
        p_target_type,
        p_target_id,
        p_target_ref,
        CASE WHEN COALESCE(p_approval_required, TRUE) THEN 'pending_approval' ELSE 'suggested' END,
        COALESCE(NULLIF(trim(p_risk_level), ''), 'medium'),
        p_summary,
        COALESCE(p_evidence, '[]'::jsonb),
        COALESCE(p_input_context, '{}'::jsonb),
        COALESCE(p_proposed_payload, '{}'::jsonb),
        COALESCE(p_approval_required, TRUE),
        p_expires_at
    )
    RETURNING id INTO new_action_id;

    RETURN new_action_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_agent_action(
    p_action_id UUID,
    p_decision TEXT,
    p_review_note TEXT DEFAULT NULL
)
RETURNS public.agent_actions
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    updated_action public.agent_actions;
    normalized_decision TEXT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'review_agent_action requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    normalized_decision := lower(trim(COALESCE(p_decision, '')));

    IF normalized_decision NOT IN ('approved', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'Decision must be approved, rejected or cancelled'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.agent_actions
    SET
        status = normalized_decision,
        reviewed_at = NOW(),
        review_note = p_review_note,
        approved_by_user_id = CASE WHEN normalized_decision = 'approved' THEN auth.uid() ELSE NULL END,
        approved_at = CASE WHEN normalized_decision = 'approved' THEN NOW() ELSE NULL END
    WHERE id = p_action_id
      AND status IN ('suggested', 'pending_approval')
    RETURNING * INTO updated_action;

    IF updated_action.id IS NULL THEN
        RAISE EXCEPTION 'Agent action not found or not reviewable'
            USING ERRCODE = '02000';
    END IF;

    RETURN updated_action;
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
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    updated_action public.agent_actions;
    normalized_status TEXT;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'record_agent_action_execution requires an admin user'
            USING ERRCODE = '42501';
    END IF;

    normalized_status := lower(trim(COALESCE(p_status, '')));

    IF normalized_status NOT IN ('executed', 'failed') THEN
        RAISE EXCEPTION 'Execution status must be executed or failed'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.agent_actions
    SET
        status = normalized_status,
        executed_at = NOW(),
        execution_result = COALESCE(p_execution_result, '{}'::jsonb),
        error_message = p_error_message
    WHERE id = p_action_id
      AND status = 'approved'
    RETURNING * INTO updated_action;

    IF updated_action.id IS NULL THEN
        RAISE EXCEPTION 'Agent action not found or not approved for execution'
            USING ERRCODE = '02000';
    END IF;

    RETURN updated_action;
END;
$$;

ALTER TABLE public.agent_actions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.agent_actions FROM PUBLIC;
REVOKE ALL ON public.agent_actions FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.agent_actions TO authenticated;

REVOKE ALL ON FUNCTION public.current_admin_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_agent_action(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, BOOLEAN, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.review_agent_action(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.current_admin_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_agent_action(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, BOOLEAN, TIMESTAMPTZ) TO authenticated;
GRANT EXECUTE ON FUNCTION public.review_agent_action(UUID, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_agent_action_execution(UUID, TEXT, JSONB, TEXT) TO authenticated;

DROP POLICY IF EXISTS "Admins read agent actions" ON public.agent_actions;
CREATE POLICY "Admins read agent actions"
ON public.agent_actions
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create agent actions" ON public.agent_actions;
CREATE POLICY "Admins create agent actions"
ON public.agent_actions
FOR INSERT
TO authenticated
WITH CHECK (
    public.is_admin()
    AND (
        created_by_user_id IS NULL
        OR created_by_user_id = auth.uid()
    )
);

DROP POLICY IF EXISTS "Admins update agent actions" ON public.agent_actions;
CREATE POLICY "Admins update agent actions"
ON public.agent_actions
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.agent_actions IS 'Auditable suggestions, approvals and execution results for internal AI/Ops agent workflows.';
COMMENT ON COLUMN public.agent_actions.evidence IS 'Array of cited facts/snapshots used by the agent to justify the recommendation.';
COMMENT ON COLUMN public.agent_actions.input_context IS 'Sanitized context received by the agent; must not contain secrets.';
COMMENT ON COLUMN public.agent_actions.proposed_payload IS 'Proposed action payload awaiting human review or execution.';
COMMENT ON COLUMN public.agent_actions.execution_result IS 'Result metadata after an approved action is executed.';
COMMENT ON COLUMN public.agent_actions.approval_required IS 'True when a human must approve before execution.';

NOTIFY pgrst, 'reload schema';
