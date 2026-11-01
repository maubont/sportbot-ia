-- Canonicalize product_media metadata after the historical type/media_type split.

ALTER TABLE public.product_media
    ADD COLUMN IF NOT EXISTS media_type TEXT;

ALTER TABLE public.product_media
    ADD COLUMN IF NOT EXISTS storage_path TEXT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_media'
          AND column_name = 'type'
    ) THEN
        EXECUTE $sql$
            UPDATE public.product_media
            SET media_type = COALESCE(NULLIF(btrim(media_type), ''), type::text)
            WHERE media_type IS NULL OR btrim(media_type) = ''
        $sql$;
    END IF;
END $$;

UPDATE public.product_media
SET media_type = 'image'
WHERE media_type IS NULL OR btrim(media_type) = '';

UPDATE public.product_media
SET storage_path = 'legacy/' || id::text
WHERE storage_path IS NULL OR btrim(storage_path) = '';

ALTER TABLE public.product_media
    ALTER COLUMN media_type SET DEFAULT 'image',
    ALTER COLUMN media_type SET NOT NULL,
    ALTER COLUMN storage_path SET NOT NULL;

ALTER TABLE public.product_media
    DROP CONSTRAINT IF EXISTS product_media_media_type_check;

ALTER TABLE public.product_media
    ADD CONSTRAINT product_media_media_type_check
    CHECK (media_type IN ('image', 'pdf', 'video'));

CREATE INDEX IF NOT EXISTS idx_product_media_product
    ON public.product_media(product_id);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'product_media'
          AND column_name = 'type'
    ) THEN
        ALTER TABLE public.product_media DROP COLUMN type;
    END IF;
END $$;

COMMENT ON COLUMN public.product_media.media_type IS 'Canonical media kind: image, pdf, or video.';
COMMENT ON COLUMN public.product_media.storage_path IS 'Storage object path. Legacy external URLs use legacy/<media_id>.';

NOTIFY pgrst, 'reload schema';
