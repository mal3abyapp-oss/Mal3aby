-- list_platform_staff(): every active/inactive platform_staff_memberships
-- row + the underlying auth user's email, joined with its role name
-- (system or custom). Gated on platform.staff.view.
create or replace function public.list_platform_staff()
returns table(
  membership_id uuid, user_id uuid, email text, full_name text,
  platform_role_id uuid, platform_role_key text, role_name_ar text, role_name_en text,
  is_custom_role boolean, status text, created_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not public.has_platform_permission('platform.staff.view') then
    raise exception 'not authorized';
  end if;

  return query
  select
    psm.id, psm.user_id, u.email::text,
    coalesce(u.raw_user_meta_data->>'full_name', null),
    psm.platform_role_id,
    r.key,
    coalesce(r.name_ar, cr.name_ar),
    coalesce(r.name_en, cr.name_en),
    psm.platform_custom_role_id is not null,
    psm.status,
    psm.created_at
  from public.platform_staff_memberships psm
  join auth.users u on u.id = psm.user_id
  left join public.platform_roles r on r.id = psm.platform_role_id
  left join public.platform_custom_roles cr on cr.id = psm.platform_custom_role_id
  order by psm.created_at desc;
end;
$$;

revoke all on function public.list_platform_staff() from public;
revoke all on function public.list_platform_staff() from anon;
grant execute on function public.list_platform_staff() to authenticated;

-- Last-Platform-Owner protection (directive Section 2/16): the system
-- can NEVER end with zero holders of platform-owner-equivalent authority.
-- "Platform Owner" authority today is is_platform_owner() itself
-- (club_memberships-role-based, unchanged by this whole feature) -- this
-- helper counts how many DISTINCT real accounts currently hold it, used
-- by set_platform_staff_role/deactivate_platform_staff below to refuse
-- any change that would demote/deactivate the sole remaining one who is
-- ALSO enrolled as platform_staff_memberships-tracked (the only path
-- this domain's own RPCs can actually mutate -- is_platform_owner()
-- itself, being club_memberships-based, is intentionally outside this
-- migration's write surface entirely, exactly as the Master Admin phase
-- already established: this feature must never touch that chain).
create or replace function public.count_active_platform_owners()
returns integer
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select count(distinct cm.user_id)::int
  from public.club_memberships cm
  join public.roles r on r.id = cm.role_id
  where cm.status = 'active' and r.key = 'platform_owner'
$$;

revoke all on function public.count_active_platform_owners() from public;
revoke all on function public.count_active_platform_owners() from anon;
grant execute on function public.count_active_platform_owners() to authenticated;

-- set_platform_staff_role(): reassign a platform staff member's role
-- (system or custom). Escalation-guarded the same way as
-- create/update_platform_custom_role. Self-protection (directive Section
-- 17): if the caller is changing their OWN membership away from a role
-- that would leave zero active platform_staff_memberships-tracked
-- holders of platform.role.manage-equivalent authority... in practice
-- the real, unconditional backstop is is_platform_owner() itself (never
-- touched here), so this function's own guard is a narrower, honest one:
-- refuse to deactivate/reassign a membership if doing so would leave
-- ZERO active platform_staff_memberships rows holding
-- 'platform.staff.role.assign' (the permission this very function
-- requires) -- i.e. never let the very last person able to run this RPC
-- lock themselves out of it via it.
create or replace function public.set_platform_staff_role(p_membership_id uuid, p_platform_role_id uuid default null, p_platform_custom_role_id uuid default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership public.platform_staff_memberships;
  v_before jsonb;
  v_remaining_assigners int;
begin
  if not public.has_platform_permission('platform.staff.role.assign') then
    raise exception 'not authorized';
  end if;

  if (p_platform_role_id is not null) = (p_platform_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  select * into v_membership from public.platform_staff_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'platform staff member not found';
  end if;

  if p_platform_role_id is not null then
    if exists (
      select 1 from public.platform_role_permissions prp
      join public.platform_permissions pp on pp.id = prp.platform_permission_id
      where prp.platform_role_id = p_platform_role_id
        and pp.key not in (select public.caller_platform_permission_keys())
    ) then
      raise exception 'cannot assign a role with permissions you do not hold yourself';
    end if;
  else
    if exists (
      select 1 from public.platform_custom_role_permissions pcrp
      join public.platform_permissions pp on pp.id = pcrp.platform_permission_id
      where pcrp.platform_custom_role_id = p_platform_custom_role_id
        and pp.key not in (select public.caller_platform_permission_keys())
    ) then
      raise exception 'cannot assign a role with permissions you do not hold yourself';
    end if;
  end if;

  -- Guard: if this membership currently grants platform.staff.role.assign
  -- and the reassignment would remove it, make sure at least one other
  -- active platform_staff_memberships row (or a real is_platform_owner()
  -- account, which is unconditionally exempt from this whole check)
  -- would still hold it afterward.
  select count(*) into v_remaining_assigners
  from public.platform_staff_memberships psm
  left join public.platform_role_permissions prp on prp.platform_role_id = psm.platform_role_id
  left join public.platform_custom_role_permissions pcrp on pcrp.platform_custom_role_id = psm.platform_custom_role_id
  join public.platform_permissions pp on pp.id = coalesce(prp.platform_permission_id, pcrp.platform_permission_id)
  where psm.status = 'active' and psm.id != p_membership_id and pp.key = 'platform.staff.role.assign';

  if v_remaining_assigners = 0 and public.count_active_platform_owners() = 0 then
    raise exception 'this is the last account able to manage platform staff roles -- assign another one first';
  end if;

  v_before := jsonb_build_object('platform_role_id', v_membership.platform_role_id, 'platform_custom_role_id', v_membership.platform_custom_role_id);

  update public.platform_staff_memberships
  set platform_role_id = p_platform_role_id, platform_custom_role_id = p_platform_custom_role_id, updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    null, 'platform_staff.role_changed', 'platform_staff_membership', p_membership_id,
    v_before, jsonb_build_object('platform_role_id', p_platform_role_id, 'platform_custom_role_id', p_platform_custom_role_id), null
  );
end;
$$;

revoke all on function public.set_platform_staff_role(uuid, uuid, uuid) from public;
revoke all on function public.set_platform_staff_role(uuid, uuid, uuid) from anon;
grant execute on function public.set_platform_staff_role(uuid, uuid, uuid) to authenticated;

-- deactivate_platform_staff(): flips status to 'inactive' -- immediately
-- removes console access (directive Section 15: authorization checks
-- read status='active', so an inactive membership fails
-- has_platform_permission() the instant this commits). Auth user is
-- NEVER deleted here (directive Section 15). If the deactivated staff
-- member has an active support session, it is force-ended too (directive
-- Section 15's own explicit requirement).
create or replace function public.deactivate_platform_staff(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership public.platform_staff_memberships;
begin
  if not public.has_platform_permission('platform.staff.disable') then
    raise exception 'not authorized';
  end if;

  select * into v_membership from public.platform_staff_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'platform staff member not found';
  end if;

  if v_membership.status = 'inactive' then
    return;
  end if;

  update public.platform_staff_memberships set status = 'inactive', updated_at = now() where id = p_membership_id;

  -- Force-end any active support session this employee holds (directive
  -- Section 15).
  update public.platform_support_sessions
  set ended_at = now()
  where platform_owner_id = v_membership.user_id and ended_at is null;

  perform public.write_audit_log(
    null, 'platform_staff.disabled', 'platform_staff_membership', p_membership_id,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'inactive'), null
  );
end;
$$;

revoke all on function public.deactivate_platform_staff(uuid) from public;
revoke all on function public.deactivate_platform_staff(uuid) from anon;
grant execute on function public.deactivate_platform_staff(uuid) to authenticated;
