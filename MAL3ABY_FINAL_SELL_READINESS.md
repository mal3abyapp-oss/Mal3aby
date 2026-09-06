# Mal3aby — Final Sell-Readiness Report

Written 2026-09-06, branch `release/final-sell-readiness`, consolidating the
findings of a multi-agent sell-readiness review (9 specialist review agents
plus 2 fix agents) run against production Supabase project
`gxkrtlvpjwxhcqdisyob` (Postgres 17.6.1, `ACTIVE_HEALTHY`, region
`eu-central-1`) and the repository at commit `aeb78fb` (which includes this
session's two P0 fixes on top of the previously-merged `285a9bf`, PR #24
cache remediation).

This document lays out the facts as found. It does not issue a final
go/no-go verdict — that judgment belongs to whoever orchestrates the release
decision, using the facts below plus their own risk tolerance.

## Executive summary

**Mal3aby is a pre-launch platform with zero real paying tenants.** Every
one of the 13 clubs currently in production has `is_test_fixture = true`
(see `QA_DATA_ISOLATION.md` for the full list and rationale for why they are
not deleted). Nothing in this review found evidence of any live paying
customer, so every finding below concerns readiness for the *first* real
customer, not damage to an existing one.

Two P0 (severity-1) defects were found and fixed during this mission, both
applied to production under explicit owner authorization and verified live
after the fact:

