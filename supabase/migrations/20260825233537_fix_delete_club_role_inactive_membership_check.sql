-- STAFF ACCESS CONTROL & CUSTOM ROLES -- defect found during this
-- phase's own cleanup: delete_club_role()'s employee-count check only
-- counted status='active' memberships, but club_memberships.custom_role_id
-- has no ON DELETE action (implicit RESTRICT) -- so a role still
-- referenced by an INACTIVE (suspended) membership could pass the
-- "0 active employees" check and then hit a raw, confusing FK
-- violation instead of the RPC's own clear error message. Widened the
-- check to count ANY membership (active or inactive) still referencing
-- the role, matching what the FK actually enforces, with a clearer
-- message distinguishing the two cases.
create or replace function public.delete_club_role(p_club_role_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role public.club_roles;
  v_active_count int;
  v_total_count int;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_role from public.club_roles where id = p_club_role_id;
  if v_role.id is null then
    raise exception 'role not found';
  end if;

  if not (v_role.club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', v_role.club_id)) then
    raise exception 'not authorized';
  end if;

  select count(*) filter (where status = 'active'), count(*)
    into v_active_count, v_total_count
  from public.club_memberships where custom_role_id = p_club_role_id;

  if v_active_count > 0 then
    raise exception 'this role is assigned to % active employee(s) -- reassign or suspend them first', v_active_count;
  end if;

  if v_total_count > 0 then
    raise exception 'this role is still referenced by % suspended employee(s'' historical membership record(s) -- reassign their role before deleting it, or disable this role instead of deleting it', v_total_count;
  end if;

  delete from public.club_roles where id = p_club_role_id;

  perform public.write_audit_log(
    v_role.club_id, 'role.deleted', 'club_role', p_club_role_id,
    jsonb_build_object('name_ar', v_role.name_ar),
    null,
    null
  );
end;
$function$;
