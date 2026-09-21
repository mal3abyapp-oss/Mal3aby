-- RBAC-1 deferred items, resolved (owner brief, 2026-09-21): the RBAC-1
-- investigation flagged two lower-confidence findings as needing a
-- decision rather than being fixed inline. Both are resolved here in
-- the direction the investigation itself recommended as most consistent
-- with the rest of this codebase's own conventions.
--
-- 1. sales_check_and_increment_quota() accepted platform.sales.discover
--    OR .enrich OR .generate_offer interchangeably, regardless of which
--    provider was actually being invoked -- every OTHER sales RPC in
--    this codebase strictly gates on the one specific matching
--    permission key (confirmed by the RBAC-1 investigation's own
--    exhaustive review), and these three keys are modeled as separate,
--    distinct permissions in the catalog specifically so they CAN be
--    granted independently -- treating them as interchangeable here
--    defeated that separation. A staffer granted only
--    platform.sales.discover could previously call the AI-offer-
--    generator or website-enrichment Edge Functions too, since this was
--    the only server-side re-authorization those functions perform.
--    Fixed by checking the ONE permission that actually matches
--    p_provider_key: 'google_places' -> discover, 'website_enrichment'
--    -> enrich, 'ai_offer_generator' -> generate_offer (the exact,
--    confirmed values each Edge Function passes -- grepped directly
--    from sales-google-places-discovery/sales-website-enrichment/
--    sales-ai-offer-generator before writing this). is_platform_owner()
--    still bypasses unconditionally, as everywhere else.
--
-- 2. sales_schedule_demo/sales_complete_demo/
--    sales_queue_platform_whatsapp_message use the
--    "auth.uid() is null OR is_platform_owner() OR
--    has_platform_permission(...)" idiom (meant to let a trusted
--    service_role caller bypass, matching this schema's own documented
--    pattern in sales_upsert_discovered_lead's fix), but none of the
--    three were ever granted EXECUTE as service_role -- an
--    inconsistency with their own idiom's stated intent. Not currently
--    exploitable (authenticated always has a non-null auth.uid(), so
--    the null-bypass branch was unreachable by any real caller), but
--    left as-is it risks becoming a real gap the moment any future
--    change relies on that branch without re-auditing this line. Fixed
--    by adding the missing service_role grants -- a pure grant-widening
--    to service_role only, no change to authenticated's access, no
--    change to any function body.

-- ------------------------------------------------------------
-- 1. Provider-specific quota permission check.
-- ------------------------------------------------------------
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
  v_required_permission text;
begin
  v_required_permission := case p_provider_key
    when 'google_places' then 'platform.sales.discover'
    when 'website_enrichment' then 'platform.sales.enrich'
    when 'ai_offer_generator' then 'platform.sales.generate_offer'
    else null
  end;

  if v_required_permission is null then
    raise exception 'unknown provider_key: %', p_provider_key;
  end if;

  if not (public.is_platform_owner() or public.has_platform_permission(v_required_permission)) then
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

-- ------------------------------------------------------------
-- 2. Missing service_role grants, matching each function's own
--    documented "auth.uid() is null" bypass intent. Function bodies
--    unchanged -- grant-only.
-- ------------------------------------------------------------
grant execute on function public.sales_schedule_demo(uuid, timestamptz, text) to service_role;
grant execute on function public.sales_complete_demo(uuid, text, text) to service_role;
grant execute on function public.sales_queue_platform_whatsapp_message(uuid) to service_role;
