-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- same widening pattern as
-- create_club_role (see that migration's own comment for the full
-- rationale).
create or replace function public.copy_club_role(p_club_role_id uuid, p_new_name_ar text, p_new_name_en text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_source public.club_roles;
  v_new_id uuid;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_source from public.club_roles where id = p_club_role_id;
  if v_source.id is null then
    raise exception 'role not found';
  end if;

  if not ((v_source.club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', v_source.club_id)) or public.has_platform_support_access(v_source.club_id, true)) then
    raise exception 'not authorized';
  end if;
  v_via_support := not (v_source.club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', v_source.club_id));

  insert into public.club_roles (club_id, name_ar, name_en, description, created_by)
  values (v_source.club_id, trim(p_new_name_ar), trim(p_new_name_en), v_source.description, auth.uid())
  returning id into v_new_id;

  insert into public.club_role_permissions (club_role_id, permission_id)
  select v_new_id, permission_id from public.club_role_permissions where club_role_id = p_club_role_id;

  perform public.write_audit_log(
    v_source.club_id, 'role.created', 'club_role', v_new_id,
    null,
    jsonb_build_object('name_ar', p_new_name_ar, 'copied_from', p_club_role_id),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_source.club_id, 'role.created', 'club_role', v_new_id,
      null, jsonb_build_object('name_ar', p_new_name_ar, 'copied_from', p_club_role_id), null
    );
  end if;

  return v_new_id;
end;
$function$;
