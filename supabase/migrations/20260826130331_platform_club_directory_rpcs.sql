-- PLATFORM CLUB SELECTOR FOR LARGE SCALE (2026-08-26), continued.
--
-- search_platform_clubs(): the real server-side search/filter/paginate
-- RPC. Combines get_platform_club_owners()'s own owner-search reach
-- (name/email/phone) with get_platform_clubs_access()'s own
-- access-derivation logic (inlined here as a CTE rather than calling
-- that function per-row, since it needs to run once over the whole
-- filtered/paginated set, not per club id array) -- one row PER CLUB
-- (not per owner-membership, unlike get_platform_club_owners), with
-- owner identity aggregated via array_agg for the (rare) multi-owner
-- case, so a club is never duplicated.
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

revoke all on function public.search_platform_clubs(text, text, text, text, boolean, int, int) from public;
revoke all on function public.search_platform_clubs(text, text, text, text, boolean, int, int) from anon;
grant execute on function public.search_platform_clubs(text, text, text, text, boolean, int, int) to authenticated;

-- record_platform_club_access(): upserts the "recently managed" log
-- entry. Called from inside start_platform_support_session (next
-- migration) -- never a standalone client-callable write beyond that,
-- since "recent" should reflect real support-session starts, not idle
-- browsing.
create or replace function public.record_platform_club_access(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Section 42 -- platform admin tables must be denied to a caller who
  -- doesn't separately hold platform authorization, even though the
  -- unique(platform_admin_user_id, club_id) + own-row RLS would already
  -- make this a no-op-ish write for a non-platform user (their own rows
  -- only) -- explicit denial is still the correct, consistent posture.
  if not (public.is_platform_owner() or public.has_platform_permission('platform.support.start_view') or public.has_platform_permission('platform.support.start_manage')) then
    raise exception 'not authorized';
  end if;
  insert into public.platform_owner_recent_clubs (platform_admin_user_id, club_id, last_accessed_at)
  values (auth.uid(), p_club_id, now())
  on conflict (platform_admin_user_id, club_id)
    do update set last_accessed_at = now();
end;
$$;

revoke all on function public.record_platform_club_access(uuid) from public;
revoke all on function public.record_platform_club_access(uuid) from anon;
grant execute on function public.record_platform_club_access(uuid) to authenticated;

create or replace function public.list_recent_platform_clubs(p_limit int default 10)
returns table(club_id uuid, club_name text, club_code text, last_accessed_at timestamptz)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.support.start_view') or public.has_platform_permission('platform.support.start_manage')) then
    raise exception 'not authorized';
  end if;
  return query
  select c.id, c.name_ar, c.club_code, r.last_accessed_at
  from public.platform_owner_recent_clubs r
  join public.clubs c on c.id = r.club_id
  where r.platform_admin_user_id = auth.uid()
  order by r.last_accessed_at desc
  limit p_limit;
end;
$$;

revoke all on function public.list_recent_platform_clubs(int) from public;
revoke all on function public.list_recent_platform_clubs(int) from anon;
grant execute on function public.list_recent_platform_clubs(int) to authenticated;

create or replace function public.pin_platform_club(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;
  insert into public.platform_owner_pinned_clubs (platform_admin_user_id, club_id)
  values (auth.uid(), p_club_id)
  on conflict (platform_admin_user_id, club_id) do nothing;
end;
$$;

revoke all on function public.pin_platform_club(uuid) from public;
revoke all on function public.pin_platform_club(uuid) from anon;
grant execute on function public.pin_platform_club(uuid) to authenticated;

create or replace function public.unpin_platform_club(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;
  delete from public.platform_owner_pinned_clubs
  where platform_admin_user_id = auth.uid() and club_id = p_club_id;
end;
$$;

revoke all on function public.unpin_platform_club(uuid) from public;
revoke all on function public.unpin_platform_club(uuid) from anon;
grant execute on function public.unpin_platform_club(uuid) to authenticated;

create or replace function public.list_pinned_platform_clubs()
returns table(club_id uuid, club_name text, club_code text, pinned_at timestamptz)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select c.id, c.name_ar, c.club_code, pc.pinned_at
  from public.platform_owner_pinned_clubs pc
  join public.clubs c on c.id = pc.club_id
  where pc.platform_admin_user_id = auth.uid()
  order by pc.pinned_at desc
$$;

revoke all on function public.list_pinned_platform_clubs() from public;
revoke all on function public.list_pinned_platform_clubs() from anon;
grant execute on function public.list_pinned_platform_clubs() to authenticated;
