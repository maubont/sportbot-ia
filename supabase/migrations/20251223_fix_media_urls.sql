-- Migration: Fix broken image URLs with reliable public alternatives

-- 1. Update Nike Air Max 90 (Infrared)
-- Source: Wikimedia Commons https://upload.wikimedia.org/wikipedia/commons/2/23/Nike_Air_Max_90_Infrared_%284805905007%29.jpg
UPDATE product_media
SET url = 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Nike_Air_Max_90_Infrared_%284805905007%29.jpg/640px-Nike_Air_Max_90_Infrared_%284805905007%29.jpg'
WHERE product_id IN (SELECT id FROM products WHERE model ILIKE '%Air Max 90%');

-- 2. Update Jordan 1 Low (Bred Toe)
-- Use a real sneaker photo from a public image CDN until the product has its own uploaded media.
UPDATE product_media
SET url = 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=900&q=80'
WHERE product_id IN (SELECT id FROM products WHERE brand ILIKE 'Jordan' AND model ILIKE '%1 Low%');
