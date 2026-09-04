-- P0 PRODUCTION-BREAKING FIX (2026-09-04): sales_record_signal() and
-- sales_change_lead_status() both rejected every call made by the
-- sales-website-enrichment Edge Function's service_role admin client
-- with "not authorized" -- the SAME defect class just fixed in
-- sales_upsert_discovered_lead()/sales_find_duplicate_candidates()
-- (see 20260904130300_*), but via a DIFFERENT broken check this time,
-- worth recording precisely so it is never reintroduced.
--
-- Found proactively while starting live Website Enrichment acceptance
-- verification (immediately after proving the Google Places discovery
-- fix end-to-end) -- checked every service_role-called RPC in this
-- module for the already-known failure shape before running the real
-- test, rather than waiting to hit it live. Confirmed by direct
-- reproduction: `set role service_role; select sales_record_signal(...)`
-- and `select sales_change_lead_status(...)` both raised 'not
-- authorized' immediately.
--
-- Root cause: unlike sales_upsert_discovered_lead() (which used
-- is_platform_owner()/has_platform_permission() with no service_role
-- awareness at all), these two functions DID attempt to special-case
-- the service_role caller -- but via
--   if current_user <> 'service_role' and not (...) then raise ...
-- which the original author's own migration comments describe as "the
-- genuine authenticated Postgres role for a trusted server-side worker
-- ... never a client-forgeable claim". That reasoning is correct for a
-- plain `SET ROLE service_role` in an ordinary session -- but WRONG
-- for a check written inside a SECURITY DEFINER function body. Proven
-- empirically (via a throwaway SECURITY DEFINER diagnostic function,
-- also used to root-cause 20260904130300_*): current_user (and
-- session_user) inside a SECURITY DEFINER function always reflect the
-- function's OWNER ('postgres' in this project), never the calling
-- role, regardless of whether the outer caller was authenticated,
-- anon, or service_role. So `current_user <> 'service_role'` is always
-- true inside these two functions' bodies, for every caller including
-- a genuine service_role one -- the intended bypass could never fire,
-- and every service_role call fell through to the same
-- is_platform_owner() check that has no auth.uid() to resolve.
--
-- Fix: replace `current_user <> 'service_role' and not (...)` with the
-- same auth.uid() is null discriminator already proven correct and
-- applied in 20260904130300_* -- safe here for the identical reason:
-- both functions already revoke all from public/anon and grant execute
-- only to authenticated (always has a real auth.uid()) and service_role
-- (never does), so "auth.uid() is null" inside the body can only mean
-- the trusted service_role caller. Grants on both functions were
-- already correct (service_role was already granted -- only the
-- in-body logic was broken, unlike sales_upsert_discovered_lead()
-- which was ALSO missing the grant), so no grant changes needed here.
-- No other behavior change on either function.

create or replace function public.sales_record_signal(
  p_lead_id uuid,
  p_signal_key text,
  p_confidence text,
  p_evidence jsonb,
  p_source_url text default null,
  p_enrichment_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_signal_id uuid;
begin
  if not (
    auth.uid() is null  -- service_role caller: no anon/authenticated grant exists, so reaching this point already proves trust
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.enrich')
  ) then
    raise exception 'not authorized';
  end if;

  update public.sales_lead_signals
  set is_active = false
  where lead_id = p_lead_id and signal_key = p_signal_key and is_active = true;

  insert into public.sales_lead_signals (lead_id, signal_key, confidence, evidence, source_url, enrichment_run_id)
  values (p_lead_id, p_signal_key, p_confidence, p_evidence, p_source_url, p_enrichment_run_id)
  returning id into v_signal_id;

  if p_signal_key = 'no_online_booking' then
    update public.sales_leads set has_online_booking = false where id = p_lead_id;
  elsif p_signal_key = 'multi_branch' then
    update public.sales_leads set branch_count_estimate = greatest(coalesce(branch_count_estimate, 1), 2) where id = p_lead_id;
  elsif p_signal_key = 'multi_field_facility' then
    update public.sales_leads set facility_count_estimate = greatest(coalesce(facility_count_estimate, 1), 2) where id = p_lead_id;
  elsif p_signal_key = 'academy_present' then
    update public.sales_leads set has_academy_presence = true where id = p_lead_id;
  end if;

  return v_signal_id;
end;
$$;

create or replace function public.sales_change_lead_status(p_lead_id uuid, p_new_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current text;
begin
  if not (
    auth.uid() is null  -- service_role caller: no anon/authenticated grant exists, so reaching this point already proves trust
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.qualify')
    or public.has_platform_permission('platform.sales.edit')
  ) then
    raise exception 'not authorized';
  end if;

  select status into v_current from public.sales_leads where id = p_lead_id for update;
  if v_current is null then
    raise exception 'lead not found';
  end if;

  if v_current = 'do_not_contact' and p_new_status not in ('do_not_contact', 'lost') then
    raise exception 'this lead is marked do_not_contact and cannot be re-activated for outreach';
  end if;

  if v_current in ('won', 'awaiting_owner_activation', 'tenant_activated') and p_new_status <> v_current then
    raise exception 'this lead has already been won/converted and cannot change status through this action';
  end if;

  if p_new_status = 'won' then
    raise exception 'a lead can only reach won status via sales_win_lead_and_invite_owner() (Convert to Tenant), not a direct status change';
  end if;

  if p_new_status in ('awaiting_owner_activation', 'tenant_activated') then
    raise exception 'this status is only reachable via the tenant activation flow (Convert to Tenant / owner activation), not a direct status change';
  end if;

  update public.sales_leads
  set status = p_new_status, status_reason = p_reason, updated_at = now()
  where id = p_lead_id;

  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, v_current, p_new_status, p_reason, auth.uid());

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'status_changed', jsonb_build_object('from', v_current, 'to', p_new_status, 'reason', p_reason), auth.uid());
end;
$$;
