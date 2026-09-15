-- AUDIT ROUND 2 FINDING #5: PortalQrPage.tsx's booking selector date
-- label used bare `toLocaleDateString` (browser-local timezone) instead
-- of the club's own venue timezone, unlike every other date/time
-- display in the portal (PortalBookingsPage via formatInstant(), Secure
-- Booking Page/staff calendar/WhatsApp messages all resolve the club's
-- real IANA timezone server-side and format against it). Confirmed
-- get_my_portal_qr_bookings() never returned a timezone column at all
-- (20260825100002_portal_qr_bookings_rpc_widen_shape.sql) -- there was
-- no club-scoped timezone value on the frontend for this screen to use
-- even if it wanted to.
--
-- Fix: widen the return table by exactly one column, cl.timezone (a
-- new join to `clubs` via the booking's own club_id -- the same table/
-- column SecureBookingPage's get_public_booking_context() already joins
-- for its own `tz` value). No WHERE-clause/ownership-check change.
--
-- Same DROP FUNCTION + CREATE pattern as the prior widening of this
-- function (RETURNS TABLE column-list changes cannot use CREATE OR
-- REPLACE).
drop function if exists public.get_my_portal_qr_bookings();

create function public.get_my_portal_qr_bookings()
returns table (
  booking_id uuid,
  start_at timestamptz,
  field_name text,
  club_id uuid,
  timezone text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select b.id, b.start_at, f.name, b.club_id, cl.timezone
  from public.bookings b
  left join public.fields f on f.id = b.field_id
  join public.clubs cl on cl.id = b.club_id
  where b.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
    and b.status in ('confirmed', 'pending_payment')
    and b.start_at >= now()
  order by b.start_at
  limit 20;
$function$;

revoke all on function public.get_my_portal_qr_bookings() from public, anon;
grant execute on function public.get_my_portal_qr_bookings() to authenticated;
