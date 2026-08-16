-- Follow-up to 20260817090000: the first fix only addressed
-- payment_allocations_self_service_select's own indirection through
-- invoices. The actual remaining cycle is cross-table:
--   payment_allocations_select_club_staff (pre-existing) -> queries payments
--   payments_self_service_select (new)                   -> queries payment_allocations
-- Postgres detects this mutual A->B->A policy reference as infinite
-- recursion (42P17) even though the underlying logic terminates.
-- Confirmed live: a plain `select amount from payment_allocations`
-- still 42P17'd after the previous migration, isolating the cycle to
-- this cross-table pair rather than the invoices indirection already
-- fixed.
--
-- Fix: resolve "which payment IDs are allocated to one of my
-- invoices" via the same SECURITY DEFINER pattern (bypasses RLS
-- internally, so it can query payment_allocations without ever
-- re-triggering that table's own policy evaluation).
create or replace function public.my_customer_payment_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select pa.payment_id from public.payment_allocations pa
  where pa.invoice_id in (select public.my_customer_invoice_ids());
$$;

revoke execute on function public.my_customer_payment_ids() from public, anon;
grant execute on function public.my_customer_payment_ids() to authenticated;

comment on function public.my_customer_payment_ids() is
  'SECURITY DEFINER helper: which payments.id rows are allocated to one of my own invoices. Exists specifically to break the payment_allocations_select_club_staff <-> payments_self_service_select cross-table RLS recursion (42P17) -- see migration comment for the exact cycle.';

drop policy if exists "payments_self_service_select" on public.payments;
create policy "payments_self_service_select" on public.payments
  for select using (id in (select public.my_customer_payment_ids()));
