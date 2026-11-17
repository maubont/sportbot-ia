-- Harden stock mutation RPCs exposed through PostgREST.
-- Edge Functions mutate stock with the service_role key; browser clients should
-- not execute these transactional helpers directly.

REVOKE ALL ON FUNCTION public.reserve_stock(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_stock(UUID, INT) FROM anon;
REVOKE ALL ON FUNCTION public.reserve_stock(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_stock(UUID, INT) TO service_role;

REVOKE ALL ON FUNCTION public.release_stock(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_stock(UUID, INT) FROM anon;
REVOKE ALL ON FUNCTION public.release_stock(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_stock(UUID, INT) TO service_role;

REVOKE ALL ON FUNCTION public.commit_stock(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_stock(UUID, INT) FROM anon;
REVOKE ALL ON FUNCTION public.commit_stock(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_stock(UUID, INT) TO service_role;

REVOKE ALL ON FUNCTION public.decrement_stock(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decrement_stock(UUID, INT) FROM anon;
REVOKE ALL ON FUNCTION public.decrement_stock(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.decrement_stock(UUID, INT) TO service_role;

REVOKE ALL ON FUNCTION public.increment_stock(UUID, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_stock(UUID, INT) FROM anon;
REVOKE ALL ON FUNCTION public.increment_stock(UUID, INT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_stock(UUID, INT) TO service_role;

REVOKE ALL ON FUNCTION public.release_order_stock(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_order_stock(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.release_order_stock(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.release_order_stock(UUID) TO service_role;

REVOKE ALL ON FUNCTION public.commit_order_stock(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.commit_order_stock(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.commit_order_stock(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.commit_order_stock(UUID) TO service_role;

NOTIFY pgrst, 'reload schema';
