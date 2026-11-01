-- =============================================================================
-- BASELINE - esquema inicial del proyecto
--
-- Copia literal de `supabase/schema.sql` (13 tablas, RLS y politicas base).
-- Existe porque la migracion 20251221_phase3_media.sql ya hace ALTER sobre
-- `media_files`, que solo se creaba pegando schema.sql a mano en el dashboard.
-- Sin este archivo, ni `supabase start` ni `supabase db push` pueden construir
-- el esquema desde cero.
--
-- NO EDITAR: es historia congelada. Los cambios nuevos van en una migracion
-- con fecha posterior.
-- =============================================================================
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. PRODUCTS
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku TEXT UNIQUE NOT NULL,
    brand TEXT NOT NULL,
    model TEXT NOT NULL,
    colorway TEXT,
    category TEXT, -- running/casual/basketball/training
    price_cents INTEGER NOT NULL,
    description TEXT,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 2. PRODUCT VARIANTS (Inventory by size)
CREATE TABLE IF NOT EXISTS product_variants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id UUID REFERENCES products(id) ON DELETE CASCADE,
    size NUMERIC NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
    reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW(),
    CONSTRAINT product_variants_reserved_not_above_stock CHECK (reserved <= stock)
);
CREATE INDEX idx_variants_product_size ON product_variants(product_id, size);
CREATE UNIQUE INDEX idx_product_variants_product_size_unique ON product_variants(product_id, size);

-- 2b. PRODUCT COSTS (Admin-only unit economics)
CREATE TABLE IF NOT EXISTS product_costs (
    product_id UUID PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    default_unit_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (default_unit_cost_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'COP',
    source TEXT NOT NULL DEFAULT 'manual',
    notes TEXT,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 3. CUSTOMERS
CREATE TABLE IF NOT EXISTS customers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_e164 TEXT UNIQUE NOT NULL, -- "whatsapp:+57..."
    name TEXT,
    city TEXT,
    notes TEXT,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 4. CONVERSATIONS
CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    channel TEXT DEFAULT 'whatsapp',
    status TEXT DEFAULT 'open', -- open, closed
    last_message_at TIMESTamptZ DEFAULT NOW(),
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);
CREATE INDEX idx_conversations_customer ON conversations(customer_id);

-- 5. MESSAGES
CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'agent', 'system')),
    body TEXT,
    raw_payload JSONB, -- store full Twilio payload for debugging
    twilio_message_sid TEXT,
    created_at TIMESTamptZ DEFAULT NOW()
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);

-- 6. MEDIA FILES
CREATE TABLE IF NOT EXISTS media_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL, -- image, audio, video, document, application/pdf
    content_type TEXT,
    source_url TEXT, -- Twilio MediaUrl
    storage_bucket TEXT,
    storage_path TEXT,
    public_url TEXT,
    bytes INTEGER,
    created_at TIMESTamptZ DEFAULT NOW()
);

-- 7. ORDERS
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'draft', -- draft, awaiting_payment, paid, cancelled, shipped
    shipping_name TEXT,
    shipping_phone TEXT,
    shipping_address TEXT,
    shipping_city TEXT,
    shipping_region TEXT,
    shipping_cost_cents INTEGER DEFAULT 0,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    total_cents INTEGER NOT NULL DEFAULT 0,
    payment_reference TEXT UNIQUE, -- Wompi reference
    paid_at TIMESTAMPTZ,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 8. ORDER ITEMS
CREATE TABLE IF NOT EXISTS order_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    variant_id UUID REFERENCES product_variants(id),
    qty INTEGER DEFAULT 1,
    unit_price_cents INTEGER,
    unit_cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTamptZ DEFAULT NOW()
);

-- 9. ORDER VARIABLE COSTS
CREATE TABLE IF NOT EXISTS order_variable_costs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    cost_type TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    currency TEXT NOT NULL DEFAULT 'COP',
    source TEXT NOT NULL DEFAULT 'manual',
    external_ref TEXT,
    occurred_at TIMESTamptZ DEFAULT NOW(),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 10. ORDER ECONOMICS
CREATE TABLE IF NOT EXISTS order_economics (
    order_id UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    currency TEXT NOT NULL DEFAULT 'COP',
    revenue_cents INTEGER NOT NULL DEFAULT 0,
    subtotal_cents INTEGER NOT NULL DEFAULT 0,
    shipping_charged_cents INTEGER NOT NULL DEFAULT 0,
    cogs_cents INTEGER NOT NULL DEFAULT 0,
    payment_fee_cents INTEGER NOT NULL DEFAULT 0,
    shipping_real_cost_cents INTEGER NOT NULL DEFAULT 0,
    packaging_cost_cents INTEGER NOT NULL DEFAULT 0,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    twilio_cost_cents INTEGER NOT NULL DEFAULT 0,
    ai_cost_cents INTEGER NOT NULL DEFAULT 0,
    other_variable_cost_cents INTEGER NOT NULL DEFAULT 0,
    variable_cost_cents INTEGER NOT NULL DEFAULT 0,
    gross_margin_cents INTEGER NOT NULL DEFAULT 0,
    contribution_margin_cents INTEGER NOT NULL DEFAULT 0,
    contribution_margin_bps INTEGER NOT NULL DEFAULT 0,
    data_quality_flags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    calculated_at TIMESTamptZ DEFAULT NOW(),
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 11. PAYMENTS
CREATE TABLE IF NOT EXISTS payments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id UUID REFERENCES orders(id) ON DELETE CASCADE,
    provider TEXT DEFAULT 'wompi',
    reference TEXT NOT NULL, -- matches order.payment_reference
    transaction_id TEXT, -- Wompi transaction ID
    status TEXT DEFAULT 'pending', -- pending, approved, declined, voided, error
    approved_at TIMESTAMPTZ,
    raw_event JSONB,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW()
);

