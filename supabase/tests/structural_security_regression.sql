-- MAL3ABY -- Structural security/finance regression suite.
--
-- Extracted from supabase/tests/security_finance_regression.sql (2026-09-03,
-- finding M-13: "safety-critical claims are proven once, manually, never
-- re-verified automatically"). That file is real and substantive but every
-- assertion in it needs either a live RLS-authenticated session impersonating
-- a REAL fixture user (SET ROLE authenticated + set_config('request.jwt.claims',
-- ...) against a real auth.users row) or hand-filled real fixture UUIDs from
-- the live project -- neither of which a fresh CI database has, so the whole
-- file could not be wired into CI as-is.
--
-- This file contains ONLY the subset of that suite that needs neither: pure
-- schema-shape assertions against pg_catalog/information_schema (structural
-- constraint presence, RLS FORCE coverage, protective trigger presence,
-- function grant-layer scoping, audit-log coverage-gap detection). Every
-- assertion here is self-contained and requires zero fixture data -- it only
-- needs the migrations applied. It is the direct SQL-level counterpart of
-- this project's own vitest unit-test convention (see .github/workflows/ci.yml):
-- runs with zero secrets, fails the build for real on a genuine regression,
-- never soft-skips.
--
-- WHY THIS IS A SEPARATE FILE, NOT AN EDIT TO THE ORIGINAL: the original
-- file's identity-impersonation tests (cross-tenant isolation, privilege
-- escalation, payment idempotency, etc.) are real and valuable but
-- structurally cannot run against a fresh database with no fixture data --
-- see docs/TEST_PLAN.md's "CI regression gap" section for exactly what
-- blocks them and what would close that gap. Splitting the file avoids
-- quietly deleting or diluting the original's documented manual-verification
-- record.
--
-- FORMAT: unlike the original (which relies on SELECT-and-eyeball because
-- SET ROLE cannot reliably run inside a DO block), everything here IS safe
-- to wrap in RAISE EXCEPTION -- no role switching, so ordinary DO blocks work
-- correctly. Every check RAISEs a real exception on failure so this script's
-- exit code is a genuine pass/fail signal suitable for a CI gate (run via
-- `psql ... -v ON_ERROR_STOP=1 -f supabase/tests/structural_security_regression.sql`).
--
-- HOW TO RUN LOCALLY: `supabase start` (fresh instance, migrations + seed.sql
-- applied automatically), then:
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2 | tr -d '\"')" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/structural_security_regression.sql
--
-- CI STATUS (2026-09-03): NOT currently wired as a CI job. Blocked upstream
-- -- `supabase db reset` itself does not complete on a genuinely fresh
-- database today because at least 8 historical migrations hard-depend on a
-- real auth.users row for moustafa.elsafy2@gmail.com that only exists via a
-- real signup on the live remote project (20260815380000_seed_platform_owner.sql
-- and 20260816070000_seed_qa_dataset.sql both RAISE EXCEPTION when that row is
-- absent; several more silently violate FK/NOT NULL constraints on the same
-- missing user). This is a pre-existing gap in the migration history, not
-- something introduced by this file -- see docs/TEST_PLAN.md's "CI regression
-- gap" section for the full explanation, the exact migration list, and what
-- would be needed to close it. This file is verified correct by having every
-- query in it run successfully, read-only, against the real live project
-- (via the Supabase MCP execute_sql tool) during this pass -- all 7 checks
-- passed clean -- but that is a one-time manual proof, not a standing CI
-- guarantee, until the migration-history blocker above is fixed.

do $$
begin
  raise notice 'structural_security_regression.sql: starting -- 7 checks, zero fixture data required';
end $$;

-- ============================================================
-- CHECK 1 (orig TEST 6): double booking exclusion constraint presence.
-- ============================================================
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.bookings'::regclass and contype = 'x'
      and conname = 'no_overlapping_field_bookings'
  ) then
    raise exception 'REGRESSION: no_overlapping_field_bookings exclusion constraint missing from public.bookings';
  end if;
  raise notice 'CHECK 1 PASS: double-booking exclusion constraint present';
