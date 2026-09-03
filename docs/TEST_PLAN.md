# Test Plan

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. New coverage added: `SECURITY DEFINER` cross-tenant tests, group capacity race test, refund-exceeds-balance rejection, `qr_scan_events` completeness, exclusion-constraint boundary/state tests, phone normalization, medical_notes column protection, audit log immutability. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-021.
>
> **Corrected 2026-08-15 (final)** per Final Platform SaaS Corrections. `clubs.status` never contains `grace_period` — replaced coverage below with `get_club_platform_access()` derivation tests, period-based subscription/renewal/overlap tests, and plan-price-snapshot immutability tests. See [DECISIONS.md](DECISIONS.md) ADR-027 through ADR-035.
>
> **Added 2026-08-15 (public site)** per Public Website + Signup + Free Trial addition. New coverage: public plan/settings exposure boundaries, `contact_requests` insert-only enforcement, atomic onboarding RPC privilege-escalation tests, one-trial-per-club enforcement, trial-specific `get_club_platform_access()` derivation (zero-width grace). See [DECISIONS.md](DECISIONS.md) ADR-036 through ADR-046.
>
> **Added 2026-08-15 (final pre-implementation)** per the Final Pre-Implementation Directive. The full [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#abuse-test-catalogue) Abuse Test Catalogue (13 items) is now the canonical cross-domain abuse test list — referenced from every phase's Security Gate, not just listed once. New coverage: Recurring Booking conflict-reporting correctness, Quick Field Block conflict-surfacing, Outstanding Payments ledger-match, CSV export scoping, issued-invoice-lock enforcement, severity-classified findings (P0–P3) gating Exit Gates.
>
> **Added 2026-08-15 (final two decisions)** per the Final Two Decisions Closure. Abuse Test Catalogue extended to 19 items (#14–#19: one-automatic-trial-per-user, `user_id`/`trial_origin` spoofing rejection, concurrent double-onboarding, Platform-Owner-manual-grant independence, per-occurrence recurring-booking financial independence). New coverage: `automatic_trial_entitlements` concurrency-safety, per-occurrence recurring-booking billing isolation, second-club-no-automatic-trial outcome.

Not aiming for 100% coverage as a formal goal. Aiming to make the critical, hard-to-reverse business logic provably correct — especially anything touching money, availability, or tenant isolation. Everything below runs locally against `supabase start` — no test ever depends on production. See [PROJECT_RULES.md](PROJECT_RULES.md) rule 5.

## Layers

### Unit (Vitest)
Pure functions in `lib/domain/` only — no Supabase client, no DOM. Price calculation (pricing rule resolution/priority), subscription effective-expiry derivation, installment/outstanding-balance math, invoice total calculation, phone number normalization utility (`010...`/`+2010...`/`002010...` → same `normalized_mobile`).

### Database / RLS (pgTAP, via `supabase test db`)
- Cross-club isolation matrix (see [RLS_MATRIX.md](RLS_MATRIX.md#verification-checklist-phase-2-gate)) — run per tenant-scoped table, not just spot-checked
- **Every `SECURITY DEFINER` function** — cross-tenant rejection test per the [RLS_SECURITY.md](RLS_SECURITY.md#verification-checklist-part-of-phase-14-gate) checklist: pinned `search_path` present, spoofed `club_id` argument rejected, identity resolved only from `auth.uid()`, internal permission check present, `EXECUTE` grants role-scoped not blanket
- Double-booking exclusion constraint under direct SQL insert (bypassing the RPC) and under simulated concurrent connections; constraint blocks on `pending_payment`/`confirmed`/`checked_in` and does **not** block on `completed`/`cancelled`/`no_show`; boundary test confirms `10:00–11:00` and `11:00–12:00` do not overlap (`[)` semantics)
- QR validate (scan) never mutates `qr_credentials` or `bookings` by itself; confirm-check-in RPC atomically consumes + transitions booking status together; replay of confirm returns zero rows on second attempt; player QR (`single_use=false`) can be scanned repeatedly without consumption, each scan producing its own `qr_scan_events` row
- `qr_scan_events` completeness — every scan outcome (success/already_used/expired/invalid/wrong_club/permission_denied) produces exactly one row, regardless of what happened to the credential
- Invoice numbering under concurrent calls — no duplicates, no gaps beyond intentional voids; `club_code`/`branch_code` correctly read from `clubs`/`branches`, never a hardcoded prefix
- Payment allocation sum trigger — rejects over-allocation (`SUM(payment_allocations.amount) per payment_id > payments.amount`)
- Refund correctness — original `payments.amount` unchanged and payment never deleted; a refund request exceeding the payment's refundable balance (amount minus prior completed refunds) is rejected atomically, including under concurrent refund attempts on the same payment; ledger balances correctly after refund; audit log entry always created
- Subscription freeze — `subscriptions.end_date` is never mutated; derived `effective_end_date` correctly shifts forward by frozen duration when `extends_expiry = true`, unchanged when `false`
- Subscription activation — all three `subscription_activation_policy` values (`manual`/`first_payment`/`full_payment`) produce correct activation behavior against the same underlying payment data
- Group enrollment capacity — concurrent enrollment attempts for the last open spot in a group; exactly one succeeds, verified via the `SELECT ... FOR UPDATE` lock on `groups`
- Session generation idempotency — re-running generation for an already-covered date range creates zero duplicate `training_sessions` rows (`(group_id, session_date, start_time)` constraint)
- Attendance uniqueness — marking the same player twice for one session always results in one row (`UPDATE`, not a second `INSERT`), per `(session_id, player_id)`
- `audit_logs` immutability — `UPDATE`/`DELETE` attempts rejected for every role, including Club Owner and Platform Owner
- `players.medical_notes` column protection — a role without `player.medical_notes.view` never receives the column in any query result, including a raw PostgREST call; never present in global search results
- Role/permission checks — a role without a given permission is rejected on INSERT/UPDATE at the RLS layer, not just hidden in the UI
- Branch scope via `membership_branches` — a membership with explicit rows is restricted to exactly those branches; a membership with zero rows has access to all branches of its club
- Platform Billing table isolation — `platform_plans`/`platform_subscriptions`/`platform_invoices`/`platform_payments` inaccessible to every non-`platform_owner` role, including Club Owner querying their own club's rows directly
- `clubs.status` constraint enforcement — attempting to write `'grace_period'` (or any value outside `active`/`suspended`/`closed`) into `clubs.status` is rejected at the check-constraint level, not just by application discipline
- `get_club_platform_access()` derivation correctness — for a club whose current period's `now() < end_at` returns `full`; `end_at <= now() < end_at + grace_days_snapshot` returns `grace`; `now() >= end_at + grace_days_snapshot` returns `blocked`; `lifecycle_status = 'cancelled'` returns `blocked` regardless of dates; `clubs.status IN ('suspended','closed')` returns `blocked` regardless of subscription standing — all purely from querying `platform_subscriptions` + `clubs.status` + `now()`, no reliance on a scheduled job having run
- `auth.club_write_allowed()` per-category correctness — `'new_commitment'` rejected in `grace`, `'settle_existing'` and `'operational_continuity'` allowed in `grace`, all three rejected in `blocked`, all three allowed in `full`
- Recording a `platform_payments` row immediately flips `get_club_platform_access()` to `full` on the next call, regardless of prior grace-period elapsed time, without any stored status column being updated
- Subscription period overlap prevention — two `platform_subscriptions` rows for the same club with overlapping `[start_at, end_at)` ranges → the second insert rejected by the exclusion constraint (tested both via direct SQL and simulated concurrent RPC calls); a renewal starting exactly at the prior period's `end_at` → succeeds
- Plan price/interval snapshot immutability — editing `platform_plans.price` after a subscription period was created does not change that period's `price_snapshot`; a new period created afterward reflects the new price
- Renewal history correctness — `renew_platform_subscription` creates a new row with `previous_subscription_id` correctly pointing at the prior period; walking the `previous_subscription_id` chain for a club reconstructs its full renewal history in order
- **Public user can read published plans only** — `anon` SELECT on `public_plans` returns rows with `is_public = true` and excludes `is_public = false`/archived rows entirely
- **Unpublished plan hidden** — a `platform_plans` row with `is_public = false` never appears in `public_plans`, confirmed by inserting one and asserting it's absent from the view's result set
- **Signup creates exactly one club** — calling `complete_new_club_onboarding()` once results in exactly one new `clubs` row, not zero, not two
- **Signup creates exactly one owner membership** — exactly one `club_memberships` row with `role_id` resolving to `club_owner`, for the calling `auth.uid()`
- **Signup creates exactly one 7-day trial subscription** — exactly one `platform_subscriptions` row with `subscription_kind = 'trial'` and `end_at - start_at` matching `platform_settings.default_trial_days`
- **Trial duration comes from platform setting** — changing `platform_settings.default_trial_days` to a different value before onboarding changes the resulting trial's length; the RPC never has `7` hardcoded
- **Trial belongs to club, not user** — confirmed via the schema itself (`platform_subscriptions.club_id`, no `user_id` column) plus a behavioral test below
- **Second user in same club does not create another trial** — adding a second `club_memberships` row to an existing club (e.g. an invited Receptionist) never inserts a new `platform_subscriptions` row; only `complete_new_club_onboarding()` (new-club creation) can create a trial, and only once per club (unique partial index)
- **User A creates Club 1 → automatic 7-day trial created; User A creates Club 2 → club created, no automatic trial created** — the two-rule model (one trial per club, one automatic trial per user) confirmed via a full behavioral test, not just schema inspection: `trial_granted = true` on the first onboarding call, `trial_granted = false` on the second, both clubs exist with correct `club_memberships` rows regardless of trial outcome
- **User B (a different user) creates Club 3 → automatic trial created if otherwise eligible** — confirms the per-user limit doesn't leak across users
- **Club with a previous trial cannot receive another trial automatically** — even a long-expired or cancelled trial on a club blocks a second automatic trial for that same club (existing unique partial index on `platform_subscriptions`, re-confirmed here in combination with the new entitlement table)
- **`automatic_trial_entitlements` concurrency safety** — two simultaneous `complete_new_club_onboarding()` calls from the same brand-new user (different clubs) result in exactly one `trial_granted = true` and one `trial_granted = false`, never two trials, regardless of call timing; verified via simulated concurrent transactions, not just sequential calls
- **Client cannot spoof another user's `user_id` to obtain or block a trial** — `auth.uid()` is the only identity source inside the entitlement-consumption logic; a payload-supplied `user_id` has no effect
- **Client cannot set `trial_days`** — unchanged from prior coverage, re-confirmed against the corrected RPC shape
- **Client cannot set trial mode to `manual`** — a self-service `complete_new_club_onboarding()` call always produces `trial_origin = 'automatic'` when a trial is granted at all; no payload field can request `'manual'`
- **Platform Owner can create a manual trial** — via the separate grant RPC, for any club, including one whose owner already consumed their automatic trial elsewhere
- **Manual trial creation is audited** — every manual/complimentary grant produces an `audit_logs` row with actor/club/reason/`start_at`/`end_at`/`subscription_kind`, no silent path
- **Expired trial blocks new bookings** — a trial with `end_at` in the past → `get_club_platform_access()` returns `blocked` → `create_booking` RPC rejects with the `'new_commitment'` category check
- **Expired trial does not delete data** — after simulating expiry, all previously-created club/branch/customer/booking rows remain fully queryable via `SELECT`
- **Trial converts to paid subscription without rewriting trial history** — activating a paid plan for a club with an expired trial creates a *new* `platform_subscriptions` row (`subscription_kind = 'paid'`, `previous_subscription_id` pointing at the trial row); the trial row itself is never updated or deleted
- **Public user cannot create paid subscription** — no client-reachable path (RPC or direct insert) allows `anon` or a freshly-signed-up user to create a `platform_subscriptions` row with `subscription_kind != 'trial'`
- **Public user cannot set own platform role** — `complete_new_club_onboarding()` ignores/rejects any attempt to influence `role_id`; the resulting membership is always `club_owner`, never `platform_owner`
- **Public user cannot read contact requests** — `anon` SELECT on `contact_requests` (including immediately after their own successful INSERT) → 0 rows
- **Platform Owner can see contact requests** — `platform_owner` SELECT on `contact_requests` → full visibility
- **Club Owner can see own subscription status only** — the restricted summary view returns data for the caller's own club and nothing else, even when the underlying `platform_subscriptions` table has rows for other clubs
- **Club Owner cannot see other clubs or platform revenue** — direct queries against `clubs` (other than their own, which they can see per the base matrix), `platform_subscriptions`, `platform_payments` for any club return 0 rows or are rejected outright
- **Recurring booking conflict reporting** — creating an 8-occurrence series where 1 conflicts reports "8 requested, 7 available, 1 conflict" and never silently creates fewer than the user explicitly agreed to
- **Recurring booking never bypasses the exclusion constraint** — direct SQL attempt to insert two overlapping bookings sharing a `booking_series_id` is rejected identically to two unrelated overlapping bookings
- **Quick Field Block never auto-cancels** — creating a block over a window with 3 existing non-cancelled bookings surfaces exactly those 3 bookings and does not change any of their `status` values
- **Outstanding Payments matches manual ledger calculation** — for a seeded set of invoices/payments/refunds, `outstanding_invoices` totals match hand-calculated `total − allocations + refund effect` exactly
- **CSV export cannot leak cross-club data** — attempting to export via a manipulated club/branch parameter returns only data the caller's RLS-scoped query would return, identical to viewing it on-screen
- **Issued invoice lock** — attempting to `UPDATE` `invoice_items`/price/total/customer on an invoice with `status = 'issued'` is rejected outside the void/reissue flow
- **Full Abuse Test Catalogue** ([SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#abuse-test-catalogue), all 13 items) passes as a single regression suite by Phase 14

### Integration
End-to-end against a local Supabase instance (not mocked): booking creation (slot search → price calc → RPC → invoice → QR), QR scan-then-confirm check-in as two distinct steps, subscription lifecycle (enroll → pay → activate per policy → freeze → derive effective expiry → expire), refund end-to-end, academy enrollment under simulated capacity contention, platform billing lifecycle (club subscription period lapses → `get_club_platform_access()` returns `grace` → attempt new booking [rejected] → attempt payment collection [succeeds] → grace window elapses → `blocked` → platform payment recorded against a renewal → `full` again, with `clubs.status` unchanged throughout), platform subscription renewal (create period 1 → renew into period 2 → verify no overlap, correct `previous_subscription_id`, correct snapshot values on period 2 if plan price changed between periods), **full signup-to-trial-to-operating-club flow** (anonymous → signup → onboarding → trial created → login → `/app` → create a booking during trial — see [USER_FLOWS.md](USER_FLOWS.md) Flow 8), **trial expiry flow** (simulate `end_at` passing → `blocked` → new commitment rejected → Platform Owner activates paid plan → `full` restored — see [USER_FLOWS.md](USER_FLOWS.md) Flow 9), **recurring booking flow** (request 8 occurrences with 1 conflict → user chooses "create available" → 7 real bookings created, correctly linked via `booking_series` — see [USER_FLOWS.md](USER_FLOWS.md) Flow 1b), **quick field block flow** (block window with existing bookings → conflict surfaced → manager cancels conflicting bookings individually → block created → see [USER_FLOWS.md](USER_FLOWS.md) Flow 6b).

### Manual QA
Responsive pass across mobile/tablet/desktop breakpoints against the [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#responsive-matrix) per-screen matrix; print QA (A4 + 80mm thermal — real printer if available, otherwise accurate print-preview); camera QA for `/scan` on an actual phone (desktop browser camera permission behavior differs from mobile); verify a QR scan alone never checks a booking in without the explicit confirm tap; **public site QA** — verify no "Buy"/"Checkout"/"Pay" language appears anywhere, verify pricing displayed matches `public_plans` exactly (change a plan's price in `/platform/plans` and confirm the public pricing page reflects it), verify the full signup→onboarding→trial flow works in a real browser on both desktop and mobile viewport sizes; **Design QA** per [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md#design-qa-checklist-phase-1-gate) — RTL correctness, contrast, status-never-color-only, touch target sizing on a real mobile device.

## Critical Test List

Every item below must have a passing automated test (pgTAP or Vitest/integration) before the owning phase's exit gate is considered met:

- RLS isolation (per table, per role where relevant)
- Cross-club access denial (SELECT/INSERT/UPDATE/DELETE attempts), including via every `SECURITY DEFINER` function
- Double booking prevention (direct SQL + concurrent RPC calls), correct status scope (`pending_payment`/`confirmed`/`checked_in` blocked, `completed`/`cancelled`/`no_show` not)
- Concurrent booking race (two simultaneous requests for the same slot)
- Invoice total correctness (subtotal + tax − discount = total, across multiple line items)
- Payment allocation correctness (partial payments, multi-invoice payments) — verified with **no reliance on any `payments.invoice_id` column**, which does not exist
- Refund correctness (ledger consistency, original payment untouched, cannot exceed refundable balance even concurrently)
- Subscription activation under each of the three `subscription_activation_policy` values
- Subscription expiry (active → expired when derived `effective_end_date` passes with no active freeze)
- Installment / outstanding balance correctness against the ledger (via `payment_allocations`, never a stored `amount_paid`/`amount_remaining`)
- QR validate-vs-confirm separation (scan alone never mutates; confirm is atomic and idempotent-safe against replay)
- QR expiry (expired token rejected even if otherwise valid)
- `qr_scan_events` records every scan attempt regardless of outcome
- Group capacity race (concurrent enrollment into the last spot — exactly one succeeds)
- Session generation idempotency
- Attendance uniqueness per `(session_id, player_id)`
- Role permission enforcement (unauthorized action rejected server-side, not just hidden client-side) — via permission keys, never role-key comparisons
- Branch-scoped permission enforcement via `membership_branches` (explicit rows restrict; zero rows means all branches)
- Invoice numbering concurrency (no duplicate numbers under parallel connections; correct club/branch code substitution)
- Audit log immutability (no role can UPDATE/DELETE)
- `medical_notes` column protection
- Phone normalization correctness (multiple input formats resolve to the same `normalized_mobile`)
- Platform Billing table isolation from all non-Platform-Owner roles
- `clubs.status` never accepts `'grace_period'` — check constraint enforced
- `get_club_platform_access()` (`full`/`grace`/`blocked`) correctness across all boundary conditions, computed live from `platform_subscriptions` + `clubs.status` + `now()`, not a stored-and-trusted flag alone
- `auth.club_write_allowed()` per-category gating correct in all three access levels × all three action categories
- Subscription period overlap prevention + adjacent-renewal legality
- Plan price/interval snapshot immutability across plan edits
- Renewal creates a correctly-linked new period row, never mutates the prior one
- Public user can read published plans only; unpublished plan hidden
- Signup creates exactly one club, one owner membership, one 7-day trial subscription
- Trial duration comes from `platform_settings`, never hardcoded
- Trial belongs to club, not user — second user in the same club does not create another trial
- Expired trial blocks new bookings but does not delete data
- Trial converts to paid subscription without rewriting trial history
- Public user cannot create a paid subscription or set their own platform role
- Public user cannot read `contact_requests`; Platform Owner can
- Club Owner sees own subscription status only — never other clubs or platform revenue
- Recurring booking never creates a partial series silently; never bypasses per-occurrence conflict checking
- 8-occurrence recurring series creates exactly 8 real `bookings` rows, correctly linked via `booking_series_id`
- Each occurrence in a series can be cancelled independently with zero effect on the others
- Each occurrence can have an independent invoice; series creation auto-generates zero invoices
- One payment can allocate across multiple occurrences' invoices via `payment_allocations`
- Refund or invoice-void on one occurrence has zero effect on any other occurrence in the series
- Quick Field Block never silently cancels an existing booking
- Outstanding Payments figures match the ledger exactly, no separate stored value
- CSV export respects the same scoping as the on-screen view under URL/parameter manipulation
- Issued invoice cannot be freely edited outside void/reissue
- One automatic trial per user account, enforced concurrency-safely by `automatic_trial_entitlements`, independent of the one-trial-per-club rule
- Additional club creation always succeeds regardless of prior automatic-trial consumption; only the automatic trial grant is skipped
- Full Abuse Test Catalogue (19 items, [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#abuse-test-catalogue)) passes as a regression suite

## What Is Explicitly Not Tested Formally in V1

UI pixel-perfect visual regression, exhaustive input-fuzzing of every form field, load testing beyond what a single pilot club would generate. These aren't ignored — they're just not automated test-suite items; manual QA covers what's needed for V1's actual scale.

## CI regression gap (finding M-13, 2026-09-03)

An audit flagged that the project's safety-critical claims (tenant isolation, anti-fraud, finance invariants) were proven once, manually, and never re-verified automatically: `supabase/tests/security_finance_regression.sql` was real and substantive but wired into nothing, 132 of ~301 vitest tests were permanently skipped, and 14 of 17 Playwright specs never ran in CI. This section records what was converted to real, always-on CI automation, and — just as importantly — what remains genuinely blocked and exactly why, rather than a fake job that doesn't actually check anything.

### What's now automated

`supabase/tests/structural_security_regression.sql` is a new, CI-runnable file extracted from `security_finance_regression.sql`, containing only the assertions that need **zero fixture data** — pure schema-shape checks against `pg_catalog`/`information_schema`: the double-booking exclusion constraint, FORCE RLS coverage on every table (plus a named regression guard for the 8 tables previously found missing it), the 10 tenant-identity-protection triggers, grant-layer scoping on 4 staff-only RPCs, `verify_audit_log_chain()` being service_role-only, and the audit-log coverage-gap detector across every `SECURITY DEFINER` function touching a financial table. All 7 checks were verified to pass, read-only, against the real live project's actual schema during this pass. It uses plain `RAISE EXCEPTION` (safe here since none of these checks need `SET ROLE`, unlike the original file), so a real regression fails the script's exit code, not just a diff someone has to notice by eye.

**It is not yet wired as an actual CI job**, for the reason below — this is a real, disclosed gap, not an oversight.

### What remains blocked, and why

**The blocker is upstream of this file, in the migration history itself.** The standard safe pattern for this class of problem — start a local/ephemeral Supabase instance in CI (`supabase start`), apply all migrations (`supabase db reset`), run the regression file against it, no production secrets involved — was investigated and is **not currently usable**, because `supabase db reset` does not complete on a genuinely fresh database today. At least two migrations `RAISE EXCEPTION` when a specific real user isn't present:

- `supabase/migrations/20260815380000_seed_platform_owner.sql`
- `supabase/migrations/20260816070000_seed_qa_dataset.sql`

Both do `select id into v_user_id from auth.users where email = 'moustafa.elsafy2@gmail.com'` and abort if it's null. That row only exists because a real person completed a real Supabase Auth signup on the live remote project (`gxkrtlvpjwxhcqdisyob`) — no migration creates it (correctly: `auth.users` rows are Auth's responsibility, not schema migrations'). At least three more migrations (`20260815390000_temp_grant_club_manager_for_academy_smoke_test.sql`, `20260816030000_temp_grant_for_group_edit_regression.sql`, `20260816050000_temp_remove_platform_owner_for_status_regression.sql`) depend on the same missing row and would fail on a NOT NULL/FK violation even though they don't explicitly `RAISE`. Since these sit in the middle of 565 migrations (not at the end), `supabase db reset --version <n>` to stop just before them also doesn't help — the structural checks above need the *final* schema, which is only reached by migrations that come much later.

**Why this isn't fixed here**: closing this gap means changing already-applied migration history's runtime behavior (e.g. making these migrations no-op gracefully instead of raising when the target user is absent, or seeding a synthetic local-only `auth.users` row via a new forward migration). Both are legitimate fixes, but both are a deliberate call for the repo owner to make explicitly — this project's own CI rules (see `.github/workflows/ci.yml`'s header) already treat "rewrite migration history" and "add new CI secrets" as decisions outside an automated remediation pass's authority, and this is the same class of decision: it changes what every future `supabase start`/`db reset` does, for every contributor, not just for this one test file.

**To close this gap**, a future session (with the repo owner's explicit sign-off) should do one of:
1. Add a new, forward-only migration (never edit the two existing ones) that seeds a synthetic local-only `auth.users` row for a fixed, clearly-QA-only email when running outside the live project, so the dependent migrations succeed on a fresh instance too — then wire a `build-and-test`-adjacent CI job that runs `supabase start` → `supabase db reset` → `psql -f supabase/tests/structural_security_regression.sql`, failing the build on any `RAISE EXCEPTION`. Add that job's name to branch protection's required-checks list once it's green.
2. Alternatively, accept that local `supabase start` will never fully replay this project's real migration history (documented here as a known, permanent limitation rather than continuing to imply otherwise), and instead run `structural_security_regression.sql` as a **scheduled** (not per-PR) job directly against the live project via a dedicated, minimally-privileged connection string stored as a new CI secret — this still needs no `service_role` key (the checks are all read-only `pg_catalog` queries), but it is a new production-adjacent secret, so it's the same "repo owner decides" category as option 1.

Either path is a scoped, well-understood follow-up — not a fake job. `supabase/tests/security_finance_regression.sql` itself (the identity-impersonation half: cross-tenant isolation, privilege escalation, payment idempotency, existence-oracle checks) needs real fixture `auth.users` rows regardless of which path above is taken, and stays a manual-run, SQL-Editor-driven regression file for now — see its own header for the run procedure.

### Vitest and Playwright: same root cause, confirmed

Investigated separately per the same finding. Both gaps trace to the identical cause — no disposable, CI-safe credential source exists yet, not missing effort:

- **132 skipped vitest tests**, confirmed via `npm test` (`14 passed | 15 skipped` test files, `170 passed | 132 skipped` individual tests, `2026-09-03`), across exactly 15 `src/features/**/*.integration.test.ts` files. Every one uses the same `describeIfConfigured` pattern (see e.g. `customer360.integration.test.ts`) gated on env vars that only exist as real credentials for real staff accounts on the live project: `CUSTOMER_360_TEST_EMAIL`/`PASSWORD`, `STAFF_360_OWNER_EMAIL`/`PASSWORD`, `STAFF_360_EMPLOYEE_EMAIL`/`PASSWORD`, plus `QA_AUDIT_CLUB_ID`. `.github/workflows/ci.yml`'s own header already documents this precisely and leaves the commented-out `env:` block ready to activate once those secrets exist.
- **14 of 17 Playwright specs never run in CI** — confirmed by listing `e2e/**/*.spec.ts`: 3 run today (`e2e/public/public-pages.spec.ts`, `e2e/auth/route-guards.spec.ts`, `e2e/responsive/viewport-critical-paths.spec.ts`, all zero-credential), the other 14 (12 in `e2e/staff/`, 1 in `e2e/portal/`, plus one more zero-credential file already counted above) need a real minted Supabase Auth session per role, which `e2e/setup/mint-qa-sessions.ts` produces using `SUPABASE_SERVICE_ROLE_KEY` — see `E2E_TEST_STRATEGY.md`'s "CI wiring" section, which already documents this as a deliberate, not-yet-made repo-owner decision.

**Whether a disposable, CI-safe QA project could solve this**: yes, in principle — a second, throwaway Supabase project (or a consistently-reseeded branch of the same project) containing only synthetic QA fixture accounts, with credentials that carry no real customer/financial data, is exactly the kind of secret that's safe to add to CI (unlike the live project's `service_role` key). This does **not** conflict with "no production secrets in CI" — a disposable QA project's credentials are not production secrets. But provisioning it — creating the project/branch, seeding fixture accounts (including working around the same `auth.users`-dependent-migration issue above), and adding `CUSTOMER_360_TEST_EMAIL`/`STAFF_360_*`/`SUPABASE_SERVICE_ROLE_KEY` (scoped to that disposable project only) as new GitHub repository secrets — is itself a standing-configuration change (`gh secret set`, new infrastructure) outside this pass's authority to make unilaterally. Documented here as the concrete, actionable next step; not attempted.
