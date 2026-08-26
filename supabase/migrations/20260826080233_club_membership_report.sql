-- CLUB MEMBERSHIPS domain -- operational report. Explicitly NOT a
-- revenue/finance report (that continues to derive exclusively from
-- Payments/Finance per the directive) -- purely operational counts by
-- derived status, renewals in range, and plan distribution. Mirrors
-- get_academy_report()'s exact shape/gating pattern.
create or replace function public.get_club_membership_report(p_club_id uuid, p_start_date date, p_end_date date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result jsonb;
  v_today date;
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

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  select jsonb_build_object(
    'counts_by_status', (
      select jsonb_object_agg(effective_status, cnt)
      from (
        select
          public.get_club_membership_effective_status(
            s.status, s.start_date,
            s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
            v_today
          ) as effective_status,
          count(*) as cnt
        from public.club_membership_subscriptions s
        where s.club_id = p_club_id
        group by 1
      ) grouped
    ),
    'expiring_within_range', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membership_subscription_id', s.id,
        'membership_number', s.membership_number,
        'customer_name', c.full_name,
        'plan_name_ar', s.plan_name_ar_snapshot,
        'plan_name_en', s.plan_name_en_snapshot,
        'effective_end_date', s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)
      ) order by s.end_date)
      from public.club_membership_subscriptions s
      join public.customers c on c.id = s.customer_id
      where s.club_id = p_club_id
        and s.status in ('active', 'frozen')
        and (s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)) between p_start_date and p_end_date
    ), '[]'::jsonb),
    'renewals_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and s.created_at::date between p_start_date and p_end_date
        and exists (
          select 1 from public.club_membership_subscriptions prior
          where prior.customer_id = s.customer_id and prior.club_id = s.club_id
            and prior.created_at < s.created_at
        )
    ),
    'new_memberships_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and s.created_at::date between p_start_date and p_end_date
        and not exists (
          select 1 from public.club_membership_subscriptions prior
          where prior.customer_id = s.customer_id and prior.club_id = s.club_id
            and prior.created_at < s.created_at
        )
    ),
    'cancellations_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and s.cancelled_at is not null
        and s.cancelled_at::date between p_start_date and p_end_date
    ),
    'by_plan', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_id', p.id,
        'plan_name_ar', p.name_ar,
        'plan_name_en', p.name_en,
        'is_active', p.is_active,
        'active_membership_count', mc.active_count,
        'total_membership_count', mc.total_count
      ) order by p.sort_order, p.name_en)
      from public.club_membership_plans p
      left join (
        select plan_id,
          count(*) filter (where status in ('active', 'scheduled', 'frozen')) as active_count,
          count(*) as total_count
        from public.club_membership_subscriptions
        where club_id = p_club_id
        group by plan_id
      ) mc on mc.plan_id = p.id
      where p.club_id = p_club_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

grant execute on function public.get_club_membership_report(uuid, date, date) to service_role, authenticated;
revoke all on function public.get_club_membership_report(uuid, date, date) from public, anon;
