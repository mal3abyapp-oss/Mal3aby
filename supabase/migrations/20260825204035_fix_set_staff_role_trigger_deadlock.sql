-- STAFF ACCESS CONTROL & CUSTOM ROLES -- critical pre-existing defect
-- fix, found while wiring custom-role assignment through set_staff_role.
--
-- ROOT CAUSE: trg_protect_club_membership_identity_columns (a
-- deliberate P0 security fix, 20260818224809/protect_tenant_and_identity_columns,
-- closing a real privilege-escalation path where a direct UPDATE on
-- club_memberships could change role_id with zero authorization/audit)
-- silently reverts ANY change to role_id -- including one made by
-- set_staff_role() itself, which is the RPC that trigger's own comment
-- names as "the only correct way to create a new role assignment." The
-- result: every call to set_staff_role() has always appeared to
-- succeed (no error, writes a staff.role_changed audit row claiming
-- the change happened) but role_id never actually changes. Confirmed
-- empirically live: zero staff.role_changed audit rows exist in
-- production despite the RPC/UI being reachable since the identity-
-- column-protection migration landed, and a direct reproduction hit
-- the CHECK-constraint violation this uncovered
-- (club_memberships_exactly_one_role failing on a stale,
-- trigger-reverted row).
--
-- FIX: rather than weakening the trigger (which would reopen exactly
-- the privilege-escalation hole it exists to close), give it a narrow,
-- explicit escape hatch keyed on a session-local GUC that ONLY the
-- sanctioned RPC sets, immediately before its own UPDATE, inside the
-- same transaction -- never settable by an ordinary authenticated
-- client (it is not a table/column grant, and the RPC that sets it has
-- already independently re-validated the caller's
-- permission/escalation/sole-owner rules before reaching this point).
create or replace function public.protect_club_membership_identity_columns()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role_change_authorized boolean;
begin
  v_role_change_authorized := coalesce(current_setting('mal3aby.role_change_authorized', true), '') = 'true';

  if new.role_id is distinct from old.role_id and not v_role_change_authorized then
    new.role_id := old.role_id;
  end if;
  if new.custom_role_id is distinct from old.custom_role_id and not v_role_change_authorized then
    new.custom_role_id := old.custom_role_id;
  end if;
  if new.club_id is distinct from old.club_id then
    new.club_id := old.club_id;
  end if;
  if new.user_id is distinct from old.user_id then
    new.user_id := old.user_id;
  end if;
  return new;
end;
$function$;

comment on function public.protect_club_membership_identity_columns() is
  'Security P0 fix (C1, MAL3ABY_PRODUCTION_READINESS.md), widened 2026-08-25 '
  '(STAFF ACCESS CONTROL phase) to also protect custom_role_id and to allow '
  'role_id/custom_role_id changes ONLY when the sanctioned RPC sets the '
  'session-local mal3aby.role_change_authorized=true GUC immediately before '
  'its own UPDATE (set_staff_role -- the only such RPC). club_id/user_id '
  'remain unconditionally immutable via direct UPDATE for every caller, '
  'exactly as before. This closes a real, confirmed pre-existing defect '
  'found during this phase: set_staff_role previously appeared to succeed '
  '(no error, a misleading staff.role_changed audit row) while this trigger '
  'silently reverted every role change it ever made -- zero real role '
  'changes exist in the production audit log despite the RPC being wired '
  'into the frontend since the identity-protection migration landed.';

-- set_staff_role(): set the GUC immediately before its own UPDATE.
-- Same signature/return type as before -- safe CREATE OR REPLACE.
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
