-- PHASE 4: Product Images & Advanced Inventory Control
-- Consolidated Migration

-- 1. Product Media Table (Images)
CREATE TABLE IF NOT EXISTS product_media (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    storage_path TEXT NOT NULL,
    media_type TEXT DEFAULT 'image',
    is_primary BOOLEAN DEFAULT FALSE,
    created_at TIMESTamptZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_media_product ON product_media(product_id);
ALTER TABLE product_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public Read Product Media" ON product_media FOR SELECT USING (true);
CREATE POLICY "Admin Full Access Product Media" ON product_media FOR ALL USING (true) WITH CHECK (true);


-- 2. Storage Bucket Configuration
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-media', 'product-media', true)
ON CONFLICT (id) DO UPDATE SET public = true;

CREATE POLICY "Public View Product Media Bucket" ON storage.objects FOR SELECT USING (bucket_id = 'product-media');
CREATE POLICY "Admin Manage Product Media Bucket" ON storage.objects FOR ALL USING (bucket_id = 'product-media');


-- 3. Atomic Inventory Control (RPC Functions)
-- Use FOR UPDATE to prevent Race Conditions

-- Function: Decrement Stock (Reserve)
CREATE OR REPLACE FUNCTION decrement_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    current_stock INT;
    new_stock INT;
BEGIN
    SELECT stock INTO current_stock FROM product_variants WHERE id = row_id FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Variant not found';
    END IF;

    IF current_stock < amount THEN
        RAISE EXCEPTION 'Insufficient stock. Available: %, Requested: %', current_stock, amount;
    END IF;

    new_stock := current_stock - amount;
    UPDATE product_variants SET stock = new_stock WHERE id = row_id;

    RETURN new_stock;
END;
$$;

-- Function: Increment Stock (Restock/Return)
CREATE OR REPLACE FUNCTION increment_stock(row_id UUID, amount INT)
RETURNS INT
LANGUAGE plpgsql
AS $$
DECLARE
    new_stock INT;
BEGIN
    UPDATE product_variants SET stock = stock + amount WHERE id = row_id RETURNING stock INTO new_stock;

    IF NOT FOUND THEN
         RAISE EXCEPTION 'Variant not found';
    END IF;

    RETURN new_stock;
END;
$$;

-- Refresh Schema Cache
NOTIFY pgrst, 'reload config';
