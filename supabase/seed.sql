-- SEED DATA
-- Insert Products
INSERT INTO products (sku, brand, model, colorway, category, price_cents, description) VALUES
('NK-AIR-001', 'Nike', 'Air Max 90', 'Infrared', 'casual', 45000000, 'Clásicas Air Max 90 con diseño atemporal y comodidad superior.'),
('NK-PEG-002', 'Nike', 'Pegasus 40', 'Black/White', 'running', 52000000, 'Zapatillas de running versátiles con soporte reactivo.'),
('AD-ULT-003', 'Adidas', 'Ultraboost Light', 'Core Black', 'running', 60000000, 'Energía épica. Zapatillas de running ultraligeras.'),
('AD-FOR-004', 'Adidas', 'Forum Low', 'White/Blue', 'casual', 38000000, 'Estilo clásico de baloncesto de los 80.'),
('NK-DUN-005', 'Nike', 'Dunk Low', 'Panda', 'casual', 48000000, 'El icono del baloncesto que domina las calles.'),
('NK-MET-006', 'Nike', 'Metcon 9', 'Grey/Volt', 'training', 55000000, 'Estabilidad y durabilidad para tus entrenamientos de fuerza.'),
('NB-550-007', 'New Balance', '550', 'White/Green', 'casual', 42000000, 'El regreso de una leyenda. Estilo retro simple y limpio.'),
('PU-VEL-008', 'Puma', 'Velophasis', 'Silver', 'casual', 39000000, 'Inspiradas en el running de los 2000.'),
('UA-CUR-009', 'Under Armour', 'Curry 11', 'Dub Nation', 'basketball', 62000000, 'Control total en la cancha con la tecnología Flow.'),
('NK-JOR-010', 'Jordan', 'Air Jordan 1 Low', 'Bred Toe', 'casual', 51000000, 'Un pedazo de historia. Siempre frescas.')
ON CONFLICT (sku) DO NOTHING;

-- Insert Variants for ALL products (World-Class Inventory)
-- NK-AIR-001 (Air Max 90)
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 39, 5 FROM products WHERE sku = 'NK-AIR-001' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 8 FROM products WHERE sku = 'NK-AIR-001' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 0 FROM products WHERE sku = 'NK-AIR-001' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 3 FROM products WHERE sku = 'NK-AIR-001' ON CONFLICT DO NOTHING;

-- NK-PEG-002 (Pegasus 40) - RUNNING
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 38, 5 FROM products WHERE sku = 'NK-PEG-002' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 39, 10 FROM products WHERE sku = 'NK-PEG-002' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 10 FROM products WHERE sku = 'NK-PEG-002' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 4 FROM products WHERE sku = 'NK-PEG-002' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 6 FROM products WHERE sku = 'NK-PEG-002' ON CONFLICT DO NOTHING;

-- AD-ULT-003 (Ultraboost Light) - RUNNING
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 3 FROM products WHERE sku = 'AD-ULT-003' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 5 FROM products WHERE sku = 'AD-ULT-003' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 2 FROM products WHERE sku = 'AD-ULT-003' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 43, 4 FROM products WHERE sku = 'AD-ULT-003' ON CONFLICT DO NOTHING;

-- AD-FOR-004 (Forum Low) - CASUAL
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 39, 6 FROM products WHERE sku = 'AD-FOR-004' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 8 FROM products WHERE sku = 'AD-FOR-004' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 4 FROM products WHERE sku = 'AD-FOR-004' ON CONFLICT DO NOTHING;

-- NK-DUN-005 (Dunk Low) - CASUAL
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 20 FROM products WHERE sku = 'NK-DUN-005' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 20 FROM products WHERE sku = 'NK-DUN-005' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 15 FROM products WHERE sku = 'NK-DUN-005' ON CONFLICT DO NOTHING;

-- NK-MET-006 (Metcon 9) - TRAINING
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 7 FROM products WHERE sku = 'NK-MET-006' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 5 FROM products WHERE sku = 'NK-MET-006' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 3 FROM products WHERE sku = 'NK-MET-006' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 43, 2 FROM products WHERE sku = 'NK-MET-006' ON CONFLICT DO NOTHING;

