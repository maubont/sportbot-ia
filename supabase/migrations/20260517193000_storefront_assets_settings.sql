-- Make commercial storefront assets configurable instead of hardcoded placeholders.

ALTER TABLE public.settings
    ADD COLUMN IF NOT EXISTS system_prompt TEXT,
    ADD COLUMN IF NOT EXISTS storefront_url TEXT,
    ADD COLUMN IF NOT EXISTS welcome_image_url TEXT,
    ADD COLUMN IF NOT EXISTS catalog_pdf_url TEXT;

INSERT INTO public.settings (id, store_name, timezone, welcome_message)
VALUES (
    1,
    'SportBot',
    'America/Bogota',
    'Hola, bienvenido a SportBot. Somos especialistas en sneakers exclusivos en Colombia.'
)
ON CONFLICT (id) DO UPDATE
SET
    store_name = COALESCE(NULLIF(public.settings.store_name, ''), EXCLUDED.store_name),
    timezone = COALESCE(NULLIF(public.settings.timezone, ''), EXCLUDED.timezone),
    welcome_message = COALESCE(NULLIF(public.settings.welcome_message, ''), EXCLUDED.welcome_message);

-- Remove known non-commercial placeholders from stored product media.
UPDATE public.product_media
SET
    url = 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=900&q=80',
    storage_path = 'external/sneaker-red-black-unsplash.jpg',
    media_type = 'image'
WHERE url ILIKE '%Python-logo-notext%'
   OR url ILIKE '%python-logo%';

-- Prefer a real catalog image already uploaded to storage as welcome media.
UPDATE public.settings
SET welcome_image_url = COALESCE(
    NULLIF(welcome_image_url, ''),
    (
        SELECT pm.url
        FROM public.product_media pm
        WHERE pm.media_type = 'image'
          AND pm.url NOT ILIKE '%Python-logo-notext%'
          AND pm.url NOT ILIKE '%python-logo%'
        ORDER BY pm.is_primary DESC, pm.created_at DESC
        LIMIT 1
    )
)
WHERE id = 1;

UPDATE public.settings
SET
    storefront_url = NULLIF(storefront_url, ''),
    welcome_image_url = NULLIF(welcome_image_url, ''),
    catalog_pdf_url = NULLIF(catalog_pdf_url, '')
WHERE id = 1;

COMMENT ON COLUMN public.settings.storefront_url IS 'Public storefront URL used by WhatsApp welcome flows.';
COMMENT ON COLUMN public.settings.welcome_image_url IS 'Public image URL attached to the WhatsApp welcome flow.';
COMMENT ON COLUMN public.settings.catalog_pdf_url IS 'Optional public PDF URL attached to the WhatsApp welcome flow.';
COMMENT ON COLUMN public.settings.system_prompt IS 'Optional override for the WhatsApp AI persona.';

NOTIFY pgrst, 'reload schema';
