-- FINAL AUTONOMOUS REMEDIATION -- Security MEDIUM/HIGH (from
-- MAL3ABY_PRODUCTION_READINESS.md #7 Security Findings HIGH list):
-- get_club_platform_access(p_club_id) had no caller-scope check at
-- all -- confirmed live via pg_proc (proacl grants EXECUTE to
-- `authenticated` unconditionally, and the function body never checks
-- auth.uid() or the caller's relationship to p_club_id).
--
-- Real-world impact is narrow (the function returns only one of
-- 'full'/'grace'/'blocked', no PII, no financial figures), but it did
-- let any signed-in user enumerate any club's platform-subscription
-- health by guessing/iterating club UUIDs -- a genuine, if low-
-- severity, information-disclosure gap that has no reason to exist.
--
-- Fix: add a caller-scope check -- authorized callers are (a) the
-- platform owner (legitimate use: src/features/platform/* screens
-- call this for arbitrary clubs to render the Clubs/Overview/Alerts
-- dashboards), or (b) a staff member who actually belongs to
-- p_club_id (legitimate use: club_write_allowed() calls this
-- internally to gate a club's own write actions against its own
-- subscription state). Every other caller now gets 'blocked' rather
-- than a real answer -- this is a safe default (an unauthorized club
-- ID probe never learns anything beyond "you may not know"), and does
-- not change behavior for either of the two real, confirmed call
-- sites above.
create or replace function public.get_club_platform_access(p_club_id uuid)
returns text  -- 'full' | 'grace' | 'blocked'
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_status text;
  v_sub record;
begin
  if not (
    public.is_platform_owner()
    or p_club_id in (select public.user_club_ids())
  ) then
    return 'blocked';
  end if;

  select status into v_club_status from public.clubs where id = p_club_id;
  if v_club_status is null or v_club_status in ('suspended', 'closed') then
    return 'blocked';
  end if;

  select * into v_sub from public.platform_subscriptions
    where club_id = p_club_id and lifecycle_status != 'cancelled'
    order by start_at desc limit 1;

  if v_sub is null then
    return 'blocked';
  elsif now() < v_sub.end_at then
    return 'full';
  elsif now() < v_sub.end_at + (v_sub.grace_period_days_snapshot || ' days')::interval then
    return 'grace';
  else
    return 'blocked';
  end if;
end;
$$;

revoke execute on function public.get_club_platform_access(uuid) from public;
revoke execute on function public.get_club_platform_access(uuid) from anon;
grant execute on function public.get_club_platform_access(uuid) to authenticated;

comment on function public.get_club_platform_access(uuid) is
  'Security fix (MAL3ABY_PRODUCTION_READINESS.md Security Findings): now scoped to callers who are either the platform owner or an actual member of p_club_id -- previously any authenticated user could probe any club_id and learn its subscription health (full/grace/blocked) with no relationship check at all.';
