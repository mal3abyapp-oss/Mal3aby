-- PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase E (2026-08-29)
--
-- Directive Section 22: "if backend data exists, build a practical
-- read-only screen (support user, club, access level, reason, start,
-- expiry, end, status)". platform_support_sessions already carries every
-- field the directive names (platform_owner_id, club_id, mode, reason,
-- started_at, expires_at, ended_at) -- confirmed via schema inspection,
-- no new table/column needed. Only a read RPC was missing (the existing
-- functions -- has_platform_support_access / get_my_active_support_session
-- / start_platform_support_session / end_platform_support_session -- are
-- all check/mutate, none are a listing read). This RPC is purely
-- additive: no change to authorization, no change to how sessions are
-- started/ended, and it never weakens support-session isolation --
-- gated the same way get_platform_club_gateway_overview (Phase A) is,
-- restricted to platform owners / holders of a real existing platform
-- permission (see below).
--
-- Joins in the support user's and club's display identity so the UI
-- doesn't need extra round-trips or expose more than necessary. Status
-- is derived server-side (ended / expired / active) rather than left for
-- the client to compute from raw timestamps, to avoid clock-skew-driven
-- inconsistency between rows on the same screen.
--
-- Authorization reuses the existing 'platform.audit.view' permission
-- (already granted to the same platform roles that can see the Audit
-- Log) rather than introducing a new platform_permissions catalog row --
-- support session history is fundamentally the same kind of read
-- (a historical log of privileged platform actions), and adding a
-- brand-new permission key would mean also wiring it into
-- platform_role_permissions for every relevant role, which is more
-- surface than a "practical read-only screen" calls for per the
-- directive's own Section 22 guidance against disproportionate new
-- architecture.

create or replace function public.get_platform_support_session_history(
  p_club_id uuid default null,
  p_limit int default 200
)
returns table (
  id uuid,
  platform_owner_id uuid,
  platform_owner_email text,
  club_id uuid,
  club_name text,
  mode text,
  reason text,
  started_at timestamptz,
  expires_at timestamptz,
  ended_at timestamptz,
  status text
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (
    public.is_platform_owner()
    or public.has_platform_permission('platform.audit.view')
  ) then
    raise exception 'not authorized';
  end if;

  return query
  select
    s.id,
    s.platform_owner_id,
    u.email::text,
    s.club_id,
    c.name,
    s.mode,
    s.reason,
    s.started_at,
    s.expires_at,
    s.ended_at,
    case
      when s.ended_at is not null then 'ended'
      when s.expires_at <= now() then 'expired'
      else 'active'
    end as status
  from public.platform_support_sessions s
  join auth.users u on u.id = s.platform_owner_id
  join public.clubs c on c.id = s.club_id
  where p_club_id is null or s.club_id = p_club_id
  order by s.started_at desc
  limit greatest(1, least(p_limit, 500));
end;
$function$;

revoke all on function public.get_platform_support_session_history(uuid, int) from public;
revoke all on function public.get_platform_support_session_history(uuid, int) from anon;
grant execute on function public.get_platform_support_session_history(uuid, int) to authenticated;
