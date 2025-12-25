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

-- Policies for public reading
CREATE POLICY "Public profiles are viewable by everyone" ON product_media
    FOR SELECT USING (true);

-- Storage bucket for products
-- Note: This is usually done via Supabase Dashboard or API, 
-- but we can reference it here for documentation.
-- INSERT INTO storage.buckets (id, name, public) VALUES ('product-media', 'product-media', true);
