-- Migration: Admin external channel allowlist
-- Date: 2026-05-18
-- Description:
--   Prepares SB-047 by creating an audited allowlist for external admin
--   channels such as Telegram. The channel can read snapshots and create
--   suggested actions only after a server-side webhook validates the user.

CREATE TABLE IF NOT EXISTS public.admin_channel_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel TEXT NOT NULL DEFAULT 'telegram_admin' CHECK (
        channel IN (
            'telegram_admin',
            'whatsapp_admin'
        )
    ),
    external_user_id TEXT NOT NULL CHECK (length(trim(external_user_id)) > 0),
    external_chat_id TEXT CHECK (
        external_chat_id IS NULL
        OR length(trim(external_chat_id)) > 0
    ),
    admin_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    display_name TEXT,
    role_scope TEXT NOT NULL DEFAULT 'read_only' CHECK (
        role_scope IN (
            'owner',
            'admin',
            'operator',
            'seller',
            'read_only'
        )
    ),
    allowed_commands TEXT[] NOT NULL DEFAULT ARRAY['/ayuda']::TEXT[],
    status TEXT NOT NULL DEFAULT 'active' CHECK (
        status IN (
            'active',
            'paused',
            'revoked'
        )
    ),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    notes TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT admin_channel_users_unique_external_user UNIQUE (channel, external_user_id),
    CONSTRAINT admin_channel_users_commands_not_empty CHECK (cardinality(allowed_commands) > 0)
);

CREATE INDEX IF NOT EXISTS idx_admin_channel_users_admin_user
ON public.admin_channel_users (admin_user_id);

CREATE INDEX IF NOT EXISTS idx_admin_channel_users_status_channel
ON public.admin_channel_users (status, channel);

CREATE TABLE IF NOT EXISTS public.agent_channel_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    channel TEXT NOT NULL CHECK (
        channel IN (
            'telegram_admin',
            'whatsapp_admin',
            'hook',
            'admin'
        )
    ),
    external_update_id TEXT,
    external_message_id TEXT,
    external_user_id TEXT,
    external_chat_id TEXT,
    admin_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    agent_action_id UUID REFERENCES public.agent_actions(id) ON DELETE SET NULL,
    direction TEXT NOT NULL CHECK (
        direction IN (
            'inbound',
            'outbound'
        )
    ),
    message_type TEXT NOT NULL DEFAULT 'text' CHECK (
        message_type IN (
            'command',
            'text',
            'voice',
            'callback',
            'system'
        )
    ),
    normalized_intent TEXT,
    sanitized_body TEXT,
    response_summary TEXT,
    status TEXT NOT NULL DEFAULT 'received' CHECK (
        status IN (
            'received',
            'processed',
            'blocked',
            'failed'
        )
    ),
    error_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_channel_messages_update_unique
ON public.agent_channel_messages (channel, external_update_id, direction)
WHERE external_update_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_channel_messages_admin_created
ON public.agent_channel_messages (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_channel_messages_status_created
ON public.agent_channel_messages (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_channel_messages_action
ON public.agent_channel_messages (agent_action_id)
WHERE agent_action_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.touch_admin_channel_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS admin_channel_users_touch_updated_at ON public.admin_channel_users;
CREATE TRIGGER admin_channel_users_touch_updated_at
BEFORE UPDATE ON public.admin_channel_users
FOR EACH ROW
EXECUTE FUNCTION public.touch_admin_channel_updated_at();

DROP TRIGGER IF EXISTS agent_channel_messages_touch_updated_at ON public.agent_channel_messages;
CREATE TRIGGER agent_channel_messages_touch_updated_at
BEFORE UPDATE ON public.agent_channel_messages
FOR EACH ROW
EXECUTE FUNCTION public.touch_admin_channel_updated_at();

ALTER TABLE public.admin_channel_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_channel_messages ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.admin_channel_users FROM PUBLIC;
REVOKE ALL ON public.admin_channel_users FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.admin_channel_users TO authenticated;

REVOKE ALL ON public.agent_channel_messages FROM PUBLIC;
REVOKE ALL ON public.agent_channel_messages FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.agent_channel_messages TO authenticated;

DROP POLICY IF EXISTS "Admins read admin channel users" ON public.admin_channel_users;
CREATE POLICY "Admins read admin channel users"
ON public.admin_channel_users
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create admin channel users" ON public.admin_channel_users;
CREATE POLICY "Admins create admin channel users"
ON public.admin_channel_users
FOR INSERT
TO authenticated
WITH CHECK (
    public.is_admin()
    AND public.current_admin_role() IN ('owner', 'admin')
    AND (
        created_by IS NULL
        OR created_by = auth.uid()
    )
);

DROP POLICY IF EXISTS "Admins update admin channel users" ON public.admin_channel_users;
CREATE POLICY "Admins update admin channel users"
ON public.admin_channel_users
FOR UPDATE
TO authenticated
USING (
    public.is_admin()
    AND public.current_admin_role() IN ('owner', 'admin')
)
WITH CHECK (
    public.is_admin()
    AND public.current_admin_role() IN ('owner', 'admin')
);

DROP POLICY IF EXISTS "Admins read agent channel messages" ON public.agent_channel_messages;
CREATE POLICY "Admins read agent channel messages"
ON public.agent_channel_messages
FOR SELECT
TO authenticated
USING (public.is_admin());

DROP POLICY IF EXISTS "Admins create agent channel messages" ON public.agent_channel_messages;
CREATE POLICY "Admins create agent channel messages"
ON public.agent_channel_messages
FOR INSERT
TO authenticated
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins update agent channel messages" ON public.agent_channel_messages;
CREATE POLICY "Admins update agent channel messages"
ON public.agent_channel_messages
FOR UPDATE
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.admin_channel_users IS 'Allowlist mapping external admin-channel identities, such as Telegram user ids, to internal admin users and role scopes.';
COMMENT ON COLUMN public.admin_channel_users.external_user_id IS 'External platform user id. For Telegram this is the numeric from.id stored as text.';
COMMENT ON COLUMN public.admin_channel_users.external_chat_id IS 'Allowed private chat id for the external user when the channel provides one.';
COMMENT ON COLUMN public.admin_channel_users.allowed_commands IS 'Commands this external user may run from the admin channel.';
COMMENT ON TABLE public.agent_channel_messages IS 'Sanitized audit trail for inbound/outbound admin-channel agent interactions.';
COMMENT ON COLUMN public.agent_channel_messages.sanitized_body IS 'Sanitized message text. Must not store secrets or raw sensitive payloads.';
COMMENT ON COLUMN public.agent_channel_messages.metadata IS 'Small non-secret metadata for troubleshooting, for example Telegram update type or blocked reason.';

NOTIFY pgrst, 'reload schema';
