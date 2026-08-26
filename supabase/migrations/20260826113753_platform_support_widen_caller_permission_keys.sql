-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- caller_permission_keys() is
-- the single root helper permission_set_escalates() (and therefore every
-- role-CRUD RPC's own escalation check) is built on: it derives "what can
-- the caller grant" purely from their own club_memberships row for
-- p_club_id, which a platform_owner never has for an arbitrary club they
-- don't independently belong to. Without this change, EVERY role-CRUD
-- call from a valid MANAGE-mode support session would be rejected as
-- "escalation" (since caller_permission_keys would return zero rows for
-- them), even though has_platform_support_access(p_club_id, true) is
-- specifically designed to grant exactly this kind of full administrative
-- capability for the club they are actively, explicitly supporting.
--
-- Widened, centrally, in the ONE function every escalation check already
-- routes through (directive Section 6/9/21: centralize the bypass, don't
-- scatter is_platform_owner() checks through every call site): when a
-- valid MANAGE-mode support session exists for p_club_id, the caller is
-- treated as holding every permission key in the catalog (the intended,
-- explicit semantic of Master Admin MANAGE mode -- full administrative
-- capability for the club being supported, never for any other club).
-- Ordinary tenant users are completely unaffected -- has_platform_support_access
-- is false for them by construction (not is_platform_owner()), so this
-- new UNION ALL branch contributes zero rows and the function's behavior
-- for every non-platform-owner caller is byte-identical to before.
create or replace function public.caller_permission_keys(p_club_id uuid)
returns setof text
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select p.key
  from public.club_memberships cm
  left join public.role_permissions rp on rp.role_id = cm.role_id
  left join public.club_role_permissions crp on crp.club_role_id = cm.custom_role_id
  join public.permissions p on p.id = coalesce(rp.permission_id, crp.permission_id)
  where cm.user_id = auth.uid()
    and cm.club_id = p_club_id
    and cm.status = 'active'
  union
  select key from public.permissions
  where public.has_platform_support_access(p_club_id, true)
$$;
