-- Canonical payment approval timestamps for logistics, finance and conversion KPIs.
-- `orders.paid_at` is the operational source for "payment approved".
-- `payments.approved_at` preserves the provider-specific approval event.

ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

UPDATE public.payments
SET approved_at = COALESCE(
    CASE
        WHEN raw_event #>> '{transaction,finalized_at}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN (raw_event #>> '{transaction,finalized_at}')::timestamptz
    END,
    CASE
        WHEN raw_event #>> '{transaction,created_at}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
        THEN (raw_event #>> '{transaction,created_at}')::timestamptz
    END,
    updated_at,
    created_at
)
WHERE approved_at IS NULL
  AND lower(status) = 'approved';

UPDATE public.orders AS o
SET paid_at = COALESCE(p.approved_at, o.updated_at, o.created_at)
FROM public.payments AS p
WHERE o.paid_at IS NULL
  AND p.reference = o.payment_reference
  AND lower(p.status) = 'approved';

UPDATE public.orders
SET paid_at = COALESCE(updated_at, created_at)
WHERE paid_at IS NULL
  AND status IN ('paid', 'processing', 'shipped', 'delivered');

UPDATE public.payments AS p
SET approved_at = o.paid_at
FROM public.orders AS o
WHERE p.approved_at IS NULL
  AND lower(p.status) = 'approved'
  AND p.reference = o.payment_reference
  AND o.paid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS orders_paid_at_idx
ON public.orders (paid_at)
WHERE paid_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS payments_approved_at_idx
ON public.payments (approved_at)
WHERE approved_at IS NOT NULL;

COMMENT ON COLUMN public.orders.paid_at IS 'Canonical timestamp when payment was approved; base for commercial, financial and logistics SLAs.';
COMMENT ON COLUMN public.payments.approved_at IS 'Provider-specific timestamp when Wompi approved the transaction.';
