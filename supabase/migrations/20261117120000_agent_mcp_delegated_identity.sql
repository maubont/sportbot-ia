-- Verified identity context for Agent MCP audit events.
-- Historical rows remain nullable; every new user-scoped call supplies actor and role.
BEGIN;

ALTER TABLE public.agent_tool_calls
    ADD COLUMN IF NOT EXISTS actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS actor_role TEXT,
    ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'agent_proxy',
    ADD COLUMN IF NOT EXISTS request_id TEXT;

DO $agent_actor_role_constraint$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_tool_calls'::regclass
          AND conname = 'agent_tool_calls_actor_role_check'
    ) THEN
        ALTER TABLE public.agent_tool_calls
            ADD CONSTRAINT agent_tool_calls_actor_role_check
            CHECK (actor_role IS NULL OR actor_role IN ('owner', 'admin', 'operator'));
    END IF;
END;
$agent_actor_role_constraint$;

DO $agent_delegated_actor_constraint$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.agent_tool_calls'::regclass
          AND conname = 'agent_tool_calls_delegated_actor_check'
    ) THEN
        ALTER TABLE public.agent_tool_calls
            ADD CONSTRAINT agent_tool_calls_delegated_actor_check
            CHECK (
                channel <> 'agent_mcp_user'
                OR (actor_user_id IS NOT NULL AND actor_role IS NOT NULL)
            );
    END IF;
END;
$agent_delegated_actor_constraint$;

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_actor_created
    ON public.agent_tool_calls (actor_user_id, created_at DESC)
    WHERE actor_user_id IS NOT NULL;

ALTER TABLE public.agent_tool_calls
    DROP CONSTRAINT IF EXISTS agent_tool_calls_status_check;
ALTER TABLE public.agent_tool_calls
    ADD CONSTRAINT agent_tool_calls_status_check
    CHECK (status IN ('started', 'ok', 'error', 'denied'));

GRANT UPDATE ON public.agent_tool_calls TO service_role;

COMMENT ON COLUMN public.agent_tool_calls.actor_user_id IS
    'Supabase Auth subject verified for this MCP request; NULL only for historical records.';
COMMENT ON COLUMN public.agent_tool_calls.actor_role IS
    'Current admin_users role resolved server-side at the time of the MCP request.';
COMMENT ON COLUMN public.agent_tool_calls.request_id IS
    'MCP JSON-RPC request id for correlation; never an authentication credential.';

COMMIT;
