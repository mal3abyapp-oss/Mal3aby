-- Fix: infinite recursion detected in policy for relation
-- "payment_allocations".
--
-- Real bug found while live-testing task #83: the three self-service
-- SELECT policies added in 20260817080000_invoices_self_service_select
-- each nested a join back through invoices (and payment_allocations
-- self-service through invoices, and payments self-service through
-- payment_allocations through invoices). When get_invoice_payment_summary()
-- runs a query that touches invoices and payment_allocations together
-- in one plan, Postgres's RLS policy evaluation for payment_allocations
-- re-triggers the invoices policy inside the same plan, which is
-- exactly the class of self-referential policy chain Postgres's planner
-- can detect as infinite recursion (42P17) even though the underlying
-- logic terminates -- confirmed live: calling the RPC as a staff user
-- 500'd with "infinite recursion detected in policy for relation
-- payment_allocations" the moment the RLS policies from the previous
-- migration existed, even though the RPC's own SQL never changed.
--
-- Fix: a SECURITY DEFINER helper (same convention as user_club_ids()/
-- has_permission()) that resolves "which invoice IDs belong to me as a
-- customer" WITHOUT going through RLS internally, so the policies on
-- payment_allocations/payments no longer nest back through invoices'
-- own RLS-evaluated SELECT.
create or replace function public.my_customer_invoice_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select i.id from public.invoices i
  join public.customers c on c.id = i.customer_id
  where c.user_id = auth.uid();
$$;

revoke execute on function public.my_customer_invoice_ids() from public, anon;
grant execute on function public.my_customer_invoice_ids() to authenticated;

comment on function public.my_customer_invoice_ids() is
  'SECURITY DEFINER helper (bypasses RLS internally, same convention as user_club_ids()) so payment_allocations/payments self-service SELECT policies do not nest back through invoices RLS and trigger 42P17 infinite recursion.';

drop policy if exists "payment_allocations_self_service_select" on public.payment_allocations;
create policy "payment_allocations_self_service_select" on public.payment_allocations
  for select using (invoice_id in (select public.my_customer_invoice_ids()));

drop policy if exists "payments_self_service_select" on public.payments;
create policy "payments_self_service_select" on public.payments
  for select using (
    id in (select pa.payment_id from public.payment_allocations pa where pa.invoice_id in (select public.my_customer_invoice_ids()))
  );
