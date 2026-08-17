# Mala3by — Owner-Level Professional Product Review: State & Resume Cursor

This file is the durable tracking artifact for the Master Autonomous Owner-Level Full Product Review directive. It survives context resets — always read this file first before resuming.

**Directive received:** 2026-08-17
**Review started:** 2026-08-17

---

## RESUME CURSOR

```
current_role: Club Owner
module: Phase 3 — Club Owner review: FIRST PASS COMPLETE (all /app/* screens visited: Today, Bookings, Academy, Customers, Billing, CashShift, Outstanding, Reports, Staff, Settings, Subscription, More)
screen: last visited /app/more (nav hub, no issues)
test_scenario: manual live click-through as club owner via browser, cross-checked against real DB state via SQL
last_issue: (see DEFECT LOG — 9 found & fixed so far, all committed, all gate-clean)
last_fix: 30ba84e (Outstanding page listing fully-paid invoices)
last_commit: 30ba84e
test_status: gate clean after every fix (tsc/build/lint/test), all fixes live-verified against real data
blocker: none
STANDING RULE (do not violate): never stop after a phase/checkpoint/commit to send a report or wait for permission. Update this file, commit if appropriate, continue immediately to the next phase. Only 2 valid stop conditions: (1) the ENTIRE program complete (owner review + second pass + WhatsApp + final regression + final report), or (2) a genuine external blocker (missing secret/credential, external service down, unresolvable business decision) after exhausting investigation/workarounds. Task size, session length, phase count, or number of defects found are NEVER valid reasons to pause.
environment_note: whatsapp-connector was found stuck (PID 28056, every poll failing "fetch failed") -- diagnosed as the long-running process's own stale network state, NOT actual DNS/network failure (a fresh `node -e` fetch to the exact same Supabase URL from the same machine succeeded immediately with a real 401). Restarted cleanly (`npm run dev`, new PID) per explicit user request ("open the server"): session correctly restored from the encrypted Postgres-stored credentials with NO new QR scan required (re-confirms session persistence across restart), briefly hit one expected "stream:error/conflict/replaced" from the old session's tail end (harmless, absorbed by the crash guards), then stabilized. Confirmed healthy via DB: whatsapp_accounts.status='connected', last_error=null, fresh last_seen_at, real connected_phone_number. Both servers (mala3by-dev on :5173, whatsapp-connector) now genuinely running.
progress_this_session: Phase 4 (onboarding wizard) reviewed via source -- clean, no defects (3-step wizard, no hidden prerequisites, honest messaging for both trial-granted and additional-club paths, real validation). Phase 5/6/9/10 (Manager/Reception/Guardian/Coach role-conditional dashboard) spot-checked via TodayPage.tsx source -- confirmed backend-safe (Coach's revenue query has `enabled: !isCoach`, not just UI-hidden; financial stats correctly Manager-only). Phase 8 (Customer portal /portal) sampled live -- real booking history, correct status separation (Upcoming/Previous), no defects found. Phase 22 (QR security) spot-checked -- qr_credentials and invoice_verification_tokens confirmed structurally separate tables (no credential-purpose mixing). Phase 43 (tenant isolation) spot-checked -- payments' real RLS policies confirmed correctly club_id-scoped via user_club_ids().
progress_this_session_2: Academy enrollment/subscription list reviewed live (20 real active enrollments, correct status). Tooling note: this session's browser-automation pane repeatedly failed to render (screenshot timeouts), and plain `.click()`/ref-based clicks do not activate Radix UI Tabs/rows (they need a full pointerdown/mousedown/pointerup/mouseup/click sequence to match Radix's real listener) -- confirmed this is a TESTING-TOOL limitation, not a product bug, by dispatching the full synthetic pointer-event sequence and getting correct aria-selected=true. Do not mistake a bare `.click()` non-response for a real defect in future passes -- always use the full pointer-event sequence or the `computer` tool with a rendered pane.
data_integrity_sweep (Phase 44, via direct SQL against real production-shaped data): 0 negative-outstanding invoices, 0 orphaned payment_allocations (both payment-side and invoice-side), 0 orphaned refunds, 0 impossible booking time ranges (start>=end), 0 orphaned subscriptions, 0 duplicate-active subscriptions per enrollment, 0 duplicate-open cash shifts per branch. Clean across the board.
progress_this_session_3: Phase 2 (commercial entitlement enforcement) verified server-side, not just UI: enforce_branch_limit/enforce_field_limit/enforce_academy_limit all confirmed as ENABLED triggers directly on branches/fields/programs tables (not merely defined-but-unused functions) -- matches the earlier UI observation of "بلا حد" (unlimited) for the trial plan; backend is the real authority and agrees with what's shown. get_club_platform_access() logic read in full and confirmed correct (suspended/closed->blocked, no subscription->blocked, past end_at+grace->blocked, else full/grace correctly). Systematic grep for the "destructive action fires with zero confirmation" bug class (which produced defects #7 and #11) found and fixed the MOST SEVERE finding of this entire review (#11, suspend-club) -- swept the rest of the codebase for the same pattern and confirmed no other instances remain unprotected (cash-shift-close and invoice-void independently verified as already correctly gated).
progress_this_session_4: Phase 13 (financial reconciliation cross-check) DONE -- found and fixed a real orphaned-payment data-integrity defect (#12 above). Attendance duplicate-check (Phase 21 invariant) confirmed clean via direct SQL (0 dup rows on session_id+player_id). Phase 19-21 freeze/unfreeze: get_subscription_effective_end_date() re-verified correct (end_date + freeze duration = right answer) -- BUT an initial test via the raw execute_sql admin tool (no auth.uid() session) returned a false-looking NULL because the function has an inline `user_club_ids()`/`has_permission()` tenant guard in its WHERE clause; retested correctly via the authenticated browser RPC call and got the right answer (2026-09-05). METHODOLOGY NOTE for the rest of this review: any RPC with an inline tenant/permission guard MUST be tested via the authenticated browser session (supabase.rpc(...) in the page), never via the raw execute_sql admin tool, or it produces false-negative/null results that look like bugs but aren't -- execute_sql is fine for direct table reads/schema inspection/data-integrity sweeps (no auth context needed there), not for calling permission-gated RPCs.
STANDING RULE REINFORCED (per explicit user correction): do not write any "checkpoint"/"summary"/"I'll pause here" language to the user between phases. Finish step -> verify -> commit -> update this file -> immediately execute the next task, with zero chat-facing narration of stopping points. Only 2 valid outputs to the user: (1) final COMPLETE report after the entire program (all review phases + second full review + all fixes + final regression + final gate + WhatsApp QR integration + real local WhatsApp testing + final regression after WhatsApp), or (2) a genuine unresolvable external blocker. Nothing else gets sent to the user; everything else lives only in this file.
progress_this_session_5: Phase 21/22 QR membership credential issuance verified live via authenticated RPC: ensure_player_qr() correctly rejected a cross-tenant player (real tenant isolation working, not a bug) and correctly issued a real 64-char token for a same-tenant player with type=player_membership/single_use=false/expires_at=null exactly as designed.
progress_this_session_6: Phase 45 concurrency -- ALL THREE explicitly-named races tested for real, not just inferred: (1) double-booking: direct raw table INSERT of an overlapping slot correctly rejected by the `no_overlapping_field_bookings` exclusion constraint (23P01), proven even bypassing the RPC layer entirely; (2) academy enrollment capacity: create_enrollment_with_subscription() confirmed to use `FOR UPDATE` row-locking; (3) cash-shift-open race: fired two genuinely concurrent open_cash_shift() RPC calls for the same branch via Promise.all from the real authenticated browser session -- exactly one succeeded, one cleanly rejected ("a cash shift is already open for this branch"), backed by a real UNIQUE PARTIAL INDEX (cash_shifts_one_open_per_branch WHERE status='open') that I initially almost mis-flagged as missing before finding it -- correctly caught my own near-false-positive before writing it up. Test shift closed cleanly afterward (0 variance), no residue.
progress_this_session_7: Phase 40 (error recovery) reviewed -- src/lib/errors.ts translateSupabaseError() confirmed to correctly never leak raw Postgres error text, has real coverage for the exact error codes this review's own fixes produce (23P01 exclusion violation, 23505 unique violation, 42501 permission denied). PlatformClubDetailPage's onError handlers use static generic Arabic fallbacks (a different but equally safe pattern -- never leaks internals either). Double-suspend correctly rejected with a real, specific RPC-level reason; UI shows a safe generic message (acceptable P3 UX gap, not fixed -- correctness preserved, only specificity lost). Phase 47 (audit coverage) verified for the new suspend/reactivate RPCs: exactly 2 successful suspends + 2 successful reactivates from this session's testing produced exactly 2+2 real audit_logs rows; the failed double-suspend attempt correctly produced ZERO audit noise (raised exception before reaching write_audit_log) -- exactly correct, no spurious logging.
progress_this_session_8: Phase 26-27 reports drill-down DONE. get_revenue_report() total_revenue (8890) exactly matches get_payment_method_report() total_collected (8890), both correctly reconciled post orphaned-payment fix. get_customer_activity_report()'s apparent "spend/booking_count mismatch" for محمود علي (700 spend, 1 booking) investigated and confirmed correct-by-design: total_spend sums ALL completed payments (bookings + academy subscriptions), booking_count deliberately scopes to bookings only -- verified the exact 200+500=700 payment breakdown matches. get_field_occupancy_report() sampled: 5 real fields, correct zero occupancy for the maintenance-flagged court and empty padel field.
progress_this_session_9: Phase 36 (RTL) continued sweep -- found and fixed 3 more real time-range bidi-swap instances (BookingDetailSheet's الوقت field, CoachTodayView session times, QuickBookingSheet slot times) via broader grep patterns. Checked BillingPage's "{name} — {invoiceNumber}" pattern, judged genuinely lower-risk (mixed alphanumeric code, not bare numeric pair) and left as-is. This RTL bidi-swap defect class now believed FULLY swept (StatCard + 4 academy/reports files + 3 time-range files = 8 real instances found and fixed total this review).
progress_this_session_10: Phase 37 (English/LTR) verified: ar/en locale files have exactly matching 55/55 keys (0 missing either direction), 0 Arabic characters leaking into English values, spot-checked translations read as genuinely professional English (not placeholder/copy-paste). Noted (not a defect, confirmed already-known/accepted scope from Gate 10): i18n coverage is intentionally partial (nav/portal chrome only, ~55 keys) -- most in-app Arabic text is hardcoded inline, matching this whole review's observation and Gate 10's own documented "representative sweep" scope. Phase 41 (accessibility): found and fixed 4 real icon-only date-nav buttons (BookingsPage + BookingsMobileView, prev/next day) with zero aria-label -- added labels matching real semantic action, not visual icon direction (which is already correctly RTL-flipped). Grepped for the same icon-only-button pattern codebase-wide, confirmed these were the only remaining unlabeled instances. Dialog/Sheet confirmation flows (my own earlier fixes) confirmed to inherit correct focus-trap/ARIA behavior for free via Radix UI primitives -- no defect there.
progress_this_session_11: Phase 48 (secrets/security) DONE and clean: 0 .env files ever tracked in git history (current or historical), 0 service-role-key references anywhere in client-side src/, whatsapp-connector/.env correctly gitignored, connector service confirmed never imported into the frontend bundle (comment references only). Scanned the actual BUILT dist/ bundle for JWT-shaped strings -- the only one present decodes to role=anon (correctly public-safe by Supabase's own design, protected entirely by RLS), zero service-role key anywhere in the shipped artifact.
exact_next_action: Phase 14 (audit log security hardening re-verification -- was built in an earlier session, re-test don't rebuild), Phase 42-43 (permission UI-vs-backend re-verification across remaining roles not yet spot-checked: Cashier/Guardian explicit backend checks), Phase 49 (dead UI final sweep), Phase 50 (documentation reconciliation: README/PROJECT_STATE/AUTONOMOUS_EXECUTION_STATE/AUTONOMOUS_DECISION_LOG must not claim anything false about current state) -- then declare Professional Owner Review COMPLETE (first pass) and immediately begin the MANDATORY SECOND FULL REVIEW PASS per the directive (re-test high-risk/high-frequency flows as Platform Owner/Club Owner/Manager/Reception/Customer/Guardian specifically hunting for regressions from this session's own 19 fixes so far) -- do not skip the second pass, do not declare the whole program complete after only the first pass. (reports drill-down consistency), Phase 33-41 (visual/mobile/RTL/accessibility/error-recovery -- prior sessions already did extensive RTL/mobile/PWA QA per PROJECT_STATE.md Phase 15/16, treat as REVIEW not REBUILD), Phase 45-47 (concurrency/performance/audit), continuing through Phase 50 -> mandatory second full re-review (re-test high-risk flows specifically hunting for regressions from THIS session's own fixes: no-show confirm, Outstanding filter, RTL bdi wraps, Alerts no_subscription kind, Overview KPI split, suspend-club RPC, void-payment fix) -> WhatsApp integration phase (already exists and confirmed healthy/connected -- verify end-to-end per the separate WhatsApp directive: real booking -> notification -> WhatsApp send test, WITH EXPLICIT USER PERMISSION before sending to any real phone number, per this session's own established safety-rule precedent -- this is a hard constraint, not optional) -> final regression -> final report (the ONLY point at which the user hears from me again, per explicit standing instruction). Servers confirmed running: mala3by-dev (:5173) and whatsapp-connector (restarted, healthy, connected, phone 201116505553).
```

