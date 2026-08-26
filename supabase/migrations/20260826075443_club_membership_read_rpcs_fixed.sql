-- CLUB MEMBERSHIPS domain -- read RPCs: portal, Customer 360 integration,
-- staff member/plan lists, expiring-soon filter. All derived-status
-- resolution uses get_club_membership_effective_status/end_date so
-- correctness never depends on a cron job.

-- 1) Customer Portal -- "My Memberships". Hard-codes customers.user_id =
--    auth.uid() inside the RPC body (never a raw table select), mirrors
--    get_my_portal_academy()/get_my_portal_customers() exactly.
create or replace function public.get_my_portal_club_memberships()
returns table(
  membership_subscription_id uuid,
  club_id uuid,
  club_name text,
  club_name_ar text,
  membership_number text,
  plan_name_ar text,
  plan_name_en text,
  status text,
  effective_status text,
  start_date date,
  end_date date,
  effective_end_date date,
  branch_name text,
  allow_renewal boolean
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    s.id, s.club_id, cl.name, cl.name_ar, s.membership_number,
    s.plan_name_ar_snapshot, s.plan_name_en_snapshot, s.status,
    public.get_club_membership_effective_status(
      s.status, s.start_date,
      s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
      (select (day_start at time zone cl.timezone)::date from public.club_local_day_bounds(s.club_id, current_date))
    ),
    s.start_date, s.end_date,
    s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
    br.name,
    coalesce(p.allow_renewal, false)
  from public.club_membership_subscriptions s
  join public.customers c on c.id = s.customer_id
  join public.clubs cl on cl.id = s.club_id
  join public.branches br on br.id = s.branch_id
  left join public.club_membership_plans p on p.id = s.plan_id
  where c.user_id = auth.uid()
  order by s.start_date desc;
$$;

grant execute on function public.get_my_portal_club_memberships() to service_role, authenticated;
revoke all on function public.get_my_portal_club_memberships() from public, anon;

-- 2) Customer 360 integration -- staff-side, one JSONB blob per
--    customer, mirrors get_customer_academy_players()'s exact pattern
--    (customer.view-gated, jsonb_agg, coalesce to empty array).
create or replace function public.get_customer_club_memberships(p_club_id uuid, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result jsonb;
  v_today date;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club_membership.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  select coalesce(jsonb_agg(row_to_json(row) order by row.start_date desc), '[]'::jsonb) into v_result
  from (
    select
      s.id as membership_subscription_id,
      s.membership_number,
      s.plan_id,
      s.plan_name_ar_snapshot,
      s.plan_name_en_snapshot,
      s.price_snapshot,
      s.status,
      public.get_club_membership_effective_status(
        s.status, s.start_date,
        s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
        v_today
      ) as effective_status,
      s.start_date,
      s.end_date,
      s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0) as effective_end_date,
      (s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)) - v_today as days_remaining,
      br.name as branch_name,
      s.invoice_id,
      s.created_at,
      s.cancelled_at,
      s.cancel_reason,
      coalesce(fin.outstanding, 0) as outstanding
    from public.club_membership_subscriptions s
    join public.branches br on br.id = s.branch_id
    left join lateral public.get_invoice_payment_summary(array[s.invoice_id]) fin on s.invoice_id is not null
    where s.customer_id = p_customer_id and s.club_id = p_club_id
  ) row;

  return v_result;
end;
$$;

grant execute on function public.get_customer_club_memberships(uuid, uuid) to service_role, authenticated;
revoke all on function public.get_customer_club_memberships(uuid, uuid) from public, anon;

