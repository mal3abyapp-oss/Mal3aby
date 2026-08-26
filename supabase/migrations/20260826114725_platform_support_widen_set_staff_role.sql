-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- same widening pattern as
-- create_club_role (see that migration's own comment for the full
-- rationale), applied to the staff role-assignment RPC. `staff.update`
-- is the relevant permission here (not `roles.manage`).
create or replace function public.set_staff_role(p_club_id uuid, p_membership_id uuid, p_role_key text DEFAULT NULL::text, p_custom_role_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_membership record;
  v_new_role_id uuid;
  v_old_role_key text;
  v_custom_role public.club_roles;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  if not ((p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) or public.has_platform_support_access(p_club_id, true)) then
    raise exception 'not authorized';
  end if;
  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id));

  if (p_role_key is not null) = (p_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  if p_role_key != 'club_owner' or p_custom_role_id is not null then
    if public.club_would_lose_last_owner(p_club_id, p_membership_id) then
      raise exception 'this is the club''s only active owner -- assign another owner first';
    end if;
  end if;

  perform set_config('mal3aby.role_change_authorized', 'true', true);

  if p_custom_role_id is not null then
    select * into v_custom_role from public.club_roles where id = p_custom_role_id and club_id = p_club_id;
    if v_custom_role.id is null then
      raise exception 'custom role not found in this club';
    end if;
    if not v_custom_role.is_active then
      raise exception 'this custom role is disabled';
    end if;
    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id where crp.club_role_id = p_custom_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select r.key into v_old_role_key from public.roles r where r.id = v_membership.role_id;

    if exists (
      select 1 from public.club_memberships
      where user_id = v_membership.user_id and club_id = p_club_id and custom_role_id = p_custom_role_id and id != p_membership_id
    ) then
      raise exception 'this person already has a separate membership with that role in this club';
    end if;

    update public.club_memberships set role_id = null, custom_role_id = p_custom_role_id, updated_at = now()
    where id = p_membership_id;

    perform public.write_audit_log(
      p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
      jsonb_build_object('role_key', v_old_role_key),
      jsonb_build_object('custom_role_id', p_custom_role_id),
      null
    );
    if v_via_support then
      perform public.write_audit_log_as_support(
        p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
        jsonb_build_object('role_key', v_old_role_key), jsonb_build_object('custom_role_id', p_custom_role_id), null
      );
    end if;
  else
    if p_role_key = 'platform_owner' then
      raise exception 'not authorized';
    end if;

    select id into v_new_role_id from public.roles where key = p_role_key;
    if v_new_role_id is null then
      raise exception 'unknown role';
    end if;

    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = v_new_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select r.key into v_old_role_key from public.roles r where r.id = v_membership.role_id;

    if exists (
      select 1 from public.club_memberships
      where user_id = v_membership.user_id and club_id = p_club_id and role_id = v_new_role_id and id != p_membership_id
    ) then
      raise exception 'this person already has a separate membership with that role in this club';
    end if;

    update public.club_memberships set role_id = v_new_role_id, custom_role_id = null, updated_at = now()
    where id = p_membership_id;

    perform public.write_audit_log(
      p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
      jsonb_build_object('role_key', v_old_role_key),
      jsonb_build_object('role_key', p_role_key),
      null
    );
    if v_via_support then
      perform public.write_audit_log_as_support(
        p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
        jsonb_build_object('role_key', v_old_role_key), jsonb_build_object('role_key', p_role_key), null
      );
    end if;
  end if;
end;
$function$;