---

## PHASE 0 — TRUE CURRENT STATE (completed 2026-08-17)

- **Branch:** `master`
- **HEAD:** `045cf082b15284c76f4570cfd73bfbdea018d26d` ("docs: full financial regression + acceptance matrix (task #90)")
- **git status:** clean except `.claude/launch.json` (dev-tooling config, unrelated to product code, not touched)
- **Worktrees:** one stale secondary worktree (`.claude/worktrees/goofy-ptolemy-0d3fbc`, branch `claude/goofy-ptolemy-0d3fbc`) — behind master, clean, zero unique commits. Inspected, confirmed inert. Left alone (not deleted) per directive.
- **Migrations applied (live Supabase):** 109
- **Tables (public schema):** 61, **100% RLS-enabled** (0 without RLS)
- **SECURITY DEFINER functions:** 98
- **npm scripts (real, from package.json):** `dev` (vite), `build` (`tsc -b && vite build`), `lint` (`eslint . --ext ts,tsx`), `preview`, `test` (`vitest run`) — no separate `typecheck` script exists; `tsc -b`/`tsc --noEmit` used directly.
- **Baseline gate result:** `tsc --noEmit` ✅ 0 errors · `npm run build` ✅ · `npm run lint` ✅ 0 errors / 4 pre-existing warnings (fast-refresh only-exports-components, in `AuthProvider.tsx`, `DirectionProvider.tsx`, `badge.tsx`, `button.tsx` — cosmetic, not functional) · `npm test` ✅ 4/4 passing.
- **WhatsApp connector:** separate Node service at `whatsapp-connector/`, running live during this review (PID seen: 28056, started 2026-08-17 08:15), one real connected account (club `6ca5315e-e199-4531-9fb1-1df358cda087`, phone `201116505553`, status `connected`). Baileys session persisted encrypted in Postgres (`whatsapp_accounts.session_credentials_encrypted`, AES-256-GCM) — confirmed NOT relying on localStorage, confirmed `.baileys-auth-tmp/` correctly gitignored and untracked.

