# Sales Intelligence Architecture

**Status:** Live (2026-09-04). Fully functional except Phase 14 (tenant conversion), which is a deliberate, documented TRUE STOP — see [Open Decision](#open-decision-tenant-conversion-identityownership-model) below.

Sales Intelligence is a Platform Owner bounded context for discovering, enriching, scoring, and pursuing prospective Mal3aby tenants (sports facilities, academies, clubs) from public sources, culminating in a governed conversion into a real tenant. See [ADR-054](docs/DECISIONS.md#adr-054--sales-intelligence-is-a-platform-owned-bounded-context-isolated-from-and-never-routed-through-clubtenant-authorization) for the full decision record.

## Isolation boundary

Every `sales_*` table is platform-scoped — **no table has a `club_id` foreign key** except `sales_leads.converted_club_id` (nullable, set exactly once, at conversion time). Every table uses `FORCE ROW LEVEL SECURITY`, gated exclusively on `is_platform_owner()` or `has_platform_permission('platform.sales.<action>')` — the platform authorization domain, never the club-scoped `has_permission()`. A club owner, staff member, or customer can never read or mutate a single row of Sales Intelligence data, under any circumstance, verified live (a real `club_owner` session returns 0 rows and gets `not authorized` on every write RPC).

## Domain model

21 tables (see `supabase/migrations/20260904090000_sales_intelligence_schema.sql`): `sales_leads` (the canonical prospect entity) plus contacts/locations/social-links/dedup-fingerprints/possible-duplicates/enrichment-runs/signals/scores/notes/activities/status-history/campaigns/campaign-leads/outreach-messages/followups/demo-events/conversion-records/discovery-jobs/quota-usage/provider-configs.

## Deduplication

`sales_find_duplicate_candidates()` matches on `place_id`, normalized phone/domain/email, and name+city, producing a `high`/`medium`/`low` confidence score. `sales_upsert_discovered_lead()` auto-merges only `high`-confidence matches (attaches new source evidence to the existing canonical lead); `medium`/`low` confidence creates a new lead AND a `sales_possible_duplicates` row for human review — never silently merged.

## Scoring

`sales_compute_lead_score()` is deterministic and rule-based (no opaque AI ranking) across 5 weighted dimensions (digital-maturity gap, facility scale, academy potential, demand signal, contactability), each persisted with a bilingual plain-language explanation in `sales_lead_scores.explanation_ar`/`explanation_en`. A lead with zero discoverable contact channels is hard-floored to 0 regardless of other signals, since it cannot actually be pursued.

## Pipeline

`sales_change_lead_status()` is the sole path to change `sales_leads.status`, enforcing: `do_not_contact` leads can only move to `lost` (never re-activated for outreach); `won` leads are terminal; **`won` itself is only reachable via real tenant conversion** — the RPC raises a clean, specific error if attempted directly, backed by a DB-level CHECK constraint (`sales_leads_conversion_consistency`) as the actual enforcement layer.

## Outreach lifecycle

Four distinct, separately-permissioned RPCs — GENERATE → APPROVE → QUEUE → SEND — so the human-approval gate cannot be bypassed by a future UI shortcut. `sales_queue_outreach_message()` structurally refuses any channel other than `email`; WhatsApp cold outreach is not implemented anywhere in this module, per explicit mission requirement, and the existing WhatsApp subsystem is untouched.

## Providers

`LeadSourceProvider`-shaped adapters, not tightly coupled to any one source:
- **`website_enrichment`** (`supabase/functions/sales-website-enrichment`) — no credential required, pre-enabled. Bounded same-domain page crawl (Home + up to 5 linked pages matching About/Contact/Booking/Pricing/Facilities/Branches hints), extracts evidence-backed signals with `source_url`/`retrieved_at` on every claim.
- **`google_places`** (`supabase/functions/sales-google-places-discovery`) — official Places API (New) Text Search + Details only. No scraping, no CAPTCHA bypass, no proxy rotation.
- **`ai_offer_generator`** (`supabase/functions/sales-ai-offer-generator`) — generates outreach content grounded exclusively in verified `sales_leads`/`sales_lead_signals` evidence; the full grounding payload is persisted in `sales_outreach_messages.grounding` as a factual-audit trail.
- **`sales-outreach-email-sender`** — the SEND step, via the same Resend REST API integration already used by `cloudflare/email-worker`.

Both `google_places` and `ai_offer_generator` require an operator-configured Supabase Vault secret (`sales_provider_configs.secret_vault_id`, set via `set_sales_provider_secret()`). Until configured, every code path (Edge Functions and frontend) treats them as `CONFIGURATION_BLOCKED` — a distinct 409 response and a specific UI message — rather than a generic error, and every other non-blocked workflow (manual lead entry, website enrichment, scoring, CRM, campaigns, follow-ups) continues to function fully.

## Quota / cost control

`sales_check_and_increment_quota()` is an atomic, row-locked (`FOR UPDATE`) check-and-increment against a per-provider daily cap, called **before** any expensive external call — the cap is enforced before the cost is incurred, not after.

## Job processing

Discovery (`sales_discovery_jobs`) and enrichment (`sales_lead_enrichment_runs`) mirror `notification_queue`'s job-lifecycle shape and `whatsapp_connector_claim_next_batch()`'s `FOR UPDATE SKIP LOCKED` claim pattern — resumable, observable, bounded attempts, no infinite retry loops.

## Open decision: tenant conversion identity/ownership model

Phase 14 ("Convert Lead → Tenant") is **not implemented**. `complete_new_club_onboarding()` — the codebase's only tenant-creation path — is coupled to `auth.uid()`: it creates the `club_owner` membership for whoever is calling it, and grants a one-per-account automatic trial keyed to that same caller's identity. It has no parameter for "create this club and make a different, not-currently-authenticated prospect its owner."

A Platform Owner clicking "Convert to Tenant" is a different session than the prospect who should actually own the resulting club. Calling the existing RPC as-is would make the **platform owner's own account** the tenant's `club_owner` — a real identity-ownership defect, not a UX gap.

Two resolutions exist, neither decided:
1. **Two-step conversion via invite**: reuse the existing `portal_invites`/`claim_portal_invite_service` pattern — mark WON, send the prospect a real invite/magic-link, they complete their own onboarding. Conversion becomes asynchronous; "WON" no longer means "tenant exists this instant."
2. **Extend the onboarding RPC** (or add a carefully-scoped platform-owner-only sibling) to accept an explicit `p_owner_user_id`/`p_owner_email` and create the membership for that identity — requires its own authorization gate and an explicit decision on whether a sales-converted tenant receives the same automatic free trial a self-service signup gets.

`sales_conversion_records` and `sales_leads.converted_club_id`/`converted_at` already exist and are ready to be populated the moment this decision is made — no schema change will be needed, only the one RPC. The UI (`SalesLeadDetailPage`) renders a disabled "Convert to Tenant" button with this exact explanation rather than a broken or silently-wrong action.

## Permissions

12 new keys, `platform.sales.<action>` (group `sales`), added to the existing `platform_permissions`/`platform_role_permissions` system — no parallel authorization mechanism. `platform_owner` and `platform_admin` get full access; `platform_support` gets view-only.

## Testing

`supabase/tests/sales_intelligence_structural_regression.sql` — 10 fixture-independent schema-shape checks, verified passing live. Component tests: `SalesLeadDetailPage.convert-blocked.test.tsx` (locks in the TRUE STOP is genuinely enforced in the UI, not just documented), `SalesDiscoverPage.configuration-blocked.test.tsx` (locks in CONFIGURATION_BLOCKED handling and that non-blocked work continues). See `docs/TEST_PLAN.md`'s "Sales Intelligence structural regression" section for CI-wiring status (same pre-existing blocker as the rest of this project's structural regression suite, not a new gap).