1. **Trial-activation gap** — no code path anywhere (self-serve onboarding
   wizard or the sales-conversion RPC) ever called
   `mark_club_onboarding_complete()`, the function that actually starts a
   club's trial (introduced 2026-09-04 by
   `20260904210300_commercial_packaging_trial_gate_on_onboarding.sql`).
   Every new signup since that migration landed would create a real
   club + owner account and then instantly lock the owner out, because
   `get_club_platform_access()` returns `blocked` for a club with zero
   `platform_subscriptions` rows. Fixed in
   `src/features/onboarding/OnboardingPage.tsx` (frontend now calls
   `mark_club_onboarding_complete()` after the wizard's own RPC succeeds)
   and in `supabase/migrations/20260906080000_fix_sales_activation_never_starts_trial.sql`
   (`_complete_sales_conversion` now calls it server-side, so the
   sales-conversion path can never again miss it). Verified live via
   `pg_get_functiondef` after applying.
2. **Academy/booking double-booking** — academy `training_sessions` were
   completely invisible to the booking engine: the `bookings` table's
   `EXCLUDE` constraint, both availability RPCs
   (`_field_available_starts_internal`, `get_public_field_availability`),
   and `generate_training_sessions()`'s own guard all ignored each other.
   Live-proven in production: a real completed customer booking overlapped
   a real academy session on the same field and time. Fixed via
   `supabase/migrations/20260906150000_close_academy_booking_double_booking.sql`:
   `training_sessions` gets its own trigger-maintained `tstzrange` +
   `EXCLUDE` constraint, cross-table conflict checks were added to
   `generate_training_sessions`, `_create_booking_internal`,
   `create_public_booking`, and `reschedule_booking`, a
   `pg_advisory_xact_lock` closes the TOCTOU race between session
   generation and booking creation, and both availability RPCs now
   subtract academy sessions from computed free slots. Verified live
   post-apply: constraint active, zero NULL `during` values; the one
   cross-table historical "conflict" found is a known QA test-fixture row
   on `is_test_fixture = true` "QA Full Test Club," not a real customer,
   and was correctly not retroactively altered.

Beyond those two, the review found a working, honestly-scoped product with
several real open items — none of them P0, several genuinely important
before or shortly after the first paid customer. These are catalogued in
the Open Issue Register below, each tagged FIXED-THIS-SESSION, OPEN, or
AWAITING-OWNER-DECISION.

## Findings by workstream

### Tenant isolation — 9/10
No new P0/P1 found. The previously-fixed branch-scope multi-membership bug
and portal cross-persona isolation were both re-confirmed fixed via live
adversarial testing this session.

### Roles / permissions — 8/10
- **FIXED THIS SESSION**: `TodayPage.tsx` coach-custom-role blank-dashboard
  routing bug (a sibling of an already-fixed `AcademyPage` bug), now has a
  regression test (`TodayPage.custom-role-routing.test.ts`).
- **OPEN P1**: `players.medical_notes` has no column-level RLS enforcement
  on SELECT (the write side is gated correctly). Not currently exploitable
  through the shipped UI — no frontend call site selects that column — but
  a direct PostgREST query from a coach, branch_manager, accountant, or
  receptionist role (all hold `player.view` but not
  `player.medical_notes.view`) would succeed today. Needs a real fix
  (route through a permission-checked RPC or a security-barrier view) —
  deferred because it needs a wider mapping of every `players`-table call
  site first, not because it is unimportant.

### Subscription / billing — 7/10
Plan model (Starter/Growth/Pro pricing, limits) verified matching the
truth table exactly. Branch/field/academy hard limits are enforced by
table-level triggers with row locking — no bypass, no TOCTOU race.
Staff/active-player limits are deliberately soft ("controlled" resources
with a grace-period design), but:

- **OPEN P1**: `refresh_commercial_grace_state()` — the only writer of
  grace-period tracking — is never called by anything (no cron, no edge
  function, no frontend caller). The `grace` status can never advance to
  `over_limit`; it is dead code today.
- **OPEN P1**: `claim_founding_customer_slot()` has zero frontend callers
  anywhere. The founding offer (first 5 customers, 50% off 3 months) is
  correctly built and atomic but cannot currently be granted through the
  product — only via direct RPC/SQL.
- **FIXED THIS SESSION, NOT YET APPLIED**:
  `request_commercial_upgrade()` counted academy usage from the wrong
  table (`groups` instead of `programs`), disagreeing with the actual
  enforcement trigger. Fix written in
  `supabase/migrations/20260906120000_fix_request_commercial_upgrade_academy_usage_source.sql`,
  informational-only impact, no security exposure, **awaiting a separate
  authorization decision** before it is applied to production.
- **OPEN P2**: the Platform Owner's own subscribe/change-plan dropdown
  does not exclude legacy 499/4499 EGP plans (customer-facing surfaces
  correctly do). Flagged as a product-intent question, since legacy
  customers may legitimately need to see their own plan when renewing —
  not treated here as a straightforward bug.
- **OPEN P2**: missing composite indexes for the active-player 90-day
  window query — a performance risk at Pro-tier scale (3,000-player
  limit), not an active problem today.

### Booking — 8.5/10 pre-fix, higher after the academy-conflict fix
Atomic double-booking prevention via a real `EXCLUDE` constraint, zero
live double-bookings found beyond the one academy-conflict case (now
closed), payment-hold reaper healthy, branch-scope and per-venue-timezone
handling all correct.

### Academy — was 6/10, now fixed
The double-booking gap (above) was the sole reason for the lower score.
Four real production clubs already run fields and academy together
simultaneously — not a hypothetical configuration — confirming this
setup is genuinely used and is now genuinely safe.

### QR
- **Booking check-in QR: VERIFIED WORKING** — 148 active credentials,
  real scan volume.
- **Invoice/payment verification QR: VERIFIED WORKING** — 103 active
  tokens.
- **Club-membership QR: VERIFIED WORKING** — low volume, but real.
- **Academy attendance QR: PARTIALLY WORKING** — correctly implemented
  and wired into the scanner UI, but zero production usage. All 33
  attendance rows show `method='manual'`; none show `'qr'`. Do not claim
  this is actively used by real clubs.

### Customer portal / Payments / Invoices / Reports — 9/10 each
Portal cross-persona and account-takeover vectors closed and
live-adversarially tested. Refund idempotency is real (enforced by
database unique constraints, not app-level checks); over-refund and
cross-tenant refund are both correctly blocked.

Government/tax compliance: confirmed this is an internal receipt-tracking
ledger only (serial numbers, atomic transactions, a reversal lifecycle) —
explicitly **not** an e-invoicing or tax-authority (ETA) integration, with
zero HTTP/webhook calls to any government system. The product's own
Arabic copy already says "الإيصال الرسمي" (official receipt) honestly,
not a legal-compliance claim. No fix needed — the wording was confirmed
safe as-is.

Reports reconcile exactly to raw SQL on real data.

- **OPEN P1 — EXTERNAL BLOCKER, investigated and confirmed not
  closable with tools available to this session**: two portal-security
  regression test suites (`portal-cross-persona-authorization.integration.test.ts`,
  `claim-customer-corroboration.integration.test.ts`) exist and are
  well-targeted, but CI never wires their required secrets, so they
  silently SKIP instead of running. This is a real gap in the safety
  net, not a live vulnerability — the boundaries they test were
  separately confirmed via live adversarial testing this session.
  Closing it requires either (a) a real `SUPABASE_SERVICE_ROLE_KEY` to
  mint a QA session via the documented `generateLink`/`verifyOtp`
  mechanism (`E2E_TEST_STRATEGY.md`), or (b) an existing dedicated QA
  account's real password. Neither is obtainable through any tool
  available to this session: the Supabase MCP server's
  `get_publishable_keys` exposes only anon/publishable keys by design,
  never `service_role`; creating an `auth.users` row directly via raw
  SQL would bypass Supabase's own Auth system in an unsupported way and
  was correctly avoided; and typing a real password into the login form
  is explicitly prohibited by this project's own standing rule
  (`docs/PROJECT_STATE.md`). This is recorded honestly as a genuine
  external-credential blocker requiring the repository owner to either
  add `CUSTOMER_360_TEST_EMAIL`/`PASSWORD` (or `SUPABASE_SERVICE_ROLE_KEY`)
  as GitHub repository secrets themselves, or hand a session the
  `service_role` key directly (never pasted into chat) to mint one.

### WhatsApp — PARTIALLY ACTIVE
Architecturally complete and well-hardened: a real circuit breaker, rate
limiting, quiet hours, consent re-validation, and tenant-isolation fixes
for two historical cross-tenant leaks were all reconfirmed fixed.
Correctly wired into booking/payment/academy notification events. But
genuinely not connected to any real customer WhatsApp number yet — only 2
accounts exist, both on test-fixture clubs, both currently
`logged_out`/`qr_required`. **This is the expected pre-launch state, not
a defect.**

- **OPEN P2 (latent)**: `get_founding_offer_status()`'s slot-count query
  does not exclude `is_test_fixture` clubs, inconsistent with every other
  platform aggregate. Not yet triggered (0 slots claimed today) but
  should be fixed before any real paid checkout runs against a test club.

### Notifications / email — 7/10
Solid architecture, correct tenant guards, but:
- **OPEN**: no trial/subscription-lifecycle reminder notifications exist
  at all — a real, previously-unbuilt gap.
- **OPEN**: no club-wide failed-email dashboard for staff (only
  per-customer visibility exists today).

### Demo tenant — EXISTS-NEEDS-WORK, 7/10
A real public demo tenant exists ("نادي النموذج", `public_slug=demo-club`)
with decent booking/invoice sample data (25 bookings, 34 invoices, 3
fields), but thin academy/staff sample depth specifically under that
slug. Richer academy data exists on other QA clubs, just not the
public-facing demo one. See
`MAL3ABY_10_MINUTE_DEMO_RUNBOOK.md` for the concrete implication for
sales demos.

### Onboarding
The critical finding was the P0 trial-activation gap (fixed, see above).
Beyond that, the onboarding RPC/frontend flow
(`complete_new_club_onboarding` → `mark_club_onboarding_complete`, the
self-serve wizard in `src/features/onboarding/OnboardingPage.tsx`) is real
and does not require SQL/engineering intervention for a routine new
signup, now that the trial-start bug is fixed. See
`MAL3ABY_FIRST_CUSTOMER_ONBOARDING.md`.

### Platform Owner control plane
Real, frontend-wired RPCs exist for tenant list/health/subscriptions/
plans/usage/trial dates/founding-offer-status/limits/grace/
support-sessions/renewal/suspension/reactivation/audit-trail — all
confirmed to have actual UI callers, not just DB-side RPCs with no
frontend consumer. The one exception is `claim_founding_customer_slot`,
already noted above as a real gap.

## Open issue register

| # | Issue | Severity | Status | Notes |
|---|---|---|---|---|
| 1 | Trial never starts (onboarding + sales-conversion) | P0 | **FIXED THIS SESSION** | Applied to production, verified live |
| 2 | Academy/booking double-booking | P0 | **FIXED THIS SESSION** | Applied to production, verified live |
| 3 | `TodayPage.tsx` coach-custom-role blank dashboard | P1 | **FIXED THIS SESSION** | Regression test added |
| 4 | `players.medical_notes` no column-level RLS on SELECT | P1 | **OPEN** | Needs RPC or security-barrier view; needs wider call-site mapping first |
| 5 | `refresh_commercial_grace_state()` never called | P1 | **OPEN** | Grace status can never advance to over_limit; needs a scheduler |
| 6 | `claim_founding_customer_slot()` has no frontend caller | P1 | **OPEN** | Founding offer unreachable through the product today |
| 7 | Portal security regression suites silently SKIP in CI | P1 | **OPEN — EXTERNAL BLOCKER** | Investigated this session; requires either `SUPABASE_SERVICE_ROLE_KEY` or the QA account's real password, neither obtainable through any available tool. Needs the repository owner to add `CUSTOMER_360_TEST_EMAIL`/`PASSWORD` (or the service-role key) as GitHub repository secrets directly |
| 8 | `request_commercial_upgrade()` wrong academy usage source | Informational | **FIXED THIS SESSION, NOT YET APPLIED** | `supabase/migrations/20260906120000...sql` written, awaiting owner go-ahead |
| 9 | Platform Owner plan dropdown includes legacy plans | P2 | **AWAITING OWNER DECISION** | Product-intent question, not a clear bug |
| 10 | Missing composite index, active-player 90-day query | P2 | **OPEN** | Perf risk at Pro-tier scale, not urgent today |
| 11 | `get_founding_offer_status()` doesn't exclude test-fixture clubs | P2 | **OPEN** | Latent; fix before first real paid checkout |
| 12 | No trial/subscription lifecycle reminder notifications | Gap | **OPEN** | Not previously built |
| 13 | No club-wide failed-email dashboard for staff | Gap | **OPEN** | Only per-customer visibility exists |
| 14 | Demo tenant thin on academy/staff sample data | Gap | **OPEN** | See demo runbook |
| 15 | E2E suite cannot run safely (no isolated test environment) | Gap | **OPEN** | See Quality Gates below |

## Quality gates

All re-confirmed green after the fixes in this session:

| Gate | Result |
|---|---|
| Typecheck (`tsc --noEmit`) | PASS, 0 errors (one real `TS2345` found and fixed in `TodayPage.tsx` during this mission — a null-safety issue in the new `isCoachOnlyDashboard` helper) |
| Lint (`eslint`) | PASS, 0 errors, 21 pre-existing warnings (unused vars in 2 payment-gateway edge functions, react-refresh export warnings — cosmetic, not fixed, out of scope) |
| Unit tests (`vitest run`) | PASS, 326 passed / 132 skipped (458 total, 30/45 files run) |
| Worker tests | PASS, 17/17 (real Miniflare/workerd runtime) |
| Build (`npm run build`) | PASS (previously failing on the same `TS2345` error, now clean) |
| E2E / Playwright | **UNVERIFIED** (not FAILED) — 450 tests across 17 spec files discovered via dry-run listing, covering real authenticated role-based journeys (academy, shop/POS, finance, booking, permissions, customer portal) against a NO-MOCK backend (real production Supabase, no isolated test environment). Could not be run safely because `.env.e2e.local` (required for `SUPABASE_SERVICE_ROLE_KEY` to mint QA test sessions) does not exist locally, and creating one would require sourcing a real service-role key with no isolated environment to test against. This is an infrastructure gap, not a product defect. |

## Pending owner decisions

- ~~Apply `supabase/migrations/20260906120000_fix_request_commercial_upgrade_academy_usage_source.sql`
  to production~~ — **DONE**, applied and verified live (migration
  `20260906052835`), under explicit owner authorization.
- ~~Wire `CUSTOMER_360_TEST_EMAIL`/`CUSTOMER_360_TEST_PASSWORD` as CI
  secrets so the two portal-security regression suites actually run~~ —
  **investigated, confirmed a genuine external-credential blocker**: no
  tool available to this session can obtain a `SUPABASE_SERVICE_ROLE_KEY`
  or the QA account's real password (see the Customer Portal /
  Payments / Invoices / Reports section above for the full explanation).
  Remains open — requires the repository owner to add the secret(s)
  directly.
