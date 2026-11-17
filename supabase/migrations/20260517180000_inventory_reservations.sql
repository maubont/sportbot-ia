-- Formalize inventory semantics:
-- stock = physical units controlled by the business
-- reserved = units held by awaiting_payment orders
-- available = stock - reserved

ALTER TABLE public.product_variants
    ADD COLUMN IF NOT EXISTS reserved INTEGER NOT NULL DEFAULT 0;

UPDATE public.product_variants
SET reserved = 0
WHERE reserved IS NULL;

-- Existing awaiting_payment orders were created under the old model, where
-- stock was immediately decremented. Add those units back as physical stock
-- and represent the hold in reserved.
WITH awaiting_reservations AS (
    SELECT
        oi.variant_id,
        SUM(COALESCE(oi.qty, 0))::integer AS qty
    FROM public.order_items oi
    JOIN public.orders o ON o.id = oi.order_id
    WHERE o.status = 'awaiting_payment'
      AND oi.variant_id IS NOT NULL
    GROUP BY oi.variant_id
)
UPDATE public.product_variants pv
SET
    stock = pv.stock + ar.qty,
    reserved = pv.reserved + ar.qty,
    updated_at = NOW()
FROM awaiting_reservations ar
WHERE pv.id = ar.variant_id
  AND pv.reserved = 0;

ALTER TABLE public.product_variants
    DROP CONSTRAINT IF EXISTS product_variants_stock_non_negative,
    DROP CONSTRAINT IF EXISTS product_variants_reserved_non_negative,
    DROP CONSTRAINT IF EXISTS product_variants_reserved_not_above_stock;

ALTER TABLE public.product_variants
    ADD CONSTRAINT product_variants_stock_non_negative CHECK (stock >= 0),
    ADD CONSTRAINT product_variants_reserved_non_negative CHECK (reserved >= 0),
    ADD CONSTRAINT product_variants_reserved_not_above_stock CHECK (reserved <= stock);

WITH ranked_variants AS (
    SELECT
        id,
        product_id,
        size,
        ROW_NUMBER() OVER (PARTITION BY product_id, size ORDER BY created_at NULLS LAST, id) AS rn,
        FIRST_VALUE(id) OVER (PARTITION BY product_id, size ORDER BY created_at NULLS LAST, id) AS master_id
    FROM public.product_variants
),
duplicate_variants AS (
    SELECT id, master_id
    FROM ranked_variants
    WHERE rn > 1
)
UPDATE public.order_items oi
SET variant_id = dv.master_id
FROM duplicate_variants dv
WHERE oi.variant_id = dv.id;

WITH ranked_variants AS (
    SELECT
        id,
        product_id,
        size,
        stock,
        reserved,
        ROW_NUMBER() OVER (PARTITION BY product_id, size ORDER BY created_at NULLS LAST, id) AS rn,
        FIRST_VALUE(id) OVER (PARTITION BY product_id, size ORDER BY created_at NULLS LAST, id) AS master_id
    FROM public.product_variants
),
variant_totals AS (
    SELECT
        master_id,
        SUM(stock)::integer AS total_stock,
        SUM(reserved)::integer AS total_reserved
    FROM ranked_variants
    GROUP BY master_id
)
UPDATE public.product_variants pv
SET
    stock = vt.total_stock,
    reserved = LEAST(vt.total_reserved, vt.total_stock),
    updated_at = NOW()
FROM variant_totals vt
WHERE pv.id = vt.master_id;

WITH ranked_variants AS (
    SELECT
        id,
        ROW_NUMBER() OVER (PARTITION BY product_id, size ORDER BY created_at NULLS LAST, id) AS rn
    FROM public.product_variants
)
DELETE FROM public.product_variants pv
USING ranked_variants rv
WHERE pv.id = rv.id
  AND rv.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_variants_product_size_unique
    ON public.product_variants(product_id, size);

CREATE OR REPLACE FUNCTION public.reserve_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    current_stock INT;
    current_reserved INT;
    current_available INT;
