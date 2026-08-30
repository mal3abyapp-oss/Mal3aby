-- FULL SAAS ACCEPTANCE SWEEP (2026-08-30) -- Audit & Platform
-- Operations item 6, finding #2 from the 2026-08-29 platform-owner
-- acceptance pass: approve/dismiss on commercial_upgrade_requests
-- (PlatformClubDetailPage.tsx's resolveUpgradeRequestMutation) was a
-- direct client-side .from().update() -- same bug class as the P0 fix
-- applied the same day in 20260829040000_revoke_unaudited_platform_
-- owner_direct_writes.sql (clubs/commercial_entitlements/branches/
-- club_memberships), but that migration's table sweep didn't include
-- this one. RLS itself was correctly locked to is_platform_owner() (no
-- authorization gap), but zero audit_logs trace existed of who
-- approved/dismissed a commercial upgrade decision. Routes the write
-- through a real audited RPC, matching every sibling action on this
-- page (set_commercial_entitlements, set_club_payments_enabled,
-- set_club_gateway_provider_policy, set_club_module_active/
-- entitlement). Never deletes the request row -- same soft-transition
-- discipline as the rest of this domain.
create or replace function public.resolve_commercial_upgrade_request(p_request_id uuid, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before public.commercial_upgrade_requests;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_status not in ('approved', 'dismissed') then
    raise exception 'invalid status';
  end if;

  select * into v_before from public.commercial_upgrade_requests where id = p_request_id;
  if v_before.id is null then
    raise exception 'request not found';
  end if;

  if v_before.status not in ('pending', 'reviewed') then
    raise exception 'this request has already been resolved';
  end if;

  update public.commercial_upgrade_requests
  set status = p_status, reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_request_id;

  perform public.write_audit_log(
    v_before.club_id, 'commercial_upgrade_request.resolved', 'commercial_upgrade_request', p_request_id,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', p_status, 'limit_type', v_before.limit_type, 'current_limit', v_before.current_limit, 'current_usage', v_before.current_usage),
    p_reason
  );
end;
$function$;

revoke all on function public.resolve_commercial_upgrade_request(uuid, text, text) from public, anon;
grant execute on function public.resolve_commercial_upgrade_request(uuid, text, text) to authenticated;

-- The RPC is now the sole intended write path for this transition;
-- narrow the RLS UPDATE policy accordingly so a direct client update
-- (bypassing the audit trail) is no longer possible even for a
-- platform owner -- INSERT (club-side request creation) and SELECT
-- stay exactly as they were, only UPDATE narrows from "platform owner,
-- any column" to "blocked at the table level, RPC only" (the RPC is
-- SECURITY DEFINER and does not depend on this policy to function).
drop policy if exists commercial_upgrade_requests_platform_owner_full on public.commercial_upgrade_requests;

create policy commercial_upgrade_requests_platform_owner_select
  on public.commercial_upgrade_requests for select
  using (public.is_platform_owner());