-- NB-550-007 (New Balance 550) - CASUAL
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 39, 4 FROM products WHERE sku = 'NB-550-007' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 6 FROM products WHERE sku = 'NB-550-007' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 5 FROM products WHERE sku = 'NB-550-007' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 3 FROM products WHERE sku = 'NB-550-007' ON CONFLICT DO NOTHING;

-- PU-VEL-008 (Puma Velophasis) - CASUAL
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 8 FROM products WHERE sku = 'PU-VEL-008' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 6 FROM products WHERE sku = 'PU-VEL-008' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 4 FROM products WHERE sku = 'PU-VEL-008' ON CONFLICT DO NOTHING;

-- UA-CUR-009 (Curry 11) - BASKETBALL
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 3 FROM products WHERE sku = 'UA-CUR-009' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 5 FROM products WHERE sku = 'UA-CUR-009' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 43, 4 FROM products WHERE sku = 'UA-CUR-009' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 44, 2 FROM products WHERE sku = 'UA-CUR-009' ON CONFLICT DO NOTHING;

-- NK-JOR-010 (Air Jordan 1 Low) - CASUAL
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 40, 5 FROM products WHERE sku = 'NK-JOR-010' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 41, 7 FROM products WHERE sku = 'NK-JOR-010' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 42, 4 FROM products WHERE sku = 'NK-JOR-010' ON CONFLICT DO NOTHING;
INSERT INTO product_variants (product_id, size, stock)
SELECT id, 43, 3 FROM products WHERE sku = 'NK-JOR-010' ON CONFLICT DO NOTHING;

-- Add a customer for testing
INSERT INTO customers (phone_e164, name, city) VALUES
('whatsapp:+12025550102', 'Usuario Test', 'Bogotá')
ON CONFLICT DO NOTHING;

-- Product Media (Fixed URLs for reliable delivery)
INSERT INTO product_media (product_id, media_type, url, storage_path, is_primary)
SELECT id, 'image', 'https://images.unsplash.com/photo-1549298916-b41d501d3772?auto=format&fit=crop&w=900&q=80', 'seed/jordan-1-low/red-black-sneaker.jpg', true FROM products WHERE model ILIKE '%1 Low%'; -- Jordan 1 Low

INSERT INTO product_media (product_id, media_type, url, storage_path, is_primary)
SELECT id, 'image', 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/23/Nike_Air_Max_90_Infrared_%284805905007%29.jpg/640px-Nike_Air_Max_90_Infrared_%284805905007%29.jpg', 'seed/air-max-90/infrared.jpg', true FROM products WHERE model ILIKE '%Air Max 90%'; -- Air Max 90

-- Colores canónicos por SKU (ver 20261026120000_product_colors.sql y
-- frontend/src/lib/colors.ts). Se derivan del colorway con una regla explícita:
-- se listan los colores visibles dominantes, no el nombre comercial.
UPDATE products AS p
SET colors = v.colors
FROM (VALUES
    ('NK-AIR-001', ARRAY['blanco', 'gris', 'rojo']::text[]),
    ('NK-PEG-002', ARRAY['negro', 'blanco']::text[]),
    ('AD-ULT-003', ARRAY['negro']::text[]),
    ('AD-FOR-004', ARRAY['blanco', 'azul']::text[]),
    ('NK-DUN-005', ARRAY['blanco', 'negro']::text[]),
    ('NK-MET-006', ARRAY['gris', 'verde']::text[]),
    ('NB-550-007', ARRAY['blanco', 'verde']::text[]),
    ('PU-VEL-008', ARRAY['plata', 'gris']::text[]),
    ('UA-CUR-009', ARRAY['azul', 'amarillo']::text[]),
    ('NK-JOR-010', ARRAY['negro', 'rojo']::text[])
) AS v(sku, colors)
WHERE p.sku = v.sku;

