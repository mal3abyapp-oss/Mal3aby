-- Platform Owner directive, cross-phase (U1/U2): Platform User
-- Management visibility.
--
-- U1. Platform Owner accounts had zero visibility anywhere on the
-- console -- only discoverable via a direct DB query (confirmed by the
-- live audit). This RPC lists them via the same safe pattern
-- get_platform_club_owners() already uses (profiles/auth.users joined
-- server-side, no direct auth.users exposure to the client).
--
-- U2. Club administrative/staff visibility beyond club_owner (managers,
-- coaches, scanners, etc.) had no platform-level visibility either --
-- a platform owner had to open each club's own Staff page individually.
-- This is a SUMMARY count only (per directive: "لا يحتاج تعديل كل staff
-- permission افتراضيًا" -- no permission editing, no full user list,
-- just enough for a support agent to know a club has staff beyond its
-- owner). Full staff management stays exactly where it already is
-- (each club's own Staff page) -- this does not duplicate it.
create or replace function public.get_platform_owner_accounts()
returns table(
  user_id uuid,
  full_name text,
  email text,
  phone text,
  club_count bigint,
  created_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query
  select
    cm.user_id,
    p.full_name,
    u.email::text,
    p.phone,
    (select count(*) from public.club_memberships cm2
       join public.roles r2 on r2.id = cm2.role_id and r2.key = 'club_owner'
       where cm2.user_id = cm.user_id and cm2.status = 'active') as club_count,
    min(cm.created_at) as created_at
  from public.club_memberships cm
  join public.roles r on r.id = cm.role_id and r.key = 'platform_owner'
  left join public.profiles p on p.user_id = cm.user_id
  left join auth.users u on u.id = cm.user_id
  where cm.status = 'active'
  group by cm.user_id, p.full_name, u.email, p.phone
  order by min(cm.created_at) asc;
end;
$function$;

revoke all on function public.get_platform_owner_accounts() from public;
revoke all on function public.get_platform_owner_accounts() from anon;
grant execute on function public.get_platform_owner_accounts() to authenticated;

-- U2: per-club staff summary (counts only, by role), for the Club 360
-- panel -- not a new staff-management screen.
create or replace function public.get_platform_club_staff_summary(p_club_id uuid)
returns table(role_key text, role_name text, member_count bigint)
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
  select r.key as role_key, r.name_ar as role_name, count(*) as member_count
  from public.club_memberships cm
  join public.roles r on r.id = cm.role_id
  where cm.club_id = p_club_id and cm.status = 'active' and r.key != 'club_owner'
  group by r.key, r.name_ar
  order by r.key;
end;
$function$;

revoke all on function public.get_platform_club_staff_summary(uuid) from public;
revoke all on function public.get_platform_club_staff_summary(uuid) from anon;
grant execute on function public.get_platform_club_staff_summary(uuid) to authenticated;
