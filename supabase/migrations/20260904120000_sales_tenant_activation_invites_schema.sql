-- PHASE 14 (final, user-mandated design): CONVERSION MODEL = INVITE-BASED
-- OWNER ACTIVATION.
--
-- Resolves the TRUE STOP documented in 20260904090400_sales_intelligence_
-- scoring_outreach_conversion.sql and ADR-054: complete_new_club_onboarding()
-- is auth.uid()-coupled and cannot be safely called on a not-yet-
-- authenticated prospect's behalf. The user's explicit, final decision
-- (option (a) from that migration's own comment) is implemented here:
--
--   Lead -> WON -> AWAITING_OWNER_ACTIVATION -> prospect receives a secure
--   owner-activation invitation -> prospect verifies/creates or links their
--   own Supabase Auth identity -> only after successful verification: call
--   complete_new_club_onboarding() UNMODIFIED, under the prospect's OWN
--   session -> link that verified identity as Club Owner -> lead marked
--   TENANT_ACTIVATED -> store converted_club_id + full audit trail.
--
-- This migration is schema-only (status widening + sales_tenant_activation_
-- invites table). The mint/verify/claim/resend RPCs and the frontend follow
-- in later migrations/files, exactly mirroring the proven portal_invites /
-- claim_portal_invite(_service) pattern (20260823050000, 20260823070000,
-- 20260823080000, 20260824080000, 20260824250000) -- re-read in full before
-- writing this, not reinvented from memory.
--
-- ============================================================
-- 1. sales_leads.status: widen the enum to separate commercial close from
--    technical tenant activation, per the mandatory rule "status=WON alone
--    must NOT create a tenant" / "Separate commercial close from technical
--    tenant activation: WON -> AWAITING_OWNER_ACTIVATION -> TENANT_ACTIVATED".
--
--    'won' remains a real, reachable status (the commercial-close moment --
--    sales_change_lead_status() already permits reaching it, just not yet
--    combined with a tenant). 'awaiting_owner_activation' and
--    'tenant_activated' are new. The OLD sales_leads_conversion_consistency
--    constraint required converted_club_id whenever status='won' -- that
--    is exactly backwards under the new model (won no longer implies a
--    club exists) and is replaced below.
-- ============================================================
alter table public.sales_leads drop constraint sales_leads_conversion_consistency;

alter table public.sales_leads drop constraint sales_leads_status_check;
alter table public.sales_leads add constraint sales_leads_status_check
  check (status in (
    'discovered', 'enriching', 'enriched', 'qualified', 'contact_ready',
    'contacted', 'replied', 'demo_scheduled', 'demo_completed',
    'negotiation', 'won', 'awaiting_owner_activation', 'tenant_activated',
    'lost', 'do_not_contact'
  ));

-- New consistency rule: converted_club_id/converted_at are set if and only
-- if status = 'tenant_activated' -- the ONLY status that means "a real
-- tenant now exists for this lead". 'won' and 'awaiting_owner_activation'
-- are commercial/pending states and must never carry a club reference yet
-- (enforces "status=WON alone must NOT create a tenant" at the DB layer,
-- not just by RPC convention).
alter table public.sales_leads add constraint sales_leads_conversion_consistency
  check ((converted_club_id is null and converted_at is null and status <> 'tenant_activated')
      or (converted_club_id is not null and converted_at is not null and status = 'tenant_activated'));

comment on column public.sales_leads.status is
  'Pipeline status. won = commercial close (no tenant yet). awaiting_owner_activation = invite minted, prospect not yet verified. tenant_activated = real club exists (converted_club_id/converted_at set) -- see sales_tenant_activation_invites and ADR-054.';

-- ============================================================
-- 2. sales_tenant_activation_invites: the invite mechanism, modeled
--    directly on portal_invites (customer_portal_zero_cost_activation +
--    activation_independent_secret_factor + the two security-hardening
--    follow-ups), adapted for a B2B lead with no club yet:
--      - references sales_leads(id) instead of customers(id)
--      - no club_id (none exists until activation succeeds)
--      - two independent factors: email match (the lead's own
--        public_email / a contact email the platform owner confirms on
--        the WON call -- there is no "registered phone" the same way a
--        customer has one, since a lead is a business, not a person with
--        an account) + the same human-typeable secret delivered out of
--        band (business phone/WhatsApp/email at the platform owner's
--        discretion when relaying, never inside the invite URL)
--      - same token_hash/secret_hash sha256-at-rest convention
--      - same shared verification_attempt_count budget, 5-attempt lockout
--      - same partial-unique-pending-per-lead constraint (prevents
--        duplicate conversion / double-click creating two live invites)
-- ============================================================
create table public.sales_tenant_activation_invites (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id),

  -- Business info the platform owner confirmed at WON time -- copied here
  -- (not just referenced) so the activation landing page and the eventual
  -- complete_new_club_onboarding() call have a stable, point-in-time
  -- snapshot even if the lead row is edited afterward.
  business_name text not null,
  business_name_ar text,
  business_type text,
  city text,
  country text,
  contact_phone text,
  contact_phone_e164 text,
  owner_email text not null,

  purpose text not null default 'tenant_owner_activation' check (purpose in ('tenant_owner_activation')),
  token_hash text not null unique,
  secret_hash text not null,

  status text not null default 'pending' check (status in ('pending', 'consumed', 'revoked')),
  email_verified_at timestamptz,
  secret_verified_at timestamptz,
  verification_attempt_count int not null default 0,

  expires_at timestamptz not null,
  consumed_at timestamptz,

  -- Set once activation succeeds -- the real tenant/identity this invite
  -- resolved to. Denormalized here in addition to sales_leads.converted_
  -- club_id / sales_conversion_records so this row alone is a complete
  -- audit record of what it ultimately produced.
  activated_club_id uuid references public.clubs(id),
  activated_user_id uuid references auth.users(id),

  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index idx_sales_tenant_activation_invites_lead on public.sales_tenant_activation_invites (lead_id);
-- Only one PENDING invite per lead at a time -- re-mint (resend) revokes
-- the prior pending row first (mirrors portal_invites exactly), so this
-- index is what actually prevents "two live invites for the same lead"
-- races, not just RPC-layer discipline.
create unique index idx_sales_tenant_activation_invites_one_pending_per_lead
  on public.sales_tenant_activation_invites (lead_id) where status = 'pending';
-- A lead can be converted (consumed) at most once -- second layer of the
-- "prevent duplicate conversion of the same lead" requirement, on top of
-- sales_leads.status's own 'tenant_activated' terminal-state guard and
-- sales_conversion_records_one_per_lead's uniqueness.
create unique index idx_sales_tenant_activation_invites_one_consumed_per_lead
  on public.sales_tenant_activation_invites (lead_id) where status = 'consumed';

alter table public.sales_tenant_activation_invites enable row level security;
alter table public.sales_tenant_activation_invites force row level security;

create policy sales_tenant_activation_invites_select on public.sales_tenant_activation_invites
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
-- No client insert/update policy at all -- every write goes through the
-- SECURITY DEFINER RPCs below (mint/resend/verify/claim), matching this
-- table's own portal_invites precedent exactly.

revoke all on public.sales_tenant_activation_invites from public;
revoke all on public.sales_tenant_activation_invites from anon;
-- CRITICAL: also revoke from `authenticated` explicitly -- Supabase
-- grants INSERT/SELECT/UPDATE/DELETE/REFERENCES on every new public
-- schema table to `authenticated` by default at creation time. Without
-- this explicit revoke, the column-level grant below only ADDS select
-- on the safe columns -- it does NOT remove that pre-existing blanket
-- grant, which would otherwise leave token_hash/secret_hash directly
-- selectable by `authenticated` (this exact gap was live in production
-- for a short window before being caught by this module's own
-- structural regression suite -- see 20260904120400 for the applied
-- fix and full impact assessment; folded into this base migration too
-- so a fresh `supabase db reset` never reintroduces it).
revoke all on public.sales_tenant_activation_invites from authenticated;
-- Column-level grant from the start (never a blanket grant that would
-- later need the 20260824080000-style retrofit) -- token_hash/secret_hash
-- excluded, matching the now-corrected portal_invites convention exactly.
grant select (
  id, lead_id, business_name, business_name_ar, business_type, city, country,
  contact_phone, contact_phone_e164, owner_email, purpose, status,
  email_verified_at, secret_verified_at, verification_attempt_count,
  expires_at, consumed_at, activated_club_id, activated_user_id,
  created_at, created_by
) on public.sales_tenant_activation_invites to authenticated;
grant select on public.sales_tenant_activation_invites to service_role;

comment on table public.sales_tenant_activation_invites is
  'Phase 14 invite-based owner activation (ADR-054 final decision). Mirrors portal_invites: token+secret two-factor, sha256 at rest, shared 5-attempt lockout, single pending/consumed per lead. See sales_mint_tenant_activation_invite / verify_sales_activation_email / verify_sales_activation_secret / claim_sales_activation_invite(_service) / resend_sales_activation_invite.';
comment on column public.sales_tenant_activation_invites.token_hash is
  'sha256 of the raw activation token (256 bits entropy in the raw value -- hash not practically brute-forceable). Never granted to authenticated -- read only via SECURITY DEFINER RPCs / service_role.';
comment on column public.sales_tenant_activation_invites.secret_hash is
  'sha256 of the 8-character/32-symbol activation secret (~40 bits entropy, relies on the online 5-attempt lockout, not offline hardness). Never granted to authenticated -- read only via SECURITY DEFINER RPCs / service_role.';
