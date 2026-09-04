-- P0 PRODUCTION-BREAKING FIX (2026-09-04): sales_upsert_discovered_lead()
-- (and its own inner dependency sales_find_duplicate_candidates())
-- rejected every single call made by sales-google-places-discovery Edge
-- Function with "not authorized", so EVERY discovered place failed to
-- persist -- discovery jobs completed with discovered > 0 but new = 0,
-- duplicate = 0, failed = discovered, every single run, forever.
--
-- Confirmed live during the same Google Places provider acceptance test
-- that surfaced the sales_claim_discovery_job() ambiguous-column bug
-- (see 20260904130200_*): once that fix let a job actually get claimed
-- and Google Places genuinely returned 20 real results, all 20 failed
-- to upsert. Direct reproduction via SQL confirmed the root cause below,
-- including one dead end worth recording so it is not retried: a first
-- fix attempt gated on `current_user = 'service_role'`, which looked
-- correct testing bare SQL under `set role service_role`, but FAILED
-- when actually wired into the function body -- inside a SECURITY
-- DEFINER function, current_user (and session_user) reflect the
-- function's OWNER, never the caller's role, by Postgres's own design
-- (proven live: a throwaway SECURITY DEFINER diagnostic function
-- returned current_user = session_user = 'postgres' even when called
-- immediately after `set role service_role`). That signal cannot
-- survive a SECURITY DEFINER boundary at all, so it can never
-- distinguish the caller inside the function body.
--
-- Root cause: sales_upsert_discovered_lead() gates on
--   if not (public.is_platform_owner() or public.has_platform_permission(...))
--     then raise exception 'not authorized';
-- which is correct for its OTHER caller -- SalesDiscoverPage.tsx's
-- "add lead manually" button calls this RPC directly from the browser
-- as the authenticated platform-owner user, where is_platform_owner()
-- correctly resolves auth.uid(). But sales-google-places-discovery
-- (index.ts) calls it through its `admin` client -- the SERVICE_ROLE
-- key, deliberately used (not the caller's own session) so that a
-- long-running paginated discovery loop is never tied to one HTTP
-- request's short-lived user JWT. In that context there is no JWT at
-- all, auth.uid() is null, both authorization branches evaluate false,
-- and the exception fires on every row -- silently swallowed by the
-- Edge Function's `if (upsertError...) { failedCount++; continue }`
-- (index.ts:263-266), which is why the job status ('partial'/
-- 'completed') and discovered_count looked entirely healthy while
-- zero leads were ever actually created. The SAME defect independently
-- exists one layer deeper in sales_find_duplicate_candidates() -- the
-- read-only dedup-matching helper sales_upsert_discovered_lead() calls
-- internally -- which has its own, separately broken
-- is_platform_owner()-style gate and its own authenticated-only grant;
-- fixing only the outer function still fails inside this inner call.
--
-- Neither function is genuinely single-purpose (this is why the fix is
-- not simply moving them to the service_role-only, no-check pattern
-- used by sales_claim_discovery_job()/sales_finish_discovery_job() /
-- whatsapp_connector_claim_next_batch): sales_upsert_discovered_lead()
-- must keep enforcing is_platform_owner()/has_platform_permission() for
-- the direct browser-authenticated manual-add path (SalesDiscoverPage.
-- tsx), and sales_find_duplicate_candidates() is documented as callable
-- from a future/existing "check for duplicates" UI action the same way
-- -- both a service_role call reachable only from trusted server-side
-- Edge Function code AND a direct authenticated browser call must keep
-- working. That service_role call is never reachable from a browser --
-- there is no anon/authenticated grant on the service_role path -- and
-- by the time it runs, the real interactive user has already been
-- re-verified server-side via sales_check_and_increment_quota() on the
-- CALLER-scoped client earlier in index.ts (lines 178-186) -- so
-- trusting a genuine service_role caller without a redundant, JWT-less
-- ownership re-check does not weaken authorization; it reflects that
-- authorization already happened one layer up, exactly as
-- sales_claim_discovery_job()/sales_finish_discovery_job() assume for
-- their own service_role-only callers.
--
-- Fix: broaden each guard to `auth.uid() is null or is_platform_owner()
-- or has_platform_permission(...)`. auth.uid() is null is safe as the
-- service_role discriminator specifically BECAUSE (unlike current_user/
-- session_user) it is read from the request.jwt.claims GUC rather than
-- the Postgres role, so it correctly stays null through the SECURITY
-- DEFINER boundary for a real service_role caller -- AND because the
-- grants make it sound: both functions revoke all from public/anon and
-- grant execute ONLY to authenticated (always has a real auth.uid() --
-- Supabase never issues a valid session JWT without a sub claim) and,
-- newly, service_role (never has one). No other role can reach the
-- function body at all, so "auth.uid() is null" inside it can only ever
-- mean "the trusted service_role caller", never an anonymous bypass.
-- Also add the missing `grant execute ... to service_role` on both
-- functions (were authenticated-only, silently blocking the
-- service-role caller at the grant layer even before the auth check
-- would have rejected it). No other behavior change -- signatures,
-- dedup logic, and the authenticated/manual-add and check-duplicates
-- paths are byte-identical to the previous (broken, for the service-
-- role caller only) versions.

create or replace function public.sales_find_duplicate_candidates(
  p_place_id text,
  p_phone text,
  p_domain text,
  p_email text,
  p_normalized_name text,
  p_city text,
  p_lat numeric,
  p_lng numeric
)
returns table(candidate_lead_id uuid, confidence text, matched_signals text[])
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (
    auth.uid() is null  -- service_role caller: no anon/authenticated grant exists, so reaching this point already proves trust
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.view')
  ) then
    raise exception 'not authorized';
  end if;

  return query
  with signal_matches as (
    select f.lead_id,
      array_agg(distinct f.fingerprint_type) as signals
    from public.sales_lead_dedup_fingerprints f
    join public.sales_leads l on l.id = f.lead_id and l.merged_into_lead_id is null
    where (p_place_id is not null and f.fingerprint_type = 'place_id' and f.fingerprint_value = p_place_id)
       or (p_phone is not null and f.fingerprint_type = 'phone' and f.fingerprint_value = p_phone)
       or (p_domain is not null and f.fingerprint_type = 'domain' and f.fingerprint_value = p_domain)
       or (p_email is not null and f.fingerprint_type = 'email' and f.fingerprint_value = p_email)
    group by f.lead_id
  ),
  name_city_matches as (
    select l.id as lead_id, array['name_address']::text[] as signals
    from public.sales_leads l
    where l.merged_into_lead_id is null
      and p_normalized_name is not null and l.normalized_name = p_normalized_name
      and p_city is not null and l.city = p_city
  ),
  combined as (
    select lead_id, signals from signal_matches
    union all
    select lead_id, signals from name_city_matches
  ),
  aggregated as (
    select lead_id, array_agg(distinct s) as all_signals
    from combined, unnest(signals) as s
    group by lead_id
  )
  select
    a.lead_id,
    case
      when 'place_id' = any(a.all_signals) then 'high'
      when ('phone' = any(a.all_signals) or 'domain' = any(a.all_signals)) and 'name_address' = any(a.all_signals) then 'high'
      when 'phone' = any(a.all_signals) or 'domain' = any(a.all_signals) or 'email' = any(a.all_signals) then 'medium'
      else 'low'
    end as confidence,
    a.all_signals as matched_signals
  from aggregated a;
end;
$$;

revoke all on function public.sales_find_duplicate_candidates(text, text, text, text, text, text, numeric, numeric) from public, anon;
grant execute on function public.sales_find_duplicate_candidates(text, text, text, text, text, text, numeric, numeric) to authenticated, service_role;

create or replace function public.sales_upsert_discovered_lead(
  p_source_key text,
  p_business_name text,
  p_business_type text default null,
  p_place_id text default null,
  p_website text default null,
  p_phone text default null,
  p_email text default null,
  p_country text default null,
  p_city text default null,
  p_area text default null,
  p_address text default null,
  p_lat numeric default null,
  p_lng numeric default null,
  p_rating numeric default null,
  p_review_count int default null
)
returns table(lead_id uuid, outcome text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_source_id uuid;
  v_normalized_name text;
  v_normalized_phone text;
  v_normalized_domain text;
  v_best_match record;
  v_lead_id uuid;
  v_outcome text;
begin
  if not (
    auth.uid() is null  -- service_role caller: no anon/authenticated grant exists, so reaching this point already proves trust
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.discover')
  ) then
    raise exception 'not authorized';
  end if;

  select id into v_source_id from public.sales_lead_sources where key = p_source_key and is_active = true;
  if v_source_id is null then
    raise exception 'unknown or inactive lead source: %', p_source_key;
  end if;

  v_normalized_name := public.sales_normalize_name(p_business_name);
  v_normalized_phone := public.sales_normalize_phone(p_phone);
  v_normalized_domain := public.sales_normalize_domain(p_website);

  select candidate_lead_id, confidence
    into v_best_match
  from public.sales_find_duplicate_candidates(
    p_place_id, v_normalized_phone, v_normalized_domain, p_email, v_normalized_name, p_city, p_lat, p_lng
  )
  order by case confidence when 'high' then 1 when 'medium' then 2 else 3 end
  limit 1;

  if v_best_match.confidence = 'high' then
    -- Attach evidence to the existing canonical lead; do not create a duplicate row.
    v_lead_id := v_best_match.candidate_lead_id;
    v_outcome := 'duplicate_merged';

    update public.sales_leads
    set last_verified_at = now(),
        rating = coalesce(p_rating, rating),
        review_count = coalesce(p_review_count, review_count),
        updated_at = now()
    where id = v_lead_id;
  else
    -- New canonical lead (even at medium/low confidence -- ambiguous matches
    -- go to human review via sales_possible_duplicates, never silent auto-merge).
    insert into public.sales_leads (
      business_name, normalized_name, business_type, country, city, area, address,
      latitude, longitude, website, public_phone, public_email, rating, review_count,
      source_place_id, primary_source_id, dedup_fingerprint, data_confidence, created_by
    ) values (
      p_business_name, v_normalized_name, p_business_type, p_country, p_city, p_area, p_address,
      p_lat, p_lng, p_website, p_phone, p_email, p_rating, p_review_count,
      p_place_id, v_source_id,
      coalesce(p_place_id, v_normalized_domain, v_normalized_phone, v_normalized_name || '|' || coalesce(p_city, '')),
      case when p_place_id is not null then 'high' when p_website is not null or p_phone is not null then 'medium' else 'low' end,
      auth.uid()
    )
    returning id into v_lead_id;

    v_outcome := case when v_best_match.confidence is not null then 'new_possible_duplicate' else 'new' end;

    if p_place_id is not null then
      insert into public.sales_lead_dedup_fingerprints (lead_id, fingerprint_type, fingerprint_value) values (v_lead_id, 'place_id', p_place_id);
    end if;
    if v_normalized_phone is not null then
      insert into public.sales_lead_dedup_fingerprints (lead_id, fingerprint_type, fingerprint_value) values (v_lead_id, 'phone', v_normalized_phone);
    end if;
    if v_normalized_domain is not null then
      insert into public.sales_lead_dedup_fingerprints (lead_id, fingerprint_type, fingerprint_value) values (v_lead_id, 'domain', v_normalized_domain);
    end if;
    if p_email is not null then
      insert into public.sales_lead_dedup_fingerprints (lead_id, fingerprint_type, fingerprint_value) values (v_lead_id, 'email', p_email);
    end if;
    insert into public.sales_lead_dedup_fingerprints (lead_id, fingerprint_type, fingerprint_value)
      values (v_lead_id, 'name_address', v_normalized_name || '|' || coalesce(p_city, ''));

    if v_best_match.confidence in ('medium', 'low') then
      insert into public.sales_possible_duplicates (lead_id_a, lead_id_b, confidence, match_signals)
      values (v_lead_id, v_best_match.candidate_lead_id, v_best_match.confidence, '{}'::jsonb)
      on conflict do nothing;
    end if;

    insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
    values (v_lead_id, 'discovered', jsonb_build_object('source', p_source_key), auth.uid());
  end if;

  return query select v_lead_id, v_outcome;
end;
$$;

revoke all on function public.sales_upsert_discovered_lead(text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, numeric, int) from public, anon;
grant execute on function public.sales_upsert_discovered_lead(text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, numeric, int) to authenticated, service_role;
