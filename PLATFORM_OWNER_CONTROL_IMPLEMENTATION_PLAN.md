# Platform Owner Control — Implementation Plan

**Baseline:** `PLATFORM_OWNER_COMPLETE_CONTROL_AUDIT.md`, commit `249c9fd` (== `origin/main`, working tree clean, confirmed at plan start).
**Mode:** Autonomous execution, no owner check-ins except true stop conditions (financial-data mutation, new paid service, unresolvable security contradiction, materially ambiguous accounting rule, or missing credentials blocking a phase entirely).

## Reconciliation against current main (delta from the audit)

Re-read directly before planning: `club_modules_schema.sql`, `club_modules_rpcs.sql`, `_shop_module_active()`, `create_public_booking` (latest generation, `20260824210000`), `get_public_club` (latest generation, `20260819350000`), `commercial_entitlements` schema + triggers. All match the audit's findings exactly — no drift. Confirmed `create_public_booking`'s return shape (`TABLE(booking_id, booking_ref, hold_expires_at, total_price, invoice_id, invoice_number)`) has not changed across its ~10 `CREATE OR REPLACE` revisions, so extending it is a safe `CREATE OR REPLACE` (no DROP needed) as long as this plan doesn't change that shape either.

## Scope decisions (why some audit items are deferred, not skipped)

- **Full plan→module/limit linkage (audit §37 item 3)** is real but is the highest-risk, most schema-invasive item in the audit, and the audit itself frames it as optional ("MAY define"). Building it safely (nullable, seed-only, non-destructive) is included as Phase 4, scoped tightly: add the columns/join, wire it into subscription creation as a *seed* of `club_modules`/`commercial_entitlements` only when those don't already exist for the club — never overwrite an existing club's live configuration. This satisfies directive §12/§13's explicit non-destructive requirement.
- **WhatsApp** is out of scope for any implementation, per explicit instruction (directive §22) — not touched, not re-audited.
- **Payment provider allowlist / kill switch (P2 in the audit)** is included but deliberately additive-only: new policy table + new check in the write path, zero change to any existing connection's state.
- Full E2E browser automation for the Platform Owner console requires an authenticated Platform Owner session, which — consistent with every prior phase of this engagement — is not available in this environment. Per directive §45/§46, this is classified `ENVIRONMENT-BLOCKED`, not a stop condition; all non-visual work proceeds and is verified via direct RPC/RLS calls instead (the established pattern for this entire engagement).

## Phases

### Phase 1 — Foundational module enforcement parity (P0)
**Objective:** Close the two live, exploitable gaps: Academy and Fields entitlement toggles have zero enforcement effect, and Fields' public booking surface doesn't check module state at all.
**Scope:** Database only.
**Changes:**
- New migration: `_academy_module_active(p_club_id)` and `_fields_module_active(p_club_id)`, exact mirror of `_shop_module_active()`.
- Sweep every Academy write RPC (enrollment create/update, attendance mark, subscription create, group/program create) and every Fields/Booking write RPC (create_booking, create_recurring_booking, block_field, pricing-rule writes) to call the new helper, mirroring Shop's exact `if not public._X_module_active(...) then raise exception` idiom.
- Extend `create_public_booking` (via `CREATE OR REPLACE`, same signature/return shape) to also check `_fields_module_active(v_club_id)` alongside its existing subscription-access check.
- Extend `get_public_club` (via `CREATE OR REPLACE`, same signature/return shape) so a club with Fields disabled returns no rows, matching its existing `status='active'` guard pattern.
- Do NOT touch RLS (per audit §25, module-state does not belong in RLS by design) and do NOT touch reads that aren't module-scoped listing endpoints — reads for Academy/Fields stay ungated for now to match the "reads are never gated by subscription state" precedent (§13 of the audit) UNLESS a read RPC is the sole gate for a nav-hiding decision, in which case it's covered by Phase 3.
**Security implications:** Purely additive guards; cannot broaden access, can only narrow it. No RLS change.
**Migration requirements:** Single new migration file, `CREATE OR REPLACE FUNCTION` only where return shape is unchanged (confirmed above); helper functions are brand new (no DROP needed).
**Test requirements:** RLS-impersonation live calls: (a) disable Academy entitlement for the QA test club, attempt `create_enrollment`/`mark_attendance` directly via RPC, confirm rejection; (b) disable Fields entitlement, attempt `create_booking` directly, confirm rejection; (c) same disable, attempt `create_public_booking` as anon, confirm rejection; (d) confirm `get_public_club` returns no rows for a Fields-disabled club; (e) re-enable both, confirm all four actions succeed again and no historical data was affected.
**Acceptance criteria:** All 5 tests pass; existing Shop enforcement untouched and re-verified with one smoke call; no RLS policy changed (confirmed via diff).
**Rollback/safety:** Every check is a new `if not X then raise exception` — reverting means dropping the new helper functions and removing the new checks in a follow-up migration; no data written or migrated, purely behavioral.