-- 12. SETTINGS (Singleton)
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    store_name TEXT DEFAULT 'SportBot Store',
    timezone TEXT DEFAULT 'America/Bogota',
    welcome_message TEXT DEFAULT 'Hola! Bienvenido a SportBot 👟',
    system_prompt TEXT,
    storefront_url TEXT,
    welcome_image_url TEXT,
    catalog_pdf_url TEXT,
    llm_provider TEXT DEFAULT 'openai',
    stt_provider TEXT DEFAULT 'openai',
    twilio_whatsapp_number TEXT,
    twilio_status TEXT DEFAULT 'active',
    fulfillment_sla_hours INTEGER DEFAULT 24,
    delivery_sla_hours INTEGER DEFAULT 72,
    wompi_public_key TEXT,
    wompi_integrity_secret TEXT,
    wompi_event_secret TEXT,
    created_at TIMESTamptZ DEFAULT NOW(),
    updated_at TIMESTamptZ DEFAULT NOW(),
    CONSTRAINT match_single_row CHECK (id = 1),
    CONSTRAINT settings_fulfillment_sla_hours_positive CHECK (fulfillment_sla_hours IS NULL OR fulfillment_sla_hours > 0),
    CONSTRAINT settings_delivery_sla_hours_positive CHECK (delivery_sla_hours IS NULL OR delivery_sla_hours > 0)
);

-- Insert default settings if not exists
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;

-- ENABLE ROW LEVEL SECURITY
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_variable_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_economics ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- POLICIES
-- NOTE: Edge Functions use SERVICE_ROLE_KEY which bypasses RLS.
-- These policies are mainly for the Admin UI (authenticated users) or public read (if applicable).

-- 1. Products: Public Read, Admin Write
CREATE POLICY "Public Read Products" ON products FOR SELECT USING (true);
CREATE POLICY "Admin Write Products" ON products FOR ALL USING (auth.role() = 'authenticated');

-- 2. Product Variants: Public Read, Admin Write
CREATE POLICY "Public Read Variants" ON product_variants FOR SELECT USING (true);
CREATE POLICY "Admin Write Variants" ON product_variants FOR ALL USING (auth.role() = 'authenticated');

-- 3. Customers: Admin Full Access
CREATE POLICY "Admin Full Access Customers" ON customers FOR ALL USING (auth.role() = 'authenticated');

-- 4. Conversations: Admin Full Access
CREATE POLICY "Admin Full Access Conversations" ON conversations FOR ALL USING (auth.role() = 'authenticated');

-- 5. Messages: Admin Full Access
CREATE POLICY "Admin Full Access Messages" ON messages FOR ALL USING (auth.role() = 'authenticated');

-- 6. Media: Admin Full Access (Reading public URLs is handled by Storage Buckets, not Table RLS usually, but for metadata:)
CREATE POLICY "Admin Full Access Media" ON media_files FOR ALL USING (auth.role() = 'authenticated');

-- 7. Orders: Admin Full Access
CREATE POLICY "Admin Full Access Orders" ON orders FOR ALL USING (auth.role() = 'authenticated');

-- 8. Order Items: Admin Full Access
CREATE POLICY "Admin Full Access Order Items" ON order_items FOR ALL USING (auth.role() = 'authenticated');

-- 9. Product Costs: Admin Full Access
CREATE POLICY "Admin Full Access Product Costs" ON product_costs FOR ALL USING (auth.role() = 'authenticated');

-- 10. Order Variable Costs: Admin Full Access
CREATE POLICY "Admin Full Access Order Variable Costs" ON order_variable_costs FOR ALL USING (auth.role() = 'authenticated');

-- 11. Order Economics: Admin Full Access
CREATE POLICY "Admin Full Access Order Economics" ON order_economics FOR ALL USING (auth.role() = 'authenticated');

-- 12. Payments: Admin Full Access
CREATE POLICY "Admin Full Access Payments" ON payments FOR ALL USING (auth.role() = 'authenticated');

-- 13. Settings: Admin Full Access
CREATE POLICY "Admin Full Access Settings" ON settings FOR ALL USING (auth.role() = 'authenticated');

-- STORAGE BUCKETS (Script cannot create buckets via SQL directly in all Supabase versions, but usually done via dashboard or client)
-- Placeholder comment: Create 'media' bucket public.
