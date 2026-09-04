# Mal3aby V1 — Feature Inventory (code/DB/UI-derived)

Derived by architecture-reviewer from live migrations, `src/app/routing/router.tsx`, layouts, and `supabase/functions/` — not copied from prior narrative docs. HEAD `7b773ec`.

## Roles — two independent catalogues

**Club-scoped** (`public.roles` + custom `club_roles`): `platform_owner`, `club_owner`, `club_manager`, `branch_manager`, `receptionist`, `accountant`, `academy_manager`, `coach`, `scanner`, plus per-club custom roles (composed from the shared `permissions` catalogue, `club_role_permissions`).

**Platform-staff** (`public.platform_roles`, structurally separate): `platform_owner`, `platform_admin`, `platform_support`, `platform_finance`, `platform_operations`, `platform_viewer`.

**Customer/Guardian**: not a `roles` row — separate portal auth (`portal_invites`, `activate-portal-account` edge function, `RequirePortalAuth`/`RequirePortalCustomer` guards) layered on `customers`/`guardian_links`.

**Bridge/single-point-of-failure**: both catalogues converge only on `is_platform_owner()` — the one documented exception to the permission-key-only rule (ADR-014). Deserves disproportionate test weight.

**Known doc drift**: `docs/RLS_MATRIX.md` states "no portal access exists in V1" — false; a full `/portal/*` tree exists live with a documented P0 bypass fix already closed (2026-08-25). Treat RLS_MATRIX.md as stale for portal coverage; verify against live policies.

## Modules (A-O mapping from mission, cross-referenced to real routes)

| Mission area | Real routes/modules | Status |
|---|---|---|
| A. Tenant isolation | cross-cutting (RLS on all tables) | Baseline PROVEN 2026-08-31/09-03, spot-check in progress |
| B. Auth/AuthZ/RLS | `is_platform_owner()`, `has_permission()`, `has_platform_permission()` | Baseline PROVEN, spot-check in progress |
| C. Club Ops | `/app/bookings,fields,staff,staff/roles,settings,audit-log` | Baseline PROVEN 2026-08-31 |
| D. Academy Ops | `/app/academy`, `/app/academy/players/:id`, `/app/memberships` | Baseline PROVEN 2026-08-31 |
| E. Booking Engine | `/app/bookings`, `/c/:slug` (public), `/qr/:token` | Baseline PROVEN, GiST exclusion constraint confirmed live |
| F. Payments/Finance | `/app/finance/*` (payments,invoices,cash,expenses,reports,gateway-return) | Baseline PROVEN; gateways below |
| G. QR/Attendance | `/scan`, `qr_credentials`/`qr_scan_events` | Baseline PROVEN 2026-08-21/31 |
| H. WhatsApp/Comms | `/app/whatsapp` (own top-level module, 4 tabs); separate Cloudflare Container deployment | Baseline PROVEN live send 2026-08-21; NOT eligible for Sales Intelligence leads (structural, documented, correct) |
| I. Customer Experience | `/portal/*` (bookings,academy,memberships,payments,qr,profile) | Baseline PROVEN 2026-08-31 (OTP login, cross-module consistency) |
| J. Platform Owner/Subscription | `/platform/*` (clubs,owners,plans,trials,leads=contact_requests,reports,alerts,audit,support-history,staff,roles,settings) | Baseline PROVEN |
| K. Frontend/UX/RTL | cross-cutting | Baseline PROVEN 2026-08-31 (375-1440px, RTL, a11y basics) |
| L. Security/Abuse | cross-cutting | Baseline PROVEN 2026-08-24/09-03; fresh spot-check in progress for Sales Intelligence delta |
| M. Production/Deployment | Cloudflare Worker + Supabase | Baseline PROVEN; SOURCE=BUILD=RUNTIME confirmed holding at HEAD this session (no diff) |
| N. Adversarial QA | cross-cutting | Baseline PROVEN 2026-09-03 (full multi-tenant red team); fresh delta spot-check in progress |
| O. Commercial Sellability | synthesis | Pending final reconciliation |

