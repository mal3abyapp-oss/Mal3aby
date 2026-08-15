# Implementation Plan

18 phases. RLS and multi-tenancy land before any domain data (retrofitting tenant isolation onto a live model is the most expensive rebuild this project could suffer). Booking lands before Academy so Academy can reuse the same billing/QR/RPC pattern instead of inventing a parallel one. Dashboards/reports are woven into the phase that produces their data rather than one late catch-all phase. See [DECISIONS.md](DECISIONS.md) for why this reorders the original brief's Section 89 sequence.

No phase begins until the previous phase's exit gate passes. "Done" for any feature follows [PROJECT_RULES.md](PROJECT_RULES.md) rule 9 (Definition of Done) in addition to the phase-specific acceptance criteria below.

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
**Database work:** `profiles`, `roles`, `permissions`, `role_permissions`, `club_memberships`, `clubs`, `branches` + full RLS policies per [RLS_MATRIX.md](RLS_MATRIX.md). Seed roles/permissions.
**Frontend work:** login/signup, club-switcher (for users with >1 membership).
**Security work:** helper functions (`auth.user_club_ids()`, `auth.has_permission()`); verify no service role key in frontend bundle.
**Tests:** pgTAP cross-club isolation matrix — **this is the gate, not optional.**
**Exit gate:** two seeded test clubs, two test users; automated test proves User A cannot read/write Club B data via any path, including a raw PostgREST call.

### Phase 3 — Staff & Permissions Management
**Goal:** clubs can manage their own staff.
**Frontend work:** invite staff, assign role + branch scope, deactivate staff.
**Database work:** none new — CRUD on Phase 2 tables via RLS-gated RPCs where multi-table.
**Tests:** permission-boundary test (a Receptionist cannot assign roles).
**Exit gate:** Club Owner creates a Receptionist account scoped to one branch; that account's session reflects correct, narrower permissions immediately.

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
**Database work:** `bookings` table with generated `during` column + exclusion constraint; `create_booking` RPC.
**Frontend work:** day-view calendar grid (rows=slots, columns=fields), quick booking form, booking detail/cancel.
**Security work:** RLS on `bookings`; discount action gated by `booking.discount` permission.
**Tests:** concurrent booking attempt (two simultaneous inserts for the same slot — exactly one must succeed); exclusion constraint holds against direct RPC bypass attempts.
**Exit gate:** full reception booking flow works end-to-end including price calculation; double-booking is provably impossible under a concurrency test, not just "seems to work in manual testing."

### Phase 7 — Billing Core
**Goal:** the financial ledger.
**Database work:** `invoices`, `invoice_items`, `payments`, `payment_allocations`, `refunds`, `invoice_number_sequences` + numbering RPC + RLS.
**Frontend work:** invoice view, payment collection form, refund flow, A4 + 80mm print CSS.
**Tests:** invoice numbering under concurrent calls (parallel connections, no duplicate/gap issues); allocation-sum check trigger; refund flow leaves the ledger consistent.
**Exit gate:** booking produces a correctly numbered invoice; partial payment + refund both reflected correctly in the derived outstanding balance; both print layouts render correctly on paper or accurate print-preview.

### Phase 8 — QR + Scanner + Check-in
**Goal:** secure, atomic check-in.
**Database work:** `qr_credentials` + atomic consume RPC + RLS.
**Frontend work:** `/scan` PWA page with camera access, QR generation on booking confirm, check-in result screen (four unambiguous outcomes).
**Security work:** token hashing verified end-to-end (raw token never persisted); offline fail-closed + manual override path with audit logging.
**Tests:** replay test (second scan of a consumed token fails cleanly); expiry test; wrong-club token test.
**Exit gate:** booking → QR → scan → check-in works on a real phone camera; replay is blocked and clearly reported with original timestamp/staff.

### Phase 9 — Reception & Manager Dashboards
**Goal:** the daily operational views.
**Frontend work:** Today Ops Center (fields/academy/finance/alerts summary), Reception operational view (Now/Next/Quick Actions).
**Database work:** dashboard RPCs/views reading Phase 6-8 data — no new tables.
**Tests:** N+1 query check (each dashboard widget loads in one query pass).
**Exit gate:** dashboards reflect real booking/payment data live; no widget triggers more than one query per render.

