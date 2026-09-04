-- P0 PRODUCTION-BREAKING FIX (2026-09-04): sales_check_and_increment_quota()
-- has been throwing "column reference \"daily_cap\" is ambiguous" (42702)
-- on every single call since it was first written -- confirmed live via a
-- real authenticated Platform Owner browser session calling the actual
-- sales-website-enrichment Edge Function through the real production
-- HTTP path (not a manual SQL workaround): the Edge Function's own
-- callerClient.rpc('sales_check_and_increment_quota', ...) call failed
-- with this exact error, which the Edge Function surfaces as a generic
-- 403 "not authorized or quota check failed" -- masking the real 42702
-- underneath. This means EVERY discovery/website-enrichment/AI-offer-
-- generation call through any of the three provider Edge Functions has
-- been completely broken in production since they were first deployed
-- (100% failure rate before ever reaching the provider itself), exactly
-- mirroring the 20260831095910 complete_new_club_onboarding() defect
-- class found and fixed in the prior remediation.
--
-- Root cause: this function's own `returns table(allowed boolean,
-- current_count int, daily_cap int)` clause implicitly declares
-- `daily_cap` as a PL/pgSQL variable in scope for the entire function
-- body. The line:
--
--   select coalesce(daily_cap, 100) into v_cap
--   from public.sales_provider_configs where provider_key = p_provider_key;
--
-- has a bare `daily_cap` reference inside embedded SQL that is
-- ambiguous between the table column (public.sales_provider_configs.
-- daily_cap) and the same-named OUT-parameter variable -- the exact
-- same root cause class as the onboarding fix: an embedded SQL
-- statement referencing a bare identifier that collides with a
-- same-named OUT parameter from the function's own return-table clause.
--
-- Fix: add `#variable_conflict use_column` (same proven fix as
-- 20260831095910) so plpgsql always prefers a table column over a
-- same-named OUT-parameter variable when a bare identifier inside
-- embedded SQL is otherwise ambiguous. No other statement in this
-- function body is affected -- every other bare identifier is either
-- correctly disambiguated already (v_row.daily_cap, v_cap) or an
-- INSERT target-column-list (never variable-substituted, never
-- ambiguous).
--
-- No contract change: signature, return shape, and all other behavior
-- are byte-identical to the previous (broken) version.

create or replace function public.sales_check_and_increment_quota(p_provider_key text)
returns table(allowed boolean, current_count int, daily_cap int)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
#variable_conflict use_column
declare
  v_row public.sales_quota_usage%rowtype;
  v_cap int;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.discover')
       or public.has_platform_permission('platform.sales.enrich')
       or public.has_platform_permission('platform.sales.generate_offer')) then
    raise exception 'not authorized';
  end if;

  select coalesce(daily_cap, 100) into v_cap from public.sales_provider_configs where provider_key = p_provider_key;
  v_cap := coalesce(v_cap, 100);

  insert into public.sales_quota_usage (provider_key, usage_date, request_count, daily_cap)
  values (p_provider_key, current_date, 0, v_cap)
  on conflict (provider_key, usage_date) do nothing;

  select * into v_row from public.sales_quota_usage
  where provider_key = p_provider_key and usage_date = current_date
  for update;

  if v_row.request_count >= v_row.daily_cap then
    return query select false, v_row.request_count, v_row.daily_cap;
    return;
  end if;

  update public.sales_quota_usage
  set request_count = request_count + 1, updated_at = now()
  where provider_key = p_provider_key and usage_date = current_date;

  return query select true, v_row.request_count + 1, v_row.daily_cap;
end;
$$;

revoke all on function public.sales_check_and_increment_quota(text) from public, anon;
grant execute on function public.sales_check_and_increment_quota(text) to authenticated, service_role;
