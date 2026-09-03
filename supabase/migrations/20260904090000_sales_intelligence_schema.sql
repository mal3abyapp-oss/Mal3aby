-- Sales Intelligence — core domain schema (ADR-054, 2026-09-04).
-- Platform-owned bounded context: lead discovery, enrichment, scoring,
-- CRM pipeline, campaigns, follow-ups, and governed tenant conversion.
-- No table here has a club_id column except sales_leads.converted_club_id
-- (nullable, set only at the moment of conversion). Every table is
-- FORCE ROW LEVEL SECURITY, gated exclusively on is_platform_owner() or
-- has_platform_permission('platform.sales.<action>') -- never the
-- club-scoped has_permission(). See ADR-054 for full reasoning.

-- ============================================================
-- sales_lead_sources: catalog of discovery providers (Google Places,
-- manual entry, website form, referral, etc). A lookup table, not a
-- job log -- job execution lives in sales_discovery_jobs below.
-- ============================================================
create table public.sales_lead_sources (
  id uuid primary key default gen_random_uuid(),
  key text not null unique check (key ~ '^[a-z0-9_]+$'),
  name_ar text not null,
  name_en text not null,
  is_active boolean not null default true,
  requires_credential boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.sales_lead_sources (key, name_ar, name_en, requires_credential) values
  ('manual', 'إدخال يدوي', 'Manual entry', false),
  ('google_places', 'Google Places', 'Google Places', true),
  ('website_form', 'نموذج الموقع الإلكتروني', 'Website contact form', false),
  ('referral', 'إحالة', 'Referral', false),
  ('public_search', 'بحث عام', 'Public search result', false);

-- ============================================================
-- sales_leads: the canonical lead entity. One row per real-world
-- business, deduplicated across sources (see sales_lead_dedup_fingerprints
-- and Phase 4 dedup RPCs in the follow-up migration). Deliberately no
-- club_id -- this is platform data about a prospect, not a tenant.
-- converted_club_id is set exactly once, at WON->conversion time, by
-- convert_sales_lead_to_tenant() (follow-up migration), and is the only
-- link this domain ever has to real tenant data.
-- ============================================================
create table public.sales_leads (
  id uuid primary key default gen_random_uuid(),

  -- Identity
  business_name text not null,
  normalized_name text not null,
  business_type text,                      -- e.g. 'football_field','academy','padel_club','sports_club','multi_sport'
  sport_types text[] not null default '{}',

  -- Location (public business address only, never a private residence)
  country text,
  governorate_state text,
  city text,
  area text,
  address text,
  latitude numeric(9,6),
  longitude numeric(9,6),

  -- Public contact (business-published only -- never scraped personal data)
  website text,
  public_phone text,
  public_email text,
  whatsapp_public_number text,             -- publicly displayed on the business's own site/listing only

  -- Public reputation signals
  rating numeric(2,1),
  review_count int,
  opening_hours jsonb,                      -- public hours if published, structure: {"mon":"09:00-23:00",...}

  -- Derived operational signals (see sales_lead_signals for the
  -- evidence-backed detail; these are denormalized current-best-guess
  -- summary columns for fast list/filter queries)
  branch_count_estimate int,
  facility_count_estimate int,
  has_online_booking boolean,
  booking_provider_detected text,
  has_academy_presence boolean,

  -- Google Places / external provider linkage
  source_place_id text,                     -- Google Places place_id if discovered via that provider

  -- Provenance
  primary_source_id uuid references public.sales_lead_sources(id),
  first_discovered_at timestamptz not null default now(),
  last_verified_at timestamptz,

  -- Pipeline state (Phase 9)
  status text not null default 'discovered' check (status in (
    'discovered', 'enriching', 'enriched', 'qualified', 'contact_ready',
    'contacted', 'replied', 'demo_scheduled', 'demo_completed',
    'negotiation', 'won', 'lost', 'do_not_contact'
  )),
  status_reason text,

  -- Scoring (Phase 7) -- denormalized latest score for fast list sort;
  -- full history/explanation lives in sales_lead_scores
  current_score int check (current_score is null or (current_score between 0 and 100)),
  current_score_band text check (current_score_band is null or current_score_band in ('hot', 'warm', 'cold')),

  -- Deduplication
  dedup_fingerprint text not null,
  merged_into_lead_id uuid references public.sales_leads(id),  -- set if this row was merged into a canonical duplicate

  -- Conversion (Phase 14) -- the ONLY link to real tenant data
  converted_club_id uuid references public.clubs(id),
  converted_at timestamptz,

  -- Confidence / quality
  data_confidence text not null default 'low' check (data_confidence in ('low', 'medium', 'high')),

  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint sales_leads_conversion_consistency
    check ((converted_club_id is null and converted_at is null and status <> 'won')
        or (converted_club_id is not null and converted_at is not null))
);

create index sales_leads_status_idx on public.sales_leads (status);
create index sales_leads_score_idx on public.sales_leads (current_score desc nulls last) where merged_into_lead_id is null;
create index sales_leads_city_idx on public.sales_leads (country, city) where merged_into_lead_id is null;
create index sales_leads_fingerprint_idx on public.sales_leads (dedup_fingerprint) where merged_into_lead_id is null;
create index sales_leads_place_id_idx on public.sales_leads (source_place_id) where source_place_id is not null;
create index sales_leads_phone_idx on public.sales_leads (public_phone) where public_phone is not null;
create index sales_leads_email_idx on public.sales_leads (public_email) where public_email is not null;
create index sales_leads_website_idx on public.sales_leads (website) where website is not null;
create index sales_leads_converted_club_idx on public.sales_leads (converted_club_id) where converted_club_id is not null;
-- Only one active (non-merged) conversion per lead -- prevents duplicate conversion (Phase 14 requirement)
create unique index sales_leads_one_conversion_per_lead on public.sales_leads (id) where converted_club_id is not null;

create trigger trg_sales_leads_updated_at
  before update on public.sales_leads
  for each row execute function public.set_updated_at();

-- ============================================================
-- sales_lead_contacts: individual named contacts at a lead business
-- (owner, manager) when publicly discoverable -- e.g. a website's
-- "About"/"Team" page. Separate from sales_leads' business-level
-- public_phone/public_email so multiple named contacts can coexist.
-- ============================================================
create table public.sales_lead_contacts (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  full_name text,
  role_title text,
  phone text,
  email text,
  is_primary boolean not null default false,
  source_url text,
  created_at timestamptz not null default now()
);

create index sales_lead_contacts_lead_idx on public.sales_lead_contacts (lead_id);

-- ============================================================
-- sales_lead_locations: supports multi-branch leads (a facility with
-- more than one physical location) without denormalizing branch data
-- onto sales_leads itself.
-- ============================================================
create table public.sales_lead_locations (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  branch_name text,
  address text,
  city text,
  area text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  source_url text,
  created_at timestamptz not null default now()
);

create index sales_lead_locations_lead_idx on public.sales_lead_locations (lead_id);

-- ============================================================
-- sales_lead_social_links: public social/business profile links
-- discovered for a lead (Instagram, Facebook, TikTok, Google Business
-- Profile, booking-platform profile, etc).
-- ============================================================
create table public.sales_lead_social_links (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  platform text not null,                   -- 'instagram','facebook','tiktok','google_business','other'
  url text not null,
  followers_estimate int,
  source_url text,
  discovered_at timestamptz not null default now()
);

create index sales_lead_social_links_lead_idx on public.sales_lead_social_links (lead_id);
create unique index sales_lead_social_links_unique on public.sales_lead_social_links (lead_id, platform, url);

-- ============================================================
-- sales_lead_dedup_fingerprints: every fingerprint signal ever computed
-- for a lead (not just the current one on sales_leads.dedup_fingerprint)
-- -- lets the dedup engine (Phase 4) match a NEW incoming discovery
-- against ANY prior fingerprint a lead has ever had, not just its most
-- recent one, closing the "business changed its phone number between
-- two discovery runs" gap.
-- ============================================================
create table public.sales_lead_dedup_fingerprints (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  fingerprint_type text not null check (fingerprint_type in (
    'place_id', 'phone', 'domain', 'email', 'name_address', 'social_url'
  )),
  fingerprint_value text not null,
  created_at timestamptz not null default now()
);

create index sales_lead_dedup_fingerprints_lookup_idx
  on public.sales_lead_dedup_fingerprints (fingerprint_type, fingerprint_value);
create index sales_lead_dedup_fingerprints_lead_idx on public.sales_lead_dedup_fingerprints (lead_id);

-- ============================================================
-- sales_possible_duplicates: human-review queue for ambiguous-confidence
-- dedup matches (Phase 4's explicit "never auto-merge when materially
-- ambiguous" requirement).
-- ============================================================
create table public.sales_possible_duplicates (
  id uuid primary key default gen_random_uuid(),
  lead_id_a uuid not null references public.sales_leads(id) on delete cascade,
  lead_id_b uuid not null references public.sales_leads(id) on delete cascade,
  match_signals jsonb not null default '{}'::jsonb,  -- which fingerprint types matched, confidence per signal
  confidence text not null check (confidence in ('low', 'medium', 'high')),
  status text not null default 'pending' check (status in ('pending', 'confirmed_duplicate', 'confirmed_distinct')),
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint sales_possible_duplicates_distinct_leads check (lead_id_a <> lead_id_b)
);

create index sales_possible_duplicates_pending_idx on public.sales_possible_duplicates (status) where status = 'pending';
create unique index sales_possible_duplicates_pair_unique
  on public.sales_possible_duplicates (least(lead_id_a, lead_id_b), greatest(lead_id_a, lead_id_b));

-- ============================================================
-- sales_lead_enrichment_runs: one row per enrichment attempt (website
-- scan, Places details fetch) for a lead -- the job-execution record,
-- mirroring notification_queue's status/attempts/error shape.
-- ============================================================
create table public.sales_lead_enrichment_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  source_id uuid references public.sales_lead_sources(id),
  run_type text not null check (run_type in ('website_scan', 'places_details', 'manual')),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'partial', 'failed', 'retryable')),
  attempts int not null default 0,
  error_class text,
  last_error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now()
);

