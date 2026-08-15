# Implementation Plan

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021 for the reasoning behind the database/security changes reflected in the phases below.
>
> **Added 2026-08-15 (later):** Phase 3b — Platform Billing, covering [DECISIONS.md](DECISIONS.md) ADR-022 through ADR-026 (Mala3by charging clubs to use the platform).

> **⚠️ GIT POLICY: LOCAL ONLY.** Every phase below ends with a **local** stable commit and a stop. `git push`, GitHub repository creation, GitHub Actions, and any Cloudflare/production-Supabase action are blocked until a separate, explicit go-ahead — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 5b. Phases 17 and 18 describe the target end-state and remain in the plan for sequencing purposes, but are **not** to be executed under the current authorization.

19 phases (18 + 3b). RLS and multi-tenancy land before any domain data (retrofitting tenant isolation onto a live model is the most expensive rebuild this project could suffer). Platform Billing (3b) lands immediately after Staff/Permissions — it depends only on `clubs` and Platform Owner role/permission plumbing from Phases 2-3, and every later phase's grace-period write-gating (`auth.club_write_allowed()`) depends on it existing first. Booking lands before Academy so Academy can reuse the same billing/QR/RPC pattern instead of inventing a parallel one. Dashboards/reports are woven into the phase that produces their data rather than one late catch-all phase. See [DECISIONS.md](DECISIONS.md) for why this reorders the original brief's Section 89 sequence.

No phase begins until the previous phase's exit gate passes. "Done" for any feature follows [PROJECT_RULES.md](PROJECT_RULES.md) rule 9 (Definition of Done) in addition to the phase-specific acceptance criteria below. **Phase discipline (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 14): at the end of every phase — run tests, run build, review migrations, review RLS, review `git diff`, update docs, update `PROJECT_STATE.md`, local stable commit, stop and report. Do not auto-continue into the next phase.**

---

### Phase 0 — Foundations
**Goal:** repo, tooling, docs skeleton, design tokens in place.
**Tasks:** Vite+React+TS+Tailwind+shadcn init; ESLint/Prettier config; `docs/*.md` skeletons (this set); `.env.example`; `.gitignore`; git init; Supabase CLI local init (`supabase init`).
**DB work:** none yet — just `supabase/` folder scaffolding.
**Security work:** `.gitignore` verified to exclude `.env`, `*.local`, service role keys.
**Tests:** none yet.
**Exit gate:** `npm run dev` and `npm run build` succeed on an empty shell; `supabase start` runs locally without error.

### Phase 1 — Design System + App Shell
**Goal:** navigation shell, RTL/LTR toggle, shared UI primitives.
**Frontend work:** desktop sidebar nav, mobile bottom nav, status badge component set (pending/confirmed/completed/cancelled/overdue), loading/empty/error state patterns, dialog/drawer patterns (shadcn).
**Tests:** component-level render tests for shared primitives.
**Exit gate:** shell renders correctly RTL and LTR, responsive at mobile/tablet/desktop breakpoints, no real data wired yet.

