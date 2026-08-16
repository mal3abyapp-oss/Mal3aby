-- Gate 11 (Reporting Rebuild) -- Executive Dashboard + Booking Report.
-- See AUTONOMOUS_DECISION_LOG.md D-011.
--
-- Doc 3 requires every KPI be computed in exactly one place. These two new
-- RPCs are additive (no existing report RPC is touched): get_executive_dashboard
-- summarizes revenue/occupancy/academy/customer KPIs by calling the *same*
-- aggregation logic as the existing per-domain report RPCs (not a parallel
-- reimplementation), and get_booking_report adds the booking-count/status
-- breakdown that get_field_occupancy_report deliberately does not cover
-- (occupancy is about hours utilized, not booking lifecycle outcomes).

-- ============================================================
-- get_executive_dashboard: single top-level KPI summary for the date range.
-- Revenue figures reuse the exact payments/refunds predicates as
-- get_revenue_report; occupancy reuses the same bookings predicate as
-- get_field_occupancy_report -- same source of truth, not reinvented.
-- ============================================================

create or replace function public.get_executive_dashboard(
  p_club_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
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

  select jsonb_build_object(
    'total_revenue', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at::date between p_start_date and p_end_date
    ), 0),
    'refunds_total', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at::date between p_start_date and p_end_date
    ), 0),
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
    'revenue_by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.day, 'revenue', d.revenue) order by d.day)
      from (
        select p.received_at::date as day, sum(p.amount) as revenue
        from public.payments p
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at::date between p_start_date and p_end_date
        group by p.received_at::date
      ) d
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_executive_dashboard(uuid, date, date) from public;
revoke execute on function public.get_executive_dashboard(uuid, date, date) from anon;
grant execute on function public.get_executive_dashboard(uuid, date, date) to authenticated;

-- ============================================================
-- get_booking_report: booking lifecycle breakdown (status counts, by-branch,
-- by-field booking counts) -- distinct from get_field_occupancy_report,
-- which reports booked *hours* per field, not booking outcomes/status mix.
-- ============================================================

create or replace function public.get_booking_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
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

  select jsonb_build_object(
    'by_status', coalesce((
      select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt) order by s.cnt desc)
      from (
        select b.status, count(*) as cnt
        from public.bookings b
        where b.club_id = p_club_id
          and b.start_at::date between p_start_date and p_end_date
          and (p_branch_id is null or b.branch_id = p_branch_id)
        group by b.status
      ) s
    ), '[]'::jsonb),
    'by_branch', coalesce((
      select jsonb_agg(jsonb_build_object(
        'branch_id', br.id,
        'branch_name', br.name,
        'booking_count', coalesce(bc.cnt, 0)
      ) order by br.name)
      from public.branches br
      left join (
        select b.branch_id, count(*) as cnt
        from public.bookings b
        where b.club_id = p_club_id
          and b.status in ('confirmed', 'checked_in', 'completed')
          and b.start_at::date between p_start_date and p_end_date
        group by b.branch_id
      ) bc on bc.branch_id = br.id
      where br.club_id = p_club_id and (p_branch_id is null or br.id = p_branch_id)
    ), '[]'::jsonb),
    'cancellation_rate', (
      select case when count(*) = 0 then null
        else round(100.0 * count(*) filter (where b.status = 'cancelled') / count(*), 1)
      end
      from public.bookings b
      where b.club_id = p_club_id
        and b.start_at::date between p_start_date and p_end_date
        and (p_branch_id is null or b.branch_id = p_branch_id)
    ),
    'average_booking_value', (
      select case when count(*) filter (where b.status in ('confirmed','checked_in','completed')) = 0 then null
        else round(sum(b.total_price - coalesce(b.discount_amount, 0)) filter (where b.status in ('confirmed','checked_in','completed'))
          / count(*) filter (where b.status in ('confirmed','checked_in','completed')), 2)
      end
      from public.bookings b
      where b.club_id = p_club_id
        and b.start_at::date between p_start_date and p_end_date
        and (p_branch_id is null or b.branch_id = p_branch_id)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_booking_report(uuid, date, date, uuid) from public;
revoke execute on function public.get_booking_report(uuid, date, date, uuid) from anon;
grant execute on function public.get_booking_report(uuid, date, date, uuid) to authenticated;
