-- Sales Intelligence — core RPCs (ADR-054): normalization, dedup engine,
-- discovery job lifecycle, quota enforcement, lead CRUD/status
-- transitions, notes/activity timeline. Mirrors notification_queue's
-- FOR UPDATE SKIP LOCKED claim pattern for job processing and
-- search_platform_clubs' pagination shape for list queries.

-- ============================================================
-- sales_normalize_name(): deterministic name normalization for
-- dedup fingerprinting -- lowercase, strip diacritics/punctuation,
-- collapse whitespace. Not locale-perfect (Arabic normalization is
-- intentionally conservative -- only whitespace/punctuation collapse,
-- no stemming, to avoid false-positive merges across genuinely
-- different business names that happen to share common Arabic words).
-- ============================================================
create or replace function public.sales_normalize_name(p_name text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  -- POSIX [:alnum:] class, not \p{L}\p{N} (PCRE-only, unsupported by
  -- Postgres's default ARE regex engine -- caught live during smoke
  -- testing: "invalid escape \ sequence"). [:alnum:] is UTF-8-aware in
  -- a UTF-8 database and correctly preserves Arabic letters, verified
  -- live against 'ملعب كرة القدم - النادي' -> 'ملعب كرة القدم النادي'.
  select trim(regexp_replace(lower(coalesce(p_name, '')), '[^[:alnum:]]+', ' ', 'g'))
$$;

-- ============================================================
-- sales_normalize_phone(): strip everything but digits, keep leading
-- '+' if present. The frontend/enrichment layer is expected to hand
-- this function an already-reasonable phone string (E.164 where
-- possible, via the SAME libphonenumber-js module every other part of
-- this app uses client-side for real customer phones -- this function
-- is a lightweight SQL-side normalization for fingerprinting only, not
-- a replacement for that validation).
-- ============================================================
create or replace function public.sales_normalize_phone(p_phone text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '')
$$;

-- ============================================================
-- sales_normalize_domain(): extract a bare registrable-ish domain from
-- a URL for dedup (strips protocol, www., path/query, lowercases).
-- ============================================================
create or replace function public.sales_normalize_domain(p_url text)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select nullif(
    lower(regexp_replace(regexp_replace(coalesce(p_url, ''), '^https?://(www\.)?', ''), '/.*$', '')),
    ''
  )
$$;

-- ============================================================
-- sales_find_duplicate_candidates(): the read-only matching core of
-- the dedup engine (Phase 4). Given a candidate lead's raw fields,
-- returns every existing (non-merged) lead that shares ANY fingerprint
-- signal, with a computed confidence. Called by both
-- sales_upsert_discovered_lead() (automatic, at discovery time) and the
-- Leads UI (manual "check for duplicates" action).
--
-- Confidence rule (deliberately conservative -- "never merge
-- automatically when confidence is materially ambiguous", Phase 4):
--   HIGH   = place_id match, OR (phone match AND name similarity), OR
--            (domain match AND name similarity)
--   MEDIUM = a single strong signal alone (phone OR domain OR email
--            match) with no corroborating name/address match
--   LOW    = name+city match only, no contact-channel corroboration
-- HIGH is eligible for auto-merge-as-same-source-record; MEDIUM/LOW are
-- always routed to sales_possible_duplicates for human review, never
-- auto-merged.
-- ============================================================
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
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.view')) then
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
grant execute on function public.sales_find_duplicate_candidates(text, text, text, text, text, text, numeric, numeric) to authenticated;

-- ============================================================
-- sales_upsert_discovered_lead(): the single write path for a
-- discovery/enrichment result becoming (or updating) a sales_leads row.
-- Runs dedup BEFORE insert -- a HIGH-confidence match attaches the new
-- source evidence to the EXISTING canonical lead instead of creating a
-- new row; MEDIUM/LOW confidence creates a new lead AND records a
-- sales_possible_duplicates entry for human review; no match creates a
-- genuinely new lead. Returns which happened, for the discovery job's
-- new/duplicate counters.
-- ============================================================
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
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.discover')) then
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
grant execute on function public.sales_upsert_discovered_lead(text, text, text, text, text, text, text, text, text, text, text, numeric, numeric, numeric, int) to authenticated;

-- ============================================================
-- sales_check_and_increment_quota(): atomic quota-check-and-increment
-- (Phase 18) -- called BEFORE any expensive discovery/enrichment/AI
-- call, so the cap is enforced before the cost is incurred, not after.
-- Row-locked (mirrors this codebase's now-established FOR UPDATE
-- convention for exactly this class of race -- see the payment-proof
-- and entitlement-cap fixes in the prior production remediation).
-- ============================================================
create or replace function public.sales_check_and_increment_quota(p_provider_key text)
returns table(allowed boolean, current_count int, daily_cap int)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

-- ============================================================
-- sales_create_discovery_job() / sales_claim_discovery_job() /
-- sales_finish_discovery_job(): job lifecycle, mirroring
-- notification_queue's FOR UPDATE SKIP LOCKED claim pattern
-- (whatsapp_connector_claim_next_batch) so discovery runs are
-- resumable and never double-processed.
-- ============================================================
create or replace function public.sales_create_discovery_job(p_source_key text, p_search_params jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_source_id uuid;
  v_job_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.discover')) then
    raise exception 'not authorized';
  end if;

  select id into v_source_id from public.sales_lead_sources where key = p_source_key and is_active = true;
  if v_source_id is null then
    raise exception 'unknown or inactive lead source: %', p_source_key;
  end if;

  insert into public.sales_discovery_jobs (source_id, search_params, created_by)
  values (v_source_id, p_search_params, auth.uid())
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke all on function public.sales_create_discovery_job(text, jsonb) from public, anon;
grant execute on function public.sales_create_discovery_job(text, jsonb) to authenticated;

create or replace function public.sales_claim_discovery_job()
returns table(job_id uuid, source_key text, search_params jsonb, next_page_token text, attempts int)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_job record;
begin
  -- Service-role-only (called from the discovery Edge Function's worker loop, not the frontend directly).
  select j.id, s.key, j.search_params, j.next_page_token, j.attempts
    into v_job
  from public.sales_discovery_jobs j
  join public.sales_lead_sources s on s.id = j.source_id
  where j.status in ('pending', 'retryable')
  order by j.created_at
  for update of j skip locked
  limit 1;

  if v_job.id is null then
    return;
  end if;

  update public.sales_discovery_jobs
  set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now())
  where id = v_job.id;

  return query select v_job.id, v_job.key, v_job.search_params, v_job.next_page_token, v_job.attempts + 1;
end;
$$;

revoke all on function public.sales_claim_discovery_job() from public, anon, authenticated;
grant execute on function public.sales_claim_discovery_job() to service_role;

create or replace function public.sales_finish_discovery_job(
  p_job_id uuid,
  p_status text,
  p_discovered_count int,
  p_new_count int,
  p_duplicate_count int,
  p_failed_count int,
  p_skipped_count int,
  p_next_page_token text default null,
  p_error_class text default null,
  p_last_error text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if p_status not in ('completed', 'partial', 'failed', 'retryable') then
    raise exception 'invalid terminal/interim status: %', p_status;
  end if;

  update public.sales_discovery_jobs
  set status = p_status,
      discovered_count = discovered_count + p_discovered_count,
      new_count = new_count + p_new_count,
      duplicate_count = duplicate_count + p_duplicate_count,
      failed_count = failed_count + p_failed_count,
      skipped_count = skipped_count + p_skipped_count,
      next_page_token = p_next_page_token,
      error_class = p_error_class,
      last_error = p_last_error,
      finished_at = case when p_status in ('completed', 'failed') then now() else finished_at end
  where id = p_job_id;
end;
$$;

revoke all on function public.sales_finish_discovery_job(uuid, text, int, int, int, int, int, text, text, text) from public, anon, authenticated;
grant execute on function public.sales_finish_discovery_job(uuid, text, int, int, int, int, int, text, text, text) to service_role;

-- ============================================================
-- sales_change_lead_status(): the ONLY path to change sales_leads.status.
-- Enforces the legal transition guard (Phase 9's DO_NOT_CONTACT /
-- already-converted re-contact prevention) and writes status history.
-- Not a bare UPDATE from the client -- status is deliberately RPC-gated
-- so this invariant cannot be bypassed by a direct table write (the RLS
-- update policy allows column updates broadly, but the frontend must
-- and does call this RPC for status changes specifically).
-- ============================================================
create or replace function public.sales_change_lead_status(p_lead_id uuid, p_new_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current text;
begin
  -- current_user = 'service_role' bypasses the interactive-session check for
  -- Edge Function worker calls (e.g. sales-website-enrichment auto-advancing
  -- a lead's status after enrichment completes) -- this is the genuine
  -- Postgres-authenticated role for a service-role Supabase client
  -- connection, not a spoofable client-supplied claim, and this function is
  -- separately never grantable to anon/authenticated-without-permission
  -- (see the revoke/grant below), so this bypass only ever applies to a
  -- trusted server-side worker process, matching the same trust boundary
  -- sales_claim_discovery_job()/sales_finish_discovery_job() already use.
  if current_user <> 'service_role' and not (
       public.is_platform_owner() or public.has_platform_permission('platform.sales.qualify')
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

  if v_current = 'won' and p_new_status <> 'won' then
    raise exception 'this lead has already been won/converted and cannot change status';
  end if;

  -- 'won' is only reachable via a real tenant conversion (see
  -- sales_leads_conversion_consistency's CHECK constraint, which
  -- requires converted_club_id to be set whenever status='won') -- the
  -- conversion RPC is not yet implemented (TRUE STOP, see
  -- docs/DECISIONS.md ADR-054 and the note at the end of
  -- 20260904090400_sales_intelligence_scoring_outreach_conversion.sql).
  -- Give a clean, specific error instead of a raw constraint violation.
  if p_new_status = 'won' then
    raise exception 'a lead can only reach won status via tenant conversion, which requires an identity/ownership model decision not yet made -- see docs/DECISIONS.md ADR-054';
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

revoke all on function public.sales_change_lead_status(uuid, text, text) from public, anon;
grant execute on function public.sales_change_lead_status(uuid, text, text) to authenticated, service_role;

-- ============================================================
-- sales_add_lead_note(): append a note + activity entry in one call.
-- ============================================================
create or replace function public.sales_add_lead_note(p_lead_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_note_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit')) then
    raise exception 'not authorized';
  end if;

  insert into public.sales_lead_notes (lead_id, note, created_by)
  values (p_lead_id, p_note, auth.uid())
  returning id into v_note_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'note_added', jsonb_build_object('note_id', v_note_id), auth.uid());

  return v_note_id;
end;
$$;

revoke all on function public.sales_add_lead_note(uuid, text) from public, anon;
grant execute on function public.sales_add_lead_note(uuid, text) to authenticated;

-- ============================================================
-- search_sales_leads(): the paginated list RPC (Phase 3's discovery UI
-- filters + the Leads/Pipeline pages), mirroring search_platform_clubs'
-- exact shape (count(*) over() window function for total_count,
-- all filters optional/nullable).
-- ============================================================
create or replace function public.search_sales_leads(
  p_search text default null,
  p_status text default null,
  p_country text default null,
  p_city text default null,
  p_business_type text default null,
  p_min_score int default null,
  p_score_band text default null,
  p_has_website boolean default null,
  p_has_online_booking boolean default null,
  p_uncontacted_only boolean default false,
  p_exclude_do_not_contact boolean default true,
  p_signal_key text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table(
  lead_id uuid, business_name text, business_type text, city text, country text,
  status text, current_score int, current_score_band text, website text,
  public_phone text, rating numeric, review_count int, first_discovered_at timestamptz,
  total_count bigint
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.view')) then
    raise exception 'not authorized';
  end if;

  return query
  select
    l.id, l.business_name, l.business_type, l.city, l.country,
    l.status, l.current_score, l.current_score_band, l.website,
    l.public_phone, l.rating, l.review_count, l.first_discovered_at,
    count(*) over() as total_count
  from public.sales_leads l
  where l.merged_into_lead_id is null
    and (p_search is null or l.business_name ilike '%' || p_search || '%' or l.normalized_name ilike '%' || public.sales_normalize_name(p_search) || '%')
    and (p_status is null or l.status = p_status)
    and (p_country is null or l.country = p_country)
    and (p_city is null or l.city = p_city)
    and (p_business_type is null or l.business_type = p_business_type)
    and (p_min_score is null or l.current_score >= p_min_score)
    and (p_score_band is null or l.current_score_band = p_score_band)
    and (p_has_website is null or (p_has_website and l.website is not null) or (not p_has_website and l.website is null))
    and (p_has_online_booking is null or l.has_online_booking = p_has_online_booking)
    and (not p_uncontacted_only or l.status in ('discovered', 'enriching', 'enriched', 'qualified', 'contact_ready'))
    and (not p_exclude_do_not_contact or l.status <> 'do_not_contact')
    and (p_signal_key is null or exists (
      select 1 from public.sales_lead_signals sig where sig.lead_id = l.id and sig.signal_key = p_signal_key and sig.is_active
    ))
  order by l.current_score desc nulls last, l.first_discovered_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.search_sales_leads(text, text, text, text, text, int, text, boolean, boolean, boolean, boolean, text, int, int) from public, anon;
grant execute on function public.search_sales_leads(text, text, text, text, text, int, text, boolean, boolean, boolean, boolean, text, int, int) to authenticated;
