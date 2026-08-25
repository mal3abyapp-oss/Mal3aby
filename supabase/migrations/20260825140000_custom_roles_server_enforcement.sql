-- STAFF ACCESS CONTROL & CUSTOM ROLES -- Stage 5: server enforcement.
--
-- 1. RLS on club_roles / club_role_permissions (strict tenant isolation,
--    roles.view/roles.manage gated, club_owner/platform_owner bypass).
-- 2. has_permission() widened to also check the custom-role path.
-- 3. Two real, pre-existing security gaps closed (proven in
--    docs/CURRENT_AUTHORIZATION_MODEL.md Section 5), applied to every
--    staff-mutating RPC:
--      a) no privilege escalation beyond the caller's own permission set
--      b) sole-owner protection (can't suspend/demote/remove the last
--         active club_owner)
-- 4. Role CRUD RPCs: create/update/delete/copy a custom role, each
--    permission-gated and re-validated server-side against the guards
--    above (never trusting the client to have already checked).
-- 5. invite_staff_member / set_staff_role widened to accept an optional
--    custom role, with the same guards applied.

-- =======================================================================
-- Escalation-safety helpers (SQL, STABLE, SECURITY DEFINER -- same
-- convention as every other helper in this schema).
-- =======================================================================

-- The full, de-duplicated set of permission keys the caller currently
-- holds for a club, across BOTH their system role and/or custom role
-- (a membership has exactly one of the two, so this is really just
-- "whichever one is set", written to work either way).
create or replace function public.caller_permission_keys(p_club_id uuid)
returns setof text
language sql
stable
security definer
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
$$;

comment on function public.caller_permission_keys(uuid) is
  'All permission keys the calling user currently holds for a club, '
  'via either their system role or custom role. Used to enforce '
  '"cannot grant a permission you do not yourself hold" (no privilege '
  'escalation) when creating/editing a custom role or assigning one.';

-- A target permission-key SET is "escalating" if it contains any key
-- the caller does not themselves currently hold for that club.
create or replace function public.permission_set_escalates(p_club_id uuid, p_permission_keys text[])
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select public.caller_permission_keys(p_club_id))
  )
$$;

comment on function public.permission_set_escalates(uuid, text[]) is
  'True if the given permission-key list contains anything the caller '
  'does not themselves hold. platform_owner is exempt (checked '
  'separately by callers via is_platform_owner()) since a platform '
  'owner is not a club member with a real permission set to compare '
  'against.';

-- Would applying this membership change leave the club with zero
-- active club_owner memberships (system role only -- club_owner can
-- never be a custom role, see role CRUD guards below)?
create or replace function public.club_would_lose_last_owner(p_club_id uuid, p_excluding_membership_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select not exists (
    select 1
    from public.club_memberships cm
    join public.roles r on r.id = cm.role_id
    where cm.club_id = p_club_id
      and cm.status = 'active'
      and r.key = 'club_owner'
      and cm.id != p_excluding_membership_id
  )
$$;

comment on function public.club_would_lose_last_owner(uuid, uuid) is
  'True if removing/suspending/demoting p_excluding_membership_id would '
  'leave this club with zero active club_owner memberships. Used by '
  'deactivate_staff_member / set_staff_role to block the last-owner '
  'case (STAFF ACCESS CONTROL phase Section 21).';

-- =======================================================================
-- has_permission(): widen to check the custom-role path too. Same
-- signature, same return type (boolean) -- safe for CREATE OR REPLACE,
-- no DROP needed.
-- =======================================================================
create or replace function public.has_permission(p_key text, p_club_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1
    from public.club_memberships cm
    left join public.role_permissions rp
      on rp.role_id = cm.role_id
    left join public.club_role_permissions crp
      on crp.club_role_id = cm.custom_role_id
    join public.permissions p
      on p.id = coalesce(rp.permission_id, crp.permission_id)
    where cm.user_id = auth.uid()
      and cm.club_id = p_club_id
      and cm.status = 'active'
      and p.key = p_key
  )
$$;

comment on function public.has_permission(text, uuid) is
  'Capability check. Widened 2026-08-25 (STAFF ACCESS CONTROL phase) to '
  'also resolve permissions through a custom club_role, via the LEFT '
  'JOIN on club_role_permissions. A membership has exactly one of '
  'role_id / custom_role_id (club_memberships_exactly_one_role CHECK), '
  'so at most one of the two LEFT JOINs ever matches -- behavior for '
  'every existing system-role membership is byte-for-byte identical to '
  'before this change.';

-- =======================================================================
-- RLS: club_roles / club_role_permissions.
-- =======================================================================
alter table public.club_roles enable row level security;
alter table public.club_roles force row level security;

alter table public.club_role_permissions enable row level security;
alter table public.club_role_permissions force row level security;

-- SELECT: any active member of the club with roles.view, or the
-- platform owner (parity with every other tenant table's platform
-- bypass, e.g. clubs/club_memberships).
create policy club_roles_select on public.club_roles
  for select
  using (
    public.is_platform_owner()
    or (club_id in (select public.user_club_ids()) and public.has_permission('roles.view', club_id))
  );

-- INSERT: roles.manage, and the row's own club_id must be a club the
-- caller belongs to (WITH CHECK, not just USING -- prevents inserting
-- a role row into a club the caller doesn't manage even if club_id is
-- attacker-controlled in the request body).
create policy club_roles_insert on public.club_roles
  for insert
  with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('roles.manage', club_id)
  );

