# Autonomous Decision Log

Per-decision record for the autonomous execution run governed by the
"MASTER AUTONOMOUS DIRECTIVE V3" (Doc 3). One entry per non-trivial,
non-obviously-reversible engineering decision. Newest entries at the
bottom.

---

## D-001 — Booking time integrity root cause & fix

**Date:** 2026-08-16
**Problem:** Reported P0 — user selects a booking time on the calendar,
a different time (~2-3h off) gets stored/displayed.

**Evidence:**
- `QuickBookingSheet.tsx` built `` `${slot.date}T${slot.startTime}:00` ``
  — a naive datetime string with no UTC offset — and sent it as
  `p_start_at`/`p_end_at` to `create_booking`, whose params are typed
  `timestamp with time zone`.
- `show timezone` on the Supabase DB session returns `'UTC'`.
- Postgres parses an offset-less timestamp string using the *session's*
  default timezone, not the club's real venue timezone
  (`clubs.timezone = 'Africa/Cairo'`). So a click on "18:00" (meant as
  18:00 Cairo-local) was stored as `18:00:00+00` UTC — which is
  `21:00` Cairo-local (Cairo is UTC+3 under its 2023-reinstated DST) —
  matching the reported ~3h drift exactly.
- A second, related bug existed server-side: `_create_booking_internal`
  derived "which local day / which local wall-clock time" via bare
  `p_start_at::date` / `p_start_at::time` casts on the timestamptz —
  which ALSO implicitly use the session's UTC timezone, not the venue's.
  This fed the operating-hours check, the pricing-rule resolution
  (`resolve_field_price`), and the same-calendar-day span check — all
  three would have silently used the wrong local date/time even after
  the frontend started sending a correct instant.
- Conflict detection (`field_blocks` overlap check via `tstzrange`) was
  already correct — instant-based comparison is timezone-agnostic by
  construction and needed no change.

**Options considered:**
1. Hardcode a `+3`/`-3` adjustment in the frontend. **Rejected** —
   explicitly forbidden by the directive; wrong for any non-Cairo club,
   wrong across DST transitions, treats the symptom not the cause.
2. Build a proper Time Model (Business Date + Business Time + Venue
   Timezone → Instant, and the inverse) using real IANA tzdata via the
   `Intl` API, resolve `clubs.timezone` wherever a booking time is
   written or read, and fix the equivalent local-date/time derivation
   bug server-side via `AT TIME ZONE`. **Chosen.**

**Chosen solution:**
- New `src/lib/domain/time.ts`: `toInstant(date, time, ianaTimeZone)`,
  `fromInstant(instant, ianaTimeZone)`, `formatInstant(...)`. Verified
  against Postgres's own `AT TIME ZONE` computation to the exact second
  for all of 00:00/01:00/06:00/09:00/12:00/18:00/21:00/23:00, plus a
  winter (non-DST) sanity check confirming no hardcoded offset.
- `useClubTimezone(clubId)` hook (`useFieldPricing.ts`) — single source
  for the venue's real timezone, fetched from `clubs.timezone`.
- Wired into every booking-time write/read site:
  `QuickBookingSheet.tsx` (booking creation), `BookingsPage.tsx`
  (day-range fetch filters, `slotMinutesOf`, `FieldColumnHeader`'s
  "now" time), `BookingsMobileView.tsx` (`slotMinutesOf`, "now"
  calculation, hour-start checks, next-booking time display),
  `BookingDetailSheet.tsx` (date/time display).
- Migration `20260816110000_fix_booking_venue_timezone.sql`: rewrote
  `_create_booking_internal` to resolve `clubs.timezone` and derive
  `v_local_date`/`v_local_start_time`/`v_local_end_time` via
  `p_start_at AT TIME ZONE v_timezone`, then pass those (not the raw
  UTC-cast values) into `resolve_field_operating_hours` and
  `resolve_field_price`, and use them for the same-day-span check.
  Conflict detection left untouched (already correct).

**Why:** Root-cause fix, not a patch. Correct for any IANA timezone
(never hardcoded to Egypt/UTC+3), correct across DST transitions
automatically (verified), and fixes both halves of the bug (frontend
write path AND backend local-time derivation) rather than only masking
the symptom on one side.

**Risks:** Existing seed/QA booking rows created before this fix were
inspected directly — they were written by a raw SQL seed script (not
through the buggy frontend path) and were already storing correct UTC
instants, so no historical-data backfill was required. This was
verified, not assumed (per the directive's explicit anti-assumption
requirement) — see verification below.

**DB impact:** One function replaced (`_create_booking_internal`), no
schema/column changes, no data migration needed (see Risks).

**Security impact:** None — no RLS/permission logic touched.

**Reversal path:** Fully reversible — `_create_booking_internal` can be
restored from the prior migration file
(`supabase/migrations/20260816...` — see `list_migrations`) if needed;
frontend changes are plain file edits, revertible via git.

**Verification performed:**
1. Mathematical: `toInstant`/`fromInstant` round-tripped correctly for
   all 8 required test hours; results matched Postgres's own
   `... AT TIME ZONE 'Africa/Cairo'` computation to the second.
