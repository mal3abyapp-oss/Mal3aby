-- list_platform_roles(): system roles + custom roles, same shape as the
-- existing list_club_roles() (name/type/permission_count/employee_count/
-- editable-or-protected), gated on platform.role.view (or
-- is_platform_owner() via the bridge already baked into
-- has_platform_permission()).
create or replace function public.list_platform_roles()
returns table(id uuid, name_ar text, name_en text, description text, is_active boolean, is_system boolean, employee_count bigint, permission_count bigint, created_at timestamptz, updated_at timestamptz)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.has_platform_permission('platform.role.view') then
    raise exception 'not authorized';
  end if;

  return query
  select
    r.id, r.name_ar, r.name_en, null::text as description, true as is_active, true as is_system,
    (select count(*) from public.platform_staff_memberships psm where psm.platform_role_id = r.id and psm.status = 'active') as employee_count,
    (select count(*) from public.platform_role_permissions prp where prp.platform_role_id = r.id) as permission_count,
    null::timestamptz as created_at, null::timestamptz as updated_at
  from public.platform_roles r
  union all
  select
    cr.id, cr.name_ar, cr.name_en, cr.description, cr.is_active, false as is_system,
    (select count(*) from public.platform_staff_memberships psm where psm.platform_custom_role_id = cr.id and psm.status = 'active') as employee_count,
    (select count(*) from public.platform_custom_role_permissions pcrp where pcrp.platform_custom_role_id = cr.id) as permission_count,
    cr.created_at, cr.updated_at
  from public.platform_custom_roles cr
  order by is_system desc, name_ar;
end;
$$;

revoke all on function public.list_platform_roles() from public;
revoke all on function public.list_platform_roles() from anon;
grant execute on function public.list_platform_roles() to authenticated;

-- get_platform_role_permissions(): works for BOTH a system platform_role
-- id and a custom platform_custom_role id (unlike the club-side
-- get_club_role_permissions(), which structurally only handles custom
-- roles -- that asymmetry was the exact root cause of the earlier
-- "system role edit does nothing" defect this session already fixed for
-- club roles; built correctly from the start here).
create or replace function public.get_platform_role_permissions(p_role_id uuid)
returns setof text
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.has_platform_permission('platform.role.view') then
    raise exception 'not authorized';
  end if;

  return query
  select pp.key from public.platform_role_permissions prp
  join public.platform_permissions pp on pp.id = prp.platform_permission_id
  where prp.platform_role_id = p_role_id
  union
  select pp.key from public.platform_custom_role_permissions pcrp
  join public.platform_permissions pp on pp.id = pcrp.platform_permission_id
  where pcrp.platform_custom_role_id = p_role_id;
end;
$$;

revoke all on function public.get_platform_role_permissions(uuid) from public;
revoke all on function public.get_platform_role_permissions(uuid) from anon;
grant execute on function public.get_platform_role_permissions(uuid) to authenticated;

create or replace function public.create_platform_custom_role(p_name_ar text, p_name_en text, p_description text, p_permission_keys text[])
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role_id uuid;
  v_permission_id uuid;
  v_key text;
begin
  if not public.has_platform_permission('platform.role.create') then
    raise exception 'not authorized';
  end if;

  if p_name_ar is null or length(trim(p_name_ar)) = 0 then
    raise exception 'name_ar is required';
  end if;
  if p_name_en is null or length(trim(p_name_en)) = 0 then
    raise exception 'name_en is required';
  end if;

  -- Escalation guard (directive Section 25): a platform admin must not
  -- be able to grant a platform permission they don't themselves hold.
  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select public.caller_platform_permission_keys())
  ) then
    raise exception 'cannot grant a permission you do not hold yourself';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select key from public.platform_permissions)
  ) then
    raise exception 'unknown permission key in the requested set';
  end if;

  insert into public.platform_custom_roles (name_ar, name_en, description, created_by)
  values (trim(p_name_ar), trim(p_name_en), nullif(trim(p_description), ''), auth.uid())
  returning id into v_role_id;

  foreach v_key in array coalesce(p_permission_keys, array[]::text[]) loop
    select id into v_permission_id from public.platform_permissions where key = v_key;
    insert into public.platform_custom_role_permissions (platform_custom_role_id, platform_permission_id)
    values (v_role_id, v_permission_id)
    on conflict do nothing;
  end loop;

  perform public.write_audit_log(
    null, 'platform_role.created', 'platform_custom_role', v_role_id,
    null, jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'permissions', p_permission_keys), null
  );

  return v_role_id;
