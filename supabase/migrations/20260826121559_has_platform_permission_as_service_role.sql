-- has_platform_permission_as(p_user_id, p_key): the service_role-only
-- counterpart of has_platform_permission() -- needed because the
-- platform-staff-admin Edge Function authenticates the CALLER via their
-- own JWT (a completely separate client from the service_role admin
-- client that performs the actual Admin API operations), so there is no
-- auth.uid() available in the service_role client's own SQL context to
-- check against. Mirrors the exact same precedent already established
-- by claim_portal_invite_service(p_raw_token, p_user_id) for
-- activate-portal-account -- explicit p_user_id parameter, granted to
-- service_role ONLY (never anon/authenticated), so this is never a
-- client-reachable bypass of has_platform_permission()'s own real
-- auth.uid()-based logic -- it is reachable exclusively from the trusted
-- server context of that one Edge Function.
create or replace function public.has_platform_permission_as(p_user_id uuid, p_key text)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    exists (
      select 1 from public.club_memberships cm
      join public.roles r on r.id = cm.role_id
      where cm.user_id = p_user_id and cm.status = 'active' and r.key = 'platform_owner'
    )
    or exists (
      select 1
      from public.platform_staff_memberships psm
      left join public.platform_role_permissions prp on prp.platform_role_id = psm.platform_role_id
      left join public.platform_custom_role_permissions pcrp on pcrp.platform_custom_role_id = psm.platform_custom_role_id
      join public.platform_permissions pp on pp.id = coalesce(prp.platform_permission_id, pcrp.platform_permission_id)
      where psm.user_id = p_user_id
        and psm.status = 'active'
        and pp.key = p_key
    )
$$;

revoke all on function public.has_platform_permission_as(uuid, text) from public;
revoke all on function public.has_platform_permission_as(uuid, text) from anon;
revoke all on function public.has_platform_permission_as(uuid, text) from authenticated;
grant execute on function public.has_platform_permission_as(uuid, text) to service_role;
