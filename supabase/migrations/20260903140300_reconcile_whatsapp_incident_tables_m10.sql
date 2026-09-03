-- Production Audit Remediation, M-10 (2026-09-03): whatsapp_delivery_traces,
-- whatsapp_incidents, and whatsapp_root_cause_codes exist live and are
-- FORCE ROW LEVEL SECURITY'd by 20260824230100_force_rls_remaining_tables.sql
-- (that migration's own comment attributes their creation to migration
-- "20260821010000", but the file that actually occupies that timestamp is
-- 20260821010000_staff_360_fix_existing_rpc_gaps.sql -- an unrelated RPC
-- migration that never mentions these tables). No CREATE TABLE, ENABLE/
-- FORCE ROW LEVEL SECURITY, or CREATE POLICY for these three tables exists
-- anywhere in supabase/migrations/*.sql. A fresh migration-only rebuild
-- would not recreate them at all, and their RLS predicates were previously
-- unverifiable from source control.
--
-- This migration is reconciliation, not redesign: every definition below
-- was pulled directly from the live gxkrtlvpjwxhcqdisyob project via
-- information_schema.columns, pg_constraint, pg_policies,
-- information_schema.role_table_grants, and pg_indexes, and is written
-- idempotently (IF NOT EXISTS / DROP POLICY IF EXISTS + CREATE) purely so
-- source control matches already-live reality.
--
-- Live isolation was independently verified (rollback-wrapped, run against
-- current live state before this migration existed) before writing this
-- file: as authenticated staff of a club NOT a member of club
-- b9178c0f-00b5-4c71-abec-b8772ffb8682 ("Test", which holds 4 real
-- whatsapp_incidents rows and 124 real whatsapp_delivery_traces rows),
-- SELECT against both tables returned 0 rows -- both scoped to that
-- club_id and completely unfiltered. The same club's own owner correctly
-- saw all 4 / 124 rows in the same test. So a real club_id-scoped policy
-- (matching the whatsapp_connection_events pattern in
-- 20260816310000_whatsapp_connection_model.sql) was ALREADY live and
-- ALREADY correct -- this is NOT a newly-discovered isolation gap, and no
-- new policy logic is introduced here beyond what pg_policies already
-- showed live. whatsapp_root_cause_codes has no club_id column and no
-- tenant data (it's a small shared reference table of 28 rows: code,
-- layer, severity, bilingual explanation) -- its single
-- authenticated-only SELECT policy is correct as-is.
--
-- Grants: unlike whatsapp_connection_events (which has default
-- anon/authenticated/service_role table-level DML grants, gated purely by
-- RLS), these three tables carry NO explicit anon/authenticated/
-- service_role grants live -- all writes happen through the SECURITY
-- DEFINER functions whatsapp_connector_upsert_incident() and
-- whatsapp_connector_write_delivery_trace() (both owned by postgres, from
-- 20260821180000_independent_audit_reconciliation.sql), which do not need
-- caller grants. That is a stricter posture than the schema's baseline, so
-- it is preserved as-is rather than widened to match the baseline.

-- ============================================================
-- whatsapp_root_cause_codes: shared reference table (no club_id / no
-- tenant scoping -- referenced by whatsapp_incidents.root_cause_code and
-- whatsapp_delivery_traces.root_cause_code via FK).
-- ============================================================
create table if not exists public.whatsapp_root_cause_codes (
  code text primary key,
  layer text not null,
  severity text not null check (severity in ('info', 'warning', 'high', 'critical')),
  explanation_ar text not null,
  explanation_en text not null
);

alter table public.whatsapp_root_cause_codes enable row level security;
alter table public.whatsapp_root_cause_codes force row level security;

drop policy if exists "whatsapp_root_cause_codes_authenticated_select" on public.whatsapp_root_cause_codes;
create policy "whatsapp_root_cause_codes_authenticated_select" on public.whatsapp_root_cause_codes
  for select using (auth.role() = 'authenticated');

comment on table public.whatsapp_root_cause_codes is
  'Production audit remediation (M-10 reconciliation): shared, non-tenant reference table of known WhatsApp delivery-failure root-cause codes (layer/severity/bilingual explanation). Readable by any authenticated user -- no club_id column, nothing tenant-specific to scope. Reconstructed from live schema; originally created outside migration history (attributed by 20260824230100_force_rls_remaining_tables.sql to a "20260821010000" migration that does not actually contain it).';

-- ============================================================
-- whatsapp_incidents: per-club incident log (detected outages / failure
-- clusters), club_id-scoped.
-- ============================================================
create table if not exists public.whatsapp_incidents (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  severity text not null check (severity in ('info', 'warning', 'high', 'critical')),
  root_cause_code text references public.whatsapp_root_cause_codes(code),
  root_cause_confidence text check (root_cause_confidence in ('high', 'medium', 'low', 'unproven')),
  status text not null default 'active' check (status in ('active', 'recovering', 'resolved')),
  started_at timestamptz not null default now(),
  resolved_at timestamptz,
  affected_message_count integer not null default 0,
  affected_duration_seconds integer,
  automatic_recovery_performed boolean not null default false,
  automatic_recovery_detail text,
  manual_action_required boolean not null default false,
  fix_applied text,
  first_successful_send_after_fix_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists whatsapp_incidents_club_id_idx on public.whatsapp_incidents (club_id, started_at desc);
create index if not exists whatsapp_incidents_active_idx on public.whatsapp_incidents (club_id) where (status <> 'resolved');

alter table public.whatsapp_incidents enable row level security;
alter table public.whatsapp_incidents force row level security;

drop policy if exists "whatsapp_incidents_club_staff_select" on public.whatsapp_incidents;
create policy "whatsapp_incidents_club_staff_select" on public.whatsapp_incidents
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('manage_whatsapp_connection', club_id)
  );

drop policy if exists "whatsapp_incidents_platform_owner_select" on public.whatsapp_incidents;
create policy "whatsapp_incidents_platform_owner_select" on public.whatsapp_incidents
  for select using (public.is_platform_owner());

comment on table public.whatsapp_incidents is
  'Production audit remediation (M-10 reconciliation): per-club WhatsApp delivery incident log (detected outages / failure clusters), written only via SECURITY DEFINER reconciliation functions (no direct anon/authenticated/service_role grants live). club_id-scoped SELECT matches the whatsapp_connection_events pattern from 20260816310000_whatsapp_connection_model.sql. Cross-club isolation independently verified live before this migration existed: a staff member of a different club saw 0 rows querying this club''s incidents, while that club''s own owner correctly saw all of them. Reconstructed from live schema; originally created outside migration history.';

-- ============================================================
-- whatsapp_delivery_traces: per-attempt delivery diagnostics, club_id-scoped.
-- ============================================================
create table if not exists public.whatsapp_delivery_traces (
  id uuid primary key default gen_random_uuid(),
  trace_id uuid not null default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  notification_queue_id uuid references public.notification_queue(id) on delete set null,
  attempt_number integer not null default 1,
  template_key text not null,
  media_type text,
  media_intent text,
  socket_generation integer,
  container_instance_id text,
  stage_timeline jsonb not null default '[]'::jsonb,
  last_stage_reached text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  elapsed_ms integer,
  outcome text check (outcome in ('success', 'failed', 'timed_out', 'unknown')),
  root_cause_code text,
  root_cause_confidence text check (root_cause_confidence in ('high', 'medium', 'low', 'unproven')),
  error_summary text,
  has_provider_reference boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists whatsapp_delivery_traces_club_id_idx on public.whatsapp_delivery_traces (club_id, created_at desc);
create index if not exists whatsapp_delivery_traces_notification_queue_id_idx on public.whatsapp_delivery_traces (notification_queue_id);
create index if not exists whatsapp_delivery_traces_trace_id_idx on public.whatsapp_delivery_traces (trace_id);
create index if not exists whatsapp_delivery_traces_root_cause_idx on public.whatsapp_delivery_traces (root_cause_code) where (root_cause_code is not null);

alter table public.whatsapp_delivery_traces enable row level security;
alter table public.whatsapp_delivery_traces force row level security;

drop policy if exists "whatsapp_delivery_traces_club_staff_select" on public.whatsapp_delivery_traces;
create policy "whatsapp_delivery_traces_club_staff_select" on public.whatsapp_delivery_traces
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('manage_whatsapp_connection', club_id)
  );

drop policy if exists "whatsapp_delivery_traces_platform_owner_select" on public.whatsapp_delivery_traces;
create policy "whatsapp_delivery_traces_platform_owner_select" on public.whatsapp_delivery_traces
  for select using (public.is_platform_owner());

comment on table public.whatsapp_delivery_traces is
  'Production audit remediation (M-10 reconciliation): per-attempt WhatsApp delivery diagnostic trace (stage timeline, outcome, root cause), written only via SECURITY DEFINER reconciliation functions (no direct anon/authenticated/service_role grants live). club_id-scoped SELECT matches the whatsapp_connection_events pattern from 20260816310000_whatsapp_connection_model.sql. Cross-club isolation independently verified live before this migration existed: a staff member of a different club saw 0 rows querying this club''s traces, while that club''s own owner correctly saw all of them. Reconstructed from live schema; originally created outside migration history.';
