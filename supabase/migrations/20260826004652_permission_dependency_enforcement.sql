-- DEDICATED CASH LIABILITY PERMISSIONS phase -- server-side dependency
-- enforcement gap, found live: create_club_role() and update_club_role()
-- only ever checked permission_set_escalates() (caller cannot grant a
-- permission they don't hold themselves). Neither checked that
-- cash.liability.settle requires cash.liability.view within the SAME
-- role's permission set -- confirmed live by creating a test custom role
-- with only cash.liability.settle, which the server incorrectly allowed
-- (test role immediately deleted after confirming the gap).
--
-- Fix: a small, generic, extensible permission_dependencies table (not
-- a one-off hardcoded check), plus a permission_set_violates_dependency()
-- helper matching the existing permission_set_escalates() style exactly,
-- wired into both create_club_role() and update_club_role(). Any future
-- "X requires Y" rule is then just one row insert, no function change.

create table if not exists public.permission_dependencies (
  permission_key text not null references public.permissions(key) on delete cascade,
  requires_key text not null references public.permissions(key) on delete cascade,
  primary key (permission_key, requires_key),
  check (permission_key <> requires_key)
);

comment on table public.permission_dependencies is
  'Declares that granting permission_key in a role also requires requires_key to be present in the same role. Enforced by create_club_role/update_club_role via permission_set_violates_dependency().';

insert into public.permission_dependencies (permission_key, requires_key) values
  ('cash.liability.settle', 'cash.liability.view')
on conflict do nothing;

create or replace function public.permission_set_violates_dependency(p_permission_keys text[])
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select exists (
    select 1
    from public.permission_dependencies pd
    where pd.permission_key = any(coalesce(p_permission_keys, array[]::text[]))
      and pd.requires_key <> all(coalesce(p_permission_keys, array[]::text[]))
  )
$function$;

-- Internal helper only (called from create_club_role/update_club_role,
-- never a public API surface) -- lock down the default PUBLIC grant new
-- functions get, matching permission_set_escalates()'s own grant
-- profile (pub=false, anon=false, authenticated=true).
revoke execute on function public.permission_set_violates_dependency(text[]) from public;
revoke execute on function public.permission_set_violates_dependency(text[]) from anon;

create or replace function public.create_club_role(p_club_id uuid, p_name_ar text, p_name_en text, p_description text, p_permission_keys text[])
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role_id uuid;
  v_permission_id uuid;
  v_key text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', p_club_id)) then
    raise exception 'not authorized';
  end if;

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

  return v_role_id;
end;
$function$;

create or replace function public.update_club_role(p_club_role_id uuid, p_name_ar text, p_name_en text, p_description text, p_permission_keys text[], p_is_active boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role public.club_roles;
  v_before_permissions text[];
  v_permission_id uuid;
  v_key text;
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
end;
$function$;
