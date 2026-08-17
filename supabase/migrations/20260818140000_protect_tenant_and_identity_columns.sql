-- FINAL AUTONOMOUS REMEDIATION -- Security P0 (highest priority item
-- from MAL3ABY_PRODUCTION_READINESS.md's confirmed CRITICAL findings
-- C1/C2): a live, exploitable privilege-escalation and cross-tenant
-- data-contamination path.
--
-- ROOT CAUSE (verified live via pg_policies before writing this fix):
-- every UPDATE policy in this schema has with_check: null. RLS's
-- USING clause only re-validates the row as it existed BEFORE the
-- update (and, for some tables, only checks the club_id the row
-- already belongs to) -- it does NOT constrain which columns the
-- statement is allowed to change or what values they land on. This is
-- the exact gap this codebase already fixed twice before, for exactly
-- this reason, on two individual tables:
--   - clubs.status: protect_club_status_from_non_platform_owner()
--     (20260816040000_fix_club_owner_cannot_change_club_status.sql)
--   - customers.{photo_url,national_id,full_name,date_of_birth,
--     gender,club_id,user_id} (self-service path only):
--     protect_customer_identity_columns()
--     (20260816140000_customer_self_service_write_guard.sql)
--
-- Both fixes used the same idiom -- a BEFORE UPDATE trigger that
-- SILENTLY REVERTS a protected column to its prior value when the
-- actor isn't authorized to change it, rather than RAISE (a raise
-- would also block otherwise-legitimate multi-column updates in the
-- same statement that never touch the protected column -- e.g. a
-- normal booking-notes edit must keep working even though this
-- trigger also runs on that UPDATE). This migration generalizes that
-- exact, already-proven idiom across every table with a genuine
-- identity/tenant column reachable through a client-facing UPDATE
-- policy, closing two confirmed live gaps:
--
-- C1 -- club_memberships privilege escalation: a club_manager (who
-- holds staff.update, the same permission a club_owner holds) can
-- send a direct UPDATE that changes their own row's role_id to the
-- club_owner role's id, self-promoting to full club_owner with zero
-- audit trail, bypassing the app UI entirely. Also: club_id and
-- user_id are equally unprotected on this table.
--
-- C2 -- cross-tenant data contamination: any staff member holding the
-- relevant *.update permission (booking.update, customer.update,
-- payment.update, player.update, subscription.update,
-- enrollment.update) on a club_id they belong to can send a direct
-- UPDATE that reassigns a row's club_id to a DIFFERENT club they also
-- belong to (a real user with 4 active club_memberships exists in
-- this project's live data -- this is not a theoretical scenario).
-- The row's own club_id passes the USING check because it's checked
-- against the CURRENT (pre-update) club_id, not the new one being
-- written.
--
-- SCOPE DECISION: not every table with with_check:null needs this --
-- most (age_groups, pricing_rules, field_operating_hours, groups,
-- programs, seasons, attendance, group_schedule_slots, training_sessions,
-- guardian_links, invoice_items, membership_branches,
-- customer_photo_update_requests) have no identity/tenant column an
-- attacker could beneficially flip (their club_id is reached only via
-- a parent-table join in the policy itself, or they carry no
-- ownership-defining column at all). Widening this fix to those
-- tables would be schema-wide churn with no corresponding real risk
-- closed -- scope is kept to tables where a genuine escalation or
-- cross-tenant-reassignment path was identified.
--
-- fields/branches: club_id is protected below too, since a
-- misdirected field/branch would misattribute every booking/pricing
-- rule created against it afterward -- same class of risk as
-- bookings/customers even though it wasn't separately enumerated in
-- the original audit.
--
-- refunds and payment_allocations have NO club_id column at all (they
-- resolve tenancy via a join to payments/invoices) and have no UPDATE
-- policy whatsoever (INSERT-only, append-only by design) -- already
-- safe by construction, not touched here.

-- ============================================================
-- Generic protected-column-revert trigger. One function per table
-- (not a single parameterized function) because trigger functions
-- cannot take arguments -- this mirrors the existing
-- protect_customer_identity_columns() pattern exactly, just repeated
-- per table with that table's own protected-column list. Every one
-- of these functions is SECURITY DEFINER + zero grants (only ever
-- invoked by the trigger machinery itself, never called directly).
-- ============================================================

-- --------------------------------------------------------------
-- club_memberships: the actual C1 privilege-escalation fix.
-- role_id, club_id, user_id must never change via a direct client
-- UPDATE, regardless of who is making the request or what permission
-- they hold -- role/club/user reassignment for a membership is
-- exclusively a create-new-row/delete-old-row operation (staff
-- removal + a fresh invite), never an in-place mutation. This is
-- stricter than the customers precedent (which allows staff with
-- customer.update to change club_id) specifically because there is no
-- legitimate business reason for ANY caller to move a membership
-- between clubs or reassign its user/role via raw UPDATE -- the
-- existing invite flow (public.invite_staff_member() or equivalent)
-- is the only correct way to create a new role assignment.
create or replace function public.protect_club_membership_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.role_id is distinct from old.role_id then
    new.role_id := old.role_id;
  end if;
  if new.club_id is distinct from old.club_id then
    new.club_id := old.club_id;
  end if;
  if new.user_id is distinct from old.user_id then
    new.user_id := old.user_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_club_membership_identity_columns() from public, anon, authenticated;

drop trigger if exists trg_protect_club_membership_identity_columns on public.club_memberships;
create trigger trg_protect_club_membership_identity_columns
  before update on public.club_memberships
  for each row execute function public.protect_club_membership_identity_columns();

comment on function public.protect_club_membership_identity_columns() is
  'Security P0 fix (C1, MAL3ABY_PRODUCTION_READINESS.md): closes a live, confirmed privilege-escalation path where any staff.update holder (including club_manager, not just club_owner) could UPDATE their own club_memberships row to change role_id to club_owner''s role, self-promoting with zero audit trail. role_id/club_id/user_id are now immutable via direct UPDATE for every caller -- role reassignment must go through the invite/remove flow, never in-place mutation.';

-- --------------------------------------------------------------
-- bookings / customers / payments / invoices / players /
-- subscriptions / enrollments / fields / branches: the C2
-- cross-tenant fix. club_id is protected on every one of these --
-- a row must never be reassignable to a different club_id via direct
-- UPDATE, full stop, for any caller including platform_owner (a
-- platform owner moving a booking/customer/payment between tenants is
-- not a legitimate operation this product supports; if it ever
-- becomes one, it should be a dedicated audited RPC, not a raw
-- column write).
--
-- customers already has protect_customer_identity_columns() from the
-- prior migration, but that one only fires the revert when the actor
-- LACKS customer.update -- a staff member who legitimately holds
-- customer.update on their home club can still flip club_id to a
-- DIFFERENT club they also belong to and pass that check. This new
-- trigger is unconditional (no permission check at all) and layers on
-- top of the existing one -- Postgres runs both BEFORE UPDATE
-- triggers on customers, so the identity-column trigger still governs
-- photo_url/national_id/etc for the self-service path, and this one
-- additionally locks club_id for every path with no exception.
create or replace function public.protect_tenant_id_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.club_id is distinct from old.club_id then
    new.club_id := old.club_id;
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_tenant_id_immutable() from public, anon, authenticated;

drop trigger if exists trg_protect_tenant_id_bookings on public.bookings;
create trigger trg_protect_tenant_id_bookings
  before update on public.bookings
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_customers on public.customers;
create trigger trg_protect_tenant_id_customers
  before update on public.customers
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_payments on public.payments;
create trigger trg_protect_tenant_id_payments
  before update on public.payments
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_invoices on public.invoices;
create trigger trg_protect_tenant_id_invoices
  before update on public.invoices
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_players on public.players;
create trigger trg_protect_tenant_id_players
  before update on public.players
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_subscriptions on public.subscriptions;
create trigger trg_protect_tenant_id_subscriptions
  before update on public.subscriptions
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_enrollments on public.enrollments;
create trigger trg_protect_tenant_id_enrollments
  before update on public.enrollments
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_fields on public.fields;
create trigger trg_protect_tenant_id_fields
  before update on public.fields
  for each row execute function public.protect_tenant_id_immutable();

drop trigger if exists trg_protect_tenant_id_branches on public.branches;
create trigger trg_protect_tenant_id_branches
  before update on public.branches
  for each row execute function public.protect_tenant_id_immutable();

comment on function public.protect_tenant_id_immutable() is
  'Security P0 fix (C2, MAL3ABY_PRODUCTION_READINESS.md): closes a live, confirmed cross-tenant data-contamination path where a staff member holding the relevant *.update permission on more than one club (a real, confirmed scenario in this project''s live data) could UPDATE a row''s club_id to move it to a different club they also belong to. club_id is now unconditionally immutable via direct UPDATE on every table this trigger is attached to, for every caller including platform_owner -- tenant reassignment is not a supported operation.';