create index sales_lead_enrichment_runs_lead_idx on public.sales_lead_enrichment_runs (lead_id);
create index sales_lead_enrichment_runs_pending_idx on public.sales_lead_enrichment_runs (status) where status in ('pending', 'retryable');

-- ============================================================
-- sales_lead_signals: evidence-backed opportunity signals (Phase 6).
-- Each row is one claimed signal with its supporting evidence -- never
-- claim a signal without a source_url + retrieved_at, per the mission's
-- "do not claim a signal unless evidence supports it" requirement.
-- ============================================================
create table public.sales_lead_signals (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  signal_key text not null check (signal_key in (
    'no_online_booking', 'whatsapp_only_booking', 'phone_only_booking',
    'multi_field_facility', 'multi_branch', 'academy_present',
    'high_review_volume', 'no_website', 'outdated_website',
    'public_booking_form_only', 'multiple_contact_channels',
    'high_customer_demand_signal', 'manual_operation_indicators'
  )),
  confidence text not null check (confidence in ('high', 'medium', 'low')),
  evidence jsonb not null default '{}'::jsonb,   -- {"detail": "...", "excerpt": "..."}
  source_url text,
  retrieved_at timestamptz not null default now(),
  enrichment_run_id uuid references public.sales_lead_enrichment_runs(id),
  is_active boolean not null default true,   -- superseded signals (e.g. site added booking) are deactivated, not deleted
  created_at timestamptz not null default now()
);

