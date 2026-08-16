# Autonomous Execution State

Continuously updated. Governing directive: "MASTER AUTONOMOUS DIRECTIVE
V3" (Doc 3) — user explicitly selected "Full autonomous execution (per
docs 2/3)" via AskUserQuestion on 2026-08-16. Do not re-audit the whole
project from scratch on every task — trust this file, the decision log
(`AUTONOMOUS_DECISION_LOG.md`), and git history; only re-audit fully on
a genuine contradiction.

## Priority order (Doc 3, governs until superseded by a new user message)

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
7. Gate 7 — Notification Core — not started.
8. Gate 8 — WhatsApp QR Module — not started (large net-new module).
9. Gate 9 — RTL full sweep — not started (partial RTL exists via
   `DirectionProvider` but no full audit done). NOTE: the new portal
   screens built in Gate 3 were written with the same RTL-first
   conventions as the rest of the app (no hardcoded ltr, uses logical
   properties like existing screens) but were NOT specifically
   re-audited for RTL correctness — include them in this gate's sweep.
10. Gate 10 — Arabic/English i18n — not started (Arabic-only currently,
    including all Gate 3 portal screens — they inherit the same
    hardcoded-Arabic-string pattern as the rest of the app, to be swept
    together in this gate).
11. Gate 11 — Reporting Rebuild — not started (current reports are
    basic; task #12/Phase 13 in the original plan, not the full
    Doc 3 KPI-drill-down spec).
12. Gate 12 — Full Regression/Security/Tenant QA — not started as a
    dedicated pass for the Doc 3 scope (earlier V1/P1 passes exist but
    predate the unified-account/QR/WhatsApp scope). Should include a
    fresh `get_advisors(security)` pass once Gates 4-11 land, since two
    real security regressions were caught this way already this run
    (the `_activate_subscription_if_due_internal` anon-exec gap in
    Gate 3, the manual-policy bypass in Gate 2) — this tool is cheap and
    has a proven hit rate on this codebase.
13. Gate 13 — Resume Commercial Entitlements phase (tasks #51-67) —
    FROZEN per Doc 3 until Gates 1-12 substantially resolved. The
    underlying migration/enforcement work for commercial entitlements
    (branch/field/academy limits) is DONE and verified; only the UI
    wiring (task #51 types regen onward) remains, deliberately paused.

## Current gate: Gate 7 (Notification Core) — starting next

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

## Files changed this run
- `src/lib/domain/time.ts` (new) — Time Model utility (Gate 1).
- `src/features/bookings/*` — timezone-aware writes/reads (Gate 1).
- `src/lib/errors.ts` — new Arabic error translations (Gates 1-3).
- `src/app/layouts/PortalLayout.tsx` (new), `src/app/routing/
  RequireAuth.tsx` (added `RequirePortalAuth`), `src/app/routing/
  router.tsx` (added `/portal` tree), `src/features/auth/LoginPage.tsx`
  (persona-aware post-login redirect), `src/features/portal/*` (new —
  6 files: ClaimAccountPage, PortalRoot, PortalBookingsPage,
  PortalAcademyPage, PortalQrPage, PortalProfilePage) — all Gate 3.

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

## Outstanding from before Doc 3 arrived (still pending, now frozen — Gate 13)
- Task #51: regenerate Supabase TS types to include
  `commercial_entitlements`/`commercial_upgrade_requests`/
  `commercial_entitlements_usage` AND now also the Gate 3 additions
  (`customers.user_id`, `customer_photo_update_requests`, etc). The
  `generate_typescript_types` MCP call previously hit its output-size
  limit; needs the JSON-unwrap-via-python technique. LOW PRIORITY per
  Doc 3 freeze — do not resume until Gates 1-12 are substantially done.
  NOTE: `src/lib/supabase/types.ts` is now further out of date than
  before (missing Gate 3's new tables/columns too) — the portal
  frontend code uses `as unknown as` casts in a couple of spots to work
  around this (`PortalBookingsPage.tsx`, `PortalAcademyPage.tsx`) —
  once types are regenerated, those casts should be revisited and
  tightened.
- Tasks #52-67: all commercial-phase UI/reporting work, frozen.

## Follow-up items noted but not yet actioned (tracked, not forgotten)
- `find_claimable_customer()` has no rate limiting — an authenticated
  attacker could brute-force phone numbers to discover which numbers
  belong to real customers of a club. Noted in the migration's own
  comment as a deliberate scope cut; should be addressed in Gate 12
  (security hardening) via platform/edge-level rate limiting.
- The photo re-approval request flow (`request_customer_photo_update`/
  `review_customer_photo_request`) has backend RPCs but NO frontend UI
  yet on either side (customer request screen, staff review screen) —
  built the data model and guard first since that was the security-
  critical part; the UI is real follow-up work, not optional polish.
- Self-service booking CREATION (not just viewing) is explicitly out of
  scope for Gate 3 — noted in the bookings_self_service_select policy's
  own comment. A customer can see but not create/cancel their own
  bookings yet; this needs payment-collection/deposit design before
  it's safe to build.

## Last commit
199d776 — "feat: customer self-service portal -- claim flow, My
Bookings/Academy/QR/Profile (Gate 3)" (see `git log` for the full
chronological commit history of this run: Gate 1 fix, Gate 2 fix, Gate
3 schema, Gate 3 frontend, this state-file update to follow).
Local-first — not pushed to any remote per standing project policy.

## Next exact task
Start Gate 7 — Notification Core. Doc 3 requires business logic to
never call WhatsApp/SMS/Email directly — a Notification Engine /
domain-event abstraction must sit in between so Gate 8 (WhatsApp) can
later be built as a connector without touching Booking/Academy/
Enrollment code. Before building anything: (a) search for any existing
notification/messaging table or function (`notifications`, `messages`,
`sms`, `whatsapp` in `information_schema.tables`/`pg_proc`) — this
session hasn't checked yet, so don't assume nothing exists; (b) if
nothing exists, design the event model first (subscription-expiring,
booking-confirmed, payment-received, etc. — the full Doc 3 event-type
list is in the original directive text) as a queue/outbox table with
status tracking (pending/sent/failed/expired), never a synchronous
direct-send from a business-transaction RPC; (c) given this is
explicitly a prerequisite for Gate 8 (WhatsApp), keep the core
abstraction connector-agnostic — no WhatsApp-specific fields at this
layer. Given this session's now-repeated pattern (Gates 1/2/4/5/6 all
found at least one real defect hiding in seemingly-complete code),
apply the same audit-before-build rigor here too.