### Phase 2 — Club Memberships entitlement registration (P1)
**Objective:** Bring the `club_membership_plans`/`club_membership_subscriptions` product into the same control model.
**Scope:** Database + minimal frontend (Modules tab).
**Changes:**
- Migration: extend the `club_modules.module_key` CHECK constraint to add `'club_membership'` (requires `ALTER TABLE ... DROP CONSTRAINT` + `ADD CONSTRAINT`, not a function return-shape issue, so no `DROP FUNCTION` concern applies here).
- Backfill every existing club to `club_membership: entitled=true, active=true` — mirrors the Academy/Fields backfill precedent exactly (continuity for clubs already using it).
- New `_club_membership_module_active(p_club_id)` helper, same pattern.
- Sweep Club Membership write RPCs (plan create/update, subscription sale/renew/freeze) to check it.
- Frontend: add `club_membership` to `MODULE_LABELS` in `PlatformClubDetailPage.tsx` so it appears in the existing Modules tab — no new UI surface needed, extends the existing one.
**Security implications:** Additive only.
**Migration requirements:** One migration; constraint swap is safe (existing rows unaffected, only the allowed-value set grows).
**Test requirements:** Same 5-point pattern as Phase 1 items (a)/(e), applied to a Club Membership write RPC; confirm the Modules tab query (`get_club_modules`) returns the new row without a frontend crash before the label is added (defensive ordering).
**Acceptance criteria:** Toggling Club Membership entitlement off/on has a real, verified effect on membership-plan/subscription writes; existing membership data for all clubs unaffected (all backfilled to on).
**Rollback/safety:** Backfill is additive-only insert; constraint change is reversible; no existing membership row touched.