create index sales_lead_signals_lead_idx on public.sales_lead_signals (lead_id) where is_active = true;
create unique index sales_lead_signals_one_active_per_key
  on public.sales_lead_signals (lead_id, signal_key) where is_active = true;

-- ============================================================
-- sales_lead_scores: full scoring history (Phase 7). sales_leads carries
-- only the CURRENT score for fast list queries; every computation is
-- preserved here with its explanation, so "why is this lead HOT" is
-- always answerable, never opaque.
-- ============================================================
create table public.sales_lead_scores (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  score int not null check (score between 0 and 100),
  score_band text not null check (score_band in ('hot', 'warm', 'cold')),
  dimension_breakdown jsonb not null default '{}'::jsonb,  -- {"commercial_fit": 18, "digital_maturity_gap": 22, ...}
  explanation_ar text not null,
  explanation_en text not null,
  computed_at timestamptz not null default now()
);

create index sales_lead_scores_lead_idx on public.sales_lead_scores (lead_id, computed_at desc);

-- ============================================================
-- sales_lead_notes: free-text staff notes (manual, never overwritten
-- by re-enrichment -- Phase 20's "do not overwrite authoritative manual
-- corrections silently" applies to notes trivially since they're
-- append-only by nature).
-- ============================================================
create table public.sales_lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  note text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_lead_notes_lead_idx on public.sales_lead_notes (lead_id, created_at desc);

