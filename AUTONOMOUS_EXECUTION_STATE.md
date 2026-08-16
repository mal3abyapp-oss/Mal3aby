# Autonomous Execution State

Continuously updated. Governing directive: **"MASTER AUTONOMOUS FINAL
DIRECTIVE"** (2026-08-16) — supersedes the earlier "MASTER AUTONOMOUS
DIRECTIVE V3" (Doc 3). Explicit full-autonomy mode: no questions, no
waiting for approval, no stopping after an audit/report/gate/commit,
professional decisions made unilaterally and documented in
`AUTONOMOUS_DECISION_LOG.md`, only stop when (a) all possible work is
genuinely done, (b) the environment no longer permits any execution, or
(c) the only remaining step is an irreversible high-risk data action
with no recovery path. Do not re-audit the whole project from scratch
on every task — trust this file, the decision log, and git history;
only re-audit fully on a genuine contradiction.

## Part I of the new directive: WhatsApp removal — ✅ COMPLETE

WhatsApp is no longer part of this product. Everything built for it in
the old Gate 8 has been removed. See D-013's final update in
`AUTONOMOUS_DECISION_LOG.md` for full detail. Summary:
- Dropped `whatsapp_connections`, `whatsapp_connection_events`,
  `whatsapp_templates`, `whatsapp_automations` and their RPCs/trigger
  function (`20260816350000_remove_whatsapp_module.sql`). Confirmed via
  FK-dependency query that nothing else referenced these tables.
  Removed the 6 `whatsapp_*` permission keys and grants.
- `whatsapp-bridge` Edge Function replaced with an inert 410-Gone stub
  (no deletion tool was available in this session); local source
  deleted.
- Deleted `src/features/whatsapp/` (6 files), the `/app/whatsapp`
  route, sidebar nav item, `nav.whatsapp` i18n key, and the entire
  `whatsapp-connector/` Node service directory.
