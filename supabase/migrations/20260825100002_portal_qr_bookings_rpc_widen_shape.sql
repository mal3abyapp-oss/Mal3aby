-- Immediate follow-up to 20260825100000 in the same batch: the initial
-- get_my_portal_qr_bookings() shape omitted club_id, which PortalQrPage
-- needs for the same active-club UX scoping PortalBookingsPage/
-- PortalPaymentsPage already established (the RPC has no club_id
-- parameter, so the frontend filters the returned rows to the active
-- club client-side -- a UX concern, not a security boundary, since the
-- RPC's WHERE clause already proves ownership for every row it returns
-- regardless of club).
--
-- Same DROP FUNCTION + CREATE + explicit re-grant pattern as
-- 20260825100001 (Postgres refuses CREATE OR REPLACE across a RETURNS
-- TABLE column-list change) -- verified live before and after: single
-- overload, authenticated/postgres/service_role only, no anon/public,
-- both times.
drop function if exists public.get_my_portal_qr_bookings();

create function public.get_my_portal_qr_bookings()
returns table (
  booking_id uuid,
  start_at timestamptz,
  field_name text,
  club_id uuid
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select b.id, b.start_at, f.name, b.club_id
  from public.bookings b
  left join public.fields f on f.id = b.field_id
  where b.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
    and b.status in ('confirmed', 'pending_payment')
    and b.start_at >= now()
  order by b.start_at
  limit 20;
$function$;

revoke all on function public.get_my_portal_qr_bookings() from public, anon;
grant execute on function public.get_my_portal_qr_bookings() to authenticated;
