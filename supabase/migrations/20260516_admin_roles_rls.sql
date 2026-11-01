-- Production baseline for admin authorization and RLS.
-- Edge Functions that use the service role keep bypassing RLS; browser clients do not.

CREATE TABLE IF NOT EXISTS public.admin_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'operator')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by UUID REFERENCES auth.users(id)
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_users au
        WHERE au.user_id = auth.uid()
    );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

REVOKE ALL ON public.admin_users FROM PUBLIC;
REVOKE ALL ON public.admin_users FROM anon;
GRANT SELECT ON public.admin_users TO authenticated;

DROP POLICY IF EXISTS "Admins read admin users" ON public.admin_users;
CREATE POLICY "Admins read admin users"
ON public.admin_users
FOR SELECT
TO authenticated
USING (public.is_admin());

DO $$
DECLARE
    owner_user_id UUID;
    owner_email CONSTANT TEXT := 'owner@example.test';
BEGIN
    SELECT id
    INTO owner_user_id
    FROM auth.users
    WHERE lower(email) = lower(owner_email)
    LIMIT 1;

    IF owner_user_id IS NULL THEN
        -- Antes esto abortaba la migracion (`RAISE EXCEPTION`), y como el
        -- usuario de Auth no existe en un entorno nuevo, el esquema entero era
        -- imposible de construir desde cero (local, CI o proyecto recien
        -- creado). Ahora avisa fuerte pero deja seguir: el owner se da de alta
        -- despues con un paso explicito y verificable.
        RAISE WARNING 'Owner admin % no existe en auth.users; se omite el alta en admin_users. Crear el usuario y reejecutar el alta.', owner_email;
        RETURN;
    END IF;

    INSERT INTO public.admin_users (user_id, email, role)
    VALUES (owner_user_id, owner_email, 'owner')
    ON CONFLICT (user_id)
    DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role;
END $$;

-- Keep RLS enabled on every table reached by browser clients.
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_media ENABLE ROW LEVEL SECURITY;

-- Remove previous broad policies.
DROP POLICY IF EXISTS "Public Read Products" ON public.products;
DROP POLICY IF EXISTS "Admin Write Products" ON public.products;
DROP POLICY IF EXISTS "Public Full Access Products" ON public.products;
DROP POLICY IF EXISTS "Public read active products" ON public.products;
DROP POLICY IF EXISTS "Admins manage products" ON public.products;

DROP POLICY IF EXISTS "Public Read Variants" ON public.product_variants;
DROP POLICY IF EXISTS "Admin Write Variants" ON public.product_variants;
DROP POLICY IF EXISTS "Public Full Access Variants" ON public.product_variants;
DROP POLICY IF EXISTS "Public read active product variants" ON public.product_variants;
DROP POLICY IF EXISTS "Admins manage product variants" ON public.product_variants;

DROP POLICY IF EXISTS "Admin Full Access Customers" ON public.customers;
DROP POLICY IF EXISTS "Public Full Access Customers" ON public.customers;
DROP POLICY IF EXISTS "Admins manage customers" ON public.customers;

DROP POLICY IF EXISTS "Admin Full Access Conversations" ON public.conversations;
DROP POLICY IF EXISTS "Public Full Access Conversations" ON public.conversations;
DROP POLICY IF EXISTS "Admins manage conversations" ON public.conversations;

DROP POLICY IF EXISTS "Admin Full Access Messages" ON public.messages;
DROP POLICY IF EXISTS "Public Full Access Messages" ON public.messages;
DROP POLICY IF EXISTS "Admins manage messages" ON public.messages;

DROP POLICY IF EXISTS "Admin Full Access Media" ON public.media_files;
DROP POLICY IF EXISTS "Admins manage media files" ON public.media_files;

DROP POLICY IF EXISTS "Admin Full Access Orders" ON public.orders;
DROP POLICY IF EXISTS "Public Full Access Orders" ON public.orders;
DROP POLICY IF EXISTS "Admins manage orders" ON public.orders;

