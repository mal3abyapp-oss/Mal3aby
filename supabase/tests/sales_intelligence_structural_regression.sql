-- MAL3ABY -- Sales Intelligence structural regression suite (ADR-054,
-- Phase 22, 2026-09-04).
--
-- Mirrors structural_security_regression.sql's own convention exactly:
-- pure schema-shape assertions against pg_catalog/information_schema,
-- zero fixture data required, every check RAISEs a real exception on
-- failure so this file's exit code is a genuine CI-gate signal (same
-- CI-wiring blocker as the file it mirrors -- see docs/TEST_PLAN.md's
-- "CI regression gap" section; this file has the identical status: run
-- and verified once, live, against the real project via the Supabase
-- MCP execute_sql tool, not yet a standing CI job).
--
-- HOW TO RUN LOCALLY: `supabase start`, then:
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/sales_intelligence_structural_regression.sql

do $$
begin
  raise notice 'sales_intelligence_structural_regression.sql: starting -- 10 checks, zero fixture data required';
end $$;

-- ============================================================
-- CHECK 1: every sales_* table has RLS enabled AND forced (ADR-054's
-- core isolation requirement -- FORCE RLS blocks even the table owner).
-- ============================================================
do $$
declare
  v_table text;
  v_missing text[] := '{}';
begin
  foreach v_table in array array[
    'sales_lead_sources', 'sales_leads', 'sales_lead_contacts', 'sales_lead_locations',
    'sales_lead_social_links', 'sales_lead_dedup_fingerprints', 'sales_possible_duplicates',
    'sales_lead_enrichment_runs', 'sales_lead_signals', 'sales_lead_scores', 'sales_lead_notes',
    'sales_lead_activities', 'sales_lead_status_history', 'sales_campaigns', 'sales_campaign_leads',
    'sales_outreach_messages', 'sales_followups', 'sales_demo_events', 'sales_conversion_records',
    'sales_discovery_jobs', 'sales_quota_usage', 'sales_provider_configs', 'sales_tenant_activation_invites'
  ]
  loop
    if not exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table
        and c.relrowsecurity = true and c.relforcerowsecurity = true
    ) then
      v_missing := array_append(v_missing, v_table);
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'REGRESSION: sales_* tables missing RLS enabled+forced: %', v_missing;
  end if;
  raise notice 'CHECK 1 PASS: all 23 sales_* tables have RLS enabled + forced';
end $$;

-- ============================================================
-- CHECK 2: no sales_* table has any grant to anon or public (defense in
-- depth alongside FORCE RLS -- the explicit revoke loop in the RLS
-- migration must have actually taken effect).
-- ============================================================
do $$
declare
  v_leak_count int;
begin
  select count(*) into v_leak_count
  from information_schema.role_table_grants
  where table_schema = 'public'
    and table_name like 'sales\_%' escape '\'
    and grantee in ('anon', 'PUBLIC');

  if v_leak_count > 0 then
    raise exception 'REGRESSION: % grant(s) to anon/public found on sales_* tables', v_leak_count;
  end if;
  raise notice 'CHECK 2 PASS: zero anon/public grants on any sales_* table';
end $$;

-- ============================================================
-- CHECK 3: every platform.sales.* permission key exists, correctly
-- grouped (group_key = 'sales', matching the platform.<group>.<action>
-- convention -- ADR-054 explicitly rejected a bare sales.* prefix).
-- ============================================================
do $$
declare
  v_expected_count int := 12;
  v_actual_count int;
begin
  select count(*) into v_actual_count
  from public.platform_permissions
  where key like 'platform.sales.%' and group_key = 'sales';

  if v_actual_count <> v_expected_count then
    raise exception 'REGRESSION: expected % platform.sales.* permission keys with group_key=sales, found %', v_expected_count, v_actual_count;
  end if;
  raise notice 'CHECK 3 PASS: all % platform.sales.* permission keys present and correctly grouped', v_expected_count;
end $$;

