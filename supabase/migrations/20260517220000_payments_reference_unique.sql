-- Ensure Wompi payment events can be idempotently upserted by reference.
-- The webhook uses payments.reference as the conflict target.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'payments_reference_key'
          AND conrelid = 'public.payments'::regclass
    ) THEN
        ALTER TABLE public.payments
        ADD CONSTRAINT payments_reference_key UNIQUE (reference);
    END IF;
END $$;
