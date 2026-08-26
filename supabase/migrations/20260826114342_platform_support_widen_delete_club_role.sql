-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- same widening pattern as
-- create_club_role (see that migration's own comment for the full
-- rationale).
create or replace function public.delete_club_role(p_club_role_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role public.club_roles;
  v_active_count int;
  v_total_count int;
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

  select count(*) filter (where status = 'active'), count(*)
    into v_active_count, v_total_count
  from public.club_memberships where custom_role_id = p_club_role_id;

  if v_active_count > 0 then
    raise exception 'this role is assigned to % active employee(s) -- reassign or suspend them first', v_active_count;
  end if;

  if v_total_count > 0 then
    raise exception 'this role is still referenced by % suspended employee record(s) -- reassign their role before deleting this one, or disable it instead of deleting it', v_total_count;
  end if;

  delete from public.club_roles where id = p_club_role_id;

  perform public.write_audit_log(
    v_role.club_id, 'role.deleted', 'club_role', p_club_role_id,
    jsonb_build_object('name_ar', v_role.name_ar),
    null,
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_role.club_id, 'role.deleted', 'club_role', p_club_role_id,
      jsonb_build_object('name_ar', v_role.name_ar), null, null
    );
  end if;
end;
$function$;
