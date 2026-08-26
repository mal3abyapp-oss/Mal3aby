-- MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- widen create_club_role's
-- authorization gate to ALSO accept has_platform_support_access
-- (p_club_id, true) as an OR alongside the existing has_permission()-based
-- check. Every other line is preserved byte-for-byte from the
-- live-captured original -- the ONLY change is the single `if not (...)`
-- authorization condition. Since permission_set_escalates() already
-- routes through caller_permission_keys() (widened in the prior
-- migration), no other line needs to change for the escalation check to
-- correctly recognize a valid MANAGE-mode support session.
--
-- Audit attribution: when access is granted via the support-session
-- branch (i.e. the caller does NOT independently hold roles.manage for
-- this club), the mutation is additionally attributed to Platform Admin
-- via write_audit_log_as_support() -- an ordinary club_owner's own audit
-- trail is completely unaffected (v_via_support is false for them).
create or replace function public.create_club_role(p_club_id uuid, p_name_ar text, p_name_en text, p_description text, p_permission_keys text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role_id uuid;
  v_permission_id uuid;
  v_key text;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not ((p_club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', p_club_id)) or public.has_platform_support_access(p_club_id, true)) then
    raise exception 'not authorized';
  end if;
  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', p_club_id));

  if p_name_ar is null or length(trim(p_name_ar)) = 0 then
    raise exception 'name_ar is required';
  end if;
  if p_name_en is null or length(trim(p_name_en)) = 0 then
    raise exception 'name_en is required';
  end if;

  if public.permission_set_escalates(p_club_id, p_permission_keys) then
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

  insert into public.club_roles (club_id, name_ar, name_en, description, created_by)
  values (p_club_id, trim(p_name_ar), trim(p_name_en), nullif(trim(p_description), ''), auth.uid())
  returning id into v_role_id;

  foreach v_key in array coalesce(p_permission_keys, array[]::text[]) loop
    select id into v_permission_id from public.permissions where key = v_key;
    insert into public.club_role_permissions (club_role_id, permission_id)
    values (v_role_id, v_permission_id)
    on conflict do nothing;
  end loop;

  perform public.write_audit_log(
    p_club_id, 'role.created', 'club_role', v_role_id,
    null,
    jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'permissions', p_permission_keys),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id, 'role.created', 'club_role', v_role_id,
      null, jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'permissions', p_permission_keys), null
    );
  end if;

  return v_role_id;
end;
$function$;
