-- FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Club Owner persona
-- gap: "how do I know who's working, what did they accomplish, are
-- there errors, is anything in their custody, are bookings/collections/
-- attendance tied to them?" Built entirely from real, existing FK
-- columns already present on this schema (bookings.created_by,
-- payments.received_by, attendance.marked_by, official_collection_
-- receipts.entered_by) -- never a new HR/tracking system. All-time
-- counts plus a "this month" figure, matching the same "this month"
-- convention already used on PlatformOverviewPage/ReportsOverviewPage.
-- No metric is shown that isn't backed by a real, queryable row -- a
-- staff member who has never taken a payment shows 0, not a fabricated
-- estimate.
--
-- returns jsonb (not RETURNS TABLE), so CREATE OR REPLACE is safe here
-- -- no signature-drift/orphaned-overload risk, confirmed via this
-- project's own standing rule (that class of risk applies to RETURNS
-- TABLE shape changes only). Signature/grants verified live before and
-- after: single overload, authenticated/postgres/service_role only, no
-- anon/public, both times.
--
-- NOTE: the first attempt at this migration used bookings.created_at
-- for the "this month" attendance filter -- attendance has no
-- created_at column, only marked_at. Caught live via a real 42703
-- error on first apply; this file reflects the corrected, verified
-- version (matches the second apply in production).
create or replace function public.get_staff_360_summary(p_club_id uuid, p_membership_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_full_name text;
  v_email text;
  v_branches jsonb;
  v_current_shift jsonb;
  v_outstanding numeric;
  v_settled numeric;
  v_last_shift jsonb;
  v_last_collection jsonb;
  v_last_activity timestamptz;
  v_activity_counts jsonb;
  v_month_start timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  select full_name into v_full_name from public.profiles where user_id = v_membership.user_id;
  select email into v_email from auth.users where id = v_membership.user_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name)), '[]'::jsonb)
    into v_branches
  from public.membership_branches mb
  join public.branches b on b.id = mb.branch_id
  where mb.membership_id = p_membership_id;

  select jsonb_build_object(
    'id', cs.id, 'branch_id', cs.branch_id, 'branch_name', b.name,
    'opened_at', cs.opened_at, 'opening_float', cs.opening_float
  ) into v_current_shift
  from public.cash_shifts cs
  join public.branches b on b.id = cs.branch_id
  where cs.opened_by = v_membership.user_id and cs.club_id = p_club_id and cs.status = 'open'
  limit 1;

  select coalesce(sum(outstanding), 0) into v_outstanding
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = p_club_id and status = 'outstanding';

  select coalesce(sum(original_amount - outstanding), 0) into v_settled
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = p_club_id;

  select jsonb_build_object('id', cs.id, 'closed_at', cs.closed_at, 'branch_name', b.name)
    into v_last_shift
  from public.cash_shifts cs
  join public.branches b on b.id = cs.branch_id
  where cs.opened_by = v_membership.user_id and cs.club_id = p_club_id and cs.status = 'closed'
  order by cs.closed_at desc nulls last
  limit 1;

  select jsonb_build_object('id', p.id, 'amount', p.amount, 'received_at', p.received_at)
    into v_last_collection
  from public.payments p
  where p.received_by = v_membership.user_id and p.club_id = p_club_id
  order by p.received_at desc
  limit 1;

  select max(created_at) into v_last_activity
  from public.audit_logs
  where club_id = p_club_id and actor_id = v_membership.user_id;

  v_month_start := date_trunc('month', now());

  select jsonb_build_object(
    'bookings_created_total', (select count(*) from public.bookings where created_by = v_membership.user_id and club_id = p_club_id),
    'bookings_created_this_month', (select count(*) from public.bookings where created_by = v_membership.user_id and club_id = p_club_id and created_at >= v_month_start),
    'payments_collected_total', (select count(*) from public.payments where received_by = v_membership.user_id and club_id = p_club_id),
    'payments_collected_amount_total', (select coalesce(sum(amount), 0) from public.payments where received_by = v_membership.user_id and club_id = p_club_id),
    'payments_collected_this_month', (select count(*) from public.payments where received_by = v_membership.user_id and club_id = p_club_id and received_at >= v_month_start),
    'payments_collected_amount_this_month', (select coalesce(sum(amount), 0) from public.payments where received_by = v_membership.user_id and club_id = p_club_id and received_at >= v_month_start),
    'attendance_marked_total', (select count(*) from public.attendance where marked_by = v_membership.user_id and club_id = p_club_id),
    'attendance_marked_this_month', (select count(*) from public.attendance where marked_by = v_membership.user_id and club_id = p_club_id and marked_at >= v_month_start),
    'official_receipts_issued_total', (select count(*) from public.official_collection_receipts where entered_by = v_membership.user_id and club_id = p_club_id and status = 'active')
  ) into v_activity_counts;

  return jsonb_build_object(
    'membership', jsonb_build_object(
      'id', v_membership.id, 'user_id', v_membership.user_id,
      'full_name', v_full_name, 'email', v_email,
      'status', v_membership.status, 'has_cash_custody', v_membership.has_cash_custody,
      'created_at', v_membership.created_at
    ),
    'branches', v_branches,
    'current_shift', v_current_shift,
    'outstanding_liability', v_outstanding,
    'total_settled', v_settled,
    'last_shift', v_last_shift,
    'last_collection', v_last_collection,
    'last_activity_at', v_last_activity,
    'activity_counts', v_activity_counts
  );
end;
$function$;

revoke all on function public.get_staff_360_summary(uuid, uuid) from public, anon;
grant execute on function public.get_staff_360_summary(uuid, uuid) to authenticated;
