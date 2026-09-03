-- Sales Intelligence — RLS, platform permission keys, and grants
-- (ADR-054, 2026-09-04, Phases 15/16).
--
-- Every sales_* table: enable + FORCE row level security, single
-- read/write policy gated on is_platform_owner() OR
-- has_platform_permission('platform.sales.<action>') as appropriate,
-- zero anon/authenticated-unconditional grants. This mirrors
-- platform_staff_memberships' policy shape exactly (the recon-confirmed
-- cleanest platform-owned-data template in this codebase).

-- ============================================================
-- New platform permission keys, group_key = 'sales' (existing
-- platform.<group>.<action> convention -- see 20260826121055).
-- ============================================================
insert into public.platform_permissions (key, group_key) values
  ('platform.sales.view', 'sales'),
  ('platform.sales.discover', 'sales'),
  ('platform.sales.enrich', 'sales'),
  ('platform.sales.edit', 'sales'),
  ('platform.sales.qualify', 'sales'),
  ('platform.sales.generate_offer', 'sales'),
  ('platform.sales.approve_outreach', 'sales'),
  ('platform.sales.send_outreach', 'sales'),
  ('platform.sales.manage_campaigns', 'sales'),
  ('platform.sales.manage_followups', 'sales'),
  ('platform.sales.convert_to_tenant', 'sales'),
  ('platform.sales.manage_settings', 'sales');

-- CORRECTION (found by this module's own structural regression test,
-- CHECK 4, live-run 2026-09-04): the original text here claimed
-- platform_owner "already gets every permission via the existing
-- cross-join seed in 20260826121055" and needed no further seed. That
-- is wrong -- that seed ran ONCE, at that migration's own time; it does
-- not retroactively cross-join platform_owner against permission keys
-- inserted by LATER migrations, including these 12. This was
-- functionally safe regardless (is_platform_owner() unconditionally
-- bypasses has_platform_permission()'s role-permission-row check, so no
-- authorization gap existed), but the ORIGINAL seed's own stated intent
-- for giving platform_owner explicit rows -- "so the Role Editor's own
-- read screens show a complete, honest picture rather than an empty set
-- for this row" -- was broken for these 12 keys until the explicit
-- cross-join below was added. platform_admin gets full sales access
-- (mirrors its existing broad-but-not-total grant shape); platform_support
-- gets view-only (mirrors its existing narrow read-only grant shape).
insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r cross join public.platform_permissions p
where r.key = 'platform_owner' and p.key like 'platform.sales.%';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key in (
    'platform.sales.view', 'platform.sales.discover', 'platform.sales.enrich',
    'platform.sales.edit', 'platform.sales.qualify', 'platform.sales.generate_offer',
    'platform.sales.approve_outreach', 'platform.sales.send_outreach',
    'platform.sales.manage_campaigns', 'platform.sales.manage_followups',
    'platform.sales.convert_to_tenant', 'platform.sales.manage_settings'
  )
where r.key = 'platform_admin';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key = 'platform.sales.view'
where r.key = 'platform_support';

-- ============================================================
-- RLS: uniform pattern across every sales_* table. Read = platform.sales.view;
-- write = the specific action permission relevant to that table, always
-- with is_platform_owner() as an unconditional OR (never a separate
-- bypass path -- matches the existing platform_staff_memberships shape).
-- ============================================================

alter table public.sales_lead_sources enable row level security;
alter table public.sales_lead_sources force row level security;
create policy sales_lead_sources_select on public.sales_lead_sources
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_lead_sources_write on public.sales_lead_sources
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_settings'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_settings'));

alter table public.sales_leads enable row level security;
alter table public.sales_leads force row level security;
create policy sales_leads_select on public.sales_leads
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_leads_insert on public.sales_leads
  for insert with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.discover'));