2. Direct SQL simulation of the fixed RPC's local-time derivation for a
   correctly-converted instant → correctly recovered `18:00:00` local
   time from a `15:00:00+00` stored instant.
3. **Live end-to-end UI test**: clicked the 19:00 slot for "ملعب 2 - كرة
   قدم" in the real running app, selected an existing customer, and
   submitted via the actual `create_booking` RPC call. Resulting DB row
   confirmed: `start_at = 2026-08-16 16:00:00+00`,
   `AT TIME ZONE 'Africa/Cairo' = 2026-08-16 19:00:00` — exactly
   matching the clicked slot. TypeScript build clean throughout
   (`npx tsc --noEmit`, zero errors).

**Status:** Fixed and verified. Historical data confirmed NOT affected
(seed data was written correctly via direct SQL, not through the buggy
UI path — no bookings created through the live app prior to this fix
were found in this QA club; if any are found in other clubs during
later regression, they would need individual inspection per the
directive's "identify exactly which records are affected, don't mass-edit"
rule).

---

## D-002 — Academy enrollment integrity: manual-activation-policy bypass

**Date:** 2026-08-16
**Problem:** Gate 2 investigation (Academy Enrollment Integrity, P0 per
Doc 3 priority order). Read the full enrollment pipeline
(`create_enrollment_with_subscription`, `record_payment`,
`_activate_subscription_if_due_internal`, `activate_subscription_if_due`)
end to end before assuming new defects — a prior session had already
found and fixed the real "academy doesn't work" root cause (missing
`club_owner` permissions), so this pass looked for defects independent
of that.

**Investigation findings:**
1. **False positive, corrected in-session:** initially believed there
   was no duplicate-active-enrollment protection (checked only
   `pg_constraint`, which doesn't list standalone unique indexes). A
   `pg_indexes` check revealed `enrollments_active_player_group_idx`
   already enforces `UNIQUE (player_id, group_id) WHERE status='active'`
   — this was already correctly protected. A redundant duplicate index
   I'd created was dropped again once this was discovered.
2. **Real bug confirmed:** `_activate_subscription_if_due_internal()` is
   called from two places — automatically inside `record_payment()`
   (any payment against the invoice), and explicitly via the
   staff-invoked `activate_subscription_if_due()` RPC. For a club whose
   `subscription_activation_policy = 'manual'`, the function activated
   the subscription unconditionally regardless of which caller invoked
   it — meaning ANY payment (even a partial/token one) would silently
   activate a subscription that was supposed to require deliberate
   staff sign-off. `first_payment`/`full_payment` policies were already
   correctly payment-gated and needed no change.
3. Full-group and no-approved-price cases were already correctly
   handled: full groups auto-flip to `status='full'` inside the
   enrollment RPC and are filtered out of the frontend's group picker
   (`.eq('status','active')`); the enrollment wizard already disables
   submission with a clear message when the selected group has no
   `subscription_price` set (prior session's work, still intact).

**Chosen solution:** Added a `p_explicit boolean default false`
parameter to `_activate_subscription_if_due_internal`. The `manual`
policy branch now only activates when `p_explicit = true`.
`activate_subscription_if_due()` (the staff-invoked RPC) passes `true`;
`record_payment()`'s internal call keeps the default `false`. No schema
change; `first_payment`/`full_payment` behavior is bit-for-bit
unchanged.

**Why:** Minimal, targeted, root-cause fix — distinguishes "this
activation happened because staff explicitly chose to" from "this
activation happened as an automatic side effect of some other action,"
which is exactly the distinction `manual` policy is supposed to encode.

**Risks:** No club in the current dataset uses `manual` policy, so this
had zero observable effect on existing data — purely forward-looking
protection for any club that switches to it via Settings. Verified via
direct SQL: temporarily set the QA club to `manual`, confirmed an
implicit call (`p_explicit=false`) leaves a real pending subscription
`pending`, and an explicit call (`p_explicit=true`) correctly activates
it; both test mutations were reverted afterward.

**Housekeeping note:** `create or replace function` with a changed
argument list creates a new overload rather than replacing the old
one — the first version of this fix left an orphaned
`_activate_subscription_if_due_internal(uuid)` (1-arg) callable
alongside the new 2-arg version. Dropped explicitly in a follow-up
migration once noticed; no caller referenced the 1-arg form, so this
was pure cleanup, not a behavior change.

**DB impact:** One function signature changed (added a defaulted
parameter — backward compatible for any caller not yet updated), one
wrapper function updated to pass the new flag. No schema/column changes.

**Security impact:** None — no RLS/permission logic touched; the
`activate_subscription_if_due()` wrapper's own permission check
(`subscription.update`) is unchanged.

**Reversal path:** Fully reversible — prior function bodies recoverable
from `list_migrations`/git history.

**Status:** Fixed and verified via direct SQL simulation of both call
paths (implicit vs explicit) against a real pending subscription.
Duplicate-enrollment protection confirmed already correct (no fix
needed — corrected my own false-positive before shipping an unneeded
change). Full-group and no-price cases confirmed already correct.