### Phase 3 — Navigation parity + limit-change auditing + limit-reduction safety (P1/P2)
**Objective:** Close the three remaining concrete, low-risk gaps identified in the audit that don't require new architecture.
**Scope:** Frontend nav + one RPC + one small warning UI.
**Changes:**
- `AppLayout.tsx` sidebar: gate Academy/Fields/Shop/Club-Membership nav items on `club_modules.entitled && active` (fetched once, already available via `get_club_modules`), not permission alone — matches the existing precedent Shop already partially has, now made real for all four and consistent.
- New RPC `set_commercial_entitlements(p_club_id, p_branch_limit, p_field_limit, p_academy_limit, p_reason)`, platform-owner-gated, replacing `PlatformClubDetailPage.tsx`'s direct `.upsert()` — writes `write_audit_log` on change, matching every other commercial RPC's discipline.
- Update `PlatformClubDetailPage.tsx`'s `saveLimitsMutation` to call the new RPC instead of the direct table write.
- Add a non-blocking warning in the same Limits card: if the new limit value is below current usage (computed client-side from `commercial_entitlements_usage`, already fetched), show "current usage exceeds this new limit — existing records are preserved, no new ones can be created until usage drops" before save is confirmed. Does not block the save (per directive §15/§42 — over-limit must be *visible*, not *prevented*, since deletion is forbidden and blocking the admin from setting an intentionally-tight limit would be worse).
**Security implications:** Removes the one unaudited commercial-write path; nav change is UI-only convenience layered on top of Phase 1/2's real enforcement (never the enforcement itself).
**Migration requirements:** One new RPC migration, `CREATE FUNCTION` (new function, no prior signature to conflict with — `saveLimitsMutation`'s direct upsert had no RPC to replace, so this is a pure addition).
**Test requirements:** RPC call with a non-platform-owner session, confirm rejection; RPC call as platform owner, confirm `audit_logs` row written with before/after values; frontend structural check that the warning renders when usage > new limit (code-level, since live browser auth is unavailable).
**Acceptance criteria:** No direct client `.upsert()` on `commercial_entitlements` remains in the codebase (grep-verified); every limit change is audited; nav hiding verified structurally against `get_club_modules` query shape.
**Rollback/safety:** New RPC is additive; old direct-write path is removed from the frontend only (table-level RLS write policy for platform_owner can optionally stay as defense-in-depth, or be tightened to route only through the RPC — decided during implementation based on whether any other legitimate caller depends on direct writes, confirmed via grep before removal).

### Phase 4 — Plan-to-entitlement seeding (P1)
**Objective:** Close the "plans are purely cosmetic" gap without destabilizing any existing club's live configuration.
**Scope:** Database schema extension + one RPC touch point.
**Changes:**
- Migration: add nullable `default_modules text[]` and nullable `default_branch_limit/default_field_limit/default_academy_limit integer` columns to `platform_plans`. Nullable/optional by design — an unset plan behaves exactly as today (no defaults implied).
- Extend `create_platform_subscription` (the RPC that creates a club's first subscription against a plan) so that, ONLY when the club has no existing `club_modules` rows for a given key / no existing `commercial_entitlements` row, it seeds them from the plan's new default columns. If the club already has any configuration (the common case for every existing club today), nothing is touched — this is seed-on-first-subscription only, never an overwrite.
- `PlatformPlansPage.tsx`: add optional inputs for the new default columns to the existing plan-edit dialog.
**Security implications:** None — purely additive schema, seed-only write path.
**Migration requirements:** `ALTER TABLE platform_plans ADD COLUMN ... (nullable)`; `create_platform_subscription` is `CREATE OR REPLACE` — confirm its return shape is unchanged before writing (verify during implementation; if changed, use the mandatory `DROP FUNCTION` procedure per the standing invariant).
**Test requirements:** Create a brand-new test club, assign a plan with defaults set, confirm `club_modules`/`commercial_entitlements` seeded correctly; confirm an EXISTING club's configuration is provably untouched by a plan reassignment (before/after snapshot comparison).
**Acceptance criteria:** New clubs get plan-seeded defaults; zero existing club's live `club_modules`/`commercial_entitlements` row changes as a side effect of this phase.
**Rollback/safety:** New columns can be dropped without affecting any other data; seeding logic only fires on the narrow no-existing-row condition, verified explicitly in tests before merge.

### Phase 5 — Payment oversight: kill switch + provider policy (P2)
**Objective:** Close the two payment-control gaps identified in the audit, additive-only.
**Scope:** Database + minimal Club Detail UI.
**Changes:**
- New `club_id`-scoped boolean `payments_platform_disabled` (default false) on a suitable existing table (likely `commercial_entitlements`, since it's already the platform-owner-only-write per-club config table) or a small new table if a dedicated audit trail is preferred — decided during implementation by checking which is less invasive.
- New RPC `set_club_payments_enabled(p_club_id, p_enabled, p_reason)`, platform-owner-gated, audited.
- Wire the check into the payment/checkout creation path (the RPC that initiates a new gateway checkout) — reject with a clear message if platform-disabled. Existing/historical payments remain fully readable; refunds are unaffected (explicitly not gated, since a refund is not a new payment).
- Optional provider-policy table (`club_id`, `provider_key`, `status: 'allowed'|'policy_blocked'`) consulted at connection-time only — never retroactively disconnects an existing connection, per the directive's explicit non-destructive requirement. If no row exists for a club+provider pair, default remains "allowed" (today's behavior), so this is purely additive.
- Club Detail UI: a small toggle + provider-policy list in the existing Payments/Invoices tab area.
**Security implications:** Never touches Vault secrets or credential storage; purely a policy gate in front of the existing checkout-creation RPC.
**Migration requirements:** New column/table + new RPC; existing checkout RPC gets one new `if` check via `CREATE OR REPLACE` (confirm return shape unchanged first).
**Test requirements:** Disable payments for the QA test club, attempt a new checkout creation, confirm rejection; confirm a second, unaffected club's checkout still succeeds (cross-tenant isolation); confirm historical payment reads and refund RPCs are unaffected; confirm no Vault-backed column is ever selected/returned by any new RPC (grep + direct read of the new RPC body).
**Acceptance criteria:** Kill switch verified functionally isolated per-club; provider policy verified additive (no existing connection altered).
**Rollback/safety:** New column defaults to false/unblocked (today's behavior) everywhere until explicitly set — zero behavior change for any club until a platform owner actively uses the new control.

### Phase 6 — Enforcement matrix documentation + acceptance test suite (all phases)
**Objective:** Produce the concrete, evidence-backed matrix the audit called for, now showing the fixed state, and a repeatable automated check.
**Scope:** Test files + documentation, no product code.
**Changes:** A new integration test file (or extension of an existing suite) that runs the Phase 1/2/5 bypass tests programmatically (RLS-impersonation pattern already established in this engagement) so they're not one-off manual checks — this becomes part of the standing regression suite, not a throwaway QA script.
**Test requirements:** The suite itself IS the test requirement for this phase — must pass cleanly.
**Acceptance criteria:** Suite runs green; matrix in the final report reflects EXISTS for every cell that was previously MISSING for Academy/Fields/Memberships.

### Phase 7 — Platform Owner Club 360 UX pass (P2, structural only given no authenticated browser session)
**Objective:** Surface the now-real enforcement state in the UI so the Platform Owner can trust what they see, per audit §33.
**Scope:** Frontend only.
**Changes:** Extend the existing Modules tab in `PlatformClubDetailPage.tsx` with the limit/usage/last-changed-by columns already partially present, plus the new Club Membership row (Phase 2) and the payment kill-switch control (Phase 5) — grouped into the existing tab structure, no new top-level tabs per the audit's explicit "do not create unnecessary tabs" guidance.
**Test requirements:** TypeScript/build-level verification only (structural), since authenticated visual verification is `ENVIRONMENT-BLOCKED` this session, consistent with every prior phase of this engagement. Classified honestly in the final report, not claimed as visually verified.
**Acceptance criteria:** `tsc -b` clean, production build succeeds, component reads compile against the actual RPC return shapes added in Phases 1-5.

### Phase 8 — Final regression and closure
Per directive §50: fresh `git status`, origin/main consistency, TypeScript, lint, production build, full unit/integration suite (including the new Phase 6 suite), zero-credential E2E, targeted module-control/cross-club/public-route tests (already run per-phase, re-confirmed once at the end, not re-run speculatively). Repository hygiene per §53. Final report `PLATFORM_OWNER_CONTROL_PRODUCTION_ACCEPTANCE.md` per §49's 27-item structure. Exact final response format per §55.

---

## Phase dependency order (confirms directive §4's rule)
Phase 1 (foundational enforcement) → Phase 2 (extend the now-proven pattern to Memberships) → Phase 3 (nav + audit hygiene, depends on Phase 1/2's real state existing to hide nav correctly) → Phase 4 (plan seeding, independent of 1-3 but logically "foundational" so placed before UX) → Phase 5 (payment oversight, independent domain, placed after the module work since it's lower severity) → Phase 6 (test suite, needs 1/2/5 to exist first) → Phase 7 (UX, must come after backend is real, per directive §4's explicit rule) → Phase 8 (closure).

Execution begins immediately with Phase 1.

---

## Closure

All 8 phases complete. See `PLATFORM_OWNER_CONTROL_PRODUCTION_ACCEPTANCE.md` for the final acceptance report, live-verification evidence, and closing regression results.