### Phase 10 — Academy Structure
**Goal:** programs, groups, and coach assignment exist.
**Database work:** `programs`, `seasons`, `age_groups`, `groups`, `group_schedule_slots` + RLS (including Coach's restricted visibility).
**Frontend work:** program/season management, group creation with schedule + coach assignment.
**Exit gate:** create a program → group → assign coach → set a weekly schedule; Coach sees only their assigned group.

### Phase 11 — Enrollment + Subscriptions + Installments
**Goal:** academy revenue lifecycle.
**Database work:** `enrollments`, `subscriptions`, `subscription_freezes` + status-derivation RPC (freeze extends expiry per [DECISIONS.md ADR-008](DECISIONS.md#adr-008--subscription-freeze-extends-expiry-by-default)).
**Frontend work:** enrollment wizard (guardian→player→program→group→subscription→invoice→payment), freeze UI, installment schedule view.
**Tests:** installment/outstanding-balance correctness against the ledger; freeze correctly shifts `end_date`; expiry transition test (subscription auto-flags expired after `end_date`).
**Exit gate:** full enrollment flow works end-to-end and reaches `active` status on first payment; freeze correctly pauses and extends expiry.

### Phase 12 — Sessions + Attendance
**Goal:** the coach's daily workflow.
**Database work:** on-demand session generation RPC (idempotent upsert per `group_id`+`session_date`), `attendance` table + RLS.
**Frontend work:** Coach Today view, session detail, manual + QR attendance marking.
**Tests:** session generation idempotency (re-running doesn't duplicate); attendance RLS restricts coach to assigned sessions only.
**Exit gate:** coach sees today's sessions with correct roster, marks attendance, QR attendance works against `qr_credentials` type `player_membership`.

### Phase 13 — Reports (Financial, Field, Academy, Customer)
**Goal:** the reports the brief asked for, built on data that already exists and is stable.
**Database work:** report RPCs/views (`get_revenue_report`, field occupancy, academy attendance/expiry, customer activity).
**Frontend work:** Reports Hub UI with filters (date, branch, field, employee, payment method).
**Tests:** each report's output matches manually-verified totals against seeded test data.
**Exit gate:** all report categories from [PROJECT_BRIEF](../README.md) Sections 53-56 return correct figures against known seed data.

### Phase 14 — Audit Log + Security Hardening
**Goal:** full accountability trail and an independent security pass.
**Database work:** audit triggers/RPC logging across the action list in [RLS_MATRIX.md](RLS_MATRIX.md#audit-trigger-scope); audit viewer RLS.
**Frontend work:** Audit Log Viewer screen.
**Security work:** full RLS re-audit across every table (not just the ones tested per-phase); Storage bucket policy review.
**Tests:** every action in the audit scope list produces a correct row with before/after; an independent pass confirms no tenant-scoped table lacks RLS.
**Exit gate:** audit list fully covered; zero tables found without RLS in the re-audit.

### Phase 15 — PWA + Responsive + Print QA
**Goal:** the product actually works as a PWA on real devices.
**Frontend work:** manifest, service worker (Workbox — app shell + static assets only), install flow.
**Tests:** manual QA — install on real Android/iOS home screen, reload-after-install, full responsive pass down to 375px width, real print test (A4 + thermal, actual printer if available).
**Exit gate:** installs on a real phone home screen and works after reload; all screens usable at 375px; both print layouts verified.

### Phase 16 — End-to-End QA
**Goal:** every flow in [USER_FLOWS.md](USER_FLOWS.md) works start-to-finish with fresh data.
**Tests:** manual run of all 7 documented flows; bug triage and fixes.
**Exit gate:** no P0/P1 bugs open.

### Phase 17 — Stable GitHub Release
**Goal:** the repo is a clean, reproducible artifact.
**Tasks:** final documentation pass (every `docs/*.md` current), tag `v1.0.0`.
**Exit gate:** a fresh clone + `supabase start` + `npm install` + `npm run dev` reproduces a working app with zero undocumented manual steps.

### Phase 18 — Cloudflare + Production Supabase Deployment
**Goal:** live for the pilot club.
**Tasks:** create production Supabase project, apply migrations, connect Cloudflare Pages to `main`, set environment variables, smoke test in production.
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
| `organizations` layer | | ✅ (schema-ready now) | | No real multi-club operator customer yet |
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
2. **Booking before Academy** — proves the exclusion-constraint/RPC/QR/invoice pattern once; Academy then reuses the same billing/QR infrastructure instead of a parallel implementation.
3. **Dashboards/reports placed right after the data that feeds them exists**, not deferred to one late mega-phase — avoids a late integration phase that's really just "go query things built weeks ago."
4. **Audit + hardening as its own late phase**, added to tables that are already stable — cheaper and less error-prone than building audit alongside a still-changing schema.
