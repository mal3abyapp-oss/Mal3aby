-- PLATFORM OWNER CONTROL PLANE V1 -- Phase 2: auditability fix for
-- deactivate_platform_staff() and set_platform_staff_role().
--
-- ROOT CAUSE (docs/platform-owner/PLATFORM_OWNER_DEEP_DIVE_REPORT.md
-- Section 17/18, live-confirmed on production gxkrtlvpjwxhcqdisyob this
-- week via the Supabase Dashboard SQL Editor -- 4 real audit_logs rows,
-- action IN ('platform_staff.disabled','platform_staff.role_changed'),
-- every single one with reason = NULL): neither RPC ever accepted a
-- p_reason parameter from the caller, so the existing write_audit_log()
-- call always passed a literal `null` for reason -- these two action
-- types could NEVER be explained after the fact, unlike every other
-- consequential platform action in this codebase (platform_suspend_club,
-- cancel_platform_subscription, extend_grace_period, etc. all already
-- require a real caller-supplied reason).
--
-- FIX: add a p_reason parameter to both RPCs and thread it through to
-- write_audit_log(). Every other line of business logic in both
-- functions is byte-for-byte unchanged from the live version --
-- privilege-ceiling checks, last-assigner-lockout guard,
-- support-session force-end, status transition logic, all preserved
-- verbatim.
--
-- REVISED after independent Phase 15/16 review (2026-09-08): p_reason
-- was originally left `default null` with no server-side validation --
-- the frontend disabled its Save button until a reason was typed, but
-- any direct RPC caller (a script, a different client, a future UI
-- regression) could still bypass that and deactivate staff / reassign a
-- role with reason=null, silently reopening the exact
-- "unexplainable audit entry" gap this migration exists to close. Both
-- an independent security reviewer (P2, auditability-only) and an
-- independent UX reviewer (P1, citing this codebase's own established
-- platform_suspend_club() precedent) flagged this; fixed by requiring a
-- real non-empty reason server-side, matching platform_suspend_club()'s
-- exact validation shape (20260817100225_platform_suspend_reactivate_club_with_reason.sql):
-- `if p_reason is null or length(trim(p_reason)) = 0 then raise
-- exception`. p_reason keeps its `default null` in the signature only
-- so the exception message is the caller-facing error rather than a
-- generic not-null-constraint failure -- omitting it or passing an
-- empty/whitespace string is still rejected identically.
--
-- NOT DONE, DELIBERATELY: this migration does NOT retroactively rewrite
-- or backfill the 4 existing NULL-reason audit_logs rows -- audit_logs
-- is immutable by design (ADR-020, no UPDATE/DELETE policy for any
-- role, ever) and fabricating a reason for a real historical action
-- would falsify the record, which is worse than an honest gap. Those 4
-- rows remain permanently reason: NULL, correctly reflecting that no
-- reason was captured at the time.

create or replace function public.set_platform_staff_role(
  p_membership_id uuid,
  p_platform_role_id uuid default null,
  p_platform_custom_role_id uuid default null,
  p_reason text default null
)
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

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to change a platform staff member''s role';
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

  -- FIX (this migration): reason now threaded through, was always null.
  perform public.write_audit_log(
    null, 'platform_staff.role_changed', 'platform_staff_membership', p_membership_id,
    v_before, jsonb_build_object('platform_role_id', p_platform_role_id, 'platform_custom_role_id', p_platform_custom_role_id), p_reason
  );
end;
$$;

revoke all on function public.set_platform_staff_role(uuid, uuid, uuid) from public;
revoke all on function public.set_platform_staff_role(uuid, uuid, uuid) from anon;
revoke all on function public.set_platform_staff_role(uuid, uuid, uuid) from authenticated;
drop function if exists public.set_platform_staff_role(uuid, uuid, uuid);

revoke all on function public.set_platform_staff_role(uuid, uuid, uuid, text) from public;
revoke all on function public.set_platform_staff_role(uuid, uuid, uuid, text) from anon;
grant execute on function public.set_platform_staff_role(uuid, uuid, uuid, text) to authenticated;

create or replace function public.deactivate_platform_staff(p_membership_id uuid, p_reason text default null)
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

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to deactivate a platform staff member';
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

  -- FIX (this migration): reason now threaded through, was always null.
  perform public.write_audit_log(
    null, 'platform_staff.disabled', 'platform_staff_membership', p_membership_id,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'inactive'), p_reason
  );
end;
$$;

revoke all on function public.deactivate_platform_staff(uuid) from public;
revoke all on function public.deactivate_platform_staff(uuid) from anon;
revoke all on function public.deactivate_platform_staff(uuid) from authenticated;
drop function if exists public.deactivate_platform_staff(uuid);

revoke all on function public.deactivate_platform_staff(uuid, text) from public;
revoke all on function public.deactivate_platform_staff(uuid, text) from anon;
grant execute on function public.deactivate_platform_staff(uuid, text) to authenticated;

comment on function public.set_platform_staff_role(uuid, uuid, uuid, text) is
  'Adds p_reason, required non-empty server-side (matches platform_suspend_club''s validation shape) and threaded to write_audit_log() -- fixes the confirmed live gap where every platform_staff.role_changed audit row had reason=NULL. See 20260908150000_platform_staff_actions_require_reason.sql for full root-cause. All other logic byte-for-byte unchanged from the pre-fix version.';

comment on function public.deactivate_platform_staff(uuid, text) is
  'Adds p_reason, required non-empty server-side (matches platform_suspend_club''s validation shape) and threaded to write_audit_log() -- fixes the confirmed live gap where every platform_staff.disabled audit row had reason=NULL. See 20260908150000_platform_staff_actions_require_reason.sql for full root-cause. All other logic byte-for-byte unchanged from the pre-fix version.';
