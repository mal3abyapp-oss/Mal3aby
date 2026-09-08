-- Platform Owner Control Plane V1, Phase 9 (Owners / Audit Pagination).
--
-- Confirmed defect (deep dive Section 16/26): PlatformOwnersPage.tsx and
-- PlatformAuditPage.tsx both use an unbounded in-memory "load more"
-- accumulation pattern (a `pages` counter that re-fetches every page
-- 0..N on each render and concatenates them into one ever-growing
-- client-side array/DOM) instead of true page-replace pagination --
-- unlike PlatformClubsPage.tsx (search_platform_clubs()), which already
-- does real server-side LIMIT/OFFSET with page-replace semantics and a
-- real total_count. At `audit_logs` = 2,197 rows today (live-verified)
-- and growing on every mutating action platform-wide, this is a real,
-- not hypothetical, scale risk.
--
-- Both RPCs already accept p_limit/p_offset (added by earlier
-- migrations: 20260819150000 for get_platform_club_owners,
-- 20260819100002 for get_platform_audit_log) -- what's missing is (a) a
-- real total_count so the frontend can render Prev/Next + "page X of Y"
-- instead of an open-ended "load more", and (b) a genuinely unique
-- ORDER BY tiebreaker, since both currently order by a non-unique
-- timestamp column alone (cm.created_at / al.created_at) -- two rows
-- with the exact same timestamp (a real possibility: audit rows from
-- the same transaction, or owner memberships created in the same
-- request) can be skipped or duplicated across LIMIT/OFFSET page
-- boundaries without a tiebreaker. Fixed by appending each row's own
-- primary key (membership_id / id) as a secondary sort key -- the same
-- fix class search_platform_clubs() already needed and got.
--
-- Both functions add `total_count bigint` as a new trailing output
-- column. This changes the `returns table(...)` shape, so `create or
-- replace function` cannot be used in place (Postgres does not allow
-- changing a function's return columns via REPLACE) -- both are
-- explicitly dropped and recreated. This is still fully backward
-- compatible for every existing caller: the function NAME and INPUT
-- signature (same parameters, same defaults, same order) are unchanged,
-- so any caller not reading the new trailing column (e.g.
-- PlatformGlobalSearch.tsx's small p_limit=5 lookup against
-- get_platform_club_owners) keeps working exactly as before -- it
-- simply ignores the extra returned column, same as any other SELECT
-- consumer would. No other call site was found for either RPC besides
-- PlatformOwnersPage.tsx / PlatformGlobalSearch.tsx (club owners) and
-- PlatformAuditPage.tsx (audit log) -- confirmed by a full grep of
-- src/ before writing this migration. PlatformClubDetailPage's own
-- Audit tab reads audit_logs directly (not via this RPC), so it is
-- unaffected either way.

drop function if exists public.get_platform_club_owners(text, int, int);

create or replace function public.get_platform_club_owners(
  p_search text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns table(
  club_id uuid,
  club_name text,
  club_code text,
  club_status text,
  membership_id uuid,
  membership_status text,
  user_id uuid,
  full_name text,
  phone text,
  email text,
  owner_since timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  with matched as (
    select
      c.id as club_id,
      c.name_ar as club_name,
      c.club_code,
      c.status as club_status,
      cm.id as membership_id,
      cm.status as membership_status,
      cm.user_id,
      p.full_name,
      p.phone,
      u.email::text as email,
      cm.created_at as owner_since
    from public.club_memberships cm
    join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
    join public.clubs c on c.id = cm.club_id
    join public.profiles p on p.user_id = cm.user_id
    join auth.users u on u.id = cm.user_id
    where p_search is null or p_search = ''
       or p.full_name ilike '%' || p_search || '%'
       or u.email ilike '%' || p_search || '%'
       or p.phone ilike '%' || p_search || '%'
       or c.name_ar ilike '%' || p_search || '%'
       or c.club_code ilike '%' || p_search || '%'
  )
  select
    m.club_id, m.club_name, m.club_code, m.club_status, m.membership_id,
    m.membership_status, m.user_id, m.full_name, m.phone, m.email, m.owner_since,
    -- count(*) over () (not a per-row correlated scalar subquery): computed
    -- once per query plan over the full `matched` set and attached to every
    -- output row in the same pass, instead of re-scanning `matched` once per
    -- returned row (up to p_limit times). Flagged by an independent Phase 14
    -- performance review as a real cost once audit/owner history grows well
    -- past today's near-zero real data.
    count(*) over () as total_count
  from matched m
  -- Stable/deterministic across pages at any page size: created_at is
  -- not guaranteed unique (e.g. two owner memberships created in the
  -- same request), membership_id (primary key) always is.
  order by m.owner_since desc, m.membership_id desc
  limit p_limit offset p_offset;
end;
$function$;

revoke all on function public.get_platform_club_owners(text, int, int) from public;
revoke all on function public.get_platform_club_owners(text, int, int) from anon;
grant execute on function public.get_platform_club_owners(text, int, int) to authenticated;

drop function if exists public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz);

create or replace function public.get_platform_audit_log(
  p_limit int default 200,
  p_offset int default 0,
  p_actor_id uuid default null,
  p_action text default null,
  p_entity_type text default null,
  p_club_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(
  id uuid,
  club_id uuid,
  club_name text,
  actor_id uuid,
  actor_name text,
  actor_email text,
  action text,
  entity_type text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  with matched as (
    select
      al.id, al.club_id, c.name_ar as club_name,
      al.actor_id,
      coalesce(p.full_name, 'SYSTEM') as actor_name,
      u.email::text as actor_email,
      al.action, al.entity_type, al.entity_id,
      al.before, al.after, al.reason, al.created_at
    from public.audit_logs al
    left join public.clubs c on c.id = al.club_id
    left join public.profiles p on p.user_id = al.actor_id
    left join auth.users u on u.id = al.actor_id
    where (p_actor_id is null or al.actor_id = p_actor_id)
      and (p_action is null or al.action = p_action)
      and (p_entity_type is null or al.entity_type = p_entity_type)
      and (p_club_id is null or al.club_id = p_club_id)
      and (p_from is null or al.created_at >= p_from)
      and (p_to is null or al.created_at <= p_to)
  )
  select
    m.id, m.club_id, m.club_name, m.actor_id, m.actor_name, m.actor_email,
    m.action, m.entity_type, m.entity_id, m.before, m.after, m.reason, m.created_at,
    -- count(*) over () -- see get_platform_club_owners above for why this
    -- replaced a per-row correlated scalar subquery.
    count(*) over () as total_count
  from matched m
  -- Same stability fix as get_platform_club_owners above: id (primary
  -- key) as the tiebreaker after created_at, which audit rows from the
  -- same transaction can legitimately share.
  order by m.created_at desc, m.id desc
  limit p_limit offset p_offset;
end;
$function$;

revoke all on function public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz) from public;
revoke all on function public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz) from anon;
grant execute on function public.get_platform_audit_log(int, int, uuid, text, text, uuid, timestamptz, timestamptz) to authenticated;
