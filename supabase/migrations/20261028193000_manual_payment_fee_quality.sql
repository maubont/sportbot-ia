-- A zero fee is expected for human-approved Nequi/Bre-B payments.
-- Keep the historic missing-fee warning for legacy gateway payments, and
-- leave the actual payment_fee_cents / contribution margin untouched.
CREATE OR REPLACE FUNCTION private.ignore_missing_fee_for_manual_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    IF 'missing_payment_fee' = ANY(NEW.data_quality_flags)
       AND EXISTS (
           SELECT 1 FROM public.payments p
           WHERE p.order_id = NEW.order_id
             AND p.provider = 'manual'
             AND p.status = 'approved'
       ) THEN
        NEW.data_quality_flags := array_remove(NEW.data_quality_flags, 'missing_payment_fee');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ignore_missing_fee_for_manual_payment ON public.order_economics;
CREATE TRIGGER ignore_missing_fee_for_manual_payment
BEFORE INSERT OR UPDATE ON public.order_economics
FOR EACH ROW EXECUTE FUNCTION private.ignore_missing_fee_for_manual_payment();

-- The order-economics refresh runs when the order becomes paid, just before
-- approve_payment inserts its manual payment. Remove the temporary flag in
-- the same transaction, after that payment is actually recorded.
CREATE OR REPLACE FUNCTION private.clear_missing_fee_after_manual_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, private, pg_temp
AS $$
BEGIN
    IF NEW.provider = 'manual' AND NEW.status = 'approved' THEN
        UPDATE public.order_economics oe
           SET data_quality_flags = array_remove(oe.data_quality_flags, 'missing_payment_fee')
         WHERE oe.order_id = NEW.order_id
           AND 'missing_payment_fee' = ANY(oe.data_quality_flags);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clear_missing_fee_after_manual_approval ON public.payments;
CREATE TRIGGER clear_missing_fee_after_manual_approval
AFTER INSERT OR UPDATE OF provider, status ON public.payments
FOR EACH ROW EXECUTE FUNCTION private.clear_missing_fee_after_manual_approval();

-- Existing approved manual orders, if any; leave gateway-era flags intact.
UPDATE public.order_economics oe
   SET data_quality_flags = array_remove(oe.data_quality_flags, 'missing_payment_fee')
 WHERE 'missing_payment_fee' = ANY(oe.data_quality_flags)
   AND EXISTS (
       SELECT 1 FROM public.payments p
       WHERE p.order_id = oe.order_id
         AND p.provider = 'manual'
         AND p.status = 'approved'
   );