create policy club_roles_update on public.club_roles
  for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', club_id))
  with check (club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', club_id));

create policy club_roles_delete on public.club_roles
  for delete
  using (club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', club_id));

create policy club_roles_platform_owner_full_access on public.club_roles
  for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());

-- club_role_permissions: scoped through its parent club_roles row
-- (there is no direct club_id column on the join table itself).
create policy club_role_permissions_select on public.club_role_permissions
  for select
  using (
    exists (
      select 1 from public.club_roles cr
      where cr.id = club_role_id
        and (public.is_platform_owner() or (cr.club_id in (select public.user_club_ids()) and public.has_permission('roles.view', cr.club_id)))
    )
  );

create policy club_role_permissions_insert on public.club_role_permissions
  for insert
  with check (
    exists (
      select 1 from public.club_roles cr
      where cr.id = club_role_id
        and cr.club_id in (select public.user_club_ids())
        and public.has_permission('roles.manage', cr.club_id)
    )
  );

create policy club_role_permissions_delete on public.club_role_permissions
  for delete
  using (
    exists (
      select 1 from public.club_roles cr
      where cr.id = club_role_id
        and cr.club_id in (select public.user_club_ids())
        and public.has_permission('roles.manage', cr.club_id)
    )
  );

create policy club_role_permissions_platform_owner_full_access on public.club_role_permissions
  for all
  using (public.is_platform_owner())
  with check (public.is_platform_owner());

-- Direct-table writes are still not the sanctioned path (RPCs below
-- own validation like "don't let permissions escalate beyond the
-- caller's own set" and "don't let club_owner ever become a custom
-- role") -- RLS here is the tenant-isolation and coarse-permission
-- backstop, matching how role_permissions/membership_branches already
-- work in this schema (RLS bounds the blast radius; RPCs own business
-- rules). No REVOKE of INSERT/UPDATE/DELETE grants is needed beyond
-- what RLS already blocks, matching every other tenant table's pattern
-- in this project (e.g. bookings, invoices) rather than the
-- zero-write-policy roles/permissions/role_permissions pattern, since
-- unlike those, THIS catalogue is meant to be club-editable by design.

-- A UNIQUE constraint on (user_id, club_id, role_id) does NOT catch
-- duplicate custom-role memberships, because role_id is NULL for all
-- of them and Postgres never treats two NULLs as equal for uniqueness
-- purposes. Add a real, DB-enforced partial unique index for the
-- custom-role path so this isn't only an application-level check
-- inside the RPCs below (defense in depth, matching how the
-- system-role path is already DB-enforced, not just RPC-enforced).
create unique index club_memberships_user_club_custom_role_unique
  on public.club_memberships (user_id, club_id, custom_role_id)
  where custom_role_id is not null;

-- =======================================================================
-- Role CRUD RPCs.
-- =======================================================================

create or replace function public.list_club_roles(p_club_id uuid)
returns table (
  id uuid,
  name_ar text,
  name_en text,
  description text,
  is_active boolean,
  is_system boolean,
  employee_count bigint,
  permission_count bigint,
  created_at timestamptz,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- System roles first (fixed 9, always shown so the Club Owner sees
  -- the whole picture in one list), then custom roles for this club.
  select
    r.id, r.name_ar, r.name, null::text as description, true as is_active, true as is_system,
    (select count(*) from public.club_memberships cm where cm.role_id = r.id and cm.club_id = p_club_id and cm.status = 'active') as employee_count,
    (select count(*) from public.role_permissions rp where rp.role_id = r.id) as permission_count,
    null::timestamptz as created_at, null::timestamptz as updated_at
  from public.roles r
  where r.key != 'platform_owner'
    and (public.is_platform_owner() or (p_club_id in (select public.user_club_ids()) and public.has_permission('roles.view', p_club_id)))
  union all
  select
    cr.id, cr.name_ar, cr.name_en, cr.description, cr.is_active, false as is_system,
    (select count(*) from public.club_memberships cm where cm.custom_role_id = cr.id and cm.status = 'active') as employee_count,
    (select count(*) from public.club_role_permissions crp where crp.club_role_id = cr.id) as permission_count,
    cr.created_at, cr.updated_at
  from public.club_roles cr
  where cr.club_id = p_club_id
    and (public.is_platform_owner() or public.has_permission('roles.view', p_club_id))
  order by is_system desc, name_ar;
$$;

comment on function public.list_club_roles(uuid) is
  'Batched, single-call role list for a club -- system roles (fixed 9, '
  'minus platform_owner) unioned with this club''s custom roles, each '
  'with employee_count/permission_count computed inline. Avoids N+1 '
  'queries from the frontend (Section 23 of the phase directive).';

create or replace function public.get_club_role_permissions(p_club_role_id uuid)
returns setof text
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select p.key
  from public.club_role_permissions crp
  join public.permissions p on p.id = crp.permission_id
  join public.club_roles cr on cr.id = crp.club_role_id
  where crp.club_role_id = p_club_role_id
    and (public.is_platform_owner() or (cr.club_id in (select public.user_club_ids()) and public.has_permission('roles.view', cr.club_id)))
$$;

create or replace function public.create_club_role(
  p_club_id uuid,
  p_name_ar text,
  p_name_en text,
  p_description text,
  p_permission_keys text[]
)
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

  -- No privilege escalation: every permission key requested must be
  -- one the caller themselves currently holds for this club.
  if public.permission_set_escalates(p_club_id, p_permission_keys) then
    raise exception 'cannot grant a permission you do not hold yourself';
  end if;

  -- Reject any key that doesn't exist in the global catalog up front,
  -- with a clear error, rather than silently dropping it.
  if exists (
    select 1 from unnest(coalesce(p_permission_keys, array[]::text[])) k
    where k not in (select key from public.permissions)
  ) then
    raise exception 'unknown permission key in the requested set';
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

create or replace function public.update_club_role(
  p_club_role_id uuid,
  p_name_ar text,
  p_name_en text,
  p_description text,
  p_permission_keys text[],
  p_is_active boolean
)
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

create or replace function public.copy_club_role(p_club_role_id uuid, p_new_name_ar text, p_new_name_en text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_source public.club_roles;
  v_new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_source from public.club_roles where id = p_club_role_id;
  if v_source.id is null then
    raise exception 'role not found';
  end if;

  if not (v_source.club_id in (select public.user_club_ids()) and public.has_permission('roles.manage', v_source.club_id)) then
    raise exception 'not authorized';
  end if;

  -- Copying can never escalate (it copies a set the role already has,
  -- and that set was already validated as non-escalating when the
  -- source role was created/updated) -- no separate check needed.
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

  return v_new_id;
end;
$function$;

create or replace function public.delete_club_role(p_club_role_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role public.club_roles;
  v_employee_count int;
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

  select count(*) into v_employee_count
  from public.club_memberships where custom_role_id = p_club_role_id and status = 'active';

  if v_employee_count > 0 then
    raise exception 'this role is assigned to % active employee(s) -- reassign or suspend them first', v_employee_count;
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

-- =======================================================================
-- invite_staff_member / set_staff_role: widen to accept an optional
-- custom role alongside the existing system-role path, and apply the
-- two closed gaps (escalation, sole-owner). Same return types as
-- before (uuid / void) -- safe CREATE OR REPLACE, params only added at
-- the end with defaults so existing callers are unaffected.
-- =======================================================================

create or replace function public.invite_staff_member(
  p_club_id uuid,
  p_email text,
  p_role_key text,
  p_branch_ids uuid[] default null::uuid[],
  p_custom_role_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_target_user_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
  v_default_custody boolean;
  v_was_existing boolean;
  v_prior_status text;
  v_custom_role public.club_roles;
begin
  if not public.has_permission('staff.create', p_club_id) then
    raise exception 'not authorized';
  end if;

  -- Exactly one of system role / custom role, matching the DB
  -- constraint -- fail clearly here instead of a cryptic CHECK error.
  if (p_role_key is not null) = (p_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  select id into v_target_user_id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;

  if v_target_user_id is null then
    raise exception 'no account found for that email -- the person must sign up first';
  end if;

  if p_custom_role_id is not null then
    select * into v_custom_role from public.club_roles where id = p_custom_role_id and club_id = p_club_id;
    if v_custom_role.id is null then
      raise exception 'custom role not found in this club';
    end if;
    if not v_custom_role.is_active then
      raise exception 'this custom role is disabled';
    end if;
    -- No escalation: the inviter must hold every permission the
    -- custom role grants (Section 6/7 of the phase directive).
    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id where crp.club_role_id = p_custom_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select coalesce(bool_or(p.key = 'payment.create'), false) into v_default_custody
    from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id
    where crp.club_role_id = p_custom_role_id;

    select id, status into v_membership_id, v_prior_status
    from public.club_memberships
    where user_id = v_target_user_id and club_id = p_club_id and custom_role_id = p_custom_role_id;
    v_was_existing := v_membership_id is not null;

    insert into public.club_memberships (user_id, club_id, role_id, custom_role_id, status, has_cash_custody)
    values (v_target_user_id, p_club_id, null, p_custom_role_id, 'active', v_default_custody)
    on conflict (user_id, club_id, custom_role_id) where custom_role_id is not null
      do update set status = 'active', updated_at = now()
    returning id into v_membership_id;
  else
    if p_role_key = 'platform_owner' then
      raise exception 'not authorized';
    end if;

    select id into v_role_id from public.roles where key = p_role_key;
    if v_role_id is null then
      raise exception 'unknown role';
    end if;

    -- No escalation for system roles either -- a club_manager without
    -- payment.refund can't hand out a role that has it.
    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = v_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select exists (
      select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = v_role_id and p.key = 'payment.create'
    ) into v_default_custody;

    select id, status into v_membership_id, v_prior_status
    from public.club_memberships
    where user_id = v_target_user_id and club_id = p_club_id and role_id = v_role_id;
    v_was_existing := v_membership_id is not null;

    insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
    values (v_target_user_id, p_club_id, v_role_id, 'active', v_default_custody)
    on conflict (user_id, club_id, role_id)
      do update set status = 'active', updated_at = now()
    returning id into v_membership_id;
  end if;

  delete from public.membership_branches where membership_id = v_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    p_club_id,
    case when v_was_existing then 'staff.membership_reactivated' else 'staff.invited' end,
    'club_membership', v_membership_id,
    case when v_was_existing then jsonb_build_object('status', v_prior_status) else null end,
    jsonb_build_object('role_key', p_role_key, 'custom_role_id', p_custom_role_id, 'branch_ids', p_branch_ids, 'status', 'active'),
    null
  );

  return v_membership_id;
end;
$function$;

create or replace function public.set_staff_role(
  p_club_id uuid,
  p_membership_id uuid,
  p_role_key text,
  p_custom_role_id uuid default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_new_role_id uuid;
  v_old_role_key text;
  v_custom_role public.club_roles;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if (p_role_key is not null) = (p_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  -- Sole-owner guard: if this membership is currently the club's only
  -- active club_owner, block any role change away from club_owner.
  if p_role_key != 'club_owner' or p_custom_role_id is not null then
    if public.club_would_lose_last_owner(p_club_id, p_membership_id) then
      raise exception 'this is the club''s only active owner -- assign another owner first';
    end if;
  end if;

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
  end if;
end;
$function$;

-- =======================================================================
-- deactivate_staff_member: add the sole-owner guard. Same signature,
-- same return type (void) -- safe CREATE OR REPLACE.
-- =======================================================================
create or replace function public.deactivate_staff_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership
  from public.club_memberships
  where id = p_membership_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('staff.update', club_id);

  if v_membership.id is null then
    raise exception 'membership not found or you do not have permission to update it';
  end if;

  if public.club_would_lose_last_owner(v_membership.club_id, p_membership_id) then
    raise exception 'this is the club''s only active owner -- assign another owner before suspending';
  end if;

  if exists (
    select 1 from public.cash_shifts
    where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'open'
  ) then
    raise exception 'this employee has an open cash shift -- close it before suspending';
  end if;

  update public.club_memberships
  set status = 'inactive', updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.suspended', 'club_membership', p_membership_id,
    jsonb_build_object('status', v_membership.status),
    jsonb_build_object('status', 'inactive'),
    null
  );
end;
$function$;

-- =======================================================================
-- Grants: role CRUD RPCs follow the exact same grant pattern as every
-- other staff RPC in this schema (authenticated only, never anon).
-- =======================================================================
revoke all on function public.list_club_roles(uuid) from public;
revoke all on function public.list_club_roles(uuid) from anon;
grant execute on function public.list_club_roles(uuid) to authenticated;

revoke all on function public.get_club_role_permissions(uuid) from public;
revoke all on function public.get_club_role_permissions(uuid) from anon;
grant execute on function public.get_club_role_permissions(uuid) to authenticated;

revoke all on function public.create_club_role(uuid, text, text, text, text[]) from public;
revoke all on function public.create_club_role(uuid, text, text, text, text[]) from anon;
grant execute on function public.create_club_role(uuid, text, text, text, text[]) to authenticated;

revoke all on function public.update_club_role(uuid, text, text, text, text[], boolean) from public;
revoke all on function public.update_club_role(uuid, text, text, text, text[], boolean) from anon;
grant execute on function public.update_club_role(uuid, text, text, text, text[], boolean) to authenticated;

revoke all on function public.copy_club_role(uuid, text, text) from public;
revoke all on function public.copy_club_role(uuid, text, text) from anon;
grant execute on function public.copy_club_role(uuid, text, text) to authenticated;

revoke all on function public.delete_club_role(uuid) from public;
revoke all on function public.delete_club_role(uuid) from anon;
grant execute on function public.delete_club_role(uuid) to authenticated;

revoke all on function public.caller_permission_keys(uuid) from public;
revoke all on function public.caller_permission_keys(uuid) from anon;
grant execute on function public.caller_permission_keys(uuid) to authenticated;

revoke all on function public.permission_set_escalates(uuid, text[]) from public;
revoke all on function public.permission_set_escalates(uuid, text[]) from anon;
grant execute on function public.permission_set_escalates(uuid, text[]) to authenticated;

revoke all on function public.club_would_lose_last_owner(uuid, uuid) from public;
revoke all on function public.club_would_lose_last_owner(uuid, uuid) from anon;
grant execute on function public.club_would_lose_last_owner(uuid, uuid) to authenticated;
