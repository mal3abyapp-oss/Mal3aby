-- PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 3 (P1).
-- PLATFORM_OWNER_COMPLETE_CONTROL_AUDIT.md finding: commercial_entitlements
-- (branch/field/academy limits) is the one commercial-change surface in
-- this codebase written via a direct, unaudited client-side .upsert()
-- (PlatformClubDetailPage.tsx's saveLimitsMutation) -- every other
-- commercial RPC (subscription lifecycle, module entitlement, suspend/
-- reactivate) writes to audit_logs; this one doesn't. No trigger exists
-- on commercial_entitlements to compensate.
--
-- Fix: a new platform-owner-gated RPC that performs the same upsert but
-- captures a before/after snapshot and writes a real audit_log entry,
-- matching every sibling commercial RPC's discipline. The existing
-- direct-write RLS policy (commercial_entitlements_platform_owner_write)
-- is intentionally left in place, not revoked -- removing it is a
-- separate, larger decision (it may be relied on by other legitimate
-- paths not swept here) and isn't required to close this specific gap;
-- the frontend is updated in the same phase to route through this RPC
-- instead of the direct upsert, which is what actually closes it in
-- practice.

create or replace function public.set_commercial_entitlements(
  p_club_id uuid,
  p_branch_limit integer,
  p_field_limit integer,
  p_academy_limit integer,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.commercial_entitlements;
  v_branches_used integer;
  v_fields_used integer;
  v_academy_used integer;
  v_over_limit_note text := '';
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select * into v_before from public.commercial_entitlements where club_id = p_club_id;

  -- Directive Section 15/42: never destructively resolve an over-limit
  -- state and never silently hide it -- compute current usage so the
  -- audit entry itself records whether this change created (or left)
  -- an over-limit condition, even though nothing here blocks the save
  -- or touches existing branches/fields/programs. The BEFORE INSERT
  -- triggers (enforce_branch_limit() etc, unchanged by this migration)
  -- remain the sole enforcement point for NEW resource creation.
  select count(*) into v_branches_used from public.branches where club_id = p_club_id and status = 'active';
  select count(*) into v_fields_used from public.fields where club_id = p_club_id and status = 'active';
  select count(*) into v_academy_used from public.programs where club_id = p_club_id and status = 'active';

  if p_branch_limit is not null and v_branches_used > p_branch_limit then
    v_over_limit_note := v_over_limit_note || format('branches: %s used > new limit %s. ', v_branches_used, p_branch_limit);
  end if;
  if p_field_limit is not null and v_fields_used > p_field_limit then
    v_over_limit_note := v_over_limit_note || format('fields: %s used > new limit %s. ', v_fields_used, p_field_limit);
  end if;
  if p_academy_limit is not null and v_academy_used > p_academy_limit then
    v_over_limit_note := v_over_limit_note || format('academy: %s used > new limit %s. ', v_academy_used, p_academy_limit);
  end if;

  insert into public.commercial_entitlements (club_id, branch_limit, field_limit, academy_limit, notes, updated_at, updated_by)
  values (p_club_id, p_branch_limit, p_field_limit, p_academy_limit, coalesce(v_before.notes, null), now(), auth.uid())
  on conflict (club_id) do update set
    branch_limit = excluded.branch_limit,
    field_limit = excluded.field_limit,
    academy_limit = excluded.academy_limit,
    updated_at = now(),
    updated_by = auth.uid();

  perform public.write_audit_log(
    p_club_id, 'commercial_entitlements.updated', 'commercial_entitlements', p_club_id,
    jsonb_build_object('branch_limit', v_before.branch_limit, 'field_limit', v_before.field_limit, 'academy_limit', v_before.academy_limit),
    jsonb_build_object(
      'branch_limit', p_branch_limit, 'field_limit', p_field_limit, 'academy_limit', p_academy_limit,
      'branches_used', v_branches_used, 'fields_used', v_fields_used, 'academy_used', v_academy_used,
      'over_limit', nullif(v_over_limit_note, '')
    ),
    p_reason
  );
end;
$$;

revoke all on function public.set_commercial_entitlements(uuid, integer, integer, integer, text) from public;
revoke all on function public.set_commercial_entitlements(uuid, integer, integer, integer, text) from anon;
grant execute on function public.set_commercial_entitlements(uuid, integer, integer, integer, text) to authenticated;