end $$;

-- ============================================================
-- CHECK 2 (orig TEST 7 / 7b): FORCE RLS coverage -- every table with RLS
-- enabled must also have it FORCEd (so table owners/superuser-run
-- SECURITY DEFINER functions can't accidentally bypass it).
-- ============================================================
do $$
declare
  v_count int;
  v_names text;
begin
  select count(*), string_agg(c.relname, ', ')
  into v_count, v_names
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relrowsecurity = true and c.relforcerowsecurity = false;

  if v_count > 0 then
    raise exception 'REGRESSION: % table(s) have RLS enabled but not FORCEd: %', v_count, v_names;
  end if;
  raise notice 'CHECK 2 PASS: 0 tables with RLS enabled but not forced';
end $$;

-- ============================================================
-- CHECK 3 (orig TEST 8): protected identity-column triggers installed on
-- every tenant-scoped table that must have one.
-- ============================================================
do $$
declare
  v_count int;
  v_expected int := 10;
begin
  select count(*) into v_count
  from information_schema.triggers
  where trigger_name in (
    'trg_protect_club_membership_identity_columns',
    'trg_protect_tenant_id_bookings', 'trg_protect_tenant_id_customers',
    'trg_protect_tenant_id_payments', 'trg_protect_tenant_id_invoices',
    'trg_protect_tenant_id_players', 'trg_protect_tenant_id_subscriptions',
    'trg_protect_tenant_id_enrollments', 'trg_protect_tenant_id_fields',
    'trg_protect_tenant_id_branches'
  );

  if v_count <> v_expected then
    raise exception 'REGRESSION: expected % identity-protection triggers, found %', v_expected, v_count;
  end if;
  raise notice 'CHECK 3 PASS: all % identity-protection triggers present', v_expected;
end $$;

-- ============================================================
-- CHECK 4 (orig TEST 7b): named regression guard for the 8 tables
-- specifically found missing FORCE in the 2026-08-24 remediation pass --
-- names the offending table if this ever regresses, rather than just a
-- count from CHECK 2.
-- ============================================================
do $$
declare
  v_names text;
begin
  select string_agg(c.relname, ', ') into v_names
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and c.relrowsecurity = true and c.relforcerowsecurity = false
    and c.relname in (
      'employee_cash_liabilities', 'employee_cash_liability_ledger',
      'employee_cash_liability_settlement_keys',
      'government_collection_policies', 'official_collection_receipts',
      'whatsapp_delivery_traces', 'whatsapp_incidents',
      'whatsapp_root_cause_codes'
    );

  if v_names is not null then
    raise exception 'REGRESSION: previously-fixed FORCE RLS gap reopened on: %', v_names;
  end if;
  raise notice 'CHECK 4 PASS: none of the 8 previously-fixed tables have regressed';
end $$;

-- ============================================================
-- CHECK 5 (orig TEST 11 static half): grant-layer backstop on staff-only
-- RPCs whose signature changed via CREATE OR REPLACE -- catches a future
-- signature-changing migration silently re-widening EXECUTE to anon/PUBLIC.
-- (The live-role reproduction half of orig TEST 11, which actually calls
-- qr_validate as anon, needs a real anon session and stays in the original
-- file -- this is the schema-only half.)
-- ============================================================
do $$
declare
  v_sig text;
begin
  select p.oid::regprocedure::text into v_sig
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('qr_validate', 'qr_confirm_checkin', 'create_booking', 'get_official_receipts_report')
    and (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      or exists (
        select 1 from unnest(p.proacl) a
        where a::text like '=%/%'
      )
    )
  limit 1;

  if v_sig is not null then
    raise exception 'REGRESSION: % is EXECUTE-able by anon/PUBLIC at the grant layer', v_sig;
  end if;
  raise notice 'CHECK 5 PASS: qr_validate/qr_confirm_checkin/create_booking/get_official_receipts_report all correctly grant-scoped';
end $$;

-- ============================================================
-- CHECK 6 (orig AF-TEST 10c): verify_audit_log_chain() must be
-- service_role-only, never callable by authenticated or anon.
-- ============================================================
do $$
declare
  v_auth boolean;
  v_anon boolean;
begin
  select
    has_function_privilege('authenticated', 'public.verify_audit_log_chain(bigint, bigint)', 'execute'),
    has_function_privilege('anon', 'public.verify_audit_log_chain(bigint, bigint)', 'execute')
  into v_auth, v_anon;

  if v_auth or v_anon then
    raise exception 'REGRESSION: verify_audit_log_chain() is client-reachable (authenticated=%, anon=%)', v_auth, v_anon;
  end if;
  raise notice 'CHECK 6 PASS: verify_audit_log_chain() is service_role-only';
end $$;

-- ============================================================
-- CHECK 7 (orig AF-TEST 11): audit-log coverage gap detector -- any
-- SECURITY DEFINER function that writes to a financially/compliance-
-- sensitive table without ever calling write_audit_log() (or a direct
-- audit_logs insert) shows up here. Explicit, commented exclusion list
-- for functions already reviewed and judged genuinely low-materiality.
-- ============================================================
do $$
declare
  v_names text;
begin
  select string_agg(p.proname, ', ') into v_names
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef = true
    and (
      p.prosrc ilike '%insert into public.payments%'
      or p.prosrc ilike '%insert into public.refunds%'
      or p.prosrc ilike '%insert into public.invoices%'
      or p.prosrc ilike '%insert into public.subscriptions%'
      or p.prosrc ilike '%insert into public.shop_sales%'
      or p.prosrc ilike '%insert into public.club_membership_subscriptions%'
      or p.prosrc ilike '%insert into public.bookings%'
      or p.prosrc ilike '%insert into public.enrollments%'
      or p.prosrc ilike '%insert into public.official_collection_receipts%'
      or p.prosrc ilike '%insert into public.clubs%'
      or p.prosrc ilike '%update public.payments%'
      or p.prosrc ilike '%update public.refunds%'
      or p.prosrc ilike '%update public.invoices%'
      or p.prosrc ilike '%update public.subscriptions%'
      or p.prosrc ilike '%update public.club_membership_subscriptions%'
      or p.prosrc ilike '%update public.bookings%'
      or p.prosrc ilike '%update public.enrollments%'
    )
    and p.prosrc not ilike '%write_audit_log%'
    and p.prosrc not ilike '%insert into public.audit_logs%'
    and p.proname not like '\_%'
    -- Reviewed and confirmed genuinely low-materiality, not a coverage
    -- gap: get_or_create_shop_walk_in_customer() (a single placeholder
    -- row, zero financial/permission value) and upsert_customer() (plain
    -- name/phone/email edits -- logging every call would be noise, not
    -- signal; customer.phone_changed already exists as a separate,
    -- targeted audit path for the specifically sensitive case).
    -- expire_due_academy_subscriptions() is excluded too -- it DOES write
    -- an aggregate audit_logs row per run via a direct INSERT (the
    -- 'insert into public.audit_logs' exclusion above already covers it).
    and p.proname not in ('get_or_create_shop_walk_in_customer', 'upsert_customer')
  ;

  if v_names is not null then
    raise exception 'REGRESSION: new audit-log coverage gap(s) introduced in: % -- inspect and either add write_audit_log() or add a reviewed, commented exclusion above', v_names;
  end if;
  raise notice 'CHECK 7 PASS: no unaudited SECURITY DEFINER writes to financially/compliance-sensitive tables';
end $$;

do $$
begin
  raise notice 'structural_security_regression.sql: ALL 7 CHECKS PASSED';
end $$;