- Regenerated `src/lib/supabase/types.ts` — confirmed only the
  legitimate, unrelated `customers.whatsapp` contact-info column
  remains (a customer's own WhatsApp phone number, distinct from the
  removed connector, correctly untouched, same treatment for the
  public site's plain `wa.me` contact link).
- Verified: `npx tsc --noEmit`, `npm run build`, `npm run lint` all
  clean; live-checked in fresh browser tabs; `/app/whatsapp` now
  correctly 404s with no dead links anywhere.
- The Notification Core (Gate 7: `notification_events`/
  `notification_queue`/`notification_consent`,
  `emit_notification_event()`/`enqueue_notification()`) was explicitly
  preserved — channel-agnostic by design, so a future messaging
  channel is a connector-only addition later, not a schema rework.
- Commit: `4dffd6e`.

Gate 8 in the priority order below is now marked REMOVED, not
IMPLEMENTED — do not treat any historical "EXTERNAL SCAN QA PENDING"
language elsewhere in this file or in old commits as still relevant.

## Part II of the new directive: Full Platform Hardening & Acceptance — IN PROGRESS

This is the current, active phase. Scope (from the directive, Parts
II–XXXVII): full technical-debt sweep; complete role-by-role manual
QA (platform owner, club owner, manager, reception, coach, scanner,
customer, guardian, participant) across a second tenant for isolation
testing; auth/session edge cases; unified-account model verification;
portal ownership-security black-box testing; guardian/child edge
cases; full booking-flow + timezone regression (the specific hours
0/1/6/9/12/18/21/23 across create/edit/display/availability/reports/
QR) + concurrency + edge cases + recurring bookings; academy enrollment
full flow + every listed scenario + atomicity + capacity/concurrency;
membership state-model review; subscription lifecycle + cross-effects
+ history; QR/identity security (replay, wrong-tenant, expired,
frozen) + verified-photo requirement; attendance + manual-override
audit trail; financial single-source-of-truth verification across
every screen that shows a financial number + edge cases (partial/
duplicate/overpayment/refund/void); full reporting build-out (14
report types, drill-down, accurate KPIs, filters, period comparison,
export) — this picks up directly from Gate 11's already-identified
9 missing report types; Arabic + English full-app sweep (not just the
nav-label slice from Gate 10) + hard-coded-string removal; RTL/LTR
surface-by-surface testing; UX audit per screen; mobile + desktop QA;
full RLS/cross-tenant/cross-user/role-escalation/input-abuse attack
testing; DB integrity (orphans, constraints, indexes) with root-cause
fixes not just cleanup; performance (N+1, evidence-based indexing);
accessibility; design-system consistency; navigation/dead-button
sweep; failure-recovery/retry-safety testing; Commercial Entitlements
completion (Gate 13, already in progress — see below); adversarial
"attack the system" pass; regression tests for real bugs found; final
automated + manual QA; git discipline (small logical commits); new
required artifacts: `FINAL_DEFECT_REGISTER.md`, `UX_IMPROVEMENT_
REGISTER.md`; and a final `FINAL PLATFORM ACCEPTANCE REPORT` only once
all of the above is genuinely done, including a full Roles × Desktop/
Mobile × Arabic/English × Core-Features acceptance matrix with real
PASS marks only after real testing.

This supersedes and subsumes the old Doc 3 priority order below in
scope, but the already-completed Gates 1-12 work (booking time
integrity, academy enrollment integrity, unified accounts, membership/
subscription lifecycle, recurring bookings, secure QR/attendance,
notification core, RTL sweep, i18n foundation, reporting foundation,
regression/security pass) remains valid, verified, DONE work — it is
not being redone from scratch, only extended/deepened per the new
directive's much larger scope. Gate 13 (Commercial Entitlements) was
already in progress under the old directive and continues seamlessly
under the new one — see its own section below.

## Priority order (historical — Gates 1-12 DONE under the old directive, now superseded in scope by Part II above)

0. ~~Initial audit~~ — superseded by direct-investigation approach per
   this run's evidence (see Gate 1 below); a separate standalone audit
   report was not produced as its own artifact, but Gate 1/2/3 findings
   ARE the audit for booking/academy/accounts, documented in the
   decision log.
1. **Gate 1 — Booking Time Integrity (P0)** — ✅ FIXED & VERIFIED (see
   D-001). Root cause: naive datetime strings sent to timestamptz RPC
   params + timezone-agnostic local-time derivation server-side, both
   fixed.
2. **Gate 2 — Academy Enrollment Integrity (P0)** — ✅ INVESTIGATED &
   FIXED (see D-002). Real bug found: `manual` subscription-activation
   policy was bypassed by ANY payment. Fixed via a `p_explicit` flag.
   Duplicate-enrollment protection, full-group filtering, and
   no-approved-price guard were all already correctly handled.
3. **Gate 3 — Unified Accounts / Participants / Guardians** — ✅ DONE
   (see D-003). Built `customers.user_id` auth linking, self-service
   RLS across 9 tables (bookings/fields/branches/clubs/guardian_links/
   players/enrollments/groups/subscriptions), an identity-column guard
   trigger with a photo re-approval workflow, and a real portal
   frontend at `/portal` (claim flow, My Bookings, My Academy/Children,
   My QR, My Profile). Fully verified via genuine black-box RLS testing
   (real signed-up test user, real access tokens, real REST calls) —
   this caught and fixed a real bug (claim-vs-identity-guard trigger
   conflict) that pure SQL inspection would have missed.
4. ✅ **Gate 4 — Memberships / Subscriptions / Operational Entitlements**
   — lifecycle-operations slice DONE (see D-004). Added
   `unfreeze_subscription()`/`cancel_subscription()` RPCs, an
   audit-log-enforcing status-transition guard trigger, and fixed a
   real circular RLS dependency between `enrollments`/`groups`
   (introduced across Gate 3's self-service policies, only surfaced
   under real black-box RPC testing). Full freeze→unfreeze→cancel
   lifecycle verified end-to-end with correct audit trail. NOT yet
   built: explicit session-count/remaining-sessions tracking,
   allowed-days/allowed-entry-times columns (`subscriptions.plan_type`
   is still a simple enum with no structured usage-tracking) — needs
   its own scoping pass on how `package`-type plans currently track
   usage (if at all) before adding columns.
5. ✅ **Gate 5 — Bookings / Activities / Seats** — recurring-bookings
   slice DONE (see D-005). `create_recurring_booking()` audited (no
   bug — inherits Gate 1's timezone fix via `_create_booking_internal`),
   wired into `QuickBookingSheet.tsx`, verified live end-to-end. Also
   verified Doc 3's double-booking requirement was ALREADY fully
   satisfied at the DB level via a real Postgres `EXCLUDE USING gist`
   constraint (`no_overlapping_field_bookings`) — confirmed via a direct
   overlapping-INSERT test that correctly raised `23P01`. NOT built:
   seat/activity/event booking + waitlist — confirmed via
   `information_schema.tables` that no such schema exists at all
   (genuinely new product surface, not a bug — needs its own design
   pass for event definition/seat inventory/capacity/waitlist-promotion
   policy before building).
6. ✅ **Gate 6 — Secure QR / Identity / Attendance** — DONE (see D-006).
   Audited both QR paths (booking + academy membership). Found the
   backend was mostly already well-designed (opaque tokens, correct
   single-use/expiry/revocation checks, full scan-attempt audit trail
   via `qr_scan_events`) but found and fixed 3 real gaps: (1) scanner
   had no UI for the academy attendance flow at all, (2) `qr_validate()`
   returned zero identity-verification data so the required
   photo/name/status comparison screen was structurally impossible,
   (3) the actual "Active Entitlement" violation — `qr_mark_attendance()`
   checked enrollment status but never subscription status, letting a
   frozen/expired/cancelled/pending-payment member check in. All fixed
   and verified via real coach-role RPC calls. NOT re-audited in this
   pass: whether any manual (non-QR) attendance-marking path exists and
   is correctly coach-scoped — flagged as follow-up, not assumed safe.
   This remains an open item for Part II's attendance-testing scope.
7. ✅ **Gate 7 — Notification Core** — DONE (see D-007). Built
   `notification_events`/`notification_queue`/`notification_consent`
   with `emit_notification_event()`/`enqueue_notification()`. Confirmed
   zero notification infra existed before this pass. Wired one real
   integration point (`_create_booking_internal` emits
   `booking.created`/`booking.confirmed`), verified live. Explicitly
   channel-agnostic by design — no WhatsApp-specific (or any other
   channel-specific) columns anywhere in this schema. Explicit scope
   cut (not silently dropped): no queue worker yet.
8. ❌ **Gate 8 — WhatsApp QR Module — REMOVED ENTIRELY.** Built, then
   fully removed per explicit user instruction (2026-08-16) after
   repeated real environment blockers (Docker/WSL2 unavailable,
   Supabase CLI login non-interactive-only in this sandbox) prevented
   reaching a genuinely verifiable end-to-end real-phone connection,
   and after a proposed direct-browser-to-connector bypass was
   explicitly rejected before being wired into code. See D-013's full
   final update and "Part I" above. Do not resume WhatsApp work without
   new explicit user instruction — it is out of scope for this product
   as of this directive.
9. ✅ **Gate 9 — RTL full sweep** — DONE (see D-009), for the slice
   audited at the time. Exhaustive grep across every feature screen
   found ZERO hardcoded physical-direction classes anywhere in
   `src/features/**` — the RTL-first convention was actually followed
   throughout. All real defects were isolated to 4 shared shadcn/ui
   primitives (`dialog.tsx`/`sheet.tsx`/`select.tsx`/`dropdown-menu.tsx`)
   — fixed at the root, verified live via screenshot. Part II's RTL
   scope goes further: surface-by-surface testing (calendars, booking
   timeline, reports, QR, portal) is still needed, not yet done as a
   dedicated pass.
10. ✅ **Gate 10 — Arabic/English i18n** — foundation DONE (see D-010),
    NOT the full sweep Part II now requires. Installed react-i18next,
    built resource-file system (`src/lib/i18n/resources/{ar,en}/
    common.json`), wired `DirectionProvider` as the single source of
    truth for both language and direction (no-reload RTL/LTR flip +
    localStorage persistence), added a `LanguageSwitcher` to every
    layout, and locale-aware `formatNumber`/`formatCurrency`/
    `formatDate` helpers. Verified live. Swept the staff app's
    sidebar/nav labels only — explicit, tracked, now-active follow-up
    under Part II: every feature screen's own body copy (bookings,
    academy, billing, portal screens, reports, forms, error messages)
    still renders hardcoded Arabic text directly. This is Part II's
    "no partial translation accepted" requirement — a real, large
    remaining scope, not yet started.
11. ✅ **Gate 11 — Reporting Rebuild** — foundational slice DONE (see
    D-011), NOT the full 14-report build-out Part II now requires.
    Audited existing reporting layer first: found 4 real RPC-backed
    reports already existed (revenue/occupancy/academy/customer).
    Found and fixed a real single-source-of-truth violation
    (`CustomersPage.tsx`'s independent "outstanding" recompute, now
    reading the shared `outstanding_invoices` view). Built
    `get_executive_dashboard` + `get_booking_report`, wired into a
    rebuilt `ReportsPage.tsx` (6 tabs), verified live with cross-
    reconciled real numbers. Remaining 9 Doc 3 report types (Field
    Performance, Group Report, Player Report, Subscription Report,
    Attendance Report, Collections Report, Employee Activity,
    Discounts/Refunds/Voids, and — now that WhatsApp is removed — the
    former "WhatsApp/Notification Report" item should be re-scoped as
    a channel-agnostic Notification Report only) are the real,
    now-active Part II reporting scope, along with drill-down capability
    and export testing for every report, not just the 6 that exist.
12. ✅ **Gate 12 — Full Regression/Security/Tenant QA** — substantially
    DONE (see D-012), NOT the exhaustive attack-testing Part II now
    requires. Fresh `get_advisors(security)`: 64 findings, 0 ERROR —
    SECURITY DEFINER-executable warnings are expected-by-design; one
    real gap flagged separately via spawn_task
    (`validate_whatsapp_template_variables` grants, task_caf4163d —
    NOTE: this function no longer exists, it was dropped along with
    the rest of the WhatsApp module in Gate 8's removal, so this task
    is now moot/stale, safe to dismiss if still open). Fresh
    `get_advisors(performance)`: 307 findings — fixed the cheap/safe
    class immediately (36 `auth_rls_initplan` warnings across 32 RLS
    policies); deferred `multiple_permissive_policies` (187) and
    `unindexed_foreign_keys` (72) as explicit low-priority follow-up —
    now Part II's active DB-hardening scope. Ran a full `npm run
    build` (catching 46 real errors `tsc --noEmit` had missed all
    session, traced to a stale `types.ts`), fixed all resulting real
    issues including a genuine `BookingDetailSheet` `clubTimezone`
    prop bug. Ran ONE real black-box multi-tenant isolation test via
    the live browser session (not the exhaustive Roles × cross-tenant
    × cross-user × role-escalation matrix Part II now requires) —
    confirmed correct isolation on the tested paths; correctly
    diagnosed a platform-owner cross-club read as intended behavior,
    not a leak. Still NOT done: a live login-based isolation test using
    a genuinely non-platform-owner single-club account (blocked on
    credentials); the full attack-testing scope of Part II (Sections
    75-99 of the new directive) is a much larger, still-open task.
13. ✅ **Gate 13 — Commercial Entitlements phase** — IN PROGRESS, tasks
    #52-53 DONE this run, continuing under Part II now:
    - Task #51 (types regen): DONE as of Gate 12's build-gate work.
    - Task #52 (entitlement limit UI): DONE — built
      `EntitlementsCard.tsx` reading the existing
      `commercial_entitlements_usage` view + `request_commercial_
      upgrade()` RPC (both already correctly built pre-Doc-3), wired
      into Settings, verified live with real limit/usage data and a
      real submitted upgrade request.
    - Task #53 (onboarding messaging for pending/blocked additional
      club): DONE — audited first and found the backend policy (one
      trial per owner, `blocked` access with no subscription row,
      full platform-owner approval mechanism) was ALREADY fully
      correct; the only gap was owner-facing messaging, fixed in
      `PlatformSubscriptionCard.tsx` and `OnboardingPage.tsx`.
      Directly satisfies Part II Section 96's "Additional Club Flow"
      requirements — verify those are still true under a fresh
      black-box test as part of Part II's broader QA pass, not just
      trust this summary.
    - Tasks #54-67: NOT yet started. Next up: #54 (platform owner
      Clubs commercial detail page — note `PlatformClubDetailPage.tsx`
      was found to already exist with real subscription-granting
      capability during task #53's audit; confirm exact remaining
      scope before assuming a rebuild is needed, same as this
      session's established audit-first pattern).

## Current phase: Part II — Full Platform Hardening & Acceptance (new master directive)

Gate 13 (Commercial Entitlements) continues within this phase as one
thread among many. The next concrete action is continuing Gate 13's
task #54, then proceeding through the rest of Part II's scope
(technical debt sweep, role-by-role QA, timezone regression, financial
source-of-truth audit, full i18n sweep, full report build-out, RLS
attack testing, etc.) without stopping between items, per the
directive's explicit "do not stop after a gate/commit/report" rule.

## Completed this run (chronological)
- Resolved 3-way directive conflict via AskUserQuestion → user chose
  full autonomous execution per Docs 2/3.
- Gate 1 (Booking Time Integrity): root-caused, fixed, verified
  end-to-end via live UI test + direct SQL. See D-001.
- Gate 2 (Academy Enrollment Integrity): investigated, found and fixed
  the manual-activation-policy bypass; confirmed duplicate-enrollment/
  full-group/no-price cases already correctly handled. See D-002.
- Gate 3 (Unified Accounts): built customer self-service auth linking +
  RLS + identity-column guard + full portal frontend, verified via
  black-box testing with a real test account. See D-003.
- Gate 4 (Memberships/Subscriptions/Entitlements): lifecycle RPCs +
  audit trigger + circular-RLS fix, verified end-to-end. See D-004.
- Gate 5 (Bookings/Activities/Seats): recurring bookings wired +
  verified, double-booking constraint confirmed already correct. See
  D-005.
- Gate 6 (Secure QR/Identity/Attendance): scanner UI + identity data +
  active-entitlement check fixed and verified via real coach RPCs. See
  D-006.
- Gate 7 (Notification Core): event/queue/consent tables + entry-point
  functions built, wired into booking creation, verified live. See
  D-007.
- Gate 8 (WhatsApp): built a real persistent Node/TS Baileys connector
  service, verified via a real WebSocket handshake reaching a genuine
  scannable QR, then FULLY REMOVED per explicit user instruction after
  repeated environment blockers prevented a real-phone end-to-end
  verification. See D-008 (build) and D-013 (removal).
- Gate 9 (RTL sweep): confirmed feature code already correct; fixed 4
  shared UI primitives at the root, verified live. See D-009.
- Gate 10 (i18n foundation): react-i18next + LanguageSwitcher + no-
  reload RTL/LTR flip, verified live on authenticated and public
  pages. See D-010.
- Gate 11 (Reporting Rebuild): audited existing reports, found and
  fixed a real single-source-of-truth violation (CustomersPage.tsx's
  outstanding calc), built Executive Dashboard + Booking Report,
  verified live with cross-reconciled real numbers. See D-011.
- Gate 12 (Full Regression/Security/Tenant QA): security + performance
  advisor passes, fixed auth_rls_initplan (32 policies), full build-gate
  fix (regenerated stale types, fixed 20 real errors including a real
  clubTimezone bug), one real black-box isolation test. See D-012.
- P1 bug fix: WhatsApp QR not displaying — root-caused to (1) missing
  CORS handling on whatsapp-bridge Edge Function, (2) a swallowed-
  error-body bug in ConnectionTab.tsx. Both fixed and verified live
  (later moot — WhatsApp fully removed, see Gate 8 above).
- Gate 13 tasks #51-53: types regen (done as part of Gate 12), 
  entitlement limit UI (EntitlementsCard.tsx), onboarding messaging
  for pending/blocked additional clubs. See task list and this file's
  Gate 13 section above.
- P0 WhatsApp runtime task: audited existing Baileys connector against
  Evolution API and whatsapp-web.js (documented comparison in D-013),
  attempted real end-to-end connection via ngrok then Cloudflare
  Tunnel (both genuinely worked as tunnels — verified via direct curl
  — but Supabase Edge Function secrets could not be set due to
  `supabase login` requiring a real interactive TTY unavailable in
  this sandbox), user explicitly cancelled the attempt, then
  instructed full removal of the WhatsApp module. See D-013 in full.

## Migrations applied this run
- `20260816110000_fix_booking_venue_timezone.sql` — venue-timezone-aware
  local date/time derivation in `_create_booking_internal`.
- `20260816120000_fix_enrollment_integrity.sql` — `p_explicit` flag for
  subscription activation policy.
- `20260816130000_customer_self_service_link.sql` — `customers.user_id`
  + `claim_customer_self_service()`.
- `20260816140000_customer_self_service_write_guard.sql` —
  `protect_customer_identity_columns()` trigger + photo re-approval
  flow (`customer_photo_update_requests` + 2 RPCs).
- `20260816150000_find_claimable_customer.sql` — narrow claim-flow
  lookup RPC.
- `20260816160000_customer_self_service_bookings_read.sql`,
  `20260816170000_..._fields_branches_read.sql`,
  `20260816180000_..._clubs_read.sql`,
  `20260816190000_..._academy_read.sql` — self-service SELECT policies
  across 9 tables.
- `20260816200000_fix_ensure_booking_qr_self_service.sql` — authorize
  a booking's own linked customer, not just staff.
- `20260816210000_fix_claim_vs_identity_guard_conflict.sql` —
  transaction-local GUC flag fixing the claim-vs-guard-trigger conflict
  found via black-box testing.
- Ad hoc cleanup (via `apply_migration`, not separate files): dropped a
  redundant duplicate-enrollment index and an orphaned function overload
  from Gate 2's signature change; revoked `anon`/`authenticated` direct
  EXECUTE on `_activate_subscription_if_due_internal` (security fix
  caught via `get_advisors`).
- (Gates 4-10 migrations: see D-004 through D-010 in the decision log
  for the full per-gate migration list — omitted here for brevity,
  not because they didn't happen.)
- `20260816280000_notification_core.sql`,
  `20260816290000_notification_view_permission.sql`,
  `20260816300000_wire_booking_notification_events.sql` — Gate 7.
- `20260816310000_gate11_executive_and_booking_reports.sql` —
  `get_executive_dashboard()` + `get_booking_report()`, Gate 11.
- `20260816310000_whatsapp_connection_model.sql`,
  `20260816320000_whatsapp_permissions.sql`,
  `20260816330000_whatsapp_templates_automations.sql`,
  `20260816340000_revoke_whatsapp_template_validator_execute.sql` —
  Gate 8's original build, all now reversed by the next entry.
- `20260816350000_remove_whatsapp_module.sql` — drops all WhatsApp-
  specific tables/RPCs/permissions (Gate 8 removal). This is the
  correct forward-cleanup-migration pattern per the new directive's
  Section 9 — original migrations were NOT rewritten or deleted from
  history.

## Files changed this run
- `src/lib/domain/time.ts` (new) — Time Model utility (Gate 1).
- `src/features/bookings/*` — timezone-aware writes/reads (Gate 1).
- `src/lib/errors.ts` — new Arabic error translations (Gates 1-3).
- `src/app/layouts/PortalLayout.tsx` (new), `src/app/routing/
  RequireAuth.tsx` (added `RequirePortalAuth`), `src/app/routing/
  router.tsx` (added `/portal` tree, later also had the `/app/whatsapp`
  route removed), `src/features/auth/LoginPage.tsx` (persona-aware
  post-login redirect), `src/features/portal/*` (new — 6 files:
  ClaimAccountPage, PortalRoot, PortalBookingsPage, PortalAcademyPage,
  PortalQrPage, PortalProfilePage) — all Gate 3.
- `src/features/clubs/EntitlementsCard.tsx` (new) — Gate 13 task #52.
- `src/features/clubs/PlatformSubscriptionCard.tsx`,
  `src/features/onboarding/OnboardingPage.tsx` — Gate 13 task #53
  messaging fixes.
- `src/features/whatsapp/*` (6 files) — built in Gate 8, DELETED in
  the WhatsApp removal. `src/app/layouts/AppLayout.tsx` (nav item +
  icon import removed), `src/app/routing/router.tsx` (route removed),
  `src/lib/i18n/resources/{ar,en}/common.json` (nav.whatsapp key
  removed), `.eslintrc.cjs` (whatsapp-connector ignorePattern removed).
  `whatsapp-connector/` (entire directory, 12 files) — DELETED.
  `supabase/functions/whatsapp-bridge/index.ts` — DELETED locally,
  replaced with an inert stub on the deployed Edge Function (no
  deletion tool available).

## Known-good, do NOT re-investigate without new evidence
- React Query staleness / Radix Dialog-Select-Tabs: repeatedly tested
  and confirmed working correctly in this codebase (prior session).
- Commercial entitlement enforcement triggers (branch/field/academy
  limits): verified via direct SQL tamper tests (prior session).
- Booking conflict detection (`field_blocks` overlap via `tstzrange`):
  confirmed timezone-agnostic and correct, untouched by Gate 1 fix.
- Gate 3 self-service RLS/portal: fully black-box tested (real test
  account, real tokens) — pre-claim isolation, post-claim scoping,
  cross-customer denial, duplicate-claim rejection, identity-column
  guard, legitimate contact edits all verified correct.
- `outstanding_invoices` view is the correct, verified single source
  of truth for outstanding-balance figures — both `OutstandingPage.tsx`
  and `CustomersPage.tsx` now read it, confirmed reconciling exactly
  against real data (Gate 11).

## Outstanding from before this directive (still real, still open)
- `PortalBookingsPage.tsx`/`PortalAcademyPage.tsx`'s `as unknown as`
  casts (added during Gate 3 to work around then-stale types) were NOT
  revisited after Gate 12's type regeneration — worth checking now
  that types are accurate, to see if they can be removed/tightened.
- `find_claimable_customer()` has no rate limiting — an authenticated
  attacker could brute-force phone numbers to discover which numbers
  belong to real customers of a club. Should be addressed under Part
  II's security-hardening scope via platform/edge-level rate limiting.
- The photo re-approval request flow (`request_customer_photo_update`/
  `review_customer_photo_request`) has backend RPCs but NO frontend UI
  yet on either side (customer request screen, staff review screen).
- Self-service booking CREATION (not just viewing) is explicitly out of
  scope for Gate 3 — a customer can see but not create/cancel their own
  bookings yet; needs payment-collection/deposit design first.
- `notification_queue` has no consuming worker yet — the send path
  exists (channel-agnostic) but nothing polls the queue. Quiet-hours/
  rate-limit columns exist without enforcement code. This is now more
  relevant than before: with WhatsApp removed, any future channel
  (email/SMS/in-app) will need this worker built before it can do
  anything real.
- task_caf4163d (validate_whatsapp_template_variables grant gap): MOOT
  — the function itself was dropped along with the rest of the
  WhatsApp module. Safe to dismiss this task if it's still open in the
  task tracker.
- 9 (now effectively 9, with the WhatsApp/Notification report item
  re-scoped to a channel-agnostic Notification Report) Doc 3 report
  types remain unbuilt: Field Performance, Group Report, Player
  Report, Subscription Report, Attendance Report, Collections Report,
  Employee Activity, Discounts/Refunds/Voids, Notification Report.
  Each needs its own KPI-definition scoping pass before building —
  this is now Part II's active, large reporting scope.
- `multiple_permissive_policies` (187 performance advisor findings
  across 28 tables) and `unindexed_foreign_keys` (72 findings) remain
  deferred from Gate 12 — now Part II's active DB-hardening scope.
- A live login-based multi-tenant isolation test using a genuinely
  non-platform-owner single-club account was never completed (blocked
  on credentials in Gate 12) — Part II's Section 76-78 attack-testing
  scope requires this be done properly this time, with real accounts
  across a second tenant.

## Last commit
`4dffd6e` — "feat!: remove the WhatsApp module entirely, preserve the
channel-agnostic Notification Core" (see `git log` for the full
chronological commit history of this run). Local-first — not pushed to
any remote per standing project policy.

## Next exact task
WhatsApp removal (Part I) is fully complete and verified. Proceeding
directly into Part II's scope without stopping, per the new directive.
Immediate next action: continue Gate 13 (Commercial Entitlements) with
task #54 — audit `PlatformClubDetailPage.tsx` (already found during
task #53's work to have real subscription-granting capability) to
determine its exact remaining scope before assuming more needs to be
built, following this session's established audit-first pattern. Then
continue through Part II's much larger scope in a sensible order:
finish Gate 13's remaining commercial tasks, then move to the
technical-debt sweep and the role-by-role/tenant-isolation attack
testing (Sections 75-99), since these tend to surface real defects
worth fixing before investing further in reporting/i18n/UX polish on
top of a potentially-shaky foundation. Create `FINAL_DEFECT_
REGISTER.md` and `UX_IMPROVEMENT_REGISTER.md` as real defects/UX
findings start accumulating from this testing, not preemptively empty.
Do not write `FINAL PLATFORM ACCEPTANCE REPORT` until the acceptance
matrix can be filled with genuinely-tested PASS marks.
