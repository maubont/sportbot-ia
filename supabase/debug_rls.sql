-- TEMPORARILY DISABLE RLS FOR DEBUGGING
-- Or create permissive policies

alter table public.settings disable row level security;
alter table public.customers disable row level security;
alter table public.products disable row level security;
alter table public.product_variants disable row level security;
alter table public.conversations disable row level security;
alter table public.messages disable row level security;
alter table public.orders disable row level security;
alter table public.order_items disable row level security;
alter table public.payments disable row level security;

-- Alternatively:
-- create policy "Enable read for anon" on public.products for select using (true);