-- ============================================================
-- sales_lead_activities: the activity timeline (Phase 8) -- every
-- material event on a lead (enrichment completed, score computed,
-- message sent, status changed, note added) for the profile page's
-- "Activity timeline". Append-only.
-- ============================================================
create table public.sales_lead_activities (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  activity_type text not null,  -- 'discovered','enriched','scored','status_changed','note_added','message_sent','demo_scheduled', etc.
  detail jsonb not null default '{}'::jsonb,
  actor_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_lead_activities_lead_idx on public.sales_lead_activities (lead_id, created_at desc);

-- ============================================================
-- sales_lead_status_history: append-only status transition log (Phase 9
-- "preserve status history" requirement) -- separate from
-- sales_lead_activities because this is specifically queried for the
-- pipeline funnel analytics (Phase 19) and needs a stable, narrow shape.
-- ============================================================
create table public.sales_lead_status_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  from_status text,
  to_status text not null,
  reason text,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);

create index sales_lead_status_history_lead_idx on public.sales_lead_status_history (lead_id, changed_at desc);

-- ============================================================
-- sales_campaigns: named lead groupings with targeting criteria
-- (Phase 12).
-- ============================================================
create table public.sales_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  criteria jsonb not null default '{}'::jsonb,  -- {"country":"EG","city":"Cairo","min_score":60,"signals":[...],"uncontacted_only":true}
  status text not null default 'active' check (status in ('active', 'paused', 'completed', 'archived')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger trg_sales_campaigns_updated_at
  before update on public.sales_campaigns
  for each row execute function public.set_updated_at();

-- ============================================================
-- sales_campaign_leads: many-to-many, a lead can be in more than one
-- campaign over time (but see the outreach dedup rule in the follow-up
-- migration -- one campaign's outreach doesn't re-trigger another's).
-- ============================================================
create table public.sales_campaign_leads (
  campaign_id uuid not null references public.sales_campaigns(id) on delete cascade,
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (campaign_id, lead_id)
);

create index sales_campaign_leads_lead_idx on public.sales_campaign_leads (lead_id);

-- ============================================================
-- sales_outreach_messages: the GENERATE -> APPROVE -> QUEUE -> SEND
-- lifecycle (Phase 11). channel is 'email' only for actual sending in
-- this mission -- WhatsApp channel value is recorded for
-- talking-points/phone-script generation but NEVER queued/sent through
-- this table (see the CHECK constraint and the follow-up migration's
-- send RPC, which explicitly refuses channel='whatsapp').
-- ============================================================
create table public.sales_outreach_messages (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  campaign_id uuid references public.sales_campaigns(id),
  channel text not null check (channel in ('email', 'phone_script', 'whatsapp_talking_points')),
  message_type text not null,  -- 'intro','offer','followup','demo_pitch','proposal_summary'
  language text not null check (language in ('ar', 'en')),
  subject text,
  body text not null,
  grounding jsonb not null default '{}'::jsonb,  -- the exact signals/evidence the AI was given -- factual-grounding audit trail
  status text not null default 'generated' check (status in ('generated', 'approved', 'queued', 'sent', 'failed', 'rejected')),
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  sent_at timestamptz,
  provider_reference text,
  last_error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_outreach_messages_lead_idx on public.sales_outreach_messages (lead_id, created_at desc);
create index sales_outreach_messages_status_idx on public.sales_outreach_messages (status) where status in ('generated', 'approved', 'queued');

-- ============================================================
-- sales_followups: scheduled future actions (Phase 13). Every future
-- action has lead/reason/scheduled_time/status/owner/last_action, per
-- the mission's explicit shape.
-- ============================================================
create table public.sales_followups (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  reason text not null,
  scheduled_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled', 'overdue')),
  owner_id uuid references auth.users(id),
  last_action text,
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_followups_pending_idx on public.sales_followups (scheduled_at) where status = 'pending';
create index sales_followups_lead_idx on public.sales_followups (lead_id);

-- ============================================================
-- sales_demo_events: demo scheduling/completion tracking (Phase 9/19).
-- ============================================================
create table public.sales_demo_events (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  scheduled_at timestamptz,
  completed_at timestamptz,
  outcome text check (outcome is null or outcome in ('positive', 'neutral', 'negative', 'no_show')),
  notes text,
  owner_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_demo_events_lead_idx on public.sales_demo_events (lead_id);

-- ============================================================
-- sales_conversion_records: the WON -> tenant conversion audit record
-- (Phase 14). Separate from sales_leads.converted_club_id/converted_at
-- (which are the fast-lookup summary) so the full conversion context
-- (which fields were copied, who approved, when) survives even if a
-- future admin action needs to review exactly what data crossed the
-- sales/tenant boundary.
-- ============================================================
create table public.sales_conversion_records (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id),
  club_id uuid not null references public.clubs(id),
  copied_fields jsonb not null default '{}'::jsonb,  -- exactly what was copied from the lead into onboarding
  converted_by uuid references auth.users(id),
  converted_at timestamptz not null default now(),
  constraint sales_conversion_records_one_per_lead unique (lead_id),
  constraint sales_conversion_records_one_per_club unique (club_id)
);

-- ============================================================
-- sales_discovery_jobs: discovery run tracking (Phase 3/17), mirroring
-- notification_queue's job-lifecycle shape (status/attempts/error) so
-- the Discover Leads screen can show job status/discovered/new/
-- duplicates/enriched/failed/skipped and be resumable.
-- ============================================================
create table public.sales_discovery_jobs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sales_lead_sources(id),
  search_params jsonb not null default '{}'::jsonb,  -- {"country":"EG","city":"Cairo","query":"football fields","radius_km":15,...}
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'partial', 'failed', 'retryable', 'cancelled')),
  attempts int not null default 0,
  error_class text,
  last_error text,
  discovered_count int not null default 0,
  new_count int not null default 0,
  duplicate_count int not null default 0,
  enriched_count int not null default 0,
  failed_count int not null default 0,
  skipped_count int not null default 0,
  next_page_token text,  -- for resumable paginated discovery
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_discovery_jobs_status_idx on public.sales_discovery_jobs (status) where status in ('pending', 'running', 'retryable');
create index sales_discovery_jobs_created_idx on public.sales_discovery_jobs (created_at desc);

-- ============================================================
-- sales_quota_usage: cost/quota tracking (Phase 18) -- one row per
-- (provider, day), incremented atomically by every discovery/enrichment/
-- AI-generation call before it proceeds, so limits are enforced BEFORE
-- the expensive call, not after.
-- ============================================================
create table public.sales_quota_usage (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null,  -- 'google_places','ai_offer_generator','website_enrichment'
  usage_date date not null default current_date,
  request_count int not null default 0,
  daily_cap int not null default 100,
  updated_at timestamptz not null default now(),
  constraint sales_quota_usage_one_per_provider_per_day unique (provider_key, usage_date)
);

comment on table public.sales_leads is 'Sales Intelligence: canonical prospect entity, platform-owned, never tenant-scoped. See ADR-054.';
comment on table public.sales_conversion_records is 'Audit trail for lead-to-tenant conversion via complete_new_club_onboarding(); never a parallel onboarding implementation. See ADR-054.';