**NEW since 2026-09-03 baseline — not yet through the same adversarial pass**: Sales Intelligence module (`/platform/sales/*` — discover, leads, pipeline, campaigns, followups, settings). Platform-Owner-only, never tenant-scoped (by design, confirmed correct). RLS enabled on all 20 `sales_*` tables (confirmed via full migration sweep — zero tables found without RLS across the ENTIRE migration history, a strong structural baseline). Fully wired into real UI/nav (`PlatformLayout.tsx` sidebar section), not backend-only.

## Stateful entities / state machines

- `bookings`: pending_payment → confirmed → checked_in → completed; cancelled/no_show terminal. QR check-in is sole confirmed→checked_in path (row-locked).
- `qr_credentials`: active → consumed/expired/revoked.
- `invoices`: independent lifecycle from booking status; conditionally voided on cancellation (never touched once `paid>0`). `record_payment()` is the single converging write-enforcement point (SP-001).
- `enrollments`: active/withdrawn.
- Academy `subscriptions`: pending → active → frozen/expired/cancelled.
- `sales_leads`: 13-state pipeline (discovered → ... → won/lost).
- `sales_discovery_jobs`: pending → running → completed/partial/failed/retryable.
- `sales_outreach_messages`: dual status dimensions — `status` (generated→approved→queued→sent→failed/rejected) AND separate `quality_status` (added later, 20260904190000) — worth a combination-matrix check, flagged by architecture-reviewer as a real complexity/defect-risk pattern (this exact pipeline had its 5th same-day hotfix land at HEAD).
- Sales→tenant conversion: separate schema bridging a WON lead to a real `club_owner` tenant — cross-domain boundary worth explicit testing.

## External integrations — connected vs. skeleton

**Connected, real calls**: Resend (in+outbound, verified both directions), Stripe/PayPal/Paymob/Kashier/Fawry (checkout+refund+webhook per gateway — connection-credential status TBD, check in Phase 9), Google Places (Sales Intelligence discovery only), `sales-website-enrichment` (self-built fetch scraper, no SDK).

**WhatsApp**: NOT in `supabase/functions/` — separate 3-tier deployment (Cloudflare Worker+DO → Container → `@whiskeysockets/baileys` unofficial protocol client). Materially different trust boundary than the rest of the stack. Correction: 2 cross-tenant IDOR bugs WERE previously found and fixed (WHATSAPP_PRODUCTION_HARDENING_FINAL_ACCEPTANCE_REPORT.md §2.2) and independently re-confirmed still holding in a later pass (WHATSAPP_FINAL_INDEPENDENT_ACCEPTANCE_AUDIT.md: "2 cross-tenant IDOR fixes still hold" — CONFIRMED). RLS on `whatsapp_accounts` is enabled+forced with zero policies (correct deny-by-default), all connect/disconnect/QR/status/retry RPCs gate on `user_club_ids()` + a specific permission. Anti-abuse layer (consent, quiet hours, rate limits, circuit breaker, dedup) documented in README.md as shipped. No unresolved WhatsApp security finding carried forward from memory — this module is CLOSED per prior independent audit, not re-litigated here absent new cause.

## Confirmed dead/orphaned (not a defect, just unused)

`scripts/generate-marketing-images.mjs` and `public/images/marketing/*` — zero references anywhere in `src/`/`public/`, not wired into any package.json script beyond manual invocation. Untracked, in-progress marketing asset work with no current effect on the live product. Not a certification blocker.

## Structural notes for test planning

- Zero tables found without RLS across the entire migration history (strong baseline, worth a regression gate going forward).
- DB state machines use `text CHECK (...)` constraints, not Postgres enums — status typos bypass compile-time safety, caught only at write time by the CHECK. Newest (Sales Intelligence) code leans more heavily on loosely-typed PL/pgSQL `record` types, correlating with more post-deploy hotfixes (5 same-day fixes 20260904130000-200000).
- `/platform/leads` (legacy `contact_requests` inbox) vs `/platform/sales/leads` (`sales_leads`) — real naming collision, P3 dev-experience risk only.
