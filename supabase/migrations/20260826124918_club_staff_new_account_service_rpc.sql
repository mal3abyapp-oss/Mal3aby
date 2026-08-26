-- CLUB STAFF ONBOARDING (2026-08-26), continued -- the service_role-only
-- counterpart that lets the new club-staff-admin Edge Function attach a
-- club_memberships row to an auth user IT just created via the Admin
-- API. Mirrors has_platform_permission_as()/claim_portal_invite_service()'s
-- own precedent exactly: the Edge Function's service_role client has no
-- auth.uid() context, so the caller's real identity and permission are
-- resolved and checked separately (via the caller's own JWT, in the
-- Edge Function, BEFORE this RPC is ever invoked) -- this RPC is not
-- itself the security boundary, it is the trusted-server-only write
-- path reachable exclusively from that already-checked context.
--
-- Deliberately reuses ALL of invite_staff_member()'s own business rules
-- (exactly one of system/custom role, no platform_owner assignment,
-- escalation guard, default cash custody derivation, branch scope
-- write, audit) rather than re-deriving them, parameterized only by an
-- explicit p_user_id (the brand-new auth user) and p_actor_id (the real
-- caller, since auth.uid() is unavailable in this service-role context
-- and MUST NOT be trusted from client input for anything auth-related
-- -- audit needs the actor, but authorization was already checked
-- upstream against that same actor's own JWT).
create or replace function public.create_club_staff_membership_service(
  p_actor_id uuid,
  p_club_id uuid,
  p_user_id uuid,
  p_role_key text default null,
  p_custom_role_id uuid default null,
  p_branch_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
  v_default_custody boolean;
  v_custom_role public.club_roles;
begin
  if (p_role_key is not null) = (p_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  if exists (
    select 1 from public.club_memberships
    where user_id = p_user_id and club_id = p_club_id
  ) then
    raise exception 'this person is already staff at this club';
  end if;

  if p_custom_role_id is not null then
    select * into v_custom_role from public.club_roles where id = p_custom_role_id and club_id = p_club_id;
    if v_custom_role.id is null then
      raise exception 'custom role not found in this club';
    end if;
    if not v_custom_role.is_active then
      raise exception 'this custom role is disabled';
    end if;

    select coalesce(bool_or(p.key = 'payment.create'), false) into v_default_custody
    from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id
    where crp.club_role_id = p_custom_role_id;

    insert into public.club_memberships (user_id, club_id, role_id, custom_role_id, status, has_cash_custody)
    values (p_user_id, p_club_id, null, p_custom_role_id, 'invited', v_default_custody)
    returning id into v_membership_id;
  else
    if p_role_key = 'platform_owner' then
      raise exception 'not authorized';
    end if;

    select id into v_role_id from public.roles where key = p_role_key;
    if v_role_id is null then
      raise exception 'unknown role';
    end if;

    select exists (
      select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = v_role_id and p.key = 'payment.create'
    ) into v_default_custody;

    insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
    values (p_user_id, p_club_id, v_role_id, 'invited', v_default_custody)
    returning id into v_membership_id;
  end if;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  -- write_audit_log() unconditionally stamps actor_id = auth.uid(),
  -- which is NULL in this service_role context (no session) -- would
  -- silently lose real attribution to p_actor_id. Insert directly with
  -- the real actor instead, exactly the same reasoning that motivated
  -- write_audit_log_as_support() during the Master Admin build.
  insert into public.audit_logs (club_id, actor_id, action, entity_type, entity_id, before, after, reason)
  values (
    p_club_id, p_actor_id, 'staff.account_created_and_invited', 'club_membership', v_membership_id,
    null,
    jsonb_build_object('role_key', p_role_key, 'custom_role_id', p_custom_role_id, 'branch_ids', p_branch_ids, 'status', 'invited'),
    null
  );

  return v_membership_id;
end;
$$;

revoke all on function public.create_club_staff_membership_service(uuid, uuid, uuid, text, uuid, uuid[]) from public;
revoke all on function public.create_club_staff_membership_service(uuid, uuid, uuid, text, uuid, uuid[]) from anon;
revoke all on function public.create_club_staff_membership_service(uuid, uuid, uuid, text, uuid, uuid[]) from authenticated;
grant execute on function public.create_club_staff_membership_service(uuid, uuid, uuid, text, uuid, uuid[]) to service_role;

-- resend_staff_invite(): for a membership still in 'invited' status,
-- generate a fresh Supabase recovery/setup link (the original one may
-- have expired or been lost) -- club-side analogue of
-- platform-staff-admin's reset_password action, but this is a caller-
-- authorized RPC returning nothing sensitive itself; the actual link
-- generation happens in the Edge Function (Admin API access required),
-- this RPC only re-confirms the caller is authorized and the
-- membership is genuinely still pending, then audits the resend.
create or replace function public.mark_staff_invite_resent(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership record;
begin
  select * into v_membership
  from public.club_memberships
  where id = p_membership_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('staff.create', club_id);

  if v_membership.id is null then
    raise exception 'membership not found or you do not have permission to update it';
  end if;

  if v_membership.status != 'invited' then
    raise exception 'this membership is not in a pending-invite state';
  end if;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.invite_resent', 'club_membership', p_membership_id,
    null, null, null
  );
end;
$$;

revoke all on function public.mark_staff_invite_resent(uuid) from public;
revoke all on function public.mark_staff_invite_resent(uuid) from anon;
grant execute on function public.mark_staff_invite_resent(uuid) to authenticated;

-- cancel_staff_invite(): withdraw a pending invite before the employee
-- ever activates -- hard delete of the row (not a status flip to
-- 'inactive') since an un-activated 'invited' membership was never a
-- real staff relationship and carries no operational history yet (no
-- bookings/payments/audit could reference it beyond its own creation
-- log, which remains in audit_logs regardless -- deleting the
-- membership row itself does not delete audit history).
create or replace function public.cancel_staff_invite(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership record;
begin
  select * into v_membership
  from public.club_memberships
  where id = p_membership_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('staff.create', club_id);

  if v_membership.id is null then
    raise exception 'membership not found or you do not have permission to update it';
  end if;

  if v_membership.status != 'invited' then
    raise exception 'this membership is not in a pending-invite state';
  end if;

  delete from public.membership_branches where membership_id = p_membership_id;
  delete from public.club_memberships where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.invite_cancelled', 'club_membership', p_membership_id,
    jsonb_build_object('status', 'invited'), null, null
  );
end;
$$;

revoke all on function public.cancel_staff_invite(uuid) from public;
revoke all on function public.cancel_staff_invite(uuid) from anon;
grant execute on function public.cancel_staff_invite(uuid) to authenticated;
