-- CLUB STAFF ONBOARDING (2026-08-26), continued -- service_role-only
-- variant of has_permission(), needed by the new club-staff-admin Edge
-- Function for the exact same reason has_platform_permission_as() was
-- needed by platform-staff-admin: the Edge Function's service_role
-- client has no auth.uid() session, so the caller's real identity
-- (resolved from their own JWT via a separate caller-scoped client, in
-- the Edge Function, BEFORE any privileged action) must be checked
-- explicitly against an accepted p_user_id parameter instead. Mirrors
-- has_permission()'s own join shape exactly -- not a re-derivation.
create or replace function public.has_permission_as(p_user_id uuid, p_key text, p_club_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from public.club_memberships cm
    left join public.role_permissions rp
      on rp.role_id = cm.role_id
    left join public.club_role_permissions crp
      on crp.club_role_id = cm.custom_role_id
    join public.permissions p
      on p.id = coalesce(rp.permission_id, crp.permission_id)
    where cm.user_id = p_user_id
      and cm.club_id = p_club_id
      and cm.status = 'active'
      and p.key = p_key
  )
$$;

revoke all on function public.has_permission_as(uuid, text, uuid) from public;
revoke all on function public.has_permission_as(uuid, text, uuid) from anon;
revoke all on function public.has_permission_as(uuid, text, uuid) from authenticated;
grant execute on function public.has_permission_as(uuid, text, uuid) to service_role;
