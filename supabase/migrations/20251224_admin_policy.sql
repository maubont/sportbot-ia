-- Enable RLS (Ensure it is enabled)
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- Allow Public/Anon Read/Write access (TEMPORARY FOR DEV/AUDIT)
-- This is necessary because Admin Panel Auth is currently bypassed (using anon key).

-- 1. Products & Inventory
DROP POLICY IF EXISTS "Public Full Access Products" ON products;
CREATE POLICY "Public Full Access Products" ON products FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public Full Access Variants" ON product_variants;
CREATE POLICY "Public Full Access Variants" ON product_variants FOR ALL USING (true) WITH CHECK (true);

-- 2. Orders & Sales
DROP POLICY IF EXISTS "Public Full Access Orders" ON orders;
CREATE POLICY "Public Full Access Orders" ON orders FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public Full Access Order Items" ON order_items;
CREATE POLICY "Public Full Access Order Items" ON order_items FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public Full Access Payments" ON payments;
CREATE POLICY "Public Full Access Payments" ON payments FOR ALL USING (true) WITH CHECK (true);

-- 3. Customers
DROP POLICY IF EXISTS "Public Full Access Customers" ON customers;
CREATE POLICY "Public Full Access Customers" ON customers FOR ALL USING (true) WITH CHECK (true);

-- 4. Communications (Chats)
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public Full Access Conversations" ON conversations;
CREATE POLICY "Public Full Access Conversations" ON conversations FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Public Full Access Messages" ON messages;
CREATE POLICY "Public Full Access Messages" ON messages FOR ALL USING (true) WITH CHECK (true);