### Phase 2 — Auth + Multi-Tenant Core + RLS
**Goal:** the tenant boundary exists and is proven, before any domain table is built on top of it.
**Database work:** `profiles`, `roles`, `permissions`, `role_permissions`, `club_memberships`, `membership_branches`, `clubs` (no `organization_id` column — see [DECISIONS.md ADR-011](DECISIONS.md#adr-011--organizations-removed-entirely-from-v1-schema)), `branches` + full RLS policies per [RLS_MATRIX.md](RLS_MATRIX.md). Seed roles/permissions. Every `SECURITY DEFINER` helper (`auth.user_club_ids()`, `auth.has_permission()`, `auth.has_branch_access()`) follows the [RLS_SECURITY.md](RLS_SECURITY.md) checklist from the first line of code, not retrofitted later.
**Frontend work:** login/signup, club-switcher (for users with >1 membership).
**Security work:** helper functions with pinned `search_path`; verify no service role key in frontend bundle.
**Tests:** pgTAP cross-club isolation matrix — **this is the gate, not optional.**
**Exit gate:** two seeded test clubs, two test users; automated test proves User A cannot read/write Club B data via any path, including a raw PostgREST call.

### Phase 3 — Staff & Permissions Management
**Goal:** clubs can manage their own staff.
**Frontend work:** invite staff, assign role + branch scope (via `membership_branches` — zero rows = all branches, explicit rows = restricted to those branches, see [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column)), deactivate staff.
**Database work:** none new — CRUD on Phase 2 tables via RLS-gated RPCs where multi-table.
**Tests:** permission-boundary test (a Receptionist cannot assign roles); a membership with explicit `membership_branches` rows for Branch 1 only cannot act on Branch 2.
**Exit gate:** Club Owner creates a Receptionist account scoped to one branch; that account's session reflects correct, narrower permissions immediately.

### Phase 3b — Platform Billing
**Goal:** Mala3by can bill clubs for platform usage, structurally separate from a club's own customer billing (see [DECISIONS.md ADR-022](DECISIONS.md#adr-022--platform-billing-is-a-structurally-separate-domain-from-club-billing)). This must exist before later phases' write-gating depends on it.
**Database work:** `platform_plans` (one seeded row), `platform_subscriptions`, `platform_invoices`, `platform_payments` — Platform-Owner-only RLS on all four (see [DECISIONS.md ADR-023](DECISIONS.md#adr-023--single-flat-platform-plan-manually-managed-in-v1)/[ADR-024](DECISIONS.md#adr-024--platform-subscription-payment-is-manualoffline-in-v1)). `clubs.status` enum widened to `active` | `grace_period` | `suspended`. New `auth.club_write_allowed(p_club_id, p_action_category)` helper (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-billing-strategy)), computing effective status lazily from `platform_subscriptions` at query time — no scheduled job. Record-payment RPC that moves a club back to `active` and clears `grace_period_started_at`.
**Frontend work:** Platform Owner screen: list clubs with subscription status, record a platform payment, view/edit `price_override`/`grace_period_days` per club. Club-side: a small read-only "Platform Subscription" summary card in Club Settings (status, next due date) sourced from a restricted view, not direct table access.
**Security work:** all four platform billing tables verified inaccessible to any non-`platform_owner` role, including Club Owner, via direct query; `auth.club_write_allowed()` follows the [RLS_SECURITY.md](RLS_SECURITY.md) `SECURITY DEFINER` checklist.
**Tests:** a club with an overdue `platform_invoices` row and no payment transitions to `grace_period` then `suspended` at the correct elapsed times (including a per-club `grace_period_days` override); recording a `platform_payments` row immediately restores `active` regardless of countdown position; grace-period write-gating verified per category — `bookings`/`enrollments`/`subscriptions` INSERT rejected (`new_commitment`), `payments`/`refunds` INSERT against existing invoices succeeds (`settle_existing`), `attendance` marking for an already-scheduled session succeeds (`operational_continuity`); `suspended` rejects all writes regardless of category; Club Owner cannot read/write another club's or their own `platform_invoices`/`platform_payments` rows directly.
**Exit gate:** a seeded test club can be moved through `active → grace_period → suspended → active` (via manual payment) with each transition's write-gating behavior verified exactly as specified in [DECISIONS.md ADR-026](DECISIONS.md#adr-026--grace-period-blocks-new-commitments-but-allows-collecting-on-existing-ones); no non-Platform-Owner role can access platform billing tables directly.

### Phase 4 — Customers, Players, Guardians
**Goal:** the people model.
**Database work:** `customers`, `players`, `guardian_links` + RLS.
**Frontend work:** search, create, edit for customers and players; guardian linking UI.
**Tests:** guardian↔player many-to-many correctness; club-scoped search returns no cross-club leakage.
**Exit gate:** create a guardian, link 2 players, search by name/mobile returns correct results scoped to one club only.

### Phase 5 — Fields, Operating Hours, Pricing
**Goal:** the bookable inventory and its price resolution.
**Database work:** `fields`, `field_operating_hours`, `field_blocks`, `pricing_rules` + RLS.
**Frontend work:** field management, operating hours editor, blocks/maintenance calendar, pricing rule editor.
**Tests:** price resolution correctness (priority ordering, overlapping rules).
**Exit gate:** create a field, set hours, set a 2-tier weekday/weekend price rule; querying "price for field X at time Y" returns the correct value.

### Phase 6 — Booking Engine
**Goal:** the core operational loop, concurrency-safe.
**Database work:** `bookings` table (money columns `numeric(12,2)`) with generated `during` column + exclusion constraint blocking on `pending_payment`/`confirmed`/`checked_in` (see [DECISIONS.md ADR-021](DECISIONS.md#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in)); `create_booking` RPC covering validate→booking→invoice→optional payment→allocation in one transaction, with QR generation as a separate idempotent follow-up (`ensure_booking_qr`), never a hard dependency of the financial transaction. RPC additionally checks `auth.club_write_allowed(club_id, 'new_commitment')` (from Phase 3b) before creating a new booking.
**Frontend work:** day-view calendar grid (rows=slots, columns=fields), quick booking form, booking detail/cancel.
**Security work:** RLS on `bookings`; discount action gated by `booking.discount` permission; `create_booking` RPC follows the [RLS_SECURITY.md](RLS_SECURITY.md) checklist.
**Dependency:** Phase 3b (`auth.club_write_allowed`) must exist first.
**Tests:** concurrent booking attempt (two simultaneous inserts for the same slot — exactly one must succeed); exclusion constraint holds against direct RPC bypass attempts; boundary test confirming `10:00–11:00` and `11:00–12:00` do not overlap.
**Exit gate:** full reception booking flow works end-to-end including price calculation; double-booking is provably impossible under a concurrency test, not just "seems to work in manual testing."

### Phase 7 — Billing Core
**Goal:** the financial ledger.
**Database work:** `invoices` (numbering via `clubs.club_code`/`branches.branch_code`, never a hardcoded prefix), `invoice_items`, `payments` (**no `invoice_id` column** — see [DECISIONS.md ADR-011b](DECISIONS.md#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship)), `payment_allocations` (the sole payment↔invoice link, with a trigger enforcing `SUM(amount) per payment_id ≤ payments.amount`), `refunds` (append-only, atomic RPC validating against refundable balance before insert — see [DECISIONS.md ADR-011c](DECISIONS.md#adr-011c--refund-model-refunds-table--reversing-allocation-atomic-rpc)), `invoice_number_sequences` + numbering RPC + RLS. All money columns `numeric(12,2)`. Payment/refund RPCs check `auth.club_write_allowed(club_id, 'settle_existing')` — this is the category deliberately still **allowed** during a club's own `grace_period` (see [DECISIONS.md ADR-026](DECISIONS.md#adr-026--grace-period-blocks-new-commitments-but-allows-collecting-on-existing-ones)), distinct from `platform_payments` in Phase 3b, which is the club paying *Mala3by*, not its own customers.
**Frontend work:** invoice view, payment collection form, refund flow, A4 + 80mm print CSS.
**Tests:** invoice numbering under concurrent calls (parallel connections, no duplicate/gap issues); allocation-sum check trigger; refund flow leaves the ledger consistent and cannot exceed refundable balance even under concurrent refund attempts on the same payment.
**Exit gate:** booking produces a correctly numbered invoice; partial payment + refund both reflected correctly in the derived outstanding balance (computed from `payment_allocations`, not any stored `amount_paid` column); both print layouts render correctly on paper or accurate print-preview.

### Phase 8 — QR + Scanner + Check-in
**Goal:** secure check-in with a clear separation between validation and mutation.
**Database work:** `qr_credentials` (`type`: `booking` | `player_membership` only; `single_use` varies by type) + `qr_scan_events` (every scan logged, regardless of outcome) + RLS. Two RPCs for booking check-in: a read-only validate/lookup, and a separate atomic confirm-check-in that consumes the credential and transitions `bookings.status → checked_in` together (see [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation)). Player QR validation never mutates the credential.
**Frontend work:** `/scan` PWA page with camera access, QR generation on booking confirm, validate-then-confirm check-in UI (two explicit steps, not one), check-in result screen (four unambiguous outcomes: VALID / ALREADY USED / EXPIRED / INVALID, plus WRONG CLUB).
**Security work:** token hashing verified end-to-end (raw token never persisted); offline fail-closed + manual override path with audit logging; scan/confirm RPCs follow [RLS_SECURITY.md](RLS_SECURITY.md).
**Tests:** replay test (second confirm attempt on a consumed token fails cleanly); expiry test; wrong-club token test; player QR scanned twice in a row both succeed (reusable, not consumed) with two `qr_scan_events` rows; a scan alone (no confirm) never changes `bookings.status`.
**Exit gate:** booking → QR → scan (validate) → confirm → check-in works on a real phone camera; replay of the confirm step is blocked and clearly reported with original timestamp/staff; every scan attempt — successful or not — appears in `qr_scan_events`.

### Phase 9 — Reception & Manager Dashboards
**Goal:** the daily operational views.
**Frontend work:** Today Ops Center (fields/academy/finance/alerts summary), Reception operational view (Now/Next/Quick Actions).
**Database work:** dashboard RPCs/views reading Phase 6-8 data — no new tables.
**Tests:** N+1 query check (each dashboard widget loads in one query pass).
**Exit gate:** dashboards reflect real booking/payment data live; no widget triggers more than one query per render.

### Phase 10 — Academy Structure
**Goal:** programs, groups, and coach assignment exist.
**Database work:** `programs`, `seasons`, `age_groups`, `groups` (with `capacity`), `group_schedule_slots` + RLS (including Coach's restricted visibility).
**Frontend work:** program/season management, group creation with schedule + coach assignment.
**Exit gate:** create a program → group → assign coach → set a weekly schedule; Coach sees only their assigned group.

### Phase 11 — Enrollment + Subscriptions + Installments
**Goal:** academy revenue lifecycle.
**Database work:** `enrollments` with concurrency-safe capacity check RPC (`SELECT ... FOR UPDATE` on `groups`, re-validated inside the same transaction as the insert), `subscriptions` (`enrollment_id` unique — one subscription per enrollment, a deliberate rule, see [DECISIONS.md ADR-013b](DECISIONS.md#adr-013b--one-subscription--one-enrollment-in-v1-is-a-deliberate-rule)), `subscription_freezes` + effective-expiry derivation RPC (freeze extends expiry per [DECISIONS.md ADR-008](DECISIONS.md#adr-008--subscription-freeze-extends-expiry-by-default) — `subscriptions.end_date` is never overwritten in place, only the derived `effective_end_date` reflects freeze extensions). Activation RPC branches on `clubs.subscription_activation_policy` (`manual` | `first_payment` [default] | `full_payment` — see [DECISIONS.md ADR-013](DECISIONS.md#adr-013--subscription-activation-policy-is-a-club-setting-not-a-hardcoded-rule)). Enrollment/subscription creation RPCs check `auth.club_write_allowed(club_id, 'new_commitment')`; installment payments against an existing subscription use `'settle_existing'`, same as Phase 7.
**Frontend work:** enrollment wizard (guardian→player→program→group→subscription→invoice→payment), freeze UI, installment schedule view, a simple activation-policy dropdown in club settings.
**Tests:** installment/outstanding-balance correctness against the ledger (via `payment_allocations`); freeze correctly derives `effective_end_date` without mutating `end_date`; expiry transition test; concurrent enrollment race test (two receptionists enrolling into the last group spot — exactly one succeeds); each of the three activation policy values produces correct activation behavior.
**Exit gate:** full enrollment flow works end-to-end and activates per the club's configured policy; freeze correctly pauses and the derived effective expiry extends; a full concurrency test proves group capacity cannot be oversold.

### Phase 12 — Sessions + Attendance
**Goal:** the coach's daily workflow.
**Database work:** on-demand session generation RPC, idempotent via `INSERT ... ON CONFLICT (group_id, session_date, start_time) DO NOTHING`; `attendance` table with unique `(session_id, player_id)` — marking again is always an `UPDATE`, never a second insert — + RLS.
**Frontend work:** Coach Today view, session detail, manual + QR attendance marking (player QR is reusable — scan validates + upserts attendance in one step, does not consume the credential).
**Tests:** session generation idempotency (re-running doesn't duplicate, verified against the `(group_id, session_date, start_time)` constraint); attendance RLS restricts coach to assigned sessions only; marking the same player twice in one session updates, never duplicates.
**Exit gate:** coach sees today's sessions with correct roster, marks attendance, QR attendance works against `qr_credentials` type `player_membership` and correctly logs to `qr_scan_events` without consuming the credential.

### Phase 13 — Reports (Financial, Field, Academy, Customer)
**Goal:** the reports the brief asked for, built on data that already exists and is stable.
**Database work:** report RPCs/views (`get_revenue_report`, field occupancy, academy attendance/expiry, customer activity).
**Frontend work:** Reports Hub UI with filters (date, branch, field, employee, payment method).
**Tests:** each report's output matches manually-verified totals against seeded test data.
**Exit gate:** all report categories from [PROJECT_BRIEF](../README.md) Sections 53-56 return correct figures against known seed data.

### Phase 14 — Audit Log + Security Hardening
**Goal:** full accountability trail and an independent security pass.
**Database work:** audit triggers/RPC logging across the action list in [RLS_MATRIX.md](RLS_MATRIX.md#audit-trigger-scope); audit RLS with **no UPDATE/DELETE policy for any role** (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)); `players.medical_notes` column-protection pattern implemented per [RLS_SECURITY.md](RLS_SECURITY.md#sensitive-column-protection-medical_notes) if not already done in Phase 4.
**Frontend work:** Audit Log Viewer screen.
**Security work:** full RLS re-audit across every table (not just the ones tested per-phase); Storage bucket policy review; **full `SECURITY DEFINER` function audit against the [RLS_SECURITY.md](RLS_SECURITY.md#verification-checklist-part-of-phase-14-gate) checklist** — every privileged function checked for pinned `search_path`, no trusted client-supplied `club_id`, `auth.uid()`-only identity, internal permission check, scoped `EXECUTE` grants, and a passing cross-tenant test.
**Tests:** every action in the audit scope list produces a correct row with before/after; an independent pass confirms no tenant-scoped table lacks RLS; audit log UPDATE/DELETE attempts rejected for every role including Club Owner and Platform Owner.
**Exit gate:** audit list fully covered; zero tables found without RLS in the re-audit; zero `SECURITY DEFINER` functions found without the mandatory checklist satisfied.

### Phase 15 — PWA + Responsive + Print QA
**Goal:** the product actually works as a PWA on real devices.
**Frontend work:** manifest, service worker (Workbox — app shell + static assets only), install flow.
**Tests:** manual QA — install on real Android/iOS home screen, reload-after-install, full responsive pass down to 375px width, real print test (A4 + thermal, actual printer if available).
**Exit gate:** installs on a real phone home screen and works after reload; all screens usable at 375px; both print layouts verified.

### Phase 16 — End-to-End QA
**Goal:** every flow in [USER_FLOWS.md](USER_FLOWS.md) works start-to-finish with fresh data.
**Tests:** manual run of all 7 documented flows; bug triage and fixes.
**Exit gate:** no P0/P1 bugs open.

### Phase 17 — Stable GitHub Release *(target end-state — NOT authorized to execute under current LOCAL-ONLY policy)*
**Goal:** the repo is a clean, reproducible artifact, ready for the moment GitHub push is explicitly authorized.
**Tasks:** final documentation pass (every `docs/*.md` current), local tag `v1.0.0`. **No `git push`, no GitHub repository creation** — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 5b.
**Exit gate:** a fresh clone (once pushed, when authorized) + `supabase start` + `npm install` + `npm run dev` reproduces a working app with zero undocumented manual steps. Until then, this is verified locally via a fresh local clone/checkout instead.

### Phase 18 — Cloudflare + Production Supabase Deployment *(target end-state — NOT authorized to execute under current LOCAL-ONLY policy)*
**Goal:** live for the pilot club, once deployment is explicitly authorized.
**Tasks:** create production Supabase project, apply migrations, connect Cloudflare Pages to `main`, set environment variables, smoke test in production. **Blocked until a separate, explicit go-ahead** — see [PROJECT_RULES.md](PROJECT_RULES.md) rule 5b.
**Exit gate:** the pilot club can log in and complete one real booking + one real enrollment in production.

---

## V1 / Deferred Matrix

| Feature | V1 | V1.1 | Later | Reason |
|---|---|---|---|---|
| Auth, RBAC, RLS, multi-club/branch | ✅ | | | Core architecture — cannot be retrofitted cheaply |
| Customers, players, guardians | ✅ | | | Required by every other flow |
| Fields, hours, pricing rules | ✅ | | | Required for booking |
| Booking engine + double-booking protection | ✅ | | | Core revenue flow |
| Invoices, payments, refunds | ✅ | | | Core revenue flow |
| QR + scanner + check-in | ✅ | | | Core operational flow |
| Academy (programs/groups/enrollment/subscriptions/installments) | ✅ | | | Core revenue flow, second use case |
| Sessions + attendance | ✅ | | | Required for academy operations |
| Dashboards (Today, Reception) | ✅ | | | Daily operational necessity |
| Basic reports (revenue, occupancy, academy, customer) | ✅ | | | Requested explicitly, low incremental cost once data exists |
| Audit log | ✅ | | | Required for financial/security accountability |
| PWA, print (A4+80mm), Arabic RTL, responsive | ✅ | | | Core product requirement |
| Platform Billing (single plan, manual payment, grace period) | ✅ | | | Explicit V1 requirement — Mala3by's own revenue model — see [DECISIONS.md ADR-022](DECISIONS.md#adr-022--platform-billing-is-a-structurally-separate-domain-from-club-billing) through ADR-026 |
| Platform Billing: tiered plans / feature gating | | ✅ (when signal exists) | | No current justification for multiple tiers with one pilot club — see [DECISIONS.md ADR-023](DECISIONS.md#adr-023--single-flat-platform-plan-manually-managed-in-v1) |
| Platform Billing: online payment gateway for platform fees | | | ✅ | Consistent with existing zero-cost/no-gateway V1 rule — see [DECISIONS.md ADR-024](DECISIONS.md#adr-024--platform-subscription-payment-is-manualoffline-in-v1) |
| `organizations` layer | | | ✅ (when a real need appears) | Fully removed from V1 schema, not even a placeholder column — see [DECISIONS.md ADR-011](DECISIONS.md#adr-011--organizations-removed-entirely-from-v1-schema). Added as a genuine new table + migration only when a real multi-club operator customer exists. |
| Cash Shift / register reconciliation | | ✅ | | Self-contained, zero coupling to core schema |
| Expenses module | | ✅ | | Doesn't block revenue flows |
| Utilization Heatmap | | ✅ | | Pure read-model over existing data, free to add later |
| Full booking state machine (Draft/Pending distinct) | | (if usage shows need) | | 6 states cover real flows; add if a real gap appears |
| Full English content parity | | ✅ | | Arabic-first confirmed decision (ADR-010) |
| WhatsApp/SMS notifications | | | ✅ | Paid service, explicitly deferred |
| Online payment gateway | | | ✅ | Explicitly out of scope |
| Customer self-service portal | | | ✅ | Explicitly deferred, scope control |
| Native mobile apps | | | ✅ | PWA covers V1 needs |
| Public API / webhooks | | | ✅ | No consumer yet |
| AI features | | | Never (current plan) | Explicitly excluded |
| Full ERP accounting / payroll | | | Never (current plan) | Explicitly excluded — not this product's job |

## Build Order Rationale (summary)

1. **RLS before any domain data** — the tenant boundary is the one thing every later phase must inherit for free; retrofitting it onto live data is the most expensive possible rebuild.
2. **Platform Billing (3b) immediately after Staff/Permissions, before any customer-facing domain** — every subsequent write-heavy RPC (booking, payment, enrollment) calls `auth.club_write_allowed()`, so that helper and the tables behind it must exist first, not be retrofitted into already-built RPCs later.
3. **Booking before Academy** — proves the exclusion-constraint/RPC/QR/invoice pattern once; Academy then reuses the same billing/QR infrastructure instead of a parallel implementation.
4. **Dashboards/reports placed right after the data that feeds them exists**, not deferred to one late mega-phase — avoids a late integration phase that's really just "go query things built weeks ago."
5. **Audit + hardening as its own late phase**, added to tables that are already stable — cheaper and less error-prone than building audit alongside a still-changing schema.