DROP POLICY IF EXISTS "Admin Full Access Order Items" ON public.order_items;
DROP POLICY IF EXISTS "Public Full Access Order Items" ON public.order_items;
DROP POLICY IF EXISTS "Admins manage order items" ON public.order_items;

DROP POLICY IF EXISTS "Admin Full Access Payments" ON public.payments;
DROP POLICY IF EXISTS "Public Full Access Payments" ON public.payments;
DROP POLICY IF EXISTS "Admins manage payments" ON public.payments;

DROP POLICY IF EXISTS "Admin Full Access Settings" ON public.settings;
DROP POLICY IF EXISTS "Admins manage settings" ON public.settings;

DROP POLICY IF EXISTS "Public profiles are viewable by everyone" ON public.product_media;
DROP POLICY IF EXISTS "Public Read Product Media" ON public.product_media;
DROP POLICY IF EXISTS "Admin Full Access Product Media" ON public.product_media;
DROP POLICY IF EXISTS "Public read active product media" ON public.product_media;
DROP POLICY IF EXISTS "Admins manage product media" ON public.product_media;

-- Ver nota en 20251221_phase3_media.sql: `storage` no existe en local al migrar.
DO $storage$
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage no disponible: se omiten buckets/politicas de storage';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Public Access" ON storage.objects;
    DROP POLICY IF EXISTS "Public View Product Media Bucket" ON storage.objects;
    DROP POLICY IF EXISTS "Admin Manage Product Media Bucket" ON storage.objects;
    DROP POLICY IF EXISTS "Admin Full Access whatsapp-media" ON storage.objects;
    DROP POLICY IF EXISTS "Public view product media bucket" ON storage.objects;
    DROP POLICY IF EXISTS "Admins manage product media bucket" ON storage.objects;
    DROP POLICY IF EXISTS "Admins manage whatsapp media bucket" ON storage.objects;
END
$storage$;

-- Public catalog: anonymous users can only read active products and their public media.
CREATE POLICY "Public read active products"
ON public.products
FOR SELECT
TO anon, authenticated
USING (active = TRUE);

CREATE POLICY "Admins manage products"
ON public.products
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Public read active product variants"
ON public.product_variants
FOR SELECT
TO anon, authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.products p
        WHERE p.id = product_variants.product_id
          AND p.active = TRUE
    )
);

CREATE POLICY "Admins manage product variants"
ON public.product_variants
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Public read active product media"
ON public.product_media
FOR SELECT
TO anon, authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.products p
        WHERE p.id = product_media.product_id
          AND p.active = TRUE
    )
);

CREATE POLICY "Admins manage product media"
ON public.product_media
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Operational data: no public reads or writes from browser clients.
CREATE POLICY "Admins manage customers"
ON public.customers
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage conversations"
ON public.conversations
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage messages"
ON public.messages
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage media files"
ON public.media_files
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage orders"
ON public.orders
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage order items"
ON public.order_items
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage payments"
ON public.payments
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

CREATE POLICY "Admins manage settings"
ON public.settings
FOR ALL
TO authenticated
USING (public.is_admin())
WITH CHECK (public.is_admin());

-- Storage policies mirror table access.
-- Ver nota en 20251221_phase3_media.sql: `storage` no existe en local al migrar.
DO $storage$
BEGIN
    IF to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage no disponible: se omiten buckets/politicas de storage';
        RETURN;
    END IF;

    CREATE POLICY "Public view product media bucket"
    ON storage.objects
    FOR SELECT
    TO anon, authenticated
    USING (bucket_id = 'product-media');

    CREATE POLICY "Admins manage product media bucket"
    ON storage.objects
    FOR ALL
    TO authenticated
    USING (bucket_id = 'product-media' AND public.is_admin())
    WITH CHECK (bucket_id = 'product-media' AND public.is_admin());

    CREATE POLICY "Admins manage whatsapp media bucket"
    ON storage.objects
    FOR ALL
    TO authenticated
    USING (bucket_id = 'whatsapp-media' AND public.is_admin())
    WITH CHECK (bucket_id = 'whatsapp-media' AND public.is_admin());
END
$storage$;

NOTIFY pgrst, 'reload schema';