-- ============================================================
-- CHECK 4: platform_owner role has every platform.sales.* permission
-- (via the existing cross-join seed pattern) OR the is_platform_owner()
-- bridge makes this moot -- verify at least the role-permission rows
-- exist, matching this codebase's own belt-and-suspenders convention.
-- ============================================================
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from public.platform_role_permissions prp
  join public.platform_roles r on r.id = prp.platform_role_id
  join public.platform_permissions p on p.id = prp.platform_permission_id
  where r.key = 'platform_owner' and p.key like 'platform.sales.%';

  if v_count <> 12 then
    raise exception 'REGRESSION: platform_owner role missing sales permission grants (found %, expected 12)', v_count;
  end if;
  raise notice 'CHECK 4 PASS: platform_owner role has all 12 platform.sales.* permission grants';
end $$;

-- ============================================================
-- CHECK 5: sales_leads_conversion_consistency CHECK constraint exists
-- (the invariant that 'won' status requires a real converted_club_id --
-- this is what makes sales_change_lead_status's won-guard necessary
-- and correct, not incidental).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales_leads'::regclass and contype = 'c'
      and conname = 'sales_leads_conversion_consistency'
  ) then
    raise exception 'REGRESSION: sales_leads_conversion_consistency CHECK constraint missing';
  end if;
  raise notice 'CHECK 5 PASS: sales_leads_conversion_consistency CHECK constraint present';
end $$;

-- ============================================================
-- CHECK 6: sales_leads_one_conversion_per_lead + sales_conversion_records'
-- two unique constraints together prevent duplicate conversion
-- (Phase 14's explicit "prevent duplicate conversion" requirement).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_indexes where indexname = 'sales_leads_one_conversion_per_lead' and tablename = 'sales_leads'
  ) then
    raise exception 'REGRESSION: sales_leads_one_conversion_per_lead unique index missing';
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.sales_conversion_records'::regclass
      and conname = 'sales_conversion_records_one_per_lead'
  ) then
    raise exception 'REGRESSION: sales_conversion_records_one_per_lead unique constraint missing';
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'public.sales_conversion_records'::regclass
      and conname = 'sales_conversion_records_one_per_club'
  ) then
    raise exception 'REGRESSION: sales_conversion_records_one_per_club unique constraint missing';
  end if;
  raise notice 'CHECK 6 PASS: all 3 duplicate-conversion-prevention constraints present';
end $$;

-- ============================================================
-- CHECK 7: no SECURITY DEFINER sales_* function has an unpinned
-- search_path (the exact defect class the earlier production audit
-- found zero instances of project-wide -- this check re-proves that
-- guarantee holds for every new function this module added).
-- ============================================================
do $$
declare
  v_bad_count int;
begin
  select count(*) into v_bad_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and (p.proname like 'sales\_%' escape '\' or p.proname like '%sales%')
    and p.prosecdef = true
    and not exists (
      select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%'
    );

  if v_bad_count > 0 then
    raise exception 'REGRESSION: % SECURITY DEFINER sales-related function(s) missing pinned search_path', v_bad_count;
  end if;
  raise notice 'CHECK 7 PASS: every SECURITY DEFINER sales-related function has a pinned search_path';
end $$;

-- ============================================================
-- CHECK 8: qr_confirm_checkin-class stale-overload check, applied
-- proactively to every sales_* function this module defined more than
-- once across migrations (M-9's follow-up finding: a signature change
-- via CREATE OR REPLACE with a different parameter list creates a NEW
-- overload rather than replacing the old one, silently leaving a stale,
-- unintended bypass path live). Verifies no sales_* function name has
-- more than one live overload.
-- ============================================================
do $$
declare
  v_dupe record;
  v_found boolean := false;
begin
  for v_dupe in
    select p.proname, count(*) as overload_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'sales\_%' escape '\'
    group by p.proname
    having count(*) > 1
  loop
    v_found := true;
    raise warning 'sales function % has % live overloads', v_dupe.proname, v_dupe.overload_count;
  end loop;

  if v_found then
    raise exception 'REGRESSION: one or more sales_* functions have multiple live overloads (stale-overload risk, see M-9 precedent)';
  end if;
  raise notice 'CHECK 8 PASS: no sales_* function has more than one live overload';
end $$;

-- ============================================================
-- CHECK 9: sales_check_and_increment_quota is genuinely row-locked
-- (Phase 18's quota-enforcement requirement -- the function body must
-- contain FOR UPDATE, not just an unlocked read-then-write, matching
-- the exact race-condition class the earlier production remediation
-- fixed for approve_payment_proof/reject_payment_proof).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sales_check_and_increment_quota'
      and pg_get_functiondef(p.oid) ilike '%for update%'
  ) then
    raise exception 'REGRESSION: sales_check_and_increment_quota is missing its FOR UPDATE row lock';
  end if;
  raise notice 'CHECK 9 PASS: sales_check_and_increment_quota is row-locked';
