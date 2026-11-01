-- Least privilege: mutating SECURITY DEFINER functions are service-role only.
-- Supabase grants EXECUTE to anon/authenticated by default; REVOKE FROM PUBLIC
-- alone does not remove those explicit grants. This closes that gap and also
-- removes anon table-level writes that RLS was masking.

REVOKE EXECUTE ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT) FROM anon, authenticated, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_order_logistics_from_shipment() FROM anon, authenticated, PUBLIC;

GRANT EXECUTE ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT) TO service_role;

-- Public catalog stays readable; everything else stops being writable by anon.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
GRANT SELECT ON TABLE public.products, public.product_variants, public.product_media TO anon;

-- Future objects must opt in explicitly, instead of inheriting Supabase defaults.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;

COMMENT ON FUNCTION public.create_order_atomic(UUID, JSONB, JSONB, TEXT)
IS 'Service-role only. Creates an order and reserves stock atomically; no anon/authenticated EXECUTE.';
COMMENT ON FUNCTION public.claim_inbound_message(TEXT, TEXT, UUID)
IS 'Service-role only. Deduplicates inbound messages; no anon/authenticated EXECUTE.';
COMMENT ON FUNCTION public.finish_inbound_message(TEXT, TEXT, TEXT, TEXT)
IS 'Service-role only. Finalizes inbound message processing; no anon/authenticated EXECUTE.';