create policy sales_leads_update on public.sales_leads
  for update using (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'));
-- No delete policy -- leads are never hard-deleted (status='lost'/'do_not_contact' instead), matching this
-- codebase's general append-only-history convention for anything with a status lifecycle.

alter table public.sales_lead_contacts enable row level security;
alter table public.sales_lead_contacts force row level security;
create policy sales_lead_contacts_select on public.sales_lead_contacts
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_lead_contacts_write on public.sales_lead_contacts
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'));

alter table public.sales_lead_locations enable row level security;
alter table public.sales_lead_locations force row level security;
create policy sales_lead_locations_select on public.sales_lead_locations
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_lead_locations_write on public.sales_lead_locations
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'));

alter table public.sales_lead_social_links enable row level security;
alter table public.sales_lead_social_links force row level security;
create policy sales_lead_social_links_select on public.sales_lead_social_links
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_lead_social_links_write on public.sales_lead_social_links
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'));

alter table public.sales_lead_dedup_fingerprints enable row level security;
alter table public.sales_lead_dedup_fingerprints force row level security;
create policy sales_lead_dedup_fingerprints_select on public.sales_lead_dedup_fingerprints
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via SECURITY DEFINER RPCs (dedup engine), no client write policy at all.

alter table public.sales_possible_duplicates enable row level security;
alter table public.sales_possible_duplicates force row level security;
create policy sales_possible_duplicates_select on public.sales_possible_duplicates
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_possible_duplicates_update on public.sales_possible_duplicates
  for update using (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'));
-- Inserts only via SECURITY DEFINER dedup engine RPC, no client insert policy.

alter table public.sales_lead_enrichment_runs enable row level security;
alter table public.sales_lead_enrichment_runs force row level security;
create policy sales_lead_enrichment_runs_select on public.sales_lead_enrichment_runs
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via SECURITY DEFINER job-processing RPCs.

alter table public.sales_lead_signals enable row level security;
alter table public.sales_lead_signals force row level security;
create policy sales_lead_signals_select on public.sales_lead_signals
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via SECURITY DEFINER enrichment RPCs (evidence-backed signals must be system-computed, not hand-typed).

alter table public.sales_lead_scores enable row level security;
alter table public.sales_lead_scores force row level security;
create policy sales_lead_scores_select on public.sales_lead_scores
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via SECURITY DEFINER scoring RPC.

alter table public.sales_lead_notes enable row level security;
alter table public.sales_lead_notes force row level security;
create policy sales_lead_notes_select on public.sales_lead_notes
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_lead_notes_insert on public.sales_lead_notes
  for insert with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit'));
-- No update/delete -- notes are append-only, matching audit_logs' own immutability convention.

alter table public.sales_lead_activities enable row level security;
alter table public.sales_lead_activities force row level security;
create policy sales_lead_activities_select on public.sales_lead_activities
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via SECURITY DEFINER RPCs (system-generated timeline, not hand-editable).

alter table public.sales_lead_status_history enable row level security;
alter table public.sales_lead_status_history force row level security;
create policy sales_lead_status_history_select on public.sales_lead_status_history
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via the status-transition RPC (trigger-adjacent), never direct client insert.

alter table public.sales_campaigns enable row level security;
alter table public.sales_campaigns force row level security;
create policy sales_campaigns_select on public.sales_campaigns
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_campaigns_write on public.sales_campaigns
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns'));

alter table public.sales_campaign_leads enable row level security;
alter table public.sales_campaign_leads force row level security;
create policy sales_campaign_leads_select on public.sales_campaign_leads
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_campaign_leads_write on public.sales_campaign_leads
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns'));

alter table public.sales_outreach_messages enable row level security;
alter table public.sales_outreach_messages force row level security;
create policy sales_outreach_messages_select on public.sales_outreach_messages
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Insert (GENERATE) requires generate_offer; approve/queue/send transitions are enforced by dedicated RPCs
-- below (Phase 11's GENERATE->APPROVE->QUEUE->SEND separation), not by a blanket UPDATE policy, so that
-- approval and send remain distinct, separately-permissioned actions rather than one open write door.
create policy sales_outreach_messages_insert on public.sales_outreach_messages
  for insert with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.generate_offer'));

alter table public.sales_followups enable row level security;
alter table public.sales_followups force row level security;
create policy sales_followups_select on public.sales_followups
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_followups_write on public.sales_followups
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_followups'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_followups'));

alter table public.sales_demo_events enable row level security;
alter table public.sales_demo_events force row level security;
create policy sales_demo_events_select on public.sales_demo_events
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_demo_events_write on public.sales_demo_events
  for all using (public.is_platform_owner() or public.has_platform_permission('platform.sales.qualify'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.qualify'));

alter table public.sales_conversion_records enable row level security;
alter table public.sales_conversion_records force row level security;
create policy sales_conversion_records_select on public.sales_conversion_records
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Insert only via convert_sales_lead_to_tenant() RPC, no direct client write policy at all.

alter table public.sales_discovery_jobs enable row level security;
alter table public.sales_discovery_jobs force row level security;
create policy sales_discovery_jobs_select on public.sales_discovery_jobs
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_discovery_jobs_insert on public.sales_discovery_jobs
  for insert with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.discover'));
-- No client update policy -- job status transitions only via SECURITY DEFINER job-runner RPCs.

alter table public.sales_quota_usage enable row level security;
alter table public.sales_quota_usage force row level security;
create policy sales_quota_usage_select on public.sales_quota_usage
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- Writes only via the atomic quota-check-and-increment RPC.

-- ============================================================
-- Explicit revoke of PUBLIC/anon default grants on every new table
-- (Phase 16 requirement: "Explicitly revoke PUBLIC/anon EXECUTE on
-- privileged functions" -- applied here to table DML grants too, since
-- Supabase's default new-table grants to anon/authenticated is exactly
-- the class of leak the earlier production audit found and fixed twice
-- for WhatsApp connector RPCs). FORCE RLS above already blocks row
-- access regardless, but this closes the grant layer too, defense in
-- depth, matching this codebase's established double-lock convention.
-- ============================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'sales_lead_sources', 'sales_leads', 'sales_lead_contacts', 'sales_lead_locations',
    'sales_lead_social_links', 'sales_lead_dedup_fingerprints', 'sales_possible_duplicates',
    'sales_lead_enrichment_runs', 'sales_lead_signals', 'sales_lead_scores', 'sales_lead_notes',
    'sales_lead_activities', 'sales_lead_status_history', 'sales_campaigns', 'sales_campaign_leads',
    'sales_outreach_messages', 'sales_followups', 'sales_demo_events', 'sales_conversion_records',
    'sales_discovery_jobs', 'sales_quota_usage'
  ]
  loop
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