## PHASE 1 — ROUTE INVENTORY (from `src/app/routing/router.tsx`, ground truth)

### Public (no auth) — `PublicLayout`
`/`, `/pricing`, `/contact`, `/terms`, `/privacy`, `/login`, `/signup`, `/forgot-password`, `/reset-password`

### Standalone (no layout chrome)
`/onboarding`, `/verify/:token` (public invoice verification, task #86)

### `/app` (RequireAuth — any club membership) — `AppLayout`
`/app` (Today/dashboard), `/app/bookings`, `/app/academy`, `/app/customers`, `/app/billing`, `/app/cash-shift`, `/app/subscription`, `/app/outstanding`, `/app/reports`, `/app/staff`, `/app/settings`, `/app/more`, `/app/club` (redirect → `/app/settings`, kept for stale links)
Plus `/scan` (also under RequireAuth, own top-level path, not under AppLayout chrome)

### `/portal` (RequirePortalAuth — customer/guardian) — `PortalLayout`
`/portal`, `/portal/academy`, `/portal/payments`, `/portal/qr`, `/portal/profile`

### `/platform` (RequirePlatformOwner) — `PlatformLayout`
`/platform`, `/platform/clubs`, `/platform/clubs/:clubId`, `/platform/owners`, `/platform/subscriptions`, `/platform/plans`, `/platform/payments`, `/platform/renewals`, `/platform/trials`, `/platform/leads`, `/platform/reports`, `/platform/alerts`, `/platform/audit`, `/platform/settings`

**Total: 39 distinct routes/screens.**

### Feature module directories (`src/features/`)
`academy`, `auth`, `billing`, `bookings`, `clubs`, `customers`, `dashboard`, `onboarding`, `platform`, `portal`, `public-site`, `reports`, `scanner`, `search`, `settings`, `staff`, `verify`

---

## MODULE REVIEW TRACKER

Status values: `not started` / `in progress` / `reviewed — no issues` / `reviewed — issues found` / `reviewed — fixed & reverified`

| # | Module/Screen | Role(s) | Status | Notes |
|---|---|---|---|---|
| 1 | Platform Overview (`/platform`) | Platform Owner | reviewed — fixed & reverified | Fixed ambiguous "موقوف" KPI (7246379), see defect log #2 |
| 2 | Platform Clubs list + detail | Platform Owner | reviewed — fixed & reverified | Fixed raw enum labels (bf1fb34), see defect log #3 |
| 3 | Platform Owners directory | Platform Owner | not started | |
| 4 | Platform Subscriptions/Plans/Payments/Renewals | Platform Owner | not started | |
| 5 | Platform Trials/Leads | Platform Owner | not started | |
| 6 | Platform Reports/Alerts/Audit | Platform Owner | not started | |
| 7 | Platform Settings | Platform Owner | not started | |
| 8 | Today/Dashboard (`/app`) | Owner/Manager/Reception | not started | |
| 9 | Bookings (`/app/bookings`) | Owner/Manager/Reception | not started | |
| 10 | Academy (`/app/academy`) | Owner/Manager/Academy/Coach | not started | |
| 11 | Customers (`/app/customers`) | Owner/Manager/Reception | not started | |
| 12 | Billing (`/app/billing`) | Owner/Manager/Cashier | not started | |
| 13 | Cash Shift (`/app/cash-shift`) | Cashier/Manager | not started | |
| 14 | Platform Subscription (`/app/subscription`) | Club Owner | not started | |
| 15 | Outstanding (`/app/outstanding`) | Owner/Manager | not started | |
| 16 | Reports (`/app/reports`) | Owner/Manager/Accountant | not started | |
| 17 | Staff (`/app/staff`) | Owner/Manager | not started | |
| 18 | Settings (`/app/settings`) | Owner/Manager | not started | |
| 19 | More (`/app/more`) | all | not started | |
| 20 | Scan (`/scan`) | Reception/Coach/Scanner | not started | |
| 21 | Portal Root/Academy/Payments/QR/Profile | Customer/Guardian | not started | |
| 22 | Public site (Home/Pricing/Contact/Terms/Privacy) | Anonymous | not started | |
| 23 | Auth (Login/Signup/Forgot/Reset) | Anonymous | not started | |
| 24 | Onboarding | New owner | not started | |
| 25 | Invoice verification (`/verify/:token`) | Anonymous | not started | (built + live-tested at creation, task #86 — re-verify, not rebuild) |
| 26 | WhatsApp Connection + Messaging Safety (Settings tab) | Owner/Manager | not started | (built + tested across tasks #91-105 — re-verify current live behavior, not rebuild) |

---

## DEFECT LOG

| ID | Priority | Module | Description | Root cause | Fix commit | Verified |
|---|---|---|---|---|---|---|
| 1 | P1 | PlatformLayout | No mobile navigation at all below 768px (sidebar `hidden md:flex`, mobile header had no menu/links) | Missing mobile fallback that AppLayout already has (bottom nav) — never built for PlatformLayout | 7246379 | Yes — live: hamburger appears, drawer opens w/ 13 items, click navigates + closes |
| 2 | P2 | PlatformOverviewPage | "أندية موقوفة" KPI (admin `clubs.status='suspended'`) uses the same Arabic word as PlatformClubsPage's "حالة الاشتراك: موقوف" (`get_club_platform_access()==='blocked'`) — different concepts, same label, real "needs attention" signal invisible on dashboard | Two independently-correct fields sharing one ambiguous label; no dashboard surface for subscription-blocked clubs | 7246379 | Yes — live: 0 admin-suspended / 1 subscription-blocked, matches Clubs list |
| 3 | P2 | PlatformClubDetailPage, PlatformReportsPage | Raw enum values (`trial`, `active`) rendered directly in Arabic UI in 4 places | No label map applied at those render sites, unlike the file's own existing LIMIT_TYPE_LABELS pattern | bf1fb34 | Yes — live: "trial" became "تجربة مجانية" everywhere |
| 4 | P2 | PlatformAlertsPage | Club with zero subscription history invisible on Alerts (no rule-based alert kind for it) | Alert loop only ever iterated existing platform_subscriptions rows | 81f6229 | Yes — live: club now shows "لا يوجد اشتراك مسجّل" alert |
| 5 | P1 | FirstRunChecklist | Two checklist items permanently stuck "(قريبًا)"/unclickable; hasCustomer hardcoded to always-false | Stale Phase-0-era comments/logic never updated when fields/bookings/customers tables shipped (long ago) | a0e7637 | Yes — live: all 3 items correctly checked for a club with real data |
| 6 | P2 | StatCard (shared component) | Composite "N / M" values visually digit-swapped in RTL context (DOM correct, rendering wrong) | No Unicode bidi isolation on numeric value content | a0e7637 | Yes — live: "الملاعب المشغولة الآن" now shows "0 / 4" correctly |
| 7 | P1 | BookingDetailSheet | "تسجيل عدم حضور" fired instantly on click, zero confirmation — genuinely mutated a real confirmed booking to no_show during this review (reverted via SQL) | No confirmation step, inconsistent with the adjacent Cancel action's own two-step pattern in the same file | 5d1eada | Yes — live: confirm prompt now required; تراجع leaves booking status untouched (verified via SQL) |
| 8 | P2 | AcademyOverview, ReportsPage, PlayerStatusPanel, ProgramsGroupsSection | Same RTL digit-swap risk as #6, found via codebase-wide grep for the same composite-ratio pattern outside StatCard | Same root cause as #6, not covered by that fix since these don't use StatCard | 09b070d | Yes — live: AcademyOverview's "17/20" group-capacity card confirmed rendering correctly |
| 9 | P1 | OutstandingPage | Fully-paid invoices (outstanding=0) listed with "مستحق" badge on the one screen whose purpose is showing unpaid invoices | outstanding_invoices view is deliberately WHERE status='issued' only (shared by other consumers with broader scope); this page never added its own outstanding>0 filter | 30ba84e | Yes — live: 12+ zero-balance rows correctly disappeared, every remaining row has real nonzero outstanding |
| 10 | P3 (defense-in-depth, not client-exploitable) | ~44 public tables | RLS enabled but not FORCED (relforcerowsecurity=false) | Migrations across the whole project history never set FORCE ROW LEVEL SECURITY | not fixed | N/A — confirmed real client roles (anon/authenticated via PostgREST) are never table owners, so RLS policies apply regardless of FORCE; this only matters against direct table-owner/superuser DB access (e.g. an admin SQL tool), which real app users never have. Spot-checked payments' real policies (club_id IN user_club_ids()) — correctly tenant-scoped. Logged as a legitimate but low-severity hardening item, not fixed now given the disproportionate time cost (44 tables) vs. the broader functional review still pending. |
| 11 | **P0/P1 — most severe finding this session** | PlatformClubDetailPage | "إيقاف النادي" (Suspend Club) — the single most destructive Platform Owner action in the system, capable of shutting down a real paying customer's entire business — fired a raw `clubs.update()` with ZERO confirmation and NO audit trail | Direct client table write instead of an audited RPC; write_audit_log() is service_role-only so even a client-side confirm dialog alone couldn't have closed the audit gap | ec41bc9 | Yes — live via direct RPC calls on a real test club: empty reason correctly rejected, real suspend wrote status='suspended' + a real audit_logs row with the exact reason, reactivate correctly restored 'active', test club left clean |
| 12 | P2 (real data-integrity residue, not client-exploitable) | payments/payment_allocations (real data) | One real completed 100 EGP cash payment had zero invoice allocation, causing get_payment_method_report()/raw-ledger totals to disagree by 100 EGP | Traced via audit_logs: payment was originally allocated to a real invoice that was later hard-deleted from `invoices` — but `invoices` has NO delete RLS policy for any client role (confirmed via pg_policy), so this could only have happened via direct superuser/service-role SQL (this session's own earlier test-cleanup that missed cascading to this one payment), never through the application | Fixed via direct SQL: marked the orphaned payment `status='void'` (an existing, established terminal state) rather than deleting it, preserving full audit history | Yes — re-ran the orphan-detection query club-wide post-fix: zero remaining mismatches anywhere; get_payment_method_report() total_collected now matches raw ledger exactly (8890) |

---

## DECISIONS LOG (owner-level, no-approval-needed calls)

- Kept the stale secondary worktree (`.claude/worktrees/goofy-ptolemy-0d3fbc`) untouched — inspected, confirmed inert (behind master, clean, no unique commits), not worth the risk of deleting unknown content per directive's explicit caution.
- Chose `side="right"` (physical) over adding a new logical start/end variant to the shared `sheet.tsx` component for the Platform mobile nav drawer — smallest correct change; this app is Arabic/RTL-primary so "right" is the correct reading-start edge in practice.
- Centralized `SUBSCRIPTION_KIND_LABELS`/`LIFECYCLE_STATUS_LABELS` into a new `src/features/platform/labels.ts` the moment a second file needed the same map, rather than a third inline duplicate — matches directive's REUSE/CONSOLIDATE preference over rewrite.
