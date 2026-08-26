-- Fixes a real bug caught by live testing immediately after
-- search_platform_clubs() was first applied: PL/pgSQL implicitly
-- declares each RETURNS TABLE(...) output column as an in-scope
-- variable for the whole function body, so the `filtered` CTE's WHERE
-- clause referencing `club_status`/`access`/`reason`/etc unqualified
-- collided with those (42702 "column reference is ambiguous"). Fixed
-- by qualifying every reference to the `computed` CTE's columns with
-- its own alias inside `filtered`. Every other line byte-preserved.
create or replace function public.search_platform_clubs(
  p_search text default null,
  p_status text default null,
  p_access text default null,
  p_reason text default null,
  p_flagged_only boolean default false,
  p_limit int default 50,
  p_offset int default 0
)
returns table(
  club_id uuid,
  club_name text,
  club_code text,
  club_status text,
  club_country text,
  created_at timestamptz,
  flagged_duplicate boolean,
  owner_names text[],
  owner_emails text[],
  owner_phones text[],
  access text,
  reason text,
  total_count bigint
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  return query
  with owners as (
    select
      cm.club_id,
      array_agg(distinct p.full_name) filter (where p.full_name is not null) as owner_names,
      array_agg(distinct u.email::text) filter (where u.email is not null) as owner_emails,
      array_agg(distinct p.phone) filter (where p.phone is not null) as owner_phones
    from public.club_memberships cm
    join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
    left join public.profiles p on p.user_id = cm.user_id
    left join auth.users u on u.id = cm.user_id
    group by cm.club_id
  ),
  latest_sub as (
    select distinct on (ps.club_id)
      ps.club_id, ps.end_at, ps.grace_period_days_snapshot
    from public.platform_subscriptions ps
    where ps.lifecycle_status != 'cancelled'
    order by ps.club_id, ps.start_at desc
  ),
  computed as (
    select
      c.id as club_id,
      c.name_ar as club_name,
      c.club_code,
      c.status as club_status,
      c.country as club_country,
      c.created_at,
      coalesce(c.flagged_duplicate, false) as flagged_duplicate,
      coalesce(o.owner_names, array[]::text[]) as owner_names,
      coalesce(o.owner_emails, array[]::text[]) as owner_emails,
      coalesce(o.owner_phones, array[]::text[]) as owner_phones,
      case
        when c.status in ('suspended', 'closed') then 'blocked'
        when ls.club_id is null then 'blocked'
        when now() < ls.end_at then 'full'
        when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'grace'
        else 'blocked'
      end as access,
      case
        when c.status in ('suspended', 'closed') then 'admin_suspended'
        when ls.club_id is null then 'no_subscription'
        when now() < ls.end_at then 'active'
        when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'in_grace'
        else 'expired'
      end as reason
    from public.clubs c
    left join owners o on o.club_id = c.id
    left join latest_sub ls on ls.club_id = c.id
  ),
  filtered as (
    select *
    from computed cc
    where (p_status is null or cc.club_status = p_status)
      and (p_access is null or cc.access = p_access)
      and (p_reason is null or cc.reason = p_reason)
      and (not p_flagged_only or cc.flagged_duplicate)
      and (
        p_search is null or p_search = ''
        or cc.club_name ilike '%' || p_search || '%'
        or cc.club_code ilike '%' || p_search || '%'
        or exists (select 1 from unnest(cc.owner_names) n where n ilike '%' || p_search || '%')
        or exists (select 1 from unnest(cc.owner_emails) e where e ilike '%' || p_search || '%')
        or exists (select 1 from unnest(cc.owner_phones) ph where ph ilike '%' || p_search || '%')
      )
  )
  select f.*, count(*) over ()::bigint as total_count
  from filtered f
  order by f.created_at desc
  limit p_limit offset p_offset;
end;
$$;
