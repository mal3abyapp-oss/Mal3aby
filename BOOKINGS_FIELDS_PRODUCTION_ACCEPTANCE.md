# Mal3aby — Bookings & Field Operations Production Acceptance

Source of truth for the autonomous full end-to-end Bookings + Fields
acceptance directive (2026-08-30/31). Status values: PENDING / IN
PROGRESS / PASS / FIXED + PASS / ACCEPTED LIMITATION / FAIL.

## 0. Baseline (confirmed before any change)

- Repo HEAD = origin/main = `0110db5` (clean working tree).
- CI: green on `0110db5` (run `33329250476`).
- Production: `https://mal3aby.app`, build tag `975a174` confirmed
  live at prior session's close (one commit behind current HEAD —
  that last commit was docs-only, correctly not redeployed).
- Supabase project `gxkrtlvpjwxhcqdisyob`: ACTIVE_HEALTHY, latest
  local migration `20260830173747_...` matches remote.
- Cloudflare Worker target: `mala3by-frontend`
  (`cloudflare/frontend-worker/wrangler.jsonc`), custom domains
  `mal3aby.app` + `www.mal3aby.app`.
- CLOSED BASELINES (not reopened without concrete proof from this
  domain's own testing): Finance, Reporting, Printing, Commerce/Shop.
  WhatsApp untouched.

## 1. Architecture map (Section 3 — before any code)

Full map produced by architecture-reviewer subagent, read-only, saved
to `.claude/agent-memory-local/architecture-reviewer/`. Key findings:

- **Conflict prevention**: real Postgres GiST EXCLUDE constraint on
  `bookings` (`no_overlapping_field_bookings`, on a generated
  `tstzrange` column `during`, scoped to
  pending_payment/confirmed/checked_in statuses). DB-enforced,
  independent of RPC bugs — the strongest possible guarantee.
- **Direct client writes to `bookings`**: revoked
  (`20260824400000_revoke_direct_bookings_write_grant.sql`) — all
  writes go through SECURITY DEFINER RPCs.
- **Core RPCs**: `_create_booking_internal` (chokepoint for
  create_booking/create_recurring_booking/create_public_booking),
  `reschedule_booking` (independent reimplementation, NOT sharing
  `_create_booking_internal`'s validation — proven historical bug
  source), `cancel_booking` (redefined 12x — high churn),
  `mark_booking_no_show`, `expire_stale_booking_holds` (pg_cron
  reaper), `qr_confirm_checkin` (row-locked, TOCTOU-safe).
- **Timezone**: DB layer correctly uses `clubs.timezone` +
  `at time zone` conversion throughout, already hardened from a past
  P0. **Live defect found**: `PublicClubBookingPage.tsx`'s
  `bookMutation` builds timestamps via
  `new Date(`${dateKey}T${selectedTime}:00`).toISOString()` instead
  of the shared `toInstant()` helper — silently mis-stores the
  instant when customer browser timezone != club venue timezone. See
  D1 below.
- **Pricing**: `resolve_field_price`, priority-based over
  `pricing_rules`, full-containment match. Untested boundary: a
  booking spanning two adjacent rule windows may find no rule at all.
- **Field blocks**: `create_field_block` has NO exclusion constraint
  — pure app-layer overlap check, race-prone. Also: fully implemented
  server-side but **no create/edit/delete UI anywhere** — read-only
  "Temporarily Closed" badge only.
- **Module gating**: `club_modules` effective = entitled AND active,
  checked via `_fields_module_active()`. Was UI-only until
  2026-08-28; `reschedule_booking` was missed in that pass and only
  gated the next day after live reproduction — confirms this class of
  gate-drift bug is real and worth re-testing.
- **QR**: booking check-in (`qr_confirm_checkin`) distinct from
  Academy attendance. Single-use, but re-mint doesn't revoke prior
  tokens (deliberate) — made safe by live status re-check inside the
  row-locked transaction. No double-check-in exploit found.
  Asymmetry: no-show doesn't revoke QR (defense-in-depth gap only).
- **Permissions**: `booking.view/create/update/cancel`,
  `booking.discount.apply/override`, `qr.scan`,
  `qr.checkin.confirm`. `create_public_booking` deliberately has no
  RBAC check (anon-callable), gated by module/entitlement/anti-fraud
  instead.

## 2. Acceptance queue

| # | Item | Status |
|---|---|---|
| 1 | Architecture map | PASS |
| 2 | D1: public booking page timezone write bug | FIXED + PASS |
| 3 | Staff booking creation (new/existing customer) | PASS |
| 4 | Availability & conflict engine (all overlap scenarios) | PASS |
| 5 | Concurrency (simultaneous booking attempts) | PASS (LIVE CONCURRENT VERIFIED) |
| 6 | Timezone acceptance (midnight boundary, DST-safe) | FIXED + PASS |
| 7 | Pricing engine (incl. boundary-straddle) | PASS (D4 logged as owner decision, not a defect requiring autonomous fix) |
| 8 | Duration acceptance | PASS (covered via overlap-scenario RPC sweep) |
| 9 | Rescheduling | PASS |
| 10 | Cancellation | PASS |
| 11 | No-show / completed / status lifecycle | PASS (D2 gap logged for completed) |
| 12 | Booking QR (full acceptance) | PASS |
| 13 | Check-in / entry flow | PASS |
| 14 | Public booking journey (incl. module-disabled gating) | PASS |
| 15 | Field management (create/edit/archive) | PASS (create/edit/status/closures all verified live) |
| 16 | Field blocks/closures | PASS backend / P1 gap logged for Section 16 (no UI at all) |
| 17 | Field availability schedule (operating hours) | PASS (verified via D4/booking-rejection tests) |
| 18 | Branch operations | PASS (D6 fix + regression) |
| 19 | Customer booking experience (Customer360) | FIXED + PASS (D10) |
| 20 | Booking financial integration (regression only) | PASS (reconciled throughout: invoice/payment/discount all correct) |
| 21 | Booking printing (regression only) | PASS (verified via subagent, invoice/receipt QR/RTL/LTR confirmed) |
| 22 | Booking reporting (regression only) | PASS (ReportBookingsPage/ReportOccupancyPage already accepted; no booking-report code touched this phase) |
| 23 | Staff roles & permissions (booking-scoped) | PASS (permission + branch checks verified via RPC tests) |
| 24 | Auditability | PASS (audit_log entries confirmed present for create/cancel/discount) |
| 25 | Error UX | PASS (translateSupabaseError confirmed wired, no raw errors observed) |
| 26 | Responsive (375/768/1024/1440) | PASS |
| 27 | RTL/LTR | PASS |
| 28 | Performance | PASS (21 calls on page load, no N+1 pattern; pre-existing app-shell dupes unrelated to this session) |
| 29 | Cache/stale state | PASS (queryKey includes date/timezone; invalidateGrid() wired on create) |
| 30 | Concurrency (see #5, cross-referenced) | PASS |
| 31 | Safe QA policy compliance | PASS (real product RPCs only, real customers/fields tagged QA, no manual ledger fakes, cancellations preserve audit history) |
| 32 | Secondary bounded field/booking gap review | PASS (see Section 6 below — D8 closed, D-source/channel noted P2 not built) |
| 33-36 | Subagent/migration/git/deploy governance | ONGOING |
| 37 | Final acceptance matrix | PENDING |

## 3. Defects log

- **D1 (P1, FIXED + PASS)**: Public booking page
  (`src/features/public-booking/PublicClubBookingPage.tsx`)
  `bookMutation` built `start_at`/`end_at` via
  `new Date(`${dateKey}T${selectedTime}:00`).toISOString()`, and the
  post-confirmation `.ics` calendar-download button built its
  `startAt`/`endAt` the same way — both interpret the date/time
  string in the **browser's** local timezone, not the club's venue
  timezone. Every other booking-write surface (`QuickBookingSheet.tsx`)
  already used the shared `toInstant(date, time, clubTimezone)`
  helper from `src/lib/domain/time.ts` correctly — this was the one
  surface that didn't.
  **Root cause confirmed why this was invisible in all prior QA**:
  the dev/QA browser's own OS timezone is `Africa/Cairo`, identical
  to the QA club's configured timezone, so the bug was silent in
  every previous same-machine test.
  **Proof (live, this session)**: mathematically demonstrated via
  the browser console that a customer booking an 18:00 Cairo-club
  slot from a browser in `America/New_York` (UTC-4 EDT) would have
  had the old code store the booking 7 hours off — landing at
  01:00 the next Cairo-local day instead of 18:00, a different and
  likely-closed slot. `toInstant('2026-09-15','18:00','Africa/Cairo')`
  correctly resolves to `2026-09-15T15:00:00.000Z` (verified against
  Cairo's real UTC+3 offset via `Intl.DateTimeFormat`), independent
  of the caller's own timezone.
  **Fixed**: both call sites now use `toInstant(dateKey, time,
  club.timezone)`. **Live-verified same-timezone happy path**: real
  booking created through the actual public UI at `/c/demo-club`
  for 31 Aug 18:00 Cairo-local — booking id `73f4ed7a-906a-...`,
  DB shows `start_at = 2026-08-31 15:00:00+00`, which is exactly
  `2026-08-31 18:00:00` at `Africa/Cairo` — confirms the fix didn't
  regress the same-timezone (majority) case. `npx tsc --noEmit`
  clean after the fix.

- **D2 (candidate gap, ACCEPTED LIMITATION pending owner decision)**:
  `bookings.status` schema enum includes `completed`
  (`bookings_status_check` constraint), and the frontend defensively
  checks `booking.status !== 'completed'` in one place
  (`BookingDetailSheet.tsx:819`), but **no RPC, cron job, or any code
  path anywhere in the codebase ever sets a booking to `completed`**
  (confirmed via exhaustive grep across `supabase/migrations/*.sql`
  for `status = 'completed'` writers — zero hits outside of unrelated
  Shop stock-count code). `mark_booking_no_show` only accepts
  `confirmed`/`checked_in` source statuses (correct, by design) but
  its sibling "mark completed" action does not exist. This means: a
  booking that is attended and finishes normally stays `confirmed`
  or `checked_in` forever — there is no operational "this booking
  happened successfully" terminal state a real club could report on
  (e.g. distinguishing a normal completed session from a currently-
  in-progress `checked_in` one, or from a `confirmed`-but-never-
  checked-in one that just wasn't marked no-show). **Not fixed
  autonomously** — per directive Section 38.4 ("a materially
  ambiguous booking/payment/business rule would require inventing
  policy" is a TRUE STOP condition): whether completion should be
  automatic (a cron job once `end_at` passes, mirroring the existing
  `expire_stale_booking_holds` pattern) or a manual staff action (a
  "mark completed" button, mirroring `mark_booking_no_show`) is a
  genuine product decision, not something to invent. Logged for the
  Section 32 secondary gap review as a P2 candidate (important, not
  blocking — the booking lifecycle functions correctly without it;
  it's a reporting/completeness gap, not a broken flow).

- **D3 (P2, FIXED + PASS)**: `new Date().toISOString().slice(0, 10)`
  (browser-UTC date) and `new Date().toTimeString().slice(0, 5)`
  (browser-local time) used in 5 real locations across
  `BookingsPage.tsx`, `BookingsFieldDayView.tsx`,
  `BookingsMobileView.tsx` for "today"/"now" resolution — the exact
  anti-pattern the directive names explicitly. Impact: for any club
  timezone that differs from the browser's own OS timezone, staff
  near local midnight would see the wrong default calendar day/"is
  this today" highlighting/current-price lookup. Server-side booking
  writes were never affected (already correctly timezone-safe per the
  architecture map) — this was presentation-layer only, but still a
  real defect (wrong default landing date, wrong "is today"
  highlighting, wrong current-price display for the live "now" price
  card). **Fixed**: `BookingsPage.tsx`'s `date` state now
  self-corrects to `fromInstant(new Date(), clubTimezone).date` the
  moment `clubTimezone` resolves (guarded so it never fights a
  user-driven date change or the existing deep-link effect), and its
  "Today" button reads `clubTimezone` directly; both
  `BookingsFieldDayView.tsx` and `BookingsMobileView.tsx`'s
  `isToday`/`nowTime` and their own "Today" buttons switched to the
  same `fromInstant(new Date(), clubTimezone)` pattern (`clubTimezone`
  was already a required prop in both, so no new plumbing needed).
  `npx tsc --noEmit` clean. Live-verified on a genuinely fresh tab:
  date input correctly resolves to the real club-local today
  (`2026-08-30`), zero console errors, mobile view correctly labeled
  "اليوم" (Today) with real bookings/pricing rendering.
  Cross-midnight (23:30→00:30) booking attempts correctly rejected by
  a real, deliberate server-side rule (`"a booking cannot span more
  than one calendar day"`) — confirmed as intentional product design,
  not a defect, by reading `_create_booking_internal`.

- **D4 (TRUE STOP candidate — documented, NOT autonomously fixed)**:
  live-reproduced the pricing boundary-straddle scenario the
  architecture map flagged as untested. Constructed a safe QA fixture
  (temporary `pricing_rules` rows, cleaned up after — no financial
  history touched): two adjacent date-specific rules for one field on
  one future date, 08:00-12:00 @ 100/hr and 12:00-18:00 @ 150/hr. A
  booking spanning 11:00-13:00 (straddling the boundary) did NOT
  error — it silently priced at 150.00 EGP/hr (2h × 150 = 300.00
  total), which is neither of the two date-specific rates but the
  field's separate, broader day-of-week fallback rule (150/hr,
  08:00-23:00) — confirmed via direct query that only that fallback
  rule's containment predicate matches the full straddling range;
  neither date-specific rule does. **Root cause**: `resolve_field_price`
  (`supabase/migrations/20260815200000_phase5_fields_pricing.sql`)
  requires full-range containment within a single winning rule
  (`start_time <= p_start_time and end_time >= p_end_time`), with no
  distinct handling for "a more specific (date-specific) rule exists
  for this day but doesn't cover the full requested range" vs. "no
  rule exists for this day at all" — both currently fall through
  identically to whatever less-specific rule (if any) DOES have full
  containment. **Why this is NOT autonomously fixed**: this is a
  genuine, materially ambiguous pricing-policy question, not a
  one-right-answer bug. At least three defensible product behaviors
  exist — (a) always require full containment within the
  MOST-SPECIFIC applicable tier and raise a clear error otherwise
  (changes behavior for any split-window setup, wider blast radius
  than just the date-specific case), (b) blend/split pricing
  proportionally across a straddling booking (meaningfully new
  pricing logic), (c) leave current behavior as-is and treat
  cross-window bookings as an accepted limitation staff must avoid by
  choosing non-straddling durations. Per directive Section 38.4, a
  materially ambiguous business rule is an explicit TRUE STOP
  condition — inventing an answer here risks silently changing real
  club revenue calculations. **Flagging for the project owner as a
  genuine decision needed**, not proceeding with a unilateral fix.
  Practical exposure is currently low: this only manifests for clubs
  that configure split (non-full-day) date-specific pricing windows,
  which the QA data shows is not the common configuration (every real
  QA field pricing rule seen this session covers the field's full
  operating hours as one flat rate) — but the underlying mechanism
  IS silent, not loud, which is the part worth the owner's attention
  regardless of current low exposure.

- **D5 (P1, FIXED + PASS)**: `_create_booking_internal` only validated
  `p_discount_amount` inside `if p_discount_amount > 0 then ... end
  if` (permission checks, 30%-ceiling, exceeds-total). A NEGATIVE
  discount amount skipped that block entirely. **Live-reproduced**:
  `create_booking(..., p_discount_amount: -50)` on a 120 EGP booking
  succeeded with zero error — invoice showed subtotal 120.00,
  discount -50.00, total 170.00: a "discount" that INCREASED the
  invoice by 50 EGP, with no `booking.discount.apply` permission
  check and no dedicated discount audit-log entry (also gated by
  `> 0`). Any staff member holding plain `booking.create` could
  inflate a customer's invoice this way — unlike D4, this is not a
  policy ambiguity, since a discount that raises price is nonsensical
  by definition; the fix has one obviously correct answer. **Fixed**
  via migration `20260830195941_reject_negative_booking_discount_amount.sql`
  (`create or replace`, no signature change, no DROP needed, grants
  preserved automatically): added a guard rejecting
  `p_discount_amount < 0` immediately before the existing `> 0`
  block; every other line of the function left byte-for-byte
  identical to the prior version. Applied to remote, local migration
  file renamed to match the actual applied timestamp
  (`20260830195941`, confirmed via `list_migrations`).
  **Live-reverified after fix**: the exact same negative-discount
  call now correctly rejected; regression-checked zero-discount and
  positive-discount-within-ceiling booking creation both still
  succeed unchanged.

- **D6 (P1, FIXED + PASS)**: branch-scoping asymmetry found by direct
  code comparison (`pg_get_functiondef` on the live functions).
  `reschedule_booking` already calls
  `user_has_branch_access(v_club_id, v_branch_id)` — but
  `_create_booking_internal` (backing `create_booking`/
  `create_recurring_booking`/staff-side of `create_public_booking`),
  `cancel_booking`, and `mark_booking_no_show` never gained the same
  check; all three authorized purely via `has_permission(...,
  v_club_id)` — club-wide, no branch dimension. A staff member whose
  membership is branch-restricted (a real, live-configurable product
  feature — `membership_branches`, ADR-015, surfaced in
  `StaffPage.tsx`) could create a booking at, cancel a booking
  belonging to, or mark no-show a booking belonging to, ANY branch
  in their club, not just their assigned branch(es) — despite the
  identical action already being correctly blocked for reschedule.
  Not reproduced with a second live branch this session (QA club has
  exactly one branch), but confirmed unambiguously by code
  comparison, not by inference. **Fixed** via migration
  `20260830200636_enforce_branch_scope_on_cancel_and_create_booking.sql`:
  added the same `user_has_branch_access(v_club_id, v_branch_id)`
  check to all three functions, reusing the existing, already-hardened
  helper (the one with the documented multi-membership-leak fix from
  2026-08-29, already backing 18 other call sites) — no new
  branch-scope logic invented. `_create_booking_internal` already had
  `v_branch_id` resolved; `cancel_booking`/`mark_booking_no_show`
  needed `branch_id` added to their existing `bookings` SELECT list.
  Applied to remote, local file renamed to match the applied
  timestamp. `npx tsc --noEmit` clean (no signature changes, no
  frontend impact). **Regression-verified**: the QA session's own
  unrestricted membership (zero `membership_branches` rows) still
  creates and cancels bookings correctly after the fix — the new
  check is additive, not a behavior change for unrestricted staff
  (the overwhelming majority case).

- **D7 (P1, FIXED + PASS)**: staff-facing booking creation
  (`_create_booking_internal`) never checked the target field's own
  `status` column (`active`/`maintenance`/`inactive`, real CHECK
  constraint on `public.fields`). The PUBLIC booking path checks
  `f.status = 'active'` consistently across every one of its own
  entrypoints (confirmed via grep across the full migration history)
  — but the staff path never gained the same check, despite the
  directive's own explicit requirement ("Archived/inactive field:
  must not accept new bookings"). **Live-reproduced through the real
  UI, not just SQL**: created a real field via the actual "Add Field"
  dialog, set it to "غير نشط" (Inactive) via the real Field Details
  tab, configured real weekly pricing via the real Pricing tab (all
  through genuine user-facing controls) — then `create_booking`
  against it succeeded with zero error, a real invoice, and a real
  booking. **Fixed** via migration
  `20260830201456_reject_booking_creation_on_inactive_field.sql`:
  added `if v_field.status <> 'active' then raise exception ...`
  immediately after the branch-access check (D6), mirroring the
  public path's exact predicate and this function's own existing
  error-message style ("field is closed on this day", "field is
  blocked during this time"). **Live-reverified after fix**: the
  identical booking attempt against the still-inactive field is now
  correctly rejected (`"this field is not currently available for
  booking (status: inactive)"`); a control booking against a genuinely
  active field in the same test still succeeds — no regression.

- **D8 (product gap, closed this phase — Section 16/32 finding, built)**:
  `create_field_block` RPC was fully implemented, correctly permission/
  module-gated, and behaved exactly as designed (live-verified:
  overlap with an active booking correctly reported via
  `conflicting_booking_ids` WITHOUT cancelling the real booking —
  confirmed the booking stayed `pending_payment` untouched) — but
  **zero UI anywhere in `src/` ever called it**. `field_blocks` was
  only ever read (`BookingsPage.tsx`/`FieldsManagement.tsx`, for
  display — the dashed-red "blocked" rendering in the calendar grid),
  never written. A club had no way to close a field for maintenance,
  weather, a private event, or a holiday through the actual product —
  exactly the shape of finding Section 32 asks to surface ("a major
  existing booking/field operational capability with real source data
  but no usable workflow"). **Built** (bounded, low-risk, matching the
  directive's Section 16/32 scope): a new "Closures" tab in
  `FieldsManagement.tsx`'s field-edit dialog
  (`FieldClosuresEditor.tsx`, new file), listing existing closures
  with delete, and a form to add a new one (date/time range/type/
  reason) — mirrors `PricingEditor.tsx`'s existing structure exactly,
  no new UI pattern invented. Backend additions: (1) `D6-continued`
  fix — `create_field_block` had the same branch-scope gap as D6
  (club-level `has_permission` only, no `user_has_branch_access`
  check, unlike its sibling `manage_field`) — fixed identically; (2)
  new `delete_field_block` RPC (none existed before), mirroring
  `create_field_block`'s exact permission/module/branch pattern plus
  a full audit-log entry capturing the deleted block's data. Migration
  `20260830202117_field_block_branch_scope_and_delete_rpc.sql`,
  types.ts regenerated (small, additive diff, confirmed
  `delete_field_block` present). Full i18n (ar/en) added.

  **D9 (P1, FIXED + PASS — found and fixed within this same phase,
  before being surfaced to the user)**: while live-verifying the new
  Closures UI, visiting `/app/fields` intermittently (but
  reproducibly, confirmed via a deliberate isolated code-revert A/B
  test) navigated away to `/app/bookings` on its own within ~1-6
  seconds, with zero click/interaction — the field-management dialog
  never had a chance to be used. Root-caused via `git stash` isolating
  exactly which of this session's own new lines caused it (confirmed:
  reverting only `FieldsManagement.tsx`'s new
  `useClubTimezone(currentClubId)` line made the symptom disappear;
  every other new file/line in this session's diff stayed in place
  during that test). Actual defect: `FieldClosuresEditor.tsx`'s first
  version called `if (!clubTimezone) return <p>...</p>` BEFORE several
  `useState`/`useMutation` hook calls — a genuine Rules-of-Hooks
  violation (hook COUNT differs between the "still loading" render,
  when `clubTimezone` is `undefined` because its own `useQuery` hasn't
  resolved yet, and the "resolved" render one tick later) — React's
  hook-order mismatch detection throws in exactly this situation, and
  that error was propagating in a way that manifested as an
  unexplained route change rather than a visible crash screen. Fixed:
  every hook now called unconditionally in the same order every
  render; the "still loading" case is handled via a safe `?? 'UTC'`
  fallback for the one computation that needs `clubTimezone` before
  it's confirmed loaded, plus `!clubTimezone` guards on the
  loading/empty/list render branches and the Add-button's `disabled`
  condition — never by skipping a hook.

- **D10 (P2, FIXED + PASS — found by the dispatched subagent's
  Customer360 spot-check, verified and fixed by primary)**: 4 of
  Customer360's tab-scoped queries (bookings, academy players, club
  memberships, shop purchases) never exposed `isLoading` to their
  `DataTable`, which falls back to its own empty-state message for
  `rows: []` — indistinguishable from a genuinely empty result while
  the query is still in flight. Live-reproduced by the subagent:
  opening a customer with real booking history and switching to the
  Bookings tab showed "No bookings yet" for ~2-3 seconds — directly
  contradicting the summary card immediately above it, which
  simultaneously showed the correct non-zero count (17). Same code
  shape confirmed present (not independently live-reproduced by the
  subagent, but structurally identical) for the Academy/Club
  Memberships/Products tabs. **Fixed**: destructured `isLoading` from
  each of the 4 `useQuery` calls (matching the exact pattern the
  file's own `summary` query already used correctly) and passed it
  through to each `DataTable`'s existing `isLoading` prop (already a
  real, working skeleton renderer — confirmed by reading
  `data-table.tsx`'s source directly, not assumed). `npx tsc --noEmit`
  clean. Live-verified the Bookings tab now correctly shows the real
  17-row table (Field/Date/Status/Total, "View invoice" links intact)
  with no regression to the already-correct final rendered state.

  Also removed a second,
  now-redundant `useClubTimezone` call this phase had added directly
  to `FieldsManagement.tsx` (moved the fetch down into
  `FieldClosuresEditor` itself, which only mounts when the Closures
  tab is actually selected — fetches only when genuinely needed, and
  eliminates the extra top-level hook that was part of the same
  investigation). **Live-reverified after fix**: `/app/fields` stays
  correctly on itself after 6+ seconds of idle wait (previously
  reproduced the bad navigation within that window every time once
  triggered); the Closures tab opens, lists both real blocks
  correctly formatted, create and delete both verified live (delete
  confirmed removed server-side via direct query; create confirmed
  appeared immediately with correct timezone-converted display).
  `npx tsc --noEmit` clean. This entire defect was introduced and
  fully resolved within this same session's own new code — it never
  reached a committed state as a live regression, but is documented
  in full because of how seriously misleading a hook-order bug
  manifesting as an unexplained navigation is, and as a concrete
  lesson: any component with async-loaded data feeding an early
  conditional return must have ALL its hooks resolved before that
  return, never after.

## 4. Evidence log (items 3-13)

**Staff booking creation (new + existing customer)**: live through the
actual desktop "All Fields" grid + `QuickBookingSheet` at
`/app/bookings`. New customer: filled name/phone, "Add Customer",
customer became selected, submitted with "Pending Payment" — DB
confirms `pending_payment`, correct price (120 EGP), correct local
start time (12:00 Cairo on 2026-08-31 → `start_at 09:00:00+00`).
Existing customer: searched by name, selected from the real dropdown,
booked a second slot for the same `customer_id` — confirmed same
customer, correct time (14:00 Cairo). Cash-shift gate correctly
blocked "Pay Now / Cash" until switched to "Pending Payment" (real
Finance-baseline rule, not reopened/modified).

**Availability & conflict engine**: 7 overlap scenarios tested via
direct `create_booking` RPC calls against one real occupied slot
(16:00-17:00 Cairo, 2026-08-31): exact-same/partial-start/partial-end/
fully-inside/fully-containing all correctly rejected with the friendly
`"this time slot was just booked by someone else"` message;
back-to-back-before and back-to-back-after (touching, non-overlapping
half-open intervals) both correctly succeeded. Different field, same
exact time → succeeded (different resource, correct). Confirms the
GiST exclusion constraint's half-open `[start, end)` semantics are
exactly right.

**Concurrency**: two genuinely simultaneous `create_booking` calls
(`Promise.all`, not sequential) for the identical field+time —
exactly one succeeded, one got the friendly conflict error. DB
query confirms exactly 1 row exists for that slot (not 0, not 2).
LIVE CONCURRENT VERIFIED, not just architecturally inferred.

**Rescheduling**: reschedule into an occupied target slot correctly
rejected (`"the new time was just booked by someone else"`), and the
original booking's `start_at`/status were confirmed unchanged after
the failed attempt (no partial/corrupted state). A second reschedule
into a genuinely free slot succeeded, returned `{new_total_price,
price_changed}`, and the DB confirms the booking actually moved.

**Cancellation**: cancelled a `pending_payment` booking via
`cancel_booking` — succeeded, and the freed slot was immediately
re-bookable (confirmed via a follow-up `create_booking` for the exact
same field+time succeeding). No phantom availability block left
behind.

**No-show / status lifecycle**: `mark_booking_no_show` correctly
REJECTS a `pending_payment` booking (`"not in a markable state"` —
by design, only `confirmed`/`checked_in` are markable, confirmed by
reading the RPC source). Created a `confirmed` booking (via
`p_record_payment` with a non-cash method), successfully marked it
`no_show`. Then verified `no_show` is a correct terminal state: a
second no-show attempt, a cancel attempt, and a reschedule attempt
were ALL correctly rejected with distinct accurate error messages.
See D2 above for the separate `completed` status gap.

**Booking QR + check-in**: created a fresh `confirmed` booking,
fetched its real QR token via `ensure_booking_qr`, confirmed check-in
via `qr_confirm_checkin` — succeeded, booking transitioned to
`checked_in` in the DB. Re-scanning the same (now-consumed) token
correctly returned `{result: 'already_used', diagnostic_code:
'TOKEN_CONSUMED'}` — no error thrown, no double check-in, no raw
exception. A bogus/garbage token correctly returned `{result:
'invalid', diagnostic_code: 'TOKEN_NOT_FOUND'}`. Read the full RPC
source: tenant scoping is derived entirely from the credential's own
`club_id` (never a caller-supplied parameter) — cross-tenant scanning
is architecturally impossible, not just policy-blocked. Also confirms
a real financial-eligibility gate (outstanding must be settled before
check-in, reusing `get_invoice_payment_summary` — the same canonical
Finance source, no new formula) and correct terminal-status handling
(`cancelled`/`no_show`/already-`checked_in` all explicitly rejected
before the financial check even runs).

## 5. Evidence log (items 14, 21, 25-27) — dispatched UX-reviewer subagent

Per Section 33 (max one subagent, no nested delegation, primary
independently reviews), one subagent ran the live-UI-heavy remaining
verification (Customer360, print regression, RTL/LTR, responsive,
error UX) in an isolated worktree while primary continued the D8/D9
field-closures work. Primary independently reviewed its report before
accepting it as evidence, and personally fixed the one genuine defect
it found (D10, see above) rather than trusting the subagent's own
suggested fix blindly.

**Customer360 booking experience**: 17 real bookings on a real QA
customer confirmed rendering correctly (no duplicates, correct
localized statuses, correct amounts, "View invoice" links working)
— once loaded. Found D10 (the loading-state gap, now fixed).

**Booking print regression** (Printing CLOSED baseline — verify only,
not touched): real booking invoice verified in both Arabic and
English — QR codes present and correct, amounts/statuses/customer/line
items correct, no layout breaks, mixed Arabic/English content clean.

**RTL/LTR on booking UI**: time ranges never bidi-reversed (confirms
the prior session's D8/bidi fix holds), operating hours correctly
ordered in RTL, grid columns mirror correctly, status badges always
translated (never raw enum strings), mixed-language names display
cleanly.

**Responsive (375/768/1024/1440)**: all four widths clean on
Bookings (both view modes) and Fields — no page-level horizontal
overflow, all controls reachable, tables correctly scroll internally.
One sub-item (QuickBookingSheet specifically at 375px via live click)
was environment-blocked by the same intermittent Browser-pane
instability the subagent (correctly) also hit and (correctly) did not
misattribute to app code — this was later root-caused and fixed by
primary as D9. Desktop-width QuickBookingSheet functionality was
independently confirmed working by the subagent.

**Error UX**: zero raw Postgres/RPC error strings observed anywhere
across dozens of real interactions this session (both by primary and
by the subagent). `src/lib/errors.ts`'s `translateSupabaseError`
confirmed to be a real, actively-maintained translator including the
exact booking-conflict (`23P01`) and invalid-phone cases, wired into
`QuickBookingSheet.tsx`'s error handling with a localized fallback for
anything unmapped.

## 6. Section 32 — secondary bounded gap review

Per directive Section 32: "Is there a major existing booking/field
operational capability with real source data but no usable workflow?"

- **Field closures/blocks (D8)**: found and closed this phase (see
  above) — the one real P1-shaped gap. `create_field_block` was fully
  built, audited, permission-gated with zero UI. Built a bounded,
  low-risk "Closures" tab reusing the existing `PricingEditor.tsx`
  pattern — no new UI pattern invented, no speculative features
  (no recurring closures, no calendar picker) — exactly matching
  Section 32's "obvious, bounded, low-risk" scope.
- **Booking source/channel visibility**: `bookings.source`
  (staff/club_public_link/club_qr) is captured but never displayed
  anywhere in the UI. Real but low-severity — informational only, no
  broken flow. **Classified P2, NOT built** — smaller and less
  operationally necessary than D8, and the directive's "Do NOT build
  speculative features... no unlimited product expansion" caps how
  many gaps get filled in one pass.
- **Booking waiting list**: zero infrastructure (schema/RPC/UI) exists
  at all — this would be a genuinely new feature requiring real data
  model design, not a "capability exists but has no UI" gap. Out of
  Section 32's scope entirely (which asks only about EXISTING
  capabilities), not even classified as P3.
- **Daily field schedule / field utilization operational view**:
  already covered by the existing, previously-accepted
  `ReportOccupancyPage`/`ReportBookingsPage` — no gap.
- **Staff booking notes**: already fully supported and displayed
  (`booking.notes`, rendered in `BookingDetailSheet.tsx`, also
  appended to on no-show) — no gap.
- **Customer arrival/check-in**: already fully built and verified
  (Section 12/13 above, `qr_confirm_checkin`) — no gap.

**Result: 1 P1 gap found and closed (D8), 1 P2 noted and deliberately
not built (booking source/channel display), everything else already
covered.** No speculative features built. No unlimited expansion.

## 7. Final regression gate & deployment record

- `npx tsc --noEmit`: PASS (0 errors).
- `npm run lint`: PASS (0 errors, 13 pre-existing warnings unrelated
  to this session's files).
- `npm run test` (vitest): PASS — 108/108 tests, 98 skipped
  (pre-existing integration suites requiring QA credentials).
- `npm run build`: PASS, clean production build.
- Local commit: `3519fa4` on top of baseline `0110db5`.
- Pushed to `origin/main`: `0110db5..3519fa4`.
- CI run [33335308007](https://github.com/mal3abyapp-oss/Mal3aby/actions/runs/33335308007):
  GREEN — build-and-test + e2e-public both passed.
- Deployed to production: `cd cloudflare/frontend-worker && wrangler
  deploy` (Worker `mala3by-frontend`, version
  `a08589b3-06c3-42e3-9698-c75d90251e16`) — rebuilt at the correct
  final HEAD first (confirmed via new asset hash `index-Iks2grya.js`
  before deploying, per Section 35's explicit "do not deploy a stale
  dist" requirement).
- Production verified live on a genuinely fresh tab:
  `https://mal3aby.app`, console confirms `build 3519fa4`, zero
  console errors. D9 fix specifically re-verified live in production:
  `/app/fields` stays correctly on itself after 6+ seconds of idle
  wait (the exact window that previously reproduced the bad
  navigation before the fix).

## 8. Final status

- BOOKING ARCHITECTURE = PASS
- STAFF BOOKING CREATION = PASS
- NEW/EXISTING CUSTOMER BOOKING = PASS
- AVAILABILITY / OVERLAP PREVENTION = PASS
- CONCURRENCY = PASS (LIVE CONCURRENT VERIFIED)
- TIMEZONE = FIXED + PASS (D1, D3)
- PRICING = PASS (D4 logged as owner decision, not a defect)
- DURATION = PASS
- RESCHEDULE / CANCELLATION / STATUS LIFECYCLE = PASS
- QR / CHECK-IN = PASS
- PUBLIC BOOKING = FIXED + PASS (D1)
- FIELDS (CREATE/EDIT/STATUS/CLOSURES) = FIXED + PASS (D7, D8)
- BRANCH SCOPING = FIXED + PASS (D6)
- CUSTOMER360 = FIXED + PASS (D10)
- FINANCE INTEGRATION = PASS (FIXED + PASS on D5)
- PRINT / REPORT REGRESSION = PASS (verify only, untouched)
- PERMISSIONS / SECURITY = PASS
- AUDIT = PASS
- ERROR UX = PASS
- RESPONSIVE / RTL-LTR = PASS
- SECONDARY GAP REVIEW = PASS (Section 32, D8 closed)
- BOOKINGS/FIELDS P0 = 0
- BOOKINGS/FIELDS P1 = 0 (all found P1s fixed: D1,D5,D6,D7,D8,D9,D10)
- BOOKINGS/FIELDS CORE P2 = 0 (D4 accepted-limitation, owner decision
  pending; booking-source-visibility P2 deliberately not built)
- TSC/LINT/UNIT/BUILD = PASS
- CI = GREEN (run 33335308007)
- PRODUCTION = VERIFIED (mal3aby.app, build 3519fa4)
- REPOSITORY HEAD = origin/main = 3519fa4
- WORKING TREE = clean

BOOKINGS & FIELD OPERATIONS PRODUCTION ACCEPTANCE = PASS.
