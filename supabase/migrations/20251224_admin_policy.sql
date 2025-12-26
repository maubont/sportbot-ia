-- Enable RLS (Ensure it is enabled)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;

-- Allow Public/Anon Read/Write access (TEMPORARY FOR DEV/AUDIT)
-- This is necessary because Admin Panel Auth is currently bypassed (using anon key).
DROP POLICY IF EXISTS "Public Full Access Products" ON products;
CREATE POLICY "Public Full Access Products" ON products 
FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public Full Access Variants" ON product_variants;
CREATE POLICY "Public Full Access Variants" ON product_variants 
FOR ALL USING (true) WITH CHECK (true);
