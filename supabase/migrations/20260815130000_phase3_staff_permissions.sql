-- Phase 3 — Staff & Permissions Management
-- See docs/IMPLEMENTATION_PLAN.md Phase 3. No new tables — CRUD on Phase 2
-- tables via RLS-gated RPCs where the operation is multi-table or needs a
-- permission check beyond what a bare RLS policy expresses.
--
-- Staff "invite" can only target an EXISTING auth.users account:
-- club_memberships.user_id is a hard FK to auth.users (see
-- DATABASE_BLUEPRINT.md), and there is no invitation-token table in the
-- approved schema. So invite_staff_member() looks up auth.users by email
-- and fails with a safe, generic error if no such account exists yet --
-- it does not and cannot create an account (that would require the Auth
-- Admin API, which is not available to a SECURITY DEFINER SQL function).

-- ============================================================
-- invite_staff_member: add an existing user to a club with a role
-- (+ optional branch scope), or reactivate/re-role an inactive membership.
-- ============================================================
create or replace function public.invite_staff_member(
  p_club_id uuid,
  p_email text,
  p_role_key text,
  p_branch_ids uuid[] default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_target_user_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
begin
  -- Re-derive the caller's authorization from their own club_memberships;
  -- p_club_id is never trusted on its own (RLS_SECURITY.md rule 2).
  if not public.has_permission('staff.create', p_club_id) then
    raise exception 'not authorized';
  end if;

  select id into v_target_user_id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;

  if v_target_user_id is null then
    raise exception 'no account found for that email -- the person must sign up first';
  end if;

  select id into v_role_id from public.roles where key = p_role_key;
  if v_role_id is null then
    raise exception 'unknown role';
  end if;

  -- platform_owner can never be granted through this club-scoped path.
  if p_role_key = 'platform_owner' then
    raise exception 'not authorized';
  end if;

  insert into public.club_memberships (user_id, club_id, role_id, status)
  values (v_target_user_id, p_club_id, v_role_id, 'active')
  on conflict (user_id, club_id, role_id)
    do update set status = 'active', updated_at = now()
  returning id into v_membership_id;

  -- Replace branch scope entirely on each (re-)invite call: NULL/empty
  -- array = all branches (zero rows, per the documented semantic).
  delete from public.membership_branches where membership_id = v_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  return v_membership_id;
end;
$$;

revoke execute on function public.invite_staff_member(uuid, text, text, uuid[]) from public;
revoke execute on function public.invite_staff_member(uuid, text, text, uuid[]) from anon;
grant execute on function public.invite_staff_member(uuid, text, text, uuid[]) to authenticated;

-- ============================================================
-- deactivate_staff_member: sets status = 'inactive'. No hard delete.
-- ============================================================
create or replace function public.deactivate_staff_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.club_memberships where id = p_membership_id;
  if v_club_id is null then
    raise exception 'membership not found';
  end if;

  if not public.has_permission('staff.update', v_club_id) then
    raise exception 'not authorized';
  end if;

  update public.club_memberships
  set status = 'inactive', updated_at = now()
  where id = p_membership_id;
end;
$$;

revoke execute on function public.deactivate_staff_member(uuid) from public;
revoke execute on function public.deactivate_staff_member(uuid) from anon;
grant execute on function public.deactivate_staff_member(uuid) to authenticated;
