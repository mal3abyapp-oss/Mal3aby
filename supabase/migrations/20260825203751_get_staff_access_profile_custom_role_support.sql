-- STAFF ACCESS CONTROL & CUSTOM ROLES -- direct defect fix.
--
-- get_staff_access_profile() only ever looked up `roles` by
-- v_membership.role_id -- which is NULL for a custom-role membership
-- (club_memberships_exactly_one_role). This made Employee 360's Access
-- tab show a blank role name and an EMPTY permissions list for any
-- custom-role staff member, misleadingly implying they have zero
-- access when they actually have whatever their custom role grants.
-- Widened to resolve through either roles or club_roles, whichever the
-- membership actually has set. Same RETURNS jsonb shape -- safe CREATE
-- OR REPLACE, only the internal jsonb content is richer (adds
-- is_custom + nullable key, additive, does not remove any existing
-- key any caller might read).
--
-- NOTE: this version has a known bug (a CASE expression referencing an
-- unassigned plpgsql record's fields raises "record is not assigned
-- yet") -- fixed in the immediately-following migration,
-- fix_get_staff_access_profile_unassigned_record. Kept here verbatim,
-- matching exactly what was applied to production in this order, per
-- this project's own "the migration must be committed exactly as
-- deployed" release-discipline rule.
create or replace function public.get_staff_access_profile(p_club_id uuid, p_membership_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_role record;
  v_custom_role record;
  v_permissions jsonb;
  v_branches jsonb;
  v_all_branches jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  if v_membership.role_id is not null then
    select id, key, name, name_ar into v_role from public.roles where id = v_membership.role_id;

    select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'description', p.description) order by p.key), '[]'::jsonb)
      into v_permissions
    from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_membership.role_id;
  else
    select id, name_en, name_ar into v_custom_role from public.club_roles where id = v_membership.custom_role_id;

    select coalesce(jsonb_agg(jsonb_build_object('key', p.key, 'description', p.description) order by p.key), '[]'::jsonb)
      into v_permissions
    from public.club_role_permissions crp
    join public.permissions p on p.id = crp.permission_id
    where crp.club_role_id = v_membership.custom_role_id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name)), '[]'::jsonb) into v_branches
  from public.membership_branches mb
  join public.branches b on b.id = mb.branch_id
  where mb.membership_id = p_membership_id;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) into v_all_branches
  from public.branches where club_id = p_club_id and status = 'active';

  return jsonb_build_object(
    'role', case
      when v_membership.role_id is not null then jsonb_build_object('id', v_role.id, 'key', v_role.key, 'name', v_role.name, 'name_ar', v_role.name_ar, 'is_custom', false)
      else jsonb_build_object('id', v_custom_role.id, 'key', null, 'name', v_custom_role.name_en, 'name_ar', v_custom_role.name_ar, 'is_custom', true)
    end,
    'permissions', v_permissions,
    'assigned_branches', v_branches,
    'all_club_branches', v_all_branches,
    'branch_scope_is_all', jsonb_array_length(v_branches) = 0
  );
end;
$function$;
