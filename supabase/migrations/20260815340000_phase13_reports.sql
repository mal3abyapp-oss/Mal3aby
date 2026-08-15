-- Phase 13 -- Reports (Financial, Field, Academy, Customer).
-- See docs/IMPLEMENTATION_PLAN.md Phase 13, docs/ARCHITECTURE.md
-- ("parameterized SQL views/RPCs ... returning JSON"), docs/SCREEN_MAP.md
-- (Reports Hub: Manager, Owner, Accountant, Academy Manager).
-- No new tables -- these are read-only aggregate RPCs over existing data.

insert into public.permissions (key, description) values
  ('report.view', 'View reports (revenue, occupancy, academy, customer)')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('platform_owner', 'club_owner', 'club_manager', 'branch_manager', 'accountant', 'academy_manager')
  and p.key = 'report.view'
on conflict do nothing;

-- ============================================================
-- get_revenue_report: revenue grouped by day, filtered by date range,
-- optional branch/payment-method. Reads payments (completed only, never
-- void) -- the same source of truth as the dashboard's revenue_today.
-- ============================================================

create or replace function public.get_revenue_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null,
  p_method text default null
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
        and (p_branch_id is null or p.branch_id = p_branch_id)
        and (p_method is null or p.method = p_method)
    ), 0),
    'by_day', coalesce((
      select jsonb_agg(jsonb_build_object('date', d.day, 'revenue', d.revenue) order by d.day)
      from (
        select p.received_at::date as day, sum(p.amount) as revenue
        from public.payments p
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at::date between p_start_date and p_end_date
          and (p_branch_id is null or p.branch_id = p_branch_id)
          and (p_method is null or p.method = p_method)
        group by p.received_at::date
      ) d
    ), '[]'::jsonb),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method, 'revenue', m.revenue) order by m.revenue desc)
      from (
        select p.method, sum(p.amount) as revenue
        from public.payments p
        where p.club_id = p_club_id and p.status = 'completed'
          and p.received_at::date between p_start_date and p_end_date
          and (p_branch_id is null or p.branch_id = p_branch_id)
          and (p_method is null or p.method = p_method)
        group by p.method
      ) m
    ), '[]'::jsonb),
    'refunds_total', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_revenue_report(uuid, date, date, uuid, text) from public;
revoke execute on function public.get_revenue_report(uuid, date, date, uuid, text) from anon;
grant execute on function public.get_revenue_report(uuid, date, date, uuid, text) to authenticated;

-- ============================================================
-- get_field_occupancy_report: booked hours + booking count per field
-- over a date range (confirmed/checked_in/completed bookings only --
-- cancelled bookings never occupied the field).
-- ============================================================

create or replace function public.get_field_occupancy_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_field_id uuid default null
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
          and b.start_at::date between p_start_date and p_end_date
        group by b.field_id
      ) bh on bh.field_id = f.id
      where f.club_id = p_club_id and (p_field_id is null or f.id = p_field_id)
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_field_occupancy_report(uuid, date, date, uuid) from public;
revoke execute on function public.get_field_occupancy_report(uuid, date, date, uuid) from anon;
grant execute on function public.get_field_occupancy_report(uuid, date, date, uuid) to authenticated;

-- ============================================================
-- get_academy_report: active enrollments, attendance rate, and upcoming
-- subscription expiries (using effective end date, i.e. freeze-adjusted)
-- for the date range.
-- ============================================================

create or replace function public.get_academy_report(
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
    'active_enrollments', (
      select count(*) from public.enrollments e
      where e.club_id = p_club_id and e.status = 'active'
    ),
    'attendance_rate', (
      select case when count(*) = 0 then null
        else round(100.0 * count(*) filter (where a.status in ('present', 'late')) / count(*), 1)
      end
      from public.attendance a
      join public.training_sessions ts on ts.id = a.session_id
      where ts.club_id = p_club_id
        and ts.session_date between p_start_date and p_end_date
    ),
    'by_group', coalesce((
      select jsonb_agg(jsonb_build_object(
        'group_id', g.id,
        'group_name', g.name,
        'active_enrollments', ec.enrollment_count,
        'capacity', g.capacity
      ) order by g.name)
      from public.groups g
      left join (
        select group_id, count(*) as enrollment_count
        from public.enrollments where status = 'active'
        group by group_id
      ) ec on ec.group_id = g.id
      where g.club_id = p_club_id
    ), '[]'::jsonb),
    'expiring_subscriptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'subscription_id', s.id,
        'player_name', pl.full_name,
        'effective_end_date', public.get_subscription_effective_end_date(s.id)
      ) order by s.end_date)
      from public.subscriptions s
      join public.enrollments e on e.id = s.enrollment_id
      join public.players pl on pl.id = e.player_id
      where s.club_id = p_club_id
        and s.status in ('active', 'frozen')
        and public.get_subscription_effective_end_date(s.id) between p_start_date and p_end_date
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_academy_report(uuid, date, date) from public;
revoke execute on function public.get_academy_report(uuid, date, date) from anon;
grant execute on function public.get_academy_report(uuid, date, date) to authenticated;

-- ============================================================
-- get_customer_activity_report: booking/payment activity per customer
-- over a date range -- top customers by spend, plus new-vs-returning split.
-- ============================================================

create or replace function public.get_customer_activity_report(
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
    'new_customers', (
      select count(*) from public.customers c
      where c.club_id = p_club_id and c.created_at::date between p_start_date and p_end_date
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
          and received_at::date between p_start_date and p_end_date
        group by customer_id
        order by sum(amount) desc
        limit 20
      ) ps
      join public.customers c on c.id = ps.customer_id
      left join (
        select customer_id, count(*) as booking_count
        from public.bookings
        where club_id = p_club_id and start_at::date between p_start_date and p_end_date
          and status != 'cancelled'
        group by customer_id
      ) bc on bc.customer_id = c.id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_customer_activity_report(uuid, date, date) from public;
revoke execute on function public.get_customer_activity_report(uuid, date, date) from anon;
grant execute on function public.get_customer_activity_report(uuid, date, date) to authenticated;
