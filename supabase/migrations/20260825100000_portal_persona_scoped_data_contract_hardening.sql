-- PORTAL PERSONA-SCOPED DATA CONTRACT HARDENING (follow-up to
-- 20260825090000_portal_cross_persona_authorization_fix.sql).
--
-- That migration closed the live cross-persona leak by moving customer
-- IDENTITY resolution (get_my_portal_customers()) server-side. But
-- PortalBookingsPage/PortalPaymentsPage/PortalAcademyPage/PortalQrPage
-- still read `bookings`/`invoices`/`guardian_links` directly from the
-- client with a `.eq('customer_id', ...)`/`.in('customer_id', ...)`
-- FRONTEND filter -- correct today, but not itself a security boundary:
-- it depends entirely on every current and future Portal code path
-- remembering to apply it correctly, with RLS's OR-combined staff
-- policies sitting immediately behind it as a silent fallback the moment
-- that filter is ever dropped, widened, or bypassed by a crafted client
-- request (the exact failure mode of the original bug).
--
-- This migration makes the remaining sensitive Portal ownership data
-- contracts themselves persona-scoped, not just their current callers:
-- four new SECURITY DEFINER RPCs, each hard-coded to
-- customers.user_id = auth.uid() in its own SQL body -- never
-- has_permission()/user_club_ids()/email/phone, and never delegating to
-- ambient RLS. A client cannot get staff-scoped rows out of these RPCs
-- no matter what it sends, because the RPC bodies contain no parameter
-- or code path that reaches outside the caller's own linked customer
-- id(s).
--
-- SAFE PUBLIC CONFIG reads (clubs directory, payment_method_configs)
-- are deliberately left as direct table reads -- they carry no
-- customer-identity or ownership data, and RLS on payment_method_configs
-- already independently restricts to is_active/customer_visible rows;
-- narrowing these further would be scope creep against a boundary that
-- was never at risk. The small number of remaining `.select('club_id')
-- .eq('id', <a specific already-known booking/invoice id>)` deep-link
-- disambiguation lookups are also left as direct reads: they return only
-- a non-sensitive club_id for one id the caller already possesses (never
-- a listing), and RLS still bounds them to rows the caller can see.

-- get_my_portal_bookings(): mirrors PortalBookingsPage.fetchMyBookings's
-- exact required shape (id, timing, status, price, invoice linkage,
-- field/branch/club display names).
create or replace function public.get_my_portal_bookings()
returns table (
  booking_id uuid,
  start_at timestamptz,
  end_at timestamptz,
  status text,
  total_price numeric,
  invoice_id uuid,
  club_id uuid,
  club_name_ar text,
  club_timezone text,
  field_name text,
  branch_id uuid,
  branch_name text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select b.id, b.start_at, b.end_at, b.status, b.total_price, b.invoice_id, b.club_id,
         cl.name_ar, cl.timezone, f.name, f.branch_id, br.name
  from public.bookings b
  join public.clubs cl on cl.id = b.club_id
  left join public.fields f on f.id = b.field_id
  left join public.branches br on br.id = f.branch_id
  where b.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
  order by b.start_at desc
  limit 50;
$function$;

revoke all on function public.get_my_portal_bookings() from public, anon;
grant execute on function public.get_my_portal_bookings() to authenticated;

-- get_my_portal_invoices(): mirrors PortalPaymentsPage.fetchMyInvoices's
-- required shape. Payment/outstanding totals are deliberately NOT
-- computed here -- the frontend continues to call the existing shared
-- get_invoice_payment_summary() RPC (Master Payment Directive task #81's
-- single source of truth) for that, unchanged, so this stays a thin
-- identity-scoped listing rather than duplicating financial math.
-- NOTE: this initial shape was widened one migration later
-- (20260825100001_portal_invoices_rpc_widen_shape.sql, same batch) to
-- add customer_id/club_id -- kept here unchanged to match exactly what
-- was actually applied to production first, per this project's own
-- "Git reflects the real applied sequence" discipline.
create function public.get_my_portal_invoices()
returns table (
  invoice_id uuid,
  invoice_number text,
  total numeric,
  status text,
  issued_at timestamptz,
  created_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select i.id, i.invoice_number, i.total, i.status, i.issued_at, i.created_at
  from public.invoices i
  where i.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
  order by i.created_at desc
  limit 30;
$function$;

revoke all on function public.get_my_portal_invoices() from public, anon;
grant execute on function public.get_my_portal_invoices() to authenticated;

-- get_my_portal_qr_bookings(): mirrors PortalQrPage.fetchUpcomingBookings's
-- required shape (upcoming, confirmed/pending_payment bookings only).
-- NOTE: widened one migration later (20260825100002, same batch) to add
-- club_id -- kept here unchanged to match exactly what was actually
-- applied to production first.
create function public.get_my_portal_qr_bookings()
returns table (
  booking_id uuid,
  start_at timestamptz,
  field_name text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select b.id, b.start_at, f.name
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

-- get_my_portal_academy(): mirrors PortalAcademyPage.fetchMyPlayers's
-- required shape (every player this account is a guardian of, via
-- guardian_links -> customers.user_id, with active enrollment/
-- subscription status). Returns one row per (player, enrollment) so the
-- frontend's existing "every active enrollment as its own row" fix
-- (Phase 10 IA restructuring) keeps working unchanged.
create or replace function public.get_my_portal_academy()
returns table (
  player_id uuid,
  player_full_name text,
  player_photo_url text,
  enrollment_id uuid,
  enrollment_status text,
  group_name text,
  subscription_status text,
  subscription_end_date date
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select p.id, p.full_name, p.photo_url, e.id, e.status, g.name, s.status, s.end_date
  from public.players p
  join public.guardian_links gl on gl.player_id = p.id
  join public.customers c on c.id = gl.customer_id
  left join public.enrollments e on e.player_id = p.id
  left join public.groups g on g.id = e.group_id
  left join public.subscriptions s on s.enrollment_id = e.id
  where c.user_id = auth.uid();
$function$;

revoke all on function public.get_my_portal_academy() from public, anon;
grant execute on function public.get_my_portal_academy() to authenticated;