-- 3) Staff member list -- search/filter/paginate, branch-scope aware
--    (caller_accessible_branch_ids), club-local expiring-soon window.
create or replace function public.list_club_membership_subscriptions(
  p_club_id uuid,
  p_search text default null,
  p_status text default null,
  p_plan_id uuid default null,
  p_branch_id uuid default null,
  p_expiring_within_days integer default null,
  p_page integer default 1,
  p_page_size integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result jsonb;
  v_today date;
  v_accessible_branches uuid[];
  v_offset integer;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club_membership.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  v_accessible_branches := public.caller_accessible_branch_ids(p_club_id);

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  v_offset := greatest(p_page - 1, 0) * greatest(p_page_size, 1);

  with base as (
    select
      s.id as membership_subscription_id,
      s.membership_number,
      s.customer_id,
      c.full_name as customer_name,
      c.mobile_display as customer_mobile,
      s.plan_id,
      s.plan_name_ar_snapshot,
      s.plan_name_en_snapshot,
      s.status,
      public.get_club_membership_effective_status(
        s.status, s.start_date,
        s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
        v_today
      ) as effective_status,
      s.start_date,
      s.end_date,
      s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0) as effective_end_date,
      s.branch_id,
      br.name as branch_name
    from public.club_membership_subscriptions s
    join public.customers c on c.id = s.customer_id
    join public.branches br on br.id = s.branch_id
    where s.club_id = p_club_id
      and (v_accessible_branches is null or s.branch_id = any(v_accessible_branches))
      and (p_plan_id is null or s.plan_id = p_plan_id)
      and (p_branch_id is null or s.branch_id = p_branch_id)
      and (p_search is null or trim(p_search) = '' or c.full_name ilike '%' || p_search || '%' or c.mobile_display ilike '%' || p_search || '%' or s.membership_number ilike '%' || p_search || '%')
  ),
  filtered as (
    select * from base
    where (p_status is null or effective_status = p_status)
      and (p_expiring_within_days is null or (effective_status = 'active' and effective_end_date <= v_today + p_expiring_within_days))
  ),
  counted as (
    select count(*) as total_count from filtered
  )
  select jsonb_build_object(
    'total_count', (select total_count from counted),
    'page', p_page,
    'page_size', p_page_size,
    'rows', coalesce((
      select jsonb_agg(row_to_json(f) order by f.start_date desc)
      from (select * from filtered order by start_date desc offset v_offset limit p_page_size) f
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

grant execute on function public.list_club_membership_subscriptions(uuid, text, text, uuid, uuid, integer, integer, integer) to service_role, authenticated;
revoke all on function public.list_club_membership_subscriptions(uuid, text, text, uuid, uuid, integer, integer, integer) from public, anon;

-- 4) Staff plan list with active-membership counts.
create or replace function public.list_club_membership_plans(p_club_id uuid, p_include_archived boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club_membership.plan.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(row_to_json(row) order by row.sort_order, row.name_en), '[]'::jsonb) into v_result
  from (
    select
      p.id as plan_id, p.name_ar, p.name_en, p.description, p.price,
      p.duration_value, p.duration_unit, p.is_active, p.is_public,
      p.allow_renewal, p.allow_freeze, p.max_freeze_days_per_period,
      p.branch_scope, p.sort_order, p.archived_at,
      (select count(*) from public.club_membership_subscriptions s where s.plan_id = p.id and s.status in ('active', 'scheduled', 'frozen')) as active_membership_count,
      (select count(*) from public.club_membership_subscriptions s where s.plan_id = p.id) as total_membership_count,
      coalesce((select jsonb_agg(pb.branch_id) from public.club_membership_plan_branches pb where pb.plan_id = p.id), '[]'::jsonb) as branch_ids
    from public.club_membership_plans p
    where p.club_id = p_club_id
      and (p_include_archived or p.archived_at is null)
  ) row;

  return v_result;
end;
$$;

grant execute on function public.list_club_membership_plans(uuid, boolean) to service_role, authenticated;
revoke all on function public.list_club_membership_plans(uuid, boolean) from public, anon;

-- 5) Public plan catalog -- is_active AND is_public only, for the
--    customer purchase flow's plan browsing (no auth required, mirrors
--    get_public_club_subscription_access's own public-safe pattern).
create or replace function public.get_public_club_membership_plans(p_club_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(jsonb_agg(row_to_json(row) order by row.sort_order, row.name_en), '[]'::jsonb)
  from (
    select
      p.id as plan_id, p.name_ar, p.name_en, p.description, p.price,
      p.duration_value, p.duration_unit, p.allow_renewal, p.allow_freeze,
      p.branch_scope, p.sort_order,
      coalesce((select jsonb_agg(pb.branch_id) from public.club_membership_plan_branches pb where pb.plan_id = p.id), '[]'::jsonb) as branch_ids
    from public.club_membership_plans p
    where p.club_id = p_club_id and p.is_active = true and p.is_public = true and p.archived_at is null
  ) row;
$$;

grant execute on function public.get_public_club_membership_plans(uuid) to service_role, authenticated, anon;

-- 6) Single membership detail (staff) -- full record incl. freeze
--    history, for the member detail dialog.
create or replace function public.get_club_membership_detail(p_membership_subscription_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_result jsonb;
  v_today date;
begin
  select s.* into v_sub
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.view', s.club_id);

  if v_sub.id is null then
    raise exception 'club membership not found or you do not have permission to view it';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_sub.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_sub.club_id, current_date);

  select jsonb_build_object(
    'membership_subscription_id', v_sub.id,
    'membership_number', v_sub.membership_number,
    'customer_id', v_sub.customer_id,
    'customer_name', (select full_name from public.customers where id = v_sub.customer_id),
    'customer_photo_url', (select photo_url from public.customers where id = v_sub.customer_id),
    'plan_id', v_sub.plan_id,
    'plan_name_ar', v_sub.plan_name_ar_snapshot,
    'plan_name_en', v_sub.plan_name_en_snapshot,
    'price', v_sub.price_snapshot,
    'duration_value', v_sub.duration_value_snapshot,
    'duration_unit', v_sub.duration_unit_snapshot,
    'status', v_sub.status,
    'effective_status', public.get_club_membership_effective_status(
      v_sub.status, v_sub.start_date,
      v_sub.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = v_sub.id), 0),
      v_today
    ),
    'start_date', v_sub.start_date,
    'end_date', v_sub.end_date,
    'effective_end_date', v_sub.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = v_sub.id), 0),
    'branch_id', v_sub.branch_id,
    'branch_name', (select name from public.branches where id = v_sub.branch_id),
    'invoice_id', v_sub.invoice_id,
    'cancelled_at', v_sub.cancelled_at,
    'cancelled_by', v_sub.cancelled_by,
    'cancel_reason', v_sub.cancel_reason,
    'created_at', v_sub.created_at,
    'freezes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'start_date', f.start_date, 'end_date', f.end_date,
        'freeze_days', f.end_date - f.start_date, 'reason', f.reason, 'created_at', f.created_at
      ) order by f.start_date desc)
      from public.club_membership_freezes f where f.membership_subscription_id = v_sub.id
    ), '[]'::jsonb),
    'renewal_history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', h.id, 'membership_number', h.membership_number, 'status', h.status,
        'start_date', h.start_date, 'end_date', h.end_date, 'price', h.price_snapshot
      ) order by h.start_date desc)
      from public.club_membership_subscriptions h
      where h.customer_id = v_sub.customer_id and h.club_id = v_sub.club_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

grant execute on function public.get_club_membership_detail(uuid) to service_role, authenticated;
revoke all on function public.get_club_membership_detail(uuid) from public, anon;
