-- Platform Owner directive, Phase D (D1/D2): subscription operations
-- hardening.
--
-- D2. extend_grace_period had no reason parameter at all -- the audit
-- flagged its caller as a hardcoded literal 14 with no input field;
-- fixing the caller alone wasn't enough since the RPC itself never
-- accepted a reason to record. Added p_reason (required, matching the
-- discipline every other subscription-affecting RPC already has:
-- suspend/reactivate/cancel/reverse all require one).
--
-- D1. change_platform_plan's p_reason had a hardcoded caller-side default
-- ('plan change via platform console') -- the RPC itself already
-- accepted a real reason param, so this is a frontend-only fix (see the
-- accompanying PlatformClubDetailPage.tsx change), no RPC change needed
-- for D1. Documented here only for completeness of the Phase D record.
create or replace function public.extend_grace_period(
  p_subscription_id uuid,
  p_grace_period_days integer,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_before record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_grace_period_days < 0 then
    raise exception 'grace period days cannot be negative';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to change the grace period';
  end if;

  select * into v_before from public.platform_subscriptions where id = p_subscription_id;
  if v_before is null then
    raise exception 'subscription not found';
  end if;

  update public.platform_subscriptions
  set grace_period_days_snapshot = p_grace_period_days
  where id = p_subscription_id;

  perform public.write_audit_log(
    v_before.club_id, 'extend_grace_period', 'platform_subscriptions', p_subscription_id,
    jsonb_build_object('grace_period_days_snapshot', v_before.grace_period_days_snapshot),
    jsonb_build_object('grace_period_days_snapshot', p_grace_period_days),
    p_reason
  );
end;
$function$;

revoke all on function public.extend_grace_period(uuid, integer, text) from public;
revoke all on function public.extend_grace_period(uuid, integer, text) from anon;
grant execute on function public.extend_grace_period(uuid, integer, text) to authenticated;

-- Drop the old 2-arg signature -- fully replaced, not overloaded, so
-- there's only one code path for this action (same pattern as Phase A's
-- create_platform_subscription signature change).
drop function if exists public.extend_grace_period(uuid, integer);
