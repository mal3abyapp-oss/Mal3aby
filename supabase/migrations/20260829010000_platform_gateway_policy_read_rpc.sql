-- PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase A.
-- PLATFORM_OWNER_CONTROL_PRODUCTION_ACCEPTANCE.md's confirmed remaining
-- gap: set_club_gateway_provider_policy() (Phase 5) has zero UI. This
-- migration adds the one missing piece: a platform-owner-gated read RPC
-- that combines a club's real connection state (never secrets --
-- has_secret boolean only, mirroring list_club_gateway_connections'
-- own existing convention) with its policy state (allowed/policy_blocked
-- per provider), so a single screen can show both without a second
-- round trip or requiring an active support session (unlike
-- list_club_gateway_connections, which is club-permission/support-
-- session-gated only -- the Platform Owner's own direct authorization
-- path, is_platform_owner(), was never wired into that read path).

create or replace function public.get_platform_club_gateway_overview(p_club_id uuid)
returns table (
  provider_key text,
  provider_display_name text,
  supported_countries text[],
  connection_id uuid,
  environment text,
  connected boolean,
  enabled boolean,
  is_default boolean,
  last_verified_at timestamptz,
  last_verification_error text,
  last_webhook_at timestamptz,
  last_webhook_error text,
  policy_status text,
  policy_reason text,
  policy_updated_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (
    public.is_platform_owner()
    or public.has_platform_permission('platform.club.view')
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;

  return query
  select
    p.key,
    p.display_name,
    p.supported_countries,
    c.id,
    c.environment,
    (c.id is not null),
    coalesce(c.enabled, false),
    coalesce(c.is_default, false),
    c.last_verified_at,
    c.last_verification_error,
    c.last_webhook_at,
    c.last_webhook_error,
    coalesce(pol.status, 'allowed'),
    pol.reason,
    pol.updated_at
  from public.payment_gateway_providers p
  left join public.club_gateway_connections c
    on c.club_id = p_club_id and c.provider_key = p.key
  left join public.club_gateway_provider_policy pol
    on pol.club_id = p_club_id and pol.provider_key = p.key
  where p.status = 'active'
  order by p.display_name, c.environment nulls last;
end;
$function$;

revoke all on function public.get_platform_club_gateway_overview(uuid) from public;
revoke all on function public.get_platform_club_gateway_overview(uuid) from anon;
grant execute on function public.get_platform_club_gateway_overview(uuid) to authenticated;
