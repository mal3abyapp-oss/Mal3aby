-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- same widening pattern as
-- create_club_role (see that migration's own comment for the full
-- rationale): OR in has_platform_support_access(v_role.club_id, true)
-- alongside the existing has_permission() check, preserve every other
-- line byte-for-byte, additionally attribute to Platform Admin via
-- write_audit_log_as_support() only when the support-session branch is
-- what actually granted access.
create or replace function public.update_club_role(p_club_role_id uuid, p_name_ar text, p_name_en text, p_description text, p_permission_keys text[], p_is_active boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role public.club_roles;
  v_before_permissions text[];
  v_permission_id uuid;
  v_key text;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_role from public.club_roles where id = p_club_role_id;
  if v_role.id is null then
    raise exception 'role not found';
  end if;

  if not ((v_role.club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', v_role.club_id)) or public.has_platform_support_access(v_role.club_id, true)) then
    raise exception 'not authorized';
  end if;
  v_via_support := not (v_role.club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', v_role.club_id));

  if p_name_ar is null or length(trim(p_name_ar)) = 0 then
    raise exception 'name_ar is required';
  end if;
  if p_name_en is null or length(trim(p_name_en)) = 0 then
    raise exception 'name_en is required';
  end if;

  if public.permission_set_escalates(v_role.club_id, p_permission_keys) then
    raise exception 'cannot grant a permission you do not hold yourself';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select key from public.permissions)
  ) then
    raise exception 'unknown permission key in the requested set';
  end if;

  if public.permission_set_violates_dependency(p_permission_keys) then
    raise exception 'this permission set is missing a required dependency (e.g. cash.liability.settle requires cash.liability.view)';
  end if;

  select coalesce(array_agg(p.key order by p.key), array[]::text[]) into v_before_permissions
  from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id
  where crp.club_role_id = p_club_role_id;

  update public.club_roles
  set name_ar = trim(p_name_ar), name_en = trim(p_name_en), description = nullif(trim(p_description), ''),
      is_active = coalesce(p_is_active, is_active)
  where id = p_club_role_id;

  delete from public.club_role_permissions where club_role_id = p_club_role_id;
  foreach v_key in array coalesce(p_permission_keys, array[]::text[]) loop
    select id into v_permission_id from public.permissions where key = v_key;
    insert into public.club_role_permissions (club_role_id, permission_id)
    values (p_club_role_id, v_permission_id)
    on conflict do nothing;
  end loop;

  perform public.write_audit_log(
    v_role.club_id, 'role.updated', 'club_role', p_club_role_id,
    jsonb_build_object('name_ar', v_role.name_ar, 'permissions', v_before_permissions),
    jsonb_build_object('name_ar', p_name_ar, 'permissions', p_permission_keys),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_role.club_id, 'role.updated', 'club_role', p_club_role_id,
      jsonb_build_object('name_ar', v_role.name_ar, 'permissions', v_before_permissions),
      jsonb_build_object('name_ar', p_name_ar, 'permissions', p_permission_keys), null
    );
  end if;
end;
$function$;