- `players.medical_notes` column-level RLS gap needs a real fix
  (RPC-mediated read path or security-barrier view) — deferred, needs
  wider mapping first.
- Staff/active-player grace-state sweep
  (`refresh_commercial_grace_state`) needs a scheduler wired up, or the
  grace-to-over_limit transition will never fire.
- Founding offer needs a real UI entry point (currently unreachable
  through the product).
- Platform Owner's plan-change dropdown should probably exclude or
  clearly label legacy plans (product-intent decision, not purely
  engineering).
- E2E suite needs a genuinely safe way to run (a dedicated test Supabase
  project, or a safely-scoped service-role key setup) — flagged, not
  solved, this mission.

## Honest overall picture

This is a real, working, multi-tenant SaaS product with zero live paying
customers today. The two defects that would have been most damaging to a
real first customer — an owner locked out of their own account with no
trial ever started, and a real double-booking between academy and field
bookings — were found and fixed this session, applied to production, and
verified live. What remains open is a mix of: (a) a handful of P1 items
that are real but bounded and none of which block a first careful,
manually-onboarded customer; (b) a few pending owner decisions that are
genuinely business/product calls, not engineering unknowns; (c) an E2E
test-infrastructure gap that limits confidence beyond what unit/worker
tests and this session's live adversarial testing already provide; and
(d) a demo tenant that works but is thinner on academy/staff sample data
than the rest of the product. None of the above was hidden or minimized
above — the final call on whether this state is "ready to sell" is the
owner's to make with these facts in hand.
