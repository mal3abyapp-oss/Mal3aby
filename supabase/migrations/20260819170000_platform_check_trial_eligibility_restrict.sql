-- Final regression pass finding: check_trial_eligibility() is a pure
-- read-only helper called internally by create_platform_subscription
-- (which is correctly is_platform_owner()-gated), but had its own
-- 'authenticated' grant with no internal authorization check at all --
-- letting ANY signed-in user (not just the platform owner) probe
-- whether an arbitrary user_id/mobile/email combination has already
-- consumed a trial. Low-severity (no financial/PII data beyond a
-- boolean + a generic reason string, no cross-tenant row content) but
-- unnecessary exposure with a real production remediation. Restricting
-- to platform-owner-only, matching every other platform RPC.
create or replace function public.check_trial_eligibility(
  p_user_id uuid,
  p_normalized_mobile text,
  p_email text
)
returns table(eligible boolean, blocking_reason text)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_existing record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_existing
  from public.automatic_trial_entitlements
  where user_id = p_user_id
     or (p_normalized_mobile is not null and owner_normalized_mobile_snapshot = p_normalized_mobile)
     or (p_email is not null and lower(owner_email_snapshot) = lower(p_email))
  limit 1;

  if v_existing is null then
    return query select true, null::text;
  else
    return query select false, 'trial already consumed by this owner (user_id, mobile, or email match)';
  end if;
end;
$function$;

revoke all on function public.check_trial_eligibility(uuid, text, text) from public;
revoke all on function public.check_trial_eligibility(uuid, text, text) from anon;
grant execute on function public.check_trial_eligibility(uuid, text, text) to authenticated;
