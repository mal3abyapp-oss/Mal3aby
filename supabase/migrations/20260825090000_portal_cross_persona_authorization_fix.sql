-- PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY (HIGH, confirmed live
-- in production, 2026-08-25).
--
-- ROOT CAUSE: every Customer Portal query (PortalClubProvider.
-- fetchMyCustomerMemberships, PortalRoot.fetchMyLinkedCustomerCount,
-- PortalProfilePage.fetchMyCustomerRecords) queried `customers` with ZERO
-- filter, relying entirely on RLS to scope the result to "rows this
-- auth.uid() owns" via customers_self_service_select (user_id =
-- auth.uid()). That assumption silently breaks for any account that is
-- ALSO staff somewhere: Postgres OR-combines every applicable SELECT
-- policy, so customers_select_club_staff (club_id IN user_club_ids() AND
-- has_permission('customer.view', club_id)) applies to the SAME query,
-- and a staff member's Portal session ends up receiving their entire
-- club's customer roster instead of their own linked record. The same
-- flaw affected PortalBookingsPage/PortalPaymentsPage/PortalQrPage: their
-- existing `.eq('club_id', clubId)` filter (added by a prior, separate
-- multi-club fix) is NOT sufficient, because bookings_select_club_staff/
-- invoices_select_club_staff are ALSO club_id-scoped -- confirmed live via
-- a real authenticated REST call using the real staff+portal session's own
-- JWT (no impersonation): GET /customers returned the whole club roster;
-- GET /invoices?club_id=eq.<club> returned 5 real unrelated invoices.
--
-- FIX: a canonical, SECURITY DEFINER, hard-coded-to-user_id RPC that is
-- the ONLY safe way to resolve "which customer records does this session
-- actually own" -- it checks customers.user_id = auth.uid() directly in
-- its own SQL body, never delegating to RLS's OR-combined policy set,
-- and never consulting has_permission()/user_club_ids() at all. Every
-- Portal screen must derive its customer_id allowlist from THIS RPC's
-- result, then filter bookings/invoices by `customer_id IN (...)` against
-- that allowlist -- an explicit ownership-proven filter, not an ambient
-- RLS assumption. Table-level RLS remains the tenant/cross-club backstop
-- (unchanged, not weakened here), but is no longer the sole authorization
-- boundary for Portal identity resolution.
create or replace function public.get_my_portal_customers()
returns table (
  customer_id uuid,
  club_id uuid,
  club_name text,
  club_name_ar text,
  full_name text,
  mobile_display text,
  email text,
  whatsapp text
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select c.id, c.club_id, cl.name, cl.name_ar, c.full_name, c.mobile_display, c.email, c.whatsapp
  from public.customers c
  join public.clubs cl on cl.id = c.club_id
  where c.user_id = auth.uid();
$function$;

revoke all on function public.get_my_portal_customers() from public, anon;
grant execute on function public.get_my_portal_customers() to authenticated;
