-- Migration: Shipments and shipment events
-- Date: 2026-05-18
-- Description:
--   Introduces an explicit logistics model while keeping the existing
--   orders carrier/tracking fields as the compatibility read model.

CREATE TABLE IF NOT EXISTS public.shipments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    shipment_number INTEGER NOT NULL DEFAULT 1 CHECK (shipment_number > 0),
    status TEXT NOT NULL DEFAULT 'ready_to_fulfill' CHECK (
        status IN (
            'ready_to_fulfill',
            'picking',
            'packed',
            'label_created',
            'shipped',
            'in_transit',
            'out_for_delivery',
            'delivered',
            'exception',
            'cancelled'
        )
    ),
    carrier_name TEXT,
    tracking_number TEXT,
    tracking_url TEXT,
    service_level TEXT,
    package_count INTEGER NOT NULL DEFAULT 1 CHECK (package_count > 0),
    shipped_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    delivered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    notes TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT shipments_shipped_at_required CHECK (
        status NOT IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
        OR shipped_at IS NOT NULL
    ),
    CONSTRAINT shipments_delivered_at_required CHECK (
        status <> 'delivered'
        OR delivered_at IS NOT NULL
    ),
    CONSTRAINT shipments_delivered_after_shipped CHECK (
        delivered_at IS NULL
        OR shipped_at IS NULL
        OR delivered_at >= shipped_at
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_order_number_unique
ON public.shipments (order_id, shipment_number);

-- v1 keeps one active shipment per order. A future returns/exchanges model can
-- relax this by cancelling or superseding the previous shipment explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS idx_shipments_one_active_per_order_v1
ON public.shipments (order_id)
WHERE status <> 'cancelled';

CREATE INDEX IF NOT EXISTS idx_shipments_status_created
ON public.shipments (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipments_order
ON public.shipments (order_id);

CREATE INDEX IF NOT EXISTS idx_shipments_tracking
ON public.shipments (carrier_name, tracking_number);

CREATE TABLE IF NOT EXISTS public.shipment_events (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shipment_id UUID NOT NULL REFERENCES public.shipments(id) ON DELETE CASCADE,
    order_id UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL CHECK (
        event_type IN (
            'created',
            'ready_to_fulfill',
            'picking',
            'packed',
            'label_created',
            'shipped',
            'in_transit',
            'out_for_delivery',
            'delivered',
            'exception',
            'notification_sent',
            'notification_failed',
            'notification_read',
            'note',
            'cancelled'
        )
    ),
    status TEXT CHECK (
        status IS NULL
        OR status IN (
            'ready_to_fulfill',
            'picking',
            'packed',
            'label_created',
            'shipped',
            'in_transit',
            'out_for_delivery',
            'delivered',
            'exception',
            'cancelled'
        )
    ),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL DEFAULT 'admin' CHECK (
        source IN ('admin', 'system', 'twilio', 'carrier', 'wompi', 'migration')
    ),
    actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    carrier_name TEXT,
    tracking_number TEXT,
    description TEXT,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    event_key TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shipment_events_event_key_unique
ON public.shipment_events (event_key)
WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shipment_events_shipment_time
ON public.shipment_events (shipment_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipment_events_order_time
ON public.shipment_events (order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipment_events_type_time
ON public.shipment_events (event_type, occurred_at DESC);

CREATE OR REPLACE FUNCTION public.touch_shipments_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shipments_touch_updated_at ON public.shipments;
CREATE TRIGGER shipments_touch_updated_at
BEFORE UPDATE ON public.shipments
FOR EACH ROW
EXECUTE FUNCTION public.touch_shipments_updated_at();

CREATE OR REPLACE FUNCTION public.sync_order_logistics_from_shipment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status NOT IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
        AND NEW.carrier_name IS NULL
        AND NEW.tracking_number IS NULL
        AND NEW.shipped_at IS NULL
        AND NEW.delivered_at IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE public.orders AS o
    SET
        carrier_name = COALESCE(NEW.carrier_name, o.carrier_name),
        tracking_number = COALESCE(NEW.tracking_number, o.tracking_number),
        shipped_at = COALESCE(NEW.shipped_at, o.shipped_at),
        delivered_at = COALESCE(NEW.delivered_at, o.delivered_at),
        status = CASE
            WHEN NEW.status = 'delivered' THEN 'delivered'
            WHEN NEW.status IN ('shipped', 'in_transit', 'out_for_delivery') THEN 'shipped'
            ELSE o.status
        END,
        updated_at = NOW()
    WHERE o.id = NEW.order_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS shipments_sync_order_logistics ON public.shipments;
CREATE TRIGGER shipments_sync_order_logistics
AFTER INSERT OR UPDATE OF status, carrier_name, tracking_number, shipped_at, delivered_at
ON public.shipments
FOR EACH ROW
EXECUTE FUNCTION public.sync_order_logistics_from_shipment();

-- Backfill existing paid/shipped/delivered orders into the new logistics model.
INSERT INTO public.shipments (
    order_id,
    shipment_number,
    status,
    carrier_name,
    tracking_number,
    shipped_at,
    delivered_at,
    metadata,
    created_at,
    updated_at
)
SELECT
    o.id,
    1,
    CASE
        WHEN o.delivered_at IS NOT NULL OR o.status = 'delivered' THEN 'delivered'
        WHEN o.shipped_at IS NOT NULL
            OR o.status = 'shipped'
            OR NULLIF(BTRIM(o.carrier_name), '') IS NOT NULL
            OR NULLIF(BTRIM(o.tracking_number), '') IS NOT NULL THEN 'shipped'
        ELSE 'ready_to_fulfill'
    END,
    NULLIF(BTRIM(o.carrier_name), ''),
    NULLIF(BTRIM(o.tracking_number), ''),
    CASE
        WHEN o.shipped_at IS NOT NULL THEN o.shipped_at
        WHEN o.delivered_at IS NOT NULL THEN o.delivered_at
        WHEN o.status IN ('shipped', 'delivered') THEN COALESCE(o.updated_at, o.created_at, NOW())
        WHEN NULLIF(BTRIM(o.carrier_name), '') IS NOT NULL
            OR NULLIF(BTRIM(o.tracking_number), '') IS NOT NULL THEN COALESCE(o.updated_at, o.created_at, NOW())
        ELSE NULL
    END,
    CASE
        WHEN o.delivered_at IS NOT NULL THEN o.delivered_at
        WHEN o.status = 'delivered' THEN COALESCE(o.shipped_at, o.updated_at, o.created_at, NOW())
        ELSE NULL
    END,
    jsonb_build_object('backfilled_from_orders', true),
    COALESCE(o.created_at, NOW()),
    NOW()
FROM public.orders AS o
WHERE o.status IN ('paid', 'shipped', 'delivered')
   OR o.shipped_at IS NOT NULL
   OR o.delivered_at IS NOT NULL
   OR NULLIF(BTRIM(o.carrier_name), '') IS NOT NULL
   OR NULLIF(BTRIM(o.tracking_number), '') IS NOT NULL
ON CONFLICT (order_id, shipment_number)
DO UPDATE SET
    status = EXCLUDED.status,
    carrier_name = COALESCE(EXCLUDED.carrier_name, public.shipments.carrier_name),
    tracking_number = COALESCE(EXCLUDED.tracking_number, public.shipments.tracking_number),
    shipped_at = COALESCE(EXCLUDED.shipped_at, public.shipments.shipped_at),
    delivered_at = COALESCE(EXCLUDED.delivered_at, public.shipments.delivered_at),
    metadata = public.shipments.metadata || EXCLUDED.metadata;

INSERT INTO public.shipment_events (
    shipment_id,
    order_id,
    event_type,
    status,
    occurred_at,
    source,
    carrier_name,
    tracking_number,
    description,
    raw_payload,
    event_key
)
SELECT
    s.id,
    s.order_id,
    'created',
    s.status,
    s.created_at,
    'migration',
    s.carrier_name,
    s.tracking_number,
    'Shipment created from existing order logistics state.',
    jsonb_build_object('backfilled_from_orders', true),
    s.id::text || ':backfill:created'
FROM public.shipments AS s
ON CONFLICT DO NOTHING;

INSERT INTO public.shipment_events (
    shipment_id,
    order_id,
    event_type,
    status,
    occurred_at,
    source,
    carrier_name,
    tracking_number,
    description,
    raw_payload,
    event_key
)
SELECT
    s.id,
    s.order_id,
    'shipped',
    'shipped',
    s.shipped_at,
    'migration',
    s.carrier_name,
    s.tracking_number,
    'Shipment marked as shipped from existing order logistics fields.',
    jsonb_build_object('backfilled_from_orders', true),
    s.id::text || ':backfill:shipped'
FROM public.shipments AS s
WHERE s.shipped_at IS NOT NULL
  AND s.status IN ('shipped', 'in_transit', 'out_for_delivery', 'delivered')
ON CONFLICT DO NOTHING;

INSERT INTO public.shipment_events (
    shipment_id,
    order_id,
    event_type,
    status,
    occurred_at,
    source,
    carrier_name,
    tracking_number,
    description,
    raw_payload,
    event_key
)
SELECT
    s.id,
    s.order_id,
    'delivered',
    'delivered',
    s.delivered_at,
    'migration',
    s.carrier_name,
    s.tracking_number,
    'Shipment marked as delivered from existing order logistics fields.',
    jsonb_build_object('backfilled_from_orders', true),
    s.id::text || ':backfill:delivered'
FROM public.shipments AS s
WHERE s.delivered_at IS NOT NULL
  AND s.status = 'delivered'
ON CONFLICT DO NOTHING;

ALTER TABLE public.shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shipment_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.shipments FROM anon;
REVOKE ALL ON public.shipment_events FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shipment_events TO authenticated;

DROP POLICY IF EXISTS "Admins manage shipments" ON public.shipments;
CREATE POLICY "Admins manage shipments"
ON public.shipments
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins manage shipment events" ON public.shipment_events;
CREATE POLICY "Admins manage shipment events"
ON public.shipment_events
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

COMMENT ON TABLE public.shipments IS 'Physical fulfillment record associated with a paid order.';
COMMENT ON TABLE public.shipment_events IS 'Timeline of logistics, tracking and notification events for a shipment.';
COMMENT ON COLUMN public.shipments.order_id IS 'Order being fulfilled. v1 keeps one active shipment per order.';
COMMENT ON COLUMN public.shipments.status IS 'Operational logistics state; orders.status remains the summarized compatibility state.';
COMMENT ON COLUMN public.shipment_events.event_key IS 'Optional idempotency key used by backfills, webhooks and notification callbacks.';

NOTIFY pgrst, 'reload schema';
