-- REPORTING ACCURACY & MANAGEMENT INSIGHT ACCEPTANCE (Stage B, B5,
-- 2026-08-30): get_field_occupancy_report() was missed when
-- club-timezone-aware report boundaries were added (see
-- club_timezone_aware_report_boundaries / apply_club_timezone_to_
-- finance_reports migrations) -- every other date-range report RPC
-- (get_revenue_report, get_booking_report, get_collections_report,
-- get_employee_liability_report, get_financial_exceptions_report,
-- get_financial_reconciliation_report, get_payment_method_report,
-- get_club_membership_report) resolves p_start_date/p_end_date via
-- club_local_day_bounds(p_club_id, p_date), which converts the club's
-- own configured local calendar day into the correct timestamptz
-- range. get_field_occupancy_report() instead compared
-- `b.start_at::date` directly against the plain date parameters --
-- casting a timestamptz to date implicitly uses the DATABASE
-- SESSION's timezone (confirmed: UTC), not the club's.
--
-- Reproduced with real live data, not hypothetically: a booking
-- starting at 2026-08-31 01:00 Africa/Cairo local time is stored as
-- 2026-08-30 22:00:00+00 -- b.start_at::date under the UTC session
-- reads "2026-08-30", one calendar day EARLIER than the club's own
-- correct local date "2026-08-31". Confirmed 3 real existing bookings
-- across 2 different real Africa/Cairo clubs already sit in this
-- exact affected window, meaning the Field Occupancy report has been
-- attributing real bookings to the wrong day for those clubs.
--
-- Fix: adopt the exact same club_local_day_bounds() + timestamptz
-- range-comparison pattern already used by every sibling report RPC,
-- with zero other behavior change (grants, permission check, response
-- shape, and every other clause are unchanged).
create or replace function public.get_field_occupancy_report(p_club_id uuid, p_start_date date, p_end_date date, p_field_id uuid DEFAULT NULL::uuid)
 returns jsonb
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
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

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'by_field', coalesce((
      select jsonb_agg(jsonb_build_object(
        'field_id', f.id,
        'field_name', f.name,
        'booked_hours', round(coalesce(bh.hours, 0)::numeric, 2),
        'booking_count', coalesce(bh.booking_count, 0)
      ) order by f.name)
      from public.fields f
      left join (
        select b.field_id,
          sum(extract(epoch from (b.end_at - b.start_at)) / 3600.0) as hours,
          count(*) as booking_count
        from public.bookings b
        where b.club_id = p_club_id
          and b.status in ('confirmed', 'checked_in', 'completed')
          and b.start_at >= v_range_start and b.start_at < v_range_end
        group by b.field_id
      ) bh on bh.field_id = f.id
      where f.club_id = p_club_id and (p_field_id is null or f.id = p_field_id)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;
