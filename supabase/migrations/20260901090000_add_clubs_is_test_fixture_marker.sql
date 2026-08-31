-- Controlled Commercial Launch Gate, Phase 6 follow-up (approved by
-- owner 2026-09-01): mark the 13 existing QA/test/demo tenants so
-- platform-owner views can distinguish them from real tenants once
-- real tenants exist. See QA_DATA_ISOLATION.md for the full analysis.
--
-- Deliberately NOT reusing flagged_duplicate -- that column is a
-- different, real, already-working feature (name-collision detection
-- at signup time), not a QA/test marker. Conflating the two would
-- make both concepts less clear.
--
-- Additive only: new column, default false, backfilled for known
-- fixtures, existing rows/behavior otherwise unchanged. No data
-- destroyed.

alter table public.clubs
  add column if not exists is_test_fixture boolean not null default false;

comment on column public.clubs.is_test_fixture is
  'True for disposable QA/test/demo tenant fixtures created during development and acceptance testing, never for real paying customers. Used to exclude these from platform-owner aggregate views/reports by default (see search_platform_clubs()) without deleting their history. Set manually via governed migration, never inferred automatically.';

-- Backfill: the 13 known QA/test/demo clubs identified and verified in
-- QA_DATA_ISOLATION.md (2026-08-31). Exact IDs, not a name pattern
-- match, to avoid ever accidentally marking a real tenant whose name
-- happens to contain "Test"/"Demo".
update public.clubs
set is_test_fixture = true
where id in (
  '57ce89e4-184a-413f-bc47-ee0fdb878727', -- Mala3by Test Club One
  'c0b02979-a49e-4338-bcac-d789ca397aeb', -- Mala3by Test Club Two
  '0d533d74-c98e-49f1-a59b-b3d75a5af133', -- Mala3by Verification Club
  '7f337c8c-f641-4f51-9d52-4a4e737b2934', -- Mala3by Verification Club 2
  'b9178c0f-00b5-4c71-abec-b8772ffb8682', -- Test
  '6ca5315e-e199-4531-9fb1-1df358cda087', -- QA Full Test Club
  'a6bf6b6d-9a58-4636-bc6b-8ab0e7ed0b50', -- Demo Club
  'da916cde-3e66-4010-9fee-020ae981758c', -- QA_Lifecycle_Club_A
  '91b90fe2-4edb-4fd1-93b8-f0e5beaa7a9a', -- QA_Lifecycle_Club_A2
  '563eb7d0-8615-4021-a70b-f79560f63243', -- QA_Lifecycle_Club_B
  '774aea41-f7f7-4952-96c4-4e02ea87fa65', -- QA_Lifecycle_RegressionCheck
  'f8376f07-2b53-4146-a7fd-411c2672115a', -- Mal3aby E2E QA Club
  '676ea358-0db4-49e5-bfc6-e6d21abf960b'  -- Mal3aby E2E Tenant B
);

-- Extend search_platform_clubs() to exclude test fixtures by default,
-- with an explicit opt-in toggle (p_include_test_fixtures) for
-- support/QA use. Signature unchanged except for one new trailing
-- DEFAULT parameter -- existing callers (old frontend build, if any
-- mid-deploy) keep working unmodified.
create or replace function public.search_platform_clubs(
  p_search text default null,
  p_status text default null,
  p_access text default null,
  p_reason text default null,
  p_flagged_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0,
  p_include_test_fixtures boolean default false
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
as $function$
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
      coalesce(c.is_test_fixture, false) as is_test_fixture,
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
      and (p_include_test_fixtures or not cc.is_test_fixture)
      and (
        p_search is null or p_search = ''
        or cc.club_name ilike '%' || p_search || '%'
        or cc.club_code ilike '%' || p_search || '%'
        or exists (select 1 from unnest(cc.owner_names) n where n ilike '%' || p_search || '%')
        or exists (select 1 from unnest(cc.owner_emails) e where e ilike '%' || p_search || '%')
        or exists (select 1 from unnest(cc.owner_phones) ph where ph ilike '%' || p_search || '%')
      )
  )
  select
    f.club_id, f.club_name, f.club_code, f.club_status, f.club_country,
    f.created_at, f.flagged_duplicate, f.owner_names, f.owner_emails,
    f.owner_phones, f.access, f.reason,
    count(*) over ()::bigint as total_count
  from filtered f
  order by f.created_at desc
  limit p_limit offset p_offset;
end;
$function$;
