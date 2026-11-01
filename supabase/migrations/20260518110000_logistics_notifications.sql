-- Migration: Logistics notification traceability
-- Date: 2026-05-18
-- Description:
--   Tracks WhatsApp logistics notifications for dispatch and delivery,
--   including provider status callbacks such as sent, failed and read.

CREATE TABLE IF NOT EXISTS public.logistics_notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    shipment_id UUID REFERENCES public.shipments(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK (purpose IN ('dispatch', 'delivery')),
    channel TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp')),
    recipient_phone TEXT,
    message_body TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'queued',
            'sent',
            'delivered',
            'read',
            'failed',
            'undelivered',
            'skipped'
        )
    ),
    provider TEXT NOT NULL DEFAULT 'twilio' CHECK (provider IN ('twilio')),
    provider_message_sid TEXT,
    error_message TEXT,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_logistics_notifications_provider_sid_unique
ON public.logistics_notifications (provider, provider_message_sid);

CREATE INDEX IF NOT EXISTS idx_logistics_notifications_order_created
ON public.logistics_notifications (order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_logistics_notifications_shipment_created
ON public.logistics_notifications (shipment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_logistics_notifications_status_created
ON public.logistics_notifications (status, created_at DESC);

CREATE OR REPLACE FUNCTION public.touch_logistics_notifications_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS logistics_notifications_touch_updated_at ON public.logistics_notifications;
CREATE TRIGGER logistics_notifications_touch_updated_at
BEFORE UPDATE ON public.logistics_notifications
FOR EACH ROW
EXECUTE FUNCTION public.touch_logistics_notifications_updated_at();

ALTER TABLE public.logistics_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.logistics_notifications FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.logistics_notifications TO authenticated;

DROP POLICY IF EXISTS "Admins manage logistics notifications" ON public.logistics_notifications;
CREATE POLICY "Admins manage logistics notifications"
ON public.logistics_notifications
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.logistics_notifications IS 'Traceability for logistics WhatsApp notifications such as dispatch and delivery.';
COMMENT ON COLUMN public.logistics_notifications.purpose IS 'Business purpose of the notification: dispatch or delivery.';
COMMENT ON COLUMN public.logistics_notifications.provider_message_sid IS 'Twilio MessageSid used to reconcile status callbacks.';

NOTIFY pgrst, 'reload schema';