end;
$$;

revoke all on function public.create_platform_custom_role(text, text, text, text[]) from public;
revoke all on function public.create_platform_custom_role(text, text, text, text[]) from anon;
grant execute on function public.create_platform_custom_role(text, text, text, text[]) to authenticated;

create or replace function public.update_platform_custom_role(p_role_id uuid, p_name_ar text, p_name_en text, p_description text, p_permission_keys text[], p_is_active boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role public.platform_custom_roles;
  v_before_permissions text[];
  v_permission_id uuid;
  v_key text;
begin
  if not public.has_platform_permission('platform.role.update') then
    raise exception 'not authorized';
  end if;

  select * into v_role from public.platform_custom_roles where id = p_role_id;
  if v_role.id is null then
    raise exception 'role not found';
  end if;

  if p_name_ar is null or length(trim(p_name_ar)) = 0 then
    raise exception 'name_ar is required';
  end if;
  if p_name_en is null or length(trim(p_name_en)) = 0 then
    raise exception 'name_en is required';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select public.caller_platform_permission_keys())
  ) then
    raise exception 'cannot grant a permission you do not hold yourself';
  end if;

  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select key from public.platform_permissions)
  ) then
    raise exception 'unknown permission key in the requested set';
  end if;

  select coalesce(array_agg(pp.key order by pp.key), array[]::text[]) into v_before_permissions
  from public.platform_custom_role_permissions pcrp join public.platform_permissions pp on pp.id = pcrp.platform_permission_id
  where pcrp.platform_custom_role_id = p_role_id;

  update public.platform_custom_roles
  set name_ar = trim(p_name_ar), name_en = trim(p_name_en), description = nullif(trim(p_description), ''),
      is_active = coalesce(p_is_active, is_active), updated_at = now()
  where id = p_role_id;

  delete from public.platform_custom_role_permissions where platform_custom_role_id = p_role_id;
  foreach v_key in array coalesce(p_permission_keys, array[]::text[]) loop
    select id into v_permission_id from public.platform_permissions where key = v_key;
    insert into public.platform_custom_role_permissions (platform_custom_role_id, platform_permission_id)
    values (p_role_id, v_permission_id)
    on conflict do nothing;
  end loop;

  perform public.write_audit_log(
    null, 'platform_role.permissions_changed', 'platform_custom_role', p_role_id,
    jsonb_build_object('name_ar', v_role.name_ar, 'permissions', v_before_permissions),
    jsonb_build_object('name_ar', p_name_ar, 'permissions', p_permission_keys), null
  );
end;
$$;

revoke all on function public.update_platform_custom_role(uuid, text, text, text, text[], boolean) from public;
revoke all on function public.update_platform_custom_role(uuid, text, text, text, text[], boolean) from anon;
grant execute on function public.update_platform_custom_role(uuid, text, text, text, text[], boolean) to authenticated;

create or replace function public.delete_platform_custom_role(p_role_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role public.platform_custom_roles;
  v_active_count int;
begin
  if not public.has_platform_permission('platform.role.delete') then
    raise exception 'not authorized';
  end if;

  select * into v_role from public.platform_custom_roles where id = p_role_id;
  if v_role.id is null then
    raise exception 'role not found';
  end if;

  select count(*) into v_active_count from public.platform_staff_memberships
  where platform_custom_role_id = p_role_id and status = 'active';

  if v_active_count > 0 then
    raise exception 'this role is assigned to % active platform staff member(s) -- reassign them first', v_active_count;
  end if;

  delete from public.platform_custom_roles where id = p_role_id;

  perform public.write_audit_log(
    null, 'platform_role.deleted', 'platform_custom_role', p_role_id,
    jsonb_build_object('name_ar', v_role.name_ar), null, null
  );
end;
$$;

revoke all on function public.delete_platform_custom_role(uuid) from public;
revoke all on function public.delete_platform_custom_role(uuid) from anon;
grant execute on function public.delete_platform_custom_role(uuid) to authenticated;
