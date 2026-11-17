-- Migration: Order ficha — tracking_url shape guard
-- Date: 2026-11-01
-- Description:
--   P1.2 (ficha de pedido útil): defensive CHECK for shipments.tracking_url so a
--   malformed value can never enter the field the bot reads via getOrderStatus.
--   The guard is intentionally loose (http(s) prefix + max length); the strict
--   gatekeeper is validateTrackingUrl in supabase/functions/_shared/tracking_url.ts.
--   NOT VALID on purpose: historical rows are not re-validated, only new writes.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'shipments_tracking_url_shape'
          AND conrelid = 'public.shipments'::regclass
    ) THEN
        ALTER TABLE public.shipments
            ADD CONSTRAINT shipments_tracking_url_shape
            CHECK (
                tracking_url IS NULL
                OR (
                    char_length(tracking_url) <= 500
                    AND tracking_url ~* '^https?://'
                )
            )
            NOT VALID;
    END IF;
END;
$$;
