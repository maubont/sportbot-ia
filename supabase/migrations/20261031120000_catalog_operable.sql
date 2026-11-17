-- P1.1 Catálogo operable
--
-- 1. Defensas de datos para precio y talla. Se agregan como NOT VALID para no
--    bloquear la migración si algún registro histórico las incumple; Postgres
--    las aplica igual a cada INSERT/UPDATE nuevo.
-- 2. Una sola imagen principal por producto, con normalización previa.
-- 3. Reposición atómica de stock: incrementa unidades físicas sin tocar
--    `reserved` ni fusionar/borrar variantes.
-- 4. Cambio de imagen principal en una sola transacción.
--
-- El navegador Admin llama estas funciones como `authenticated`; ambas validan
-- `public.is_admin()` y no dependen de que el cliente recuerde la regla.

ALTER TABLE public.products
    DROP CONSTRAINT IF EXISTS products_price_positive;

ALTER TABLE public.products
    ADD CONSTRAINT products_price_positive
    CHECK (price_cents > 0) NOT VALID;

ALTER TABLE public.product_variants
    DROP CONSTRAINT IF EXISTS product_variants_size_range;

ALTER TABLE public.product_variants
    ADD CONSTRAINT product_variants_size_range
    CHECK (size > 0 AND size <= 60) NOT VALID;

-- Normaliza principales duplicados antes de crear el índice único parcial.
WITH ranked_primary AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY product_id
            ORDER BY created_at NULLS LAST, id
        ) AS rn
    FROM public.product_media
    WHERE is_primary = TRUE
)
UPDATE public.product_media pm
SET is_primary = FALSE
FROM ranked_primary rp
WHERE pm.id = rp.id
  AND rp.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_product_media_one_primary
    ON public.product_media(product_id)
    WHERE is_primary;

CREATE OR REPLACE FUNCTION public.restock_variant(p_variant_id UUID, p_qty INTEGER)
RETURNS TABLE (
    variant_id UUID,
    stock INTEGER,
    reserved INTEGER,
    available INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    next_stock INTEGER;
    current_reserved INTEGER;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
    END IF;

    IF p_qty IS NULL OR p_qty <= 0 THEN
        RAISE EXCEPTION 'invalid_quantity: quantity must be a positive integer'
            USING ERRCODE = '22023';
    END IF;

    IF p_qty > 10000 THEN
        RAISE EXCEPTION 'invalid_quantity: quantity must be at most 10000'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.product_variants
    SET
        stock = public.product_variants.stock + p_qty,
        updated_at = NOW()
    WHERE id = p_variant_id
    RETURNING public.product_variants.stock, public.product_variants.reserved
    INTO next_stock, current_reserved;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'variant_not_found' USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    SELECT p_variant_id, next_stock, current_reserved, next_stock - current_reserved;
END;
$$;

COMMENT ON FUNCTION public.restock_variant(UUID, INTEGER) IS
    'Increments physical stock atomically and returns stock, reserved and available.';

CREATE OR REPLACE FUNCTION public.set_primary_product_media(p_media_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    target_product_id UUID;
BEGIN
    IF NOT public.is_admin() THEN
        RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
    END IF;

    SELECT product_id
    INTO target_product_id
    FROM public.product_media
    WHERE id = p_media_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'media_not_found' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.product_media
    SET is_primary = FALSE
    WHERE product_id = target_product_id
      AND is_primary = TRUE
      AND id <> p_media_id;

    UPDATE public.product_media
    SET is_primary = TRUE
    WHERE id = p_media_id;

    RETURN target_product_id;
END;
$$;

COMMENT ON FUNCTION public.set_primary_product_media(UUID) IS
    'Sets exactly one primary image for the media product in one transaction.';

REVOKE ALL ON FUNCTION public.restock_variant(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restock_variant(UUID, INTEGER) FROM anon;
GRANT EXECUTE ON FUNCTION public.restock_variant(UUID, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.restock_variant(UUID, INTEGER) TO service_role;

REVOKE ALL ON FUNCTION public.set_primary_product_media(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_primary_product_media(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_primary_product_media(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_primary_product_media(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
