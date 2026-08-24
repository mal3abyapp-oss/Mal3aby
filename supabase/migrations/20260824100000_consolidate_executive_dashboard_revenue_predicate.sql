-- SQL-level consolidation of the duplicate total_revenue/refunds_total
-- predicate flagged in 20260818110000_document_duplicate_metric_predicates.sql
-- and in the comment at src/features/reports/ReportRevenuePage.tsx (top of file).
--
-- What was wrong: get_executive_dashboard() and get_revenue_report() each
-- independently hand-wrote the same "sum completed payments received in
-- range" / "sum completed refunds refunded in range" SQL. They were kept
-- in sync only by convention/comment, not by shared code -- a future edit
-- to one predicate (e.g. changing the status list, or excluding same-day
-- refunds) could silently desync Finance Overview's revenue StatCard
-- (backed by get_executive_dashboard) from Finance Reports > Revenue tab
-- (backed by get_revenue_report) for the identical date range, with no
-- compiler, RLS policy, or test catching it.
--
-- The fix: get_executive_dashboard() now calls get_revenue_report() for
-- total_revenue/refunds_total instead of re-deriving them, so there is
-- exactly one SQL body computing that predicate. revenue_by_day is derived
-- from the same get_revenue_report() result's by_day array rather than a
-- second independent query.
--
-- Why this is safe:
--   - get_revenue_report(p_club_id, p_start_date, p_end_date, p_branch_id,
--     p_method) with p_branch_id/p_method both null applies no branch or
--     method filter -- `(p_branch_id is null or ...)` and
--     `(p_method is null or ...)` both short-circuit true -- which is
--     exactly get_executive_dashboard's previous (unfiltered) behavior.
--     Same table, same status = 'completed'/'completed', same
--     received_at::date/refunded_at::date range predicate. No numeric
--     change for any existing caller.
--   - Both functions are already `security invoker` (see
--     20260821060000_make_operational_reports_rls_aware.sql), so calling
--     get_revenue_report() from inside get_executive_dashboard() runs
--     under the same invoker/RLS context as before -- no privilege change.
--   - Return shape (jsonb keys) of get_executive_dashboard is unchanged.
--   - get_revenue_report itself is untouched (signature and body both
--     identical), so nothing that calls it directly is affected.

create or replace function public.get_executive_dashboard(
  p_club_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
  v_revenue jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  -- Single source of truth for total_revenue/refunds_total/revenue_by_day:
  -- delegate to get_revenue_report with no branch/method filter, which is
  -- equivalent to this function's previous unfiltered predicate.
  v_revenue := public.get_revenue_report(p_club_id, p_start_date, p_end_date, null, null);

  select jsonb_build_object(
    'total_revenue', coalesce(v_revenue->'total_revenue', to_jsonb(0)),
    'refunds_total', coalesce(v_revenue->'refunds_total', to_jsonb(0)),
    'outstanding_total', coalesce((
      select sum(oi.outstanding) from public.outstanding_invoices oi
      where oi.club_id = p_club_id
    ), 0),
    'bookings_count', (
      select count(*) from public.bookings b
      where b.club_id = p_club_id
        and b.status in ('confirmed', 'checked_in', 'completed')
        and b.start_at::date between p_start_date and p_end_date
    ),
    'bookings_cancelled_count', (
      select count(*) from public.bookings b
      where b.club_id = p_club_id
        and b.status = 'cancelled'
        and b.start_at::date between p_start_date and p_end_date
    ),
    'total_booked_hours', coalesce((
      select round(sum(extract(epoch from (b.end_at - b.start_at)) / 3600.0)::numeric, 2)
      from public.bookings b
      where b.club_id = p_club_id
        and b.status in ('confirmed', 'checked_in', 'completed')
        and b.start_at::date between p_start_date and p_end_date
    ), 0),
    'active_enrollments', (
      select count(*) from public.enrollments e
      where e.club_id = p_club_id and e.status = 'active'
    ),
    'new_customers', (
      select count(*) from public.customers c
      where c.club_id = p_club_id and c.created_at::date between p_start_date and p_end_date
    ),
    'revenue_by_day', coalesce(v_revenue->'by_day', '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_executive_dashboard(uuid, date, date) from public;
revoke execute on function public.get_executive_dashboard(uuid, date, date) from anon;
grant execute on function public.get_executive_dashboard(uuid, date, date) to authenticated;

comment on function public.get_executive_dashboard(uuid, date, date) is
  'Dashboard/Reports Overview KPI aggregate for a date range. '
  'total_revenue/refunds_total/revenue_by_day are now computed by calling '
  'get_revenue_report() (unfiltered) rather than re-deriving the predicate -- '
  'see 20260824100000_consolidate_executive_dashboard_revenue_predicate.sql. '
  'outstanding_total still mirrors get_today_dashboard()''s (both sum '
  'public.outstanding_invoices independently). active_enrollments mirrors '
  'get_academy_report()''s. new_customers mirrors get_customer_activity_report()''s. '
  'Those three remaining pairs are unchanged by this migration.';

comment on function public.get_revenue_report(uuid, date, date, uuid, text) is
  'Revenue-by-method/day report for a date range. Single source of truth for '
  'total_revenue/by_day/refunds_total -- get_executive_dashboard() now calls '
  'this function (unfiltered) instead of re-deriving the predicate.';
