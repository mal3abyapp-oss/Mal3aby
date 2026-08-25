-- Immediate follow-up to 20260825100000 in the same batch: the initial
-- get_my_portal_invoices() shape omitted customer_id/club_id, which the
-- frontend needs for the same active-club UX scoping PortalBookingsPage
-- already established (get_my_portal_invoices() has no club_id
-- parameter, so the frontend filters the returned rows to the active
-- club client-side -- a UX concern, not a security boundary, since the
-- RPC's WHERE clause already proves ownership for every row it returns
-- regardless of club).
--
-- Postgres refuses CREATE OR REPLACE when a RETURNS TABLE column list
-- changes ("cannot change return type of existing function... Row type
-- defined by OUT parameters is different"), confirmed live when this was
-- first attempted -- exactly this project's own "orphaned overload"/
-- signature-drift class. Fixed the only safe way: DROP FUNCTION first,
-- then CREATE, then explicitly re-grant (CREATE OR REPLACE never runs
-- here, so grants are never silently reset -- verified live before and
-- after: single overload, authenticated/postgres/service_role only, no
-- anon/public, both times).
drop function if exists public.get_my_portal_invoices();

create function public.get_my_portal_invoices()
returns table (
  invoice_id uuid,
  invoice_number text,
  total numeric,
  status text,
  issued_at timestamptz,
  created_at timestamptz,
  customer_id uuid,
  club_id uuid
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select i.id, i.invoice_number, i.total, i.status, i.issued_at, i.created_at, i.customer_id, i.club_id
  from public.invoices i
  where i.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
  order by i.created_at desc
  limit 30;
$function$;

revoke all on function public.get_my_portal_invoices() from public, anon;
grant execute on function public.get_my_portal_invoices() to authenticated;
