-- Add missing columns to media_files
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('inbound', 'outbound'));
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS transcription TEXT;

-- Update media_type if needed (existing is TEXT)
-- ALTER TABLE media_files ALTER COLUMN media_type TYPE TEXT;

-- Create storage bucket if not exists (via storage schema)
INSERT INTO storage.buckets (id, name, public)
VALUES ('whatsapp-media', 'whatsapp-media', false)
ON CONFLICT (id) DO NOTHING;

-- RLS for the new bucket
-- Allow authenticated users (admin) full access to whatsapp-media
CREATE POLICY "Admin Full Access whatsapp-media" ON storage.objects
FOR ALL USING (bucket_id = 'whatsapp-media' AND auth.role() = 'authenticated');
