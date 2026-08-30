-- REPORTING ACCURACY & MANAGEMENT INSIGHT ACCEPTANCE (Stage B, B5,
-- 2026-08-30, continuing the field-occupancy-report fix in this same
-- batch): get_customer_activity_report() has the SAME class of bug in
-- THREE separate places, all comparing a timestamptz column cast to
-- ::date (implicitly using the database session's UTC timezone)
-- against the club-local date parameters, instead of using
-- club_local_day_bounds() like every other date-range report RPC:
--   1. customers.created_at::date  (new_customers count)
--   2. payments.received_at::date (top_customers total_spend window)
--   3. bookings.start_at::date    (top_customers booking_count window)
--
-- Same real-world consequence as the field-occupancy fix: a customer
-- created, a payment received, or a booking starting late at night in
-- a positive-UTC-offset timezone (e.g. Africa/Cairo, UTC+3) can be
-- attributed to the wrong calendar day, shifting a customer's activity
-- in or out of the report's date range, or moving it to the adjacent
-- day.
--
-- Fix: same club_local_day_bounds() + timestamptz range-comparison
-- pattern as every sibling report RPC and as the just-fixed
-- get_field_occupancy_report(). No other behavior change.
create or replace function public.get_customer_activity_report(p_club_id uuid, p_start_date date, p_end_date date)
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
    'new_customers', (
      select count(*) from public.customers c
      where c.club_id = p_club_id and c.created_at >= v_range_start and c.created_at < v_range_end
    ),
    'top_customers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'customer_id', c.id,
        'customer_name', c.full_name,
        'total_spend', ps.total_spend,
        'booking_count', coalesce(bc.booking_count, 0)
      ) order by ps.total_spend desc)
      from (
        select customer_id, sum(amount) as total_spend
        from public.payments
        where club_id = p_club_id and status = 'completed'
          and received_at >= v_range_start and received_at < v_range_end
        group by customer_id
        order by sum(amount) desc
        limit 20
      ) ps
      join public.customers c on c.id = ps.customer_id
      left join (
        select customer_id, count(*) as booking_count
        from public.bookings
        where club_id = p_club_id and start_at >= v_range_start and start_at < v_range_end
          and status != 'cancelled'
        group by customer_id
      ) bc on bc.customer_id = c.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;