BEGIN
    IF amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;

    SELECT stock, reserved
    INTO current_stock, current_reserved
    FROM public.product_variants
    WHERE id = row_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found';
    END IF;

    current_available := current_stock - current_reserved;

    IF current_available < amount THEN
        RAISE EXCEPTION 'Insufficient stock. Available: %, Requested: %', current_available, amount;
    END IF;

    UPDATE public.product_variants
    SET
        reserved = reserved + amount,
        updated_at = NOW()
    WHERE id = row_id
    RETURNING stock, reserved INTO current_stock, current_reserved;

    RETURN current_stock - current_reserved;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    current_stock INT;
    current_reserved INT;
    release_amount INT;
BEGIN
    IF amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;

    SELECT stock, reserved
    INTO current_stock, current_reserved
    FROM public.product_variants
    WHERE id = row_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found';
    END IF;

    release_amount := LEAST(amount, current_reserved);

    UPDATE public.product_variants
    SET
        reserved = reserved - release_amount,
        updated_at = NOW()
    WHERE id = row_id
    RETURNING stock, reserved INTO current_stock, current_reserved;

    RETURN current_stock - current_reserved;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    current_stock INT;
    current_reserved INT;
    release_amount INT;
BEGIN
    IF amount <= 0 THEN
        RAISE EXCEPTION 'Amount must be greater than zero';
    END IF;

    SELECT stock, reserved
    INTO current_stock, current_reserved
    FROM public.product_variants
    WHERE id = row_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found';
    END IF;

    IF current_stock < amount THEN
        RAISE EXCEPTION 'Insufficient physical stock. Stock: %, Requested: %', current_stock, amount;
    END IF;

    release_amount := LEAST(amount, current_reserved);

    UPDATE public.product_variants
    SET
        stock = stock - amount,
        reserved = reserved - release_amount,
        updated_at = NOW()
    WHERE id = row_id
    RETURNING stock, reserved INTO current_stock, current_reserved;

    RETURN current_stock - current_reserved;
END;
$$;

-- Backwards-compatible aliases for older function callers.
CREATE OR REPLACE FUNCTION public.decrement_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN public.reserve_stock(row_id, amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.increment_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN public.release_stock(row_id, amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.release_order_stock(target_order_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    item RECORD;
    released_total INT := 0;
BEGIN
    FOR item IN
        SELECT variant_id, COALESCE(qty, 0)::integer AS qty
        FROM public.order_items
        WHERE order_id = target_order_id
          AND variant_id IS NOT NULL
          AND COALESCE(qty, 0) > 0
    LOOP
        PERFORM public.release_stock(item.variant_id, item.qty);
        released_total := released_total + item.qty;
    END LOOP;

    RETURN released_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.commit_order_stock(target_order_id UUID)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    item RECORD;
    committed_total INT := 0;
BEGIN
    FOR item IN
        SELECT variant_id, COALESCE(qty, 0)::integer AS qty
        FROM public.order_items
        WHERE order_id = target_order_id
          AND variant_id IS NOT NULL
          AND COALESCE(qty, 0) > 0
    LOOP
        PERFORM public.commit_stock(item.variant_id, item.qty);
        committed_total := committed_total + item.qty;
    END LOOP;

    RETURN committed_total;
END;
$$;

COMMENT ON COLUMN public.product_variants.stock IS 'Physical units controlled by the business.';
COMMENT ON COLUMN public.product_variants.reserved IS 'Units reserved by awaiting_payment orders.';
COMMENT ON FUNCTION public.reserve_stock(UUID, INT) IS 'Atomically reserves units and returns available stock.';
COMMENT ON FUNCTION public.release_stock(UUID, INT) IS 'Atomically releases reserved units and returns available stock.';
COMMENT ON FUNCTION public.commit_stock(UUID, INT) IS 'Atomically commits a sale, reducing physical stock and reserved units when present.';
COMMENT ON FUNCTION public.release_order_stock(UUID) IS 'Releases all reserved units for one order.';
COMMENT ON FUNCTION public.commit_order_stock(UUID) IS 'Commits all stock units for one paid order.';

NOTIFY pgrst, 'reload schema';
