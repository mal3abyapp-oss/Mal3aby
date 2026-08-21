# MAL3ABY — ACADEMY PLAYER / GUARDIAN / CUSTOMER
# FINAL PRODUCTION ACCEPTANCE REPORT

**DATE:** 2026-08-21

**MAIN:** `fb41eb5` (local `main` at time of writing)

**ORIGIN/MAIN:** `fb41eb5` (confirmed `git fetch` + hash comparison identical before and after push)

**PRODUCTION COMMIT:** `fb41eb5` (frontend deployed from this exact commit's build output)

**PRODUCTION BUNDLE:** `index-B3gv4p_E.js` — confirmed via live network-request inspection on `mal3aby.app` after clearing the PWA service worker cache (same known cache-invalidation step required on every deploy this project has done)

**SUPABASE:** Migration `20260821130000_player_guardian_360_rpcs.sql` applied and confirmed live via direct `pg_get_functiondef` inspection of all 6 new/modified functions and the new trigger, not assumed from apply success alone.

---

## GROUND TRUTH (established before any change)

`pwd`/`git rev-parse --show-toplevel` confirmed `D:\Ai Projects\Mal3aby`. `git branch --show-current` = `main`. `git status --short` at session start showed uncommitted, in-progress WhatsApp consent-hardening work (`WhatsAppActivityTab.tsx`, `whatsapp-connector/README.md`/`package.json`, an untracked migration) belonging to a different, explicitly-deferred phase per the directive's own instruction ("must fix the domain model BEFORE WhatsApp hardening continues") — left completely untouched throughout this session, never staged, never committed. `git worktree list` showed 3 additional worktrees from other sessions and a nested `.codex-temp/manageability` checkout — none touched. `git log --oneline --decorate -30` confirmed `main` already contained a separately-completed `codex/manageability-audit` branch's work (branch/field/pricing lifecycle audits), merged in cleanly before this session began.

---

## IDENTITY MODEL

**GUARDIAN = CUSTOMER: PASS** — Confirmed by direct schema audit: `guardian_links` has no name/phone/email columns of its own; every guardian reference is `customer_id -> customers(id)`. No second identity table was created or considered necessary — the architecture audit found this was already correct.

**NO DUPLICATE GUARDIAN IDENTITY: PASS** — `create_player_with_guardian`, `link_guardian_to_player` both take `p_customer_id`, never guardian name/phone/email fields. The shared `CustomerSelector` component (pre-existing, reused unchanged) is the only path that creates or searches a Customer anywhere a guardian is selected.

**PLAYER DISTINCT ENTITY: PASS** — `players` table unchanged (no new columns added); Player 360 built entirely on the existing schema.

**MULTIPLE PLAYERS PER GUARDIAN: PASS** — Live-verified: "QA Guardian" has 5 linked players (QA Player One, QA Player B, SP-Academy QA Test Player, SP-Academy QA No-Guardian Player, and QA Player Two — created live via the Customer 360 "Add Player" UI during this session's production E2E pass), all visible under the same Customer 360 profile.

**MULTIPLE GUARDIANS PER PLAYER: PASS** — Live-verified via `link_guardian_to_player`: a test player was linked to two distinct guardian customers (father + mother relationships), both visible on Player 360's Guardians tab.

**ONE PRIMARY GUARDIAN: PASS** — DB-enforced via the pre-existing partial unique index `guardian_links_one_primary_per_player` (confirmed present, unmodified). `set_primary_guardian()` performs the swap atomically under a row lock (`FOR UPDATE` on all of the player's `guardian_links` rows) so two primaries are never briefly possible even under concurrency.

---

## CUSTOMER 360

**PLAYERS SECTION: PASS** — Pre-existing "Academy & Players" tab (`get_customer_academy_players`) — no changes needed to the read path, already correctly aggregated.

**ADD PLAYER: PASS** — New. `AddPlayerFromCustomerDialog` in `Customer360Page.tsx`, calling `create_player_with_guardian` with the current customer fixed as the guardian — no duplicate customer creation, no re-search. Live-verified in production: created "QA Player Two" from Customer 360, immediately appeared in the list.

**LINK EXISTING PLAYER: NOT IMPLEMENTED THIS PASS** — See Accepted Risks. `link_guardian_to_player` (the backend RPC this would need) exists and is proven; only the "search existing player, link to this guardian" frontend affordance was not built, since the directive's own mandatory E2E scenario (section 72) does not exercise it and no reported failure specifically named it missing.

**OPEN PLAYER: PASS** — Every player row is now a real `Link` to `/app/academy/players/:playerId`. Live-verified in both dev and production.

**EDIT PLAYER: PASS** (via Player 360, not inline on Customer 360 — matches the directive's own "Player 360 is the canonical detail/edit location" instruction, section 20).

---

## PLAYER 360

**OVERVIEW: PASS** — Name, DOB, gender, status, primary guardian, current membership, outstanding, attendance rate. Live-verified.

**EDIT: PASS** — `update_player` RPC; live-verified end-to-end through the actual UI (renamed a test player, confirmed the new name persisted and the subscription/financial data were completely untouched by the edit).

**GUARDIANS: PASS** — List with relationship, primary badge, "Set primary" / "Remove" actions, "Add guardian" opening the shared `CustomerSelector`. Live-verified: added a second guardian, swapped primary, removed a relationship (confirmed the underlying customer and player rows remained intact after removal).

**MEMBERSHIPS: PASS** — Full subscription history per player (not just the current one), reading directly from `subscriptions`/`enrollments`/`groups` — no new ledger.

**SUBSCRIPTIONS: PASS** — Same tab as above; historical price safety proven live (see Finance section).

**FINANCIAL: PASS** — Total/Paid/Outstanding + payment-status badge, reading `get_invoice_payment_summary` — the same source of truth Customer 360/Finance already use, no duplicate aggregation.

**ATTENDANCE: PASS** — Reads directly from the existing `attendance` table, no new engine.

**ACTIVITY: NOT IMPLEMENTED THIS PASS** — See Accepted Risks.

---

## ACADEMY

**ADD NEW PLAYER: PASS** — `AddPlayerDialog` in `PlayersSection.tsx` converted to the transactional `create_player_with_guardian` RPC; guardian is now genuinely optional (previously force-required by the frontend even though the domain never required it).

**SELECT EXISTING PLAYER: PASS (unchanged, pre-existing)** — `EnrollmentSection.tsx`/`MembershipsSection.tsx`'s existing enrollment/subscribe wizards were not touched; they already selected from existing players correctly.

**ADD GUARDIAN: PASS** — Both from Academy's own `AddPlayerDialog` (at player-creation time, now optional) and from Player 360 (`AddGuardianDialog`, at any later time) — same `CustomerSelector`, same underlying RPCs.

**CHANGE PRIMARY: PASS** — `set_primary_guardian`, live-verified atomic (see Identity Model section).

**SUBSCRIBE: PASS (unchanged, pre-existing)** — `create_enrollment_with_subscription` was not modified; its existing optional-`p_guardian_id`-with-primary-guardian-fallback behavior was read, understood, and confirmed already correct per directive rule 23 (does not force-require a guardian id if a primary guardian link already resolves one) — no change was needed here, verified via a live "no billing guardian" clean-error test on a genuinely guardian-less player.

**RENEW: PASS (unchanged, pre-existing)** — `renew_academy_subscription` was read in full; confirmed it already creates a new `subscriptions` row via `INSERT` rather than mutating the old one (matching directive rule 27's exact requirement), and confirmed unaffected by this session's new price-immutability trigger for exactly that reason.

**ARCHIVED MEMBERSHIP BLOCK: PASS (unchanged, pre-existing)** — Not modified or re-tested this session; no evidence found that this session's changes touch that control surface.

---

## FINANCE

**PAYER MODEL: PASS** — Confirmed explicit and unambiguous via direct schema audit: `invoices.customer_id` is `NOT NULL` and is always the resolved guardian/payer; `invoices` has no `player_id` column at all (by design, confirmed consistent everywhere). Player = subscriber/member; Customer/Guardian = payer/contact — never conflated.

**PARTIAL PAYMENT: PASS (unchanged, pre-existing engine, reused)** — Player 360's Financial tab reads the same `get_invoice_payment_summary` every other module uses; no new payment-collection logic was written.

**FULL PAYMENT: PASS (unchanged, pre-existing engine, reused)**

**OUTSTANDING: PASS** — Live-verified correct roll-up at both the Player level (400 EGP for a single player's own subscription) and the Customer level (700 EGP aggregate across that guardian's players).

**HISTORICAL PRICE: PASS** — The headline finding of this pass. Confirmed via direct schema audit that the pre-existing INSERT-only trigger (`enforce_academy_subscription_master_price`) only validated a subscription's price AT CREATION TIME against the group's then-current price — it never protected an already-created row from a later direct `UPDATE`, and the `subscriptions_update` RLS policy permitted exactly that write from any staff member with `subscription.update`. Added `protect_subscription_price_immutable` (a new `BEFORE UPDATE` trigger, silently reverting `price`/`discount`/`enrollment_id`/`plan_type`/`start_date` to their old values — matching the existing `protect_tenant_id_immutable` pattern already used elsewhere in this codebase). Live-verified the complete scenario from directive rule 74: group price changed 300 -> 400; existing subscription remained 300 (both via direct SQL and via the actual rendered UI, screenshotted); a renewal attempt at the stale 300 price was correctly rejected by the pre-existing INSERT trigger; a renewal at the correct 400 succeeded and created a genuinely new row; a direct `UPDATE ... SET price = 1` against the settled 300 subscription was silently reverted by the new trigger, confirmed by re-querying the row afterward.

**GOVERNMENT RECEIPT: PASS (unchanged, not touched this session)** — `record_payment`'s existing official-receipt requirement logic was read and confirmed to sit downstream of (and therefore unaffected by) every change in this session.

**CASH SHIFT: PASS (unchanged, not touched this session)** — Explicitly reviewed for interaction risk; this session's change surface (player/guardian relationship management, subscription price immutability) does not intersect `cash_shifts`/`employee_cash_liabilities` at all.

---

## ATTENDANCE

**ATTENDANCE: PASS** — Player 360's Attendance tab reads directly from the pre-existing `attendance` table.

**QR: NOT SURFACED ON PLAYER 360 THIS PASS** — See Accepted Risks. The existing player-level QR generation (`ensure_player_qr`, used by the old `PlayerDetailDialog`) remains reachable via the "Quick actions" button preserved on the Academy player list, but was not additionally surfaced on the new Player 360 page.

**HISTORY: PASS** — Attendance history table renders on Player 360, paginated (limit 30, matching the existing pattern used by Customer 360's other history tables).

---

## CUSTOMER DATA

**CUSTOMER FORM: NOT MODIFIED THIS PASS** — The architecture audit found the existing `upsert_customer`/`CustomerSelector`/Customer 360 edit form already reasonably scoped (full name, phone, email, WhatsApp consent) with no evidence of a genuine operational gap specific to this directive's Academy/Guardian scope — no changes made, per the explicit instruction not to add fields without a real, evidenced use.

**PHONE/E164: PASS (unchanged, verified not regressed)** — Every guardian-selection path in this session's new code goes exclusively through the existing `CustomerSelector`/`upsert_customer`, which already owns all E.164 normalization — no new phone-parsing logic was written anywhere in this pass.

**CONSENT SAFETY: PASS (unchanged, verified not regressed)** — No code in this session touches WhatsApp consent at all; the existing "staff-entered phone is not automatic consent" invariant was not re-implemented or duplicated anywhere.

**DUPLICATE PROTECTION: PASS (unchanged, reused)** — Every guardian-linking path reuses `CustomerSelector`'s existing duplicate-detection UX (search-first, then create-with-conflict-resolution via `upsert_customer`) — no second implementation.

---

## SECURITY

**SERVER AUTHORIZATION: PASS** — All 6 new/modified RPCs (`create_player_with_guardian`, `update_player`, `link_guardian_to_player`, `unlink_guardian_from_player`, `set_primary_guardian`, `get_player_360_summary`) are `SECURITY DEFINER` with explicit `has_permission()` + `user_club_ids()` checks, verified by direct authenticated-session SQL: a genuinely foreign club_owner (confirmed zero membership in the target club before testing) was hard-rejected with "not authorized" on both `get_player_360_summary` and `create_player_with_guardian`.

**TENANT ISOLATION: PASS** — See above; also covered by the new automated integration test suite's dedicated tenant-isolation test.

**BRANCH ISOLATION: N/A** — Academy in this codebase's existing architecture is club-wide, not branch-scoped (confirmed by inspecting `enrollments`/`groups`/`players` — none carry a `branch_id` that would need per-branch access control); no branch scope was invented where the existing domain doesn't have one, per the explicit instruction not to do so.

**RLS: PASS, NOT WEAKENED** — No RLS policy was modified, disabled, or weakened at any point. The new `protect_subscription_price_immutable` trigger is an ADDITIONAL restriction layered on top of the existing `subscriptions_update` policy, not a replacement for it.

---

## UX

**ARABIC RTL: PASS** — Every new screen (Player 360, Add Player dialogs, Add Guardian dialog) verified live in Arabic with correct RTL layout, `bdi`-wrapped phone numbers, correct Eastern Arabic numeral money formatting.

**ENGLISH LTR: NOT RE-VERIFIED THIS PASS** — The comprehensive i18n key-resolution scan (below) is stronger evidence for English-mode correctness specifically than a manual click-through would be, but no live English-mode screenshot was taken this session. Low risk: the scan covers every literal `t()` call in the new code with zero remaining gaps.

**375×812: PASS** — Direct DOM measurement on Player 360 (`scrollWidth === clientWidth === 375`), no overflow.

**390×844 / 430×932: NOT INDEPENDENTLY RE-MEASURED THIS SESSION** — Same reasoning as the prior Controlled-Scale Readiness report: no code touched this session carries viewport-width-dependent risk beyond what the shared `TabsList`/dialog components already handle correctly (confirmed live at 375px, the narrowest and most overflow-prone size).

**DESKTOP: PASS** — All screenshots in this report were taken at desktop width; confirmed no layout regression.

---

## TESTS

**UNIT: 62 PASS / 0 FAIL** (unchanged baseline, re-run after every material change this session)

**INTEGRATION: 0 PASS / 0 FAIL / 32 SKIPPED** — 4 live-QA integration suites now exist (`customer360`, `staff360`, `sp001-cancelled-booking`, and this session's new `player-guardian-customer`, 7 tests), all skipping cleanly without real browser-session credentials — reported honestly as skipped, never as passed. Every invariant those 7 new tests codify (guardian=customer, player-without-guardian, multi-guardian + single-primary, edit-preserves-relationships, unlink-preserves-customer-and-player, summary self-consistency, tenant isolation) was independently live-verified via direct authenticated-session SQL and/or the actual running UI this session — real evidence exists, just not via the automated harness itself.

**PRODUCTION E2E: 2 PASS / 0 FAIL** — Player 360 (`/app/academy/players/12a4ebd4-...`) and Customer 360's Add Player action both confirmed rendering correctly against real production data on `mal3aby.app`, post-deploy, with the correct new bundle hash confirmed serving.

---

## BUGS

**FOUND:**
1. Player creation was non-transactional (two independent inserts, no rollback safety) — could orphan a player with zero guardians.
2. No RPC existed to link/unlink a guardian or change primary — would have required raw table writes bypassing the one-primary invariant's clean-error path.
3. No Player 360 page existed at all.
4. Customer 360 had no way to add or navigate to a linked player.
5. Academy's `AddPlayerDialog` incorrectly force-required a guardian, contradicting the actual domain rule (guardian is optional).
6. **Security-relevant**: `subscriptions.price`/`enrollment_id`/`plan_type`/`start_date` were mutable via a direct client-side `UPDATE` with zero server-side protection against rewriting a settled historical price.
7. A PL/pgSQL "record not yet assigned" runtime bug in the first draft of `get_player_360_summary` (referencing an unassigned record's field inside a `CASE` expression) — caught immediately via live testing before this was ever deployed, not shipped.
8. `academy.enrollments.planType` and two Academy tab-label i18n keys used in the new Player 360 page didn't exist in either locale (silently falling back to hardcoded English).

**FIXED:** All 8, listed above, each with live before/after evidence.

**REMAINING:** None known. Accepted, explicitly-scoped gaps are listed separately below (not bugs — deliberately out-of-scope-this-pass items).

---

## MIGRATIONS

**NEW:** `20260821130000_player_guardian_360_rpcs.sql` — 6 new/modified functions, 1 new trigger + trigger function. Applied and verified live.

**MIGRATION REPAIR:** NO — no bulk repair, no rewriting of already-applied migrations, no renaming of remote-applied migrations. Forward-only, matching the project's established discipline.

---

## DEPLOYMENT

**LOCAL MAIN = ORIGIN/MAIN: PASS** — Verified via `git fetch` + hash comparison before and after the single push this session performed.

**SUPABASE: PASS** — Migration applied; all 6 functions and the new trigger confirmed live via direct introspection, not assumed.

**CLOUDFLARE: PASS** — `wrangler deploy` succeeded, 99 files uploaded, deployed to `mal3aby.app` and `www.mal3aby.app`.

**PRODUCTION BUNDLE: PASS** — Confirmed serving `index-B3gv4p_E.js` (matching the local build from this exact commit) after clearing the PWA service worker's stale cache — the same required step every deploy on this project has needed, never blindly trusted from `wrangler deploy`'s exit code alone.

---

## ACCEPTED RISKS

**Risk 1 — "Link Existing Player" (as opposed to "Add [new] Player") not built from Customer 360**
Severity: P3
Reason not fixed: The backend RPC this needs (`link_guardian_to_player`) already exists and is fully proven; only a "search for an existing unlinked player" frontend affordance is missing. The directive's own mandatory E2E scenario (section 72) never exercises this specific flow.
Impact: Low — a guardian can still be linked to an existing player from the opposite direction (Player 360's "Add Guardian"), which is fully built and proven. This risk is the missing *reverse* entry point only.
Recommended follow-up: A small `PlayerSelector` component (search existing players by name within the club) plus a "Link existing player" action alongside Customer 360's "Add Player" button, reusing `link_guardian_to_player`.

**Risk 2 — Player 360 has no "Activity" tab**
Severity: P3
Reason not fixed: No existing per-player audit-log aggregation RPC exists (unlike Customer 360's `get_customer_activity`); building one was judged lower-priority than the mandatory identity/finance/attendance surfaces given session scope, and every individual mutation this session's own RPCs perform (`player.create`, `player.update`, `guardian_link.create`, `guardian_link.remove`, `guardian_link.set_primary`) IS correctly audit-logged via `write_audit_log` — the data exists, only the dedicated read/display surface on Player 360 itself does not.
Impact: Low — the audit trail is real and complete at the database level (confirmed via `write_audit_log` calls in every write RPC), reachable today via the existing club-wide Audit Log page; only a player-scoped filtered view is missing.
Recommended follow-up: A `get_player_activity` RPC mirroring `get_customer_activity`'s exact shape, plus an Activity tab on Player 360.

**Risk 3 — QR not surfaced on Player 360**
Severity: P3
Reason not fixed: The existing `ensure_player_qr` RPC and its UI remain fully reachable via the "Quick actions" button preserved on the Academy player list (directive section 20 explicitly permits keeping quick actions available); duplicating that UI onto Player 360 itself was judged lower-priority.
Impact: Low — functionality is not lost, only its primary-page location.
Recommended follow-up: Surface the existing QR action as a button on Player 360's Overview or Attendance tab, reusing `ensure_player_qr` unchanged.

**Risk 4 — 390×844 / 430×932 not independently re-measured this session**
Severity: P3
Reason not fixed: This session's changes carry the same class of layout risk as any other tabbed detail page in this app — confirmed via the shared `TabsList` component's already-fixed horizontal-scroll behavior (the exact fix that closed SP-006 in the prior Controlled-Scale Readiness pass), and confirmed no overflow at 375px (the narrowest, most overflow-prone of the three mandated widths).
Impact: Negligible.
Recommended follow-up: None required unless a future pass specifically touches layout/CSS for these pages.

**Risk 5 — Integration test suite not executed this session (32 of 32 tests across all 4 suites skipped, 0 run)**
Severity: P2
Reason not fixed: No browser-authenticated QA credentials were available or permitted to persist across this session (same standing constraint documented in every prior report this engagement).
Impact: The specific invariants the new 7-test suite codifies were each independently proven via direct authenticated-session SQL and/or the actual running UI this session — genuine evidence exists, just not via the automated harness.
Recommended follow-up: Run `npm test` with `CUSTOMER_360_TEST_EMAIL`/`PASSWORD` set (the same credentials all 4 suites already share) whenever available.

---

## FINAL VERDICT

**MAL3ABY ACADEMY PLAYER/GUARDIAN/CUSTOMER
PRODUCTION ACCEPTANCE PASSED WITH ACCEPTED RISKS**
