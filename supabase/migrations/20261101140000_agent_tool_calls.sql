-- Agent Proxy audit trail and provenance channel.
-- The MCP server is service-role only; every tool call is recorded so the
-- owner can answer "what did the agent see and do?" without reading logs.

ALTER TABLE public.agent_actions
    DROP CONSTRAINT IF EXISTS agent_actions_channel_check;

ALTER TABLE public.agent_actions
    ADD CONSTRAINT agent_actions_channel_check CHECK (
        channel IN (
            'admin',
            'telegram_admin',
            'whatsapp_admin',
            'hook',
            'system',
            'agent_proxy'
        )
    );

CREATE TABLE IF NOT EXISTS public.agent_tool_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) > 0),
    arguments JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(arguments) = 'object'),
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'denied')),
    error_message TEXT,
    latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
    actor TEXT NOT NULL DEFAULT 'agent_proxy' CHECK (length(trim(actor)) > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_created
ON public.agent_tool_calls (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool_created
ON public.agent_tool_calls (tool_name, created_at DESC);

ALTER TABLE public.agent_tool_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read agent tool calls" ON public.agent_tool_calls;
CREATE POLICY "Admins read agent tool calls"
ON public.agent_tool_calls
FOR SELECT
TO authenticated
USING (public.is_admin());

REVOKE ALL ON public.agent_tool_calls FROM PUBLIC;
REVOKE ALL ON public.agent_tool_calls FROM anon;
REVOKE ALL ON public.agent_tool_calls FROM authenticated;
GRANT SELECT ON public.agent_tool_calls TO authenticated;
GRANT INSERT ON public.agent_tool_calls TO service_role;

COMMENT ON TABLE public.agent_tool_calls
IS 'Audit of Agent Proxy/MCP tool calls. Admin-read only; written by the service-role MCP server.';
