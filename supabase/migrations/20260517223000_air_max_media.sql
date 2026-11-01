-- Add product media for the catalog item used in WhatsApp flow tests.

INSERT INTO public.product_media (product_id, url, storage_path, media_type, is_primary)
SELECT
    p.id,
    'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=1200&q=80',
    'external/nike-air-max-90-unsplash-1542291026.jpg',
    'image',
    true
FROM public.products p
WHERE p.brand = 'Nike'
  AND p.model = 'Air Max 90'
  AND NOT EXISTS (
      SELECT 1
      FROM public.product_media pm
      WHERE pm.product_id = p.id
        AND pm.media_type = 'image'
  );