end $$;

-- ============================================================
-- CHECK 10: sales_queue_outreach_message structurally refuses any
-- channel other than 'email' (Phase 11's hard WhatsApp-cold-outreach
-- prohibition, enforced at the DB layer, not just UI convention).
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sales_queue_outreach_message'
      and pg_get_functiondef(p.oid) ilike '%<> ''email''%'
  ) then
    raise exception 'REGRESSION: sales_queue_outreach_message no longer appears to guard against non-email channels';
  end if;
  raise notice 'CHECK 10 PASS: sales_queue_outreach_message structurally refuses non-email channels';
end $$;

-- ============================================================
-- CHECK 11 (Phase 14): sales_tenant_activation_invites' token_hash and
-- secret_hash columns are never directly selectable by `authenticated`
-- -- the exact column-level-grant-from-day-one hardening this table was
-- deliberately built with (never needing the 20260824080000-style
-- retrofit portal_invites required).
-- ============================================================
do $$
declare
  v_leak_count int;
begin
  select count(*) into v_leak_count
  from information_schema.role_column_grants
  where table_schema = 'public' and table_name = 'sales_tenant_activation_invites'
    and grantee = 'authenticated' and column_name in ('token_hash', 'secret_hash');

  if v_leak_count > 0 then
    raise exception 'REGRESSION: token_hash/secret_hash are selectable by authenticated on sales_tenant_activation_invites (% grant(s))', v_leak_count;
  end if;
  raise notice 'CHECK 11 PASS: token_hash/secret_hash never granted to authenticated on sales_tenant_activation_invites';
end $$;

-- ============================================================
-- CHECK 12 (Phase 14): the partial-unique invariants that prevent
-- duplicate/parallel conversion at the invite layer.
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_indexes where indexname = 'idx_sales_tenant_activation_invites_one_pending_per_lead'
      and tablename = 'sales_tenant_activation_invites'
  ) then
    raise exception 'REGRESSION: idx_sales_tenant_activation_invites_one_pending_per_lead missing';
  end if;
  if not exists (
    select 1 from pg_indexes where indexname = 'idx_sales_tenant_activation_invites_one_consumed_per_lead'
      and tablename = 'sales_tenant_activation_invites'
  ) then
    raise exception 'REGRESSION: idx_sales_tenant_activation_invites_one_consumed_per_lead missing';
  end if;
  raise notice 'CHECK 12 PASS: one-pending / one-consumed per lead partial unique indexes both present';
end $$;

-- ============================================================
-- CHECK 13 (Phase 14): sales_leads_conversion_consistency now ties
-- converted_club_id/converted_at to status='tenant_activated'
-- specifically (not 'won') -- the DB-level enforcement of "status=WON
-- alone must NOT create a tenant".
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales_leads'::regclass and contype = 'c'
      and conname = 'sales_leads_conversion_consistency'
      and pg_get_constraintdef(oid) ilike '%tenant_activated%'
  ) then
    raise exception 'REGRESSION: sales_leads_conversion_consistency no longer references tenant_activated';
  end if;
  raise notice 'CHECK 13 PASS: sales_leads_conversion_consistency correctly gates on tenant_activated, not won';
end $$;

do $$
begin
  raise notice 'sales_intelligence_structural_regression.sql: ALL 13 CHECKS PASSED';
end $$;
