# Sales Intelligence Architecture

**Status:** Live (2026-09-04). Fully functional, including Phase 14 (tenant conversion) — see [Tenant conversion: invite-based owner activation](#tenant-conversion-invite-based-owner-activation) below.

Sales Intelligence is a Platform Owner bounded context for discovering, enriching, scoring, and pursuing prospective Mal3aby tenants (sports facilities, academies, clubs) from public sources, culminating in a governed conversion into a real tenant. See [ADR-054](docs/DECISIONS.md#adr-054--sales-intelligence-is-a-platform-owned-bounded-context-isolated-from-and-never-routed-through-clubtenant-authorization) for the full decision record.

## Isolation boundary

Every `sales_*` table is platform-scoped — **no table has a `club_id` foreign key** except `sales_leads.converted_club_id` (nullable, set exactly once, at conversion time). Every table uses `FORCE ROW LEVEL SECURITY`, gated exclusively on `is_platform_owner()` or `has_platform_permission('platform.sales.<action>')` — the platform authorization domain, never the club-scoped `has_permission()`. A club owner, staff member, or customer can never read or mutate a single row of Sales Intelligence data, under any circumstance, verified live (a real `club_owner` session returns 0 rows and gets `not authorized` on every write RPC).

## Domain model

22 tables (see `supabase/migrations/20260904090000_sales_intelligence_schema.sql` and `20260904120000_sales_tenant_activation_invites_schema.sql`): `sales_leads` (the canonical prospect entity) plus contacts/locations/social-links/dedup-fingerprints/possible-duplicates/enrichment-runs/signals/scores/notes/activities/status-history/campaigns/campaign-leads/outreach-messages/followups/demo-events/conversion-records/discovery-jobs/quota-usage/provider-configs/tenant-activation-invites.

## Deduplication

`sales_find_duplicate_candidates()` matches on `place_id`, normalized phone/domain/email, and name+city, producing a `high`/`medium`/`low` confidence score. `sales_upsert_discovered_lead()` auto-merges only `high`-confidence matches (attaches new source evidence to the existing canonical lead); `medium`/`low` confidence creates a new lead AND a `sales_possible_duplicates` row for human review — never silently merged.

## Scoring

`sales_compute_lead_score()` is deterministic and rule-based (no opaque AI ranking) across 5 weighted dimensions (digital-maturity gap, facility scale, academy potential, demand signal, contactability), each persisted with a bilingual plain-language explanation in `sales_lead_scores.explanation_ar`/`explanation_en`. A lead with zero discoverable contact channels is hard-floored to 0 regardless of other signals, since it cannot actually be pursued.

## Pipeline

`sales_change_lead_status()` is the sole path to change `sales_leads.status`, enforcing: `do_not_contact` leads can only move to `lost` (never re-activated for outreach); `won` leads are terminal (any further change goes through the tenant-conversion RPCs below, not this generic status setter — `sales_change_lead_status()` itself still refuses to set `won` directly, forcing every WON transition through `sales_win_lead_and_invite_owner()`, which additionally moves the lead straight to `awaiting_owner_activation` in the same call).

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

## Tenant conversion: invite-based owner activation

Phase 14 ("Convert Lead → Tenant") resolves the identity/ownership TRUE STOP documented in [ADR-054](docs/DECISIONS.md#adr-054--sales-intelligence-is-a-platform-owned-bounded-context-isolated-from-and-never-routed-through-clubtenant-authorization): `complete_new_club_onboarding()` is `auth.uid()`-only, so it cannot be called by the Platform Owner's own session to create a tenant owned by a different, not-yet-authenticated prospect without making the platform owner the club's owner. The chosen resolution (final, user-mandated) is **invite-based owner activation** — mirroring the proven `portal_invites`/`claim_portal_invite(_service)` pattern this codebase already hardened through two real security fixes (column-level grants excluding hash columns; freshness-binding on any service-role identity claim).

**Flow:** `sales_win_lead_and_invite_owner(lead_id, owner_email, ...)` (platform-owner only) moves the lead `won` → `awaiting_owner_activation` in one transaction (so `won` is never an observable standalone state a race could exploit) and mints a `sales_tenant_activation_invites` row — an opaque 256-bit token plus an independent 8-character human-typeable secret (delivered out of band by the platform owner, never in the URL), both sha256-hashed at rest, sharing one 5-attempt lockout budget. The prospect lands on `/sales-activate/:token` (`ActivateTenantOwnerPage.tsx`), verifies email + secret (`verify_sales_activation_email`/`verify_sales_activation_secret`, anon-callable, generic failure — never reveals which factor was wrong), then either:
- **New prospect** — chooses a password; the `sales-activate-tenant-owner` Edge Function creates a pre-confirmed `auth.users` identity server-side (`auth.admin.createUser(..., {email_confirm: true})`, zero outbound email, matching this project's established convention) using the invite's own server-stored `owner_email` — never a client-supplied value. No session, no onboarding happens in this call.
- **Existing account** — the Edge Function's `auth.admin.createUser` fails with "already registered"; the frontend routes to an ordinary sign-in form instead (never an automatic email-string link, per this codebase's own documented rule).

Either way, the frontend then has (or creates) a **real session** for the prospect and calls `claim_sales_activation_invite(raw_token)` — the **only** function in this entire flow that calls `complete_new_club_onboarding()`, always under the prospect's own `auth.uid()`, reusing that RPC completely unmodified (same trial/module defaults any self-service signup gets). `_complete_sales_conversion()` guards this: it checks `sales_leads.status`/`converted_club_id` first and short-circuits to the existing club on any retry, since `complete_new_club_onboarding()` itself is not idempotent — this is what prevents a double-click or parallel-tab race from creating two clubs for one lead. The invite table's own `idx_..._one_pending_per_lead`/`idx_..._one_consumed_per_lead` partial unique indexes, plus `sales_conversion_records_one_per_lead`, provide two further independent layers against duplicate conversion.

`sales_leads.status` gained `awaiting_owner_activation` and `tenant_activated`; `sales_leads_conversion_consistency` now requires `converted_club_id`/`converted_at` if and only if `status = 'tenant_activated'` (not `won`) — "status=WON alone must NOT create a tenant" is enforced at the DB layer, not just by RPC discipline. The Platform Owner sees invite status (pending/expired/consumed) on `SalesLeadDetailPage` and can Resend (`resend_sales_activation_invite`, re-mints and revokes the prior pending invite). Full audit trail via `sales_lead_activities`: `won`, `activation_invite_created`, `activation_invite_resent`, `activation_invite_consumed`, `activation_failed`, `tenant_created`, `owner_linked`, `conversion_completed`.

See `supabase/migrations/20260904120000_sales_tenant_activation_invites_schema.sql`, `20260904120100_sales_tenant_activation_invites_rpcs.sql`, `20260904120200_sales_lead_full_profile_activation_invite.sql`, and `supabase/functions/sales-activate-tenant-owner/index.ts` for the full implementation.

## Permissions

12 new keys, `platform.sales.<action>` (group `sales`), added to the existing `platform_permissions`/`platform_role_permissions` system — no parallel authorization mechanism. `platform_owner` and `platform_admin` get full access; `platform_support` gets view-only.

## Testing

`supabase/tests/sales_intelligence_structural_regression.sql` — 10 fixture-independent schema-shape checks, verified passing live. Component tests: `SalesLeadDetailPage.tenant-activation.test.tsx` (locks in the invite-send/resend/awaiting-activation/tenant-activated UI states and that no RPC in this flow can ever make the platform owner's own account the tenant owner), `SalesDiscoverPage.configuration-blocked.test.tsx` (locks in CONFIGURATION_BLOCKED handling and that non-blocked work continues). See `docs/TEST_PLAN.md`'s "Sales Intelligence structural regression" section for CI-wiring status (same pre-existing blocker as the rest of this project's structural regression suite, not a new gap).
