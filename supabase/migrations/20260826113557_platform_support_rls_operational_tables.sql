-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- RLS extension across the
-- operational tables the mandated E2E test requires (directive Section 8:
-- Staff/Roles/Bookings/Academy/Club Memberships/Customers/Finance-read).
-- Every policy here is PURELY ADDITIVE (RLS policies are OR'd) -- no
-- existing policy on any of these tables is touched, dropped, or
-- replaced. Each new policy calls the single centralized
-- has_platform_support_access(club_id[, true]) helper -- never re-derives
-- the session-lookup logic inline (directive Section 6/21).
--
-- Finance tables (invoices/payments/payment_allocations) get SELECT-only
-- support-session policies, deliberately, regardless of mode -- Master
-- Admin must never become an accounting bypass (directive Section 11).
-- Note: invoices/customers/bookings already carry a separate, pre-existing
-- `*_platform_owner_select` policy (is_platform_owner() alone, no session
-- scoping) -- that is untouched, pre-existing behavior from before this
-- feature and out of this migration's scope to alter; this migration adds
-- session-scoped policies alongside it without weakening or duplicating it.

-- club_memberships (Staff) -- read via VIEW mode, write (role assignment)
-- requires MANAGE mode.
create policy club_memberships_platform_support_select
  on public.club_memberships for select
  using (public.has_platform_support_access(club_id));

create policy club_memberships_platform_support_write
  on public.club_memberships for update
  using (public.has_platform_support_access(club_id, true))
  with check (public.has_platform_support_access(club_id, true));

-- bookings -- read via VIEW mode; write (existing booking-management RPCs
-- go through has_permission()-gated paths already, but a direct-table
-- UPDATE policy is added for completeness/consistency with the other
-- MANAGE-mode-write tables here).
create policy bookings_platform_support_select
  on public.bookings for select
  using (public.has_platform_support_access(club_id));

create policy bookings_platform_support_write
  on public.bookings for update
  using (public.has_platform_support_access(club_id, true))
  with check (public.has_platform_support_access(club_id, true));

-- Academy: enrollments/groups/subscriptions -- read-only via VIEW mode
-- (mandated E2E test item 10 only requires read access).
create policy enrollments_platform_support_select
  on public.enrollments for select
  using (public.has_platform_support_access(club_id));

create policy groups_platform_support_select
  on public.groups for select
  using (public.has_platform_support_access(club_id));

create policy subscriptions_platform_support_select
  on public.subscriptions for select
  using (public.has_platform_support_access(club_id));

-- Club Memberships (the commercial domain): plans + subscriptions --
-- read via VIEW mode; the sell/renew/freeze/cancel RPCs are widened in a
-- separate migration to accept has_platform_support_access(club_id, true)
-- alongside their existing has_permission() check, so a direct write
-- policy here is not required for those flows to work in MANAGE mode.
create policy club_membership_plans_platform_support_select
  on public.club_membership_plans for select
  using (public.has_platform_support_access(club_id));

create policy club_membership_subscriptions_platform_support_select
  on public.club_membership_subscriptions for select
  using (public.has_platform_support_access(club_id));

-- Customers -- read-only via VIEW mode (mandated E2E test item 12).
create policy customers_platform_support_select
  on public.customers for select
  using (public.has_platform_support_access(club_id));

-- Finance: invoices/payments/payment_allocations -- SELECT-ONLY,
-- deliberately, regardless of VIEW or MANAGE mode. No write policy is
-- added for any of these three tables in this migration, ever -- this is
-- a permanent restriction, not a gap to fill later (directive Section 11).
create policy invoices_platform_support_select
  on public.invoices for select
  using (public.has_platform_support_access(club_id));

create policy payments_platform_support_select
  on public.payments for select
  using (public.has_platform_support_access(club_id));

-- payment_allocations has no direct club_id column -- scope via its
-- invoice_id's own club_id (mirrors the existing
-- payment_allocations_select_club_staff policy's own join-through-invoice
-- shape, just adding the support-session branch alongside it).
create policy payment_allocations_platform_support_select
  on public.payment_allocations for select
  using (
    exists (
      select 1 from public.invoices i
      where i.id = payment_allocations.invoice_id
        and public.has_platform_support_access(i.club_id)
    )
  );
