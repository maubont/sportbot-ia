-- Create product_media table
CREATE TABLE IF NOT EXISTS product_media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    type VARCHAR(20) NOT NULL CHECK (type IN ('image', 'pdf', 'video')),
    url TEXT NOT NULL,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS
ALTER TABLE product_media ENABLE ROW LEVEL SECURITY;

-- Policies (Drop first to avoid "already exists" error)
DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON product_media;
CREATE POLICY "Public profiles are viewable by everyone" ON product_media FOR SELECT USING (true);

-- Storage bucket (Idempotent)
INSERT INTO storage.buckets (id, name, public) 
VALUES ('product-media', 'product-media', true)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Public Access" ON storage.objects;
CREATE POLICY "Public Access" ON storage.objects FOR SELECT USING (bucket_id = 'product-media');

-- SEED DATA FOR IMAGES (Using SKUs to find IDs)
DO $$
DECLARE
    vid UUID;
BEGIN
    -- 1. Nike Air Max 90 (NK-AIR-001)
    SELECT id INTO vid FROM products WHERE sku = 'NK-AIR-001';
    IF vid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_media WHERE product_id = vid AND type = 'image') THEN
        INSERT INTO product_media (product_id, type, url, is_primary)
        VALUES (vid, 'image', 'https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/cnlp15bsl0k1s8i6v567/air-max-90-zapatillas-6n3vKB.png', true);
    END IF;

    -- 2. Nike Pegasus 40 (NK-PEG-002)
    SELECT id INTO vid FROM products WHERE sku = 'NK-PEG-002';
    IF vid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_media WHERE product_id = vid AND type = 'image') THEN
        INSERT INTO product_media (product_id, type, url, is_primary)
        VALUES (vid, 'image', 'https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/8db63f68-52cb-45ec-8973-19df1f057861/pegasus-40-zapatillas-de-running-asfalto-DhzXpk.png', true);
    END IF;

    -- 3. Jordan 1 Low (NK-JOR-010)
    SELECT id INTO vid FROM products WHERE sku = 'NK-JOR-010';
    IF vid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_media WHERE product_id = vid AND type = 'image') THEN
        INSERT INTO product_media (product_id, type, url, is_primary)
        VALUES (vid, 'image', 'https://static.nike.com/a/images/t_PDP_1280_v1/f_auto,q_auto:eco/55df58c6-a690-444f-a89e-4e6267756f84/air-jordan-1-low-zapatillas-HjWp74.png', true);
    END IF;
    
    -- 4. Curry 11 (UA-CUR-009)
    SELECT id INTO vid FROM products WHERE sku = 'UA-CUR-009';
    IF vid IS NOT NULL AND NOT EXISTS (SELECT 1 FROM product_media WHERE product_id = vid AND type = 'image') THEN
        INSERT INTO product_media (product_id, type, url, is_primary)
        VALUES (vid, 'image', 'https://underarmour.scene7.com/is/image/Underarmour/3026615-100_DEFAULT?rp=standard-0pad|pdpMainDesktop&scl=1&fmt=jpg&qlt=85', true);
    END IF;
END $$;
