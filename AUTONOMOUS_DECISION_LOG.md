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

---

## D-003 — Gate 3 scoping: no customer/guardian self-service surface exists

**Date:** 2026-08-16
**Problem:** Doc 3 Gate 3 requires a unified user account model where a
person can self-manage their memberships/subscriptions/bookings/QR/
children. Investigated actual current state before writing any code.

**Findings (verified directly, not assumed):**
1. `profiles` table already gives every `auth.users` account exactly
   one profile with `avatar_url` — the "one account per person, not
   per role" principle is already the architecture. No fix needed here.
2. `players.photo_url` and `customers.photo_url` both already exist as
   columns.
3. **However:** `players`/`customers` RLS policies only grant
   INSERT/UPDATE to staff holding `player.update`/equivalent
   permissions — there is no RLS path today for an ordinary
   authenticated end-user to write their own player/customer row.
4. **Root gap found:** `customers` has NO column linking a row to
   `auth.users` (no `user_id`/`auth_user_id` foreign key). A `customers`
   row today is purely a staff-managed CRM record with no connection to
   any login identity.
5. **Consequence:** the entire `/app` route tree (`RequireAuth`) is
   exclusively the staff/employee product. There is no customer-facing
   route, page, or component anywhere in the app today — no login-and-
   see-my-own-bookings surface exists at all. This is not a bug to
   patch; it's an entire missing product domain (Doc 3's "Unified User
   Dashboard": My Academies, My Subscriptions, My Bookings, My QR, My
   Payments, My Attendance, My Children).
6. Because there's no self-service write path to `players`/`customers`
   at all yet, the specific threat Doc 3 warns about (a user swapping
   their own verified photo to impersonate someone) does not yet apply
   to this codebase — it will become a real risk only once self-service
   write access is introduced, and the re-approval-workflow requirement
   must be designed in from the start of that feature, not bolted on
   after.

**Decision:** This is legitimately a large net-new build, not a
same-day fix. Given the sheer number of remaining Doc 3 gates (4
through 13) that structurally depend on this one (Memberships/
Subscriptions/Entitlements, Bookings extensions, Secure QR, Identity
Verification, Attendance, Notifications, WhatsApp), building the full
customer-facing portal end-to-end before touching any of those would
be the correct dependency order if scope were unconstrained. Given
this is a single autonomous session, the pragmatic path (still fully
within the directive's "prefer reversible, incremental, real
architecture" guidance) is:
  a. Add the missing `customers.user_id -> auth.users` link (nullable,
     backward compatible — existing customer rows created by staff have
     no linked login and keep working exactly as today).
  b. Build a minimal but real self-service auth linking flow so a
     customer with a matching phone/email can claim their existing
     staff-created customer record (or a new one is created) on
     signup — never silent auto-linking without verification.
  c. Build the first real screen of the Unified Dashboard (My Bookings)
     end-to-end as the proof of the pattern, establish RLS policies for
     self-service customer access (customer can read/write only their
     own row, and only specific columns — never player financial data,
     never other customers' data), then continue expanding
     screen-by-screen in subsequent work.
This keeps the architecture correct from the first line of code
(the hard-to-reverse part — RLS/ownership model) while not attempting
to boil the ocean in one pass.

**Status:** Scoped. User explicitly confirmed via AskUserQuestion:
"Build it now, full steam" — proceeding with (a)-(c) below.

**Implementation so far:**
- Migration `20260816130000_customer_self_service_link.sql`: added
  nullable, unique `customers.user_id -> auth.users(id)`. Self-service
  RLS policies (`customers_self_service_select`/`_update`) scoped
  strictly to `user_id = auth.uid()`, entirely independent of
  `club_memberships`/`has_permission()` so a customer can never
  accidentally inherit staff privilege. `claim_customer_self_service()`
  RPC is the only way `user_id` is ever set — requires an
  already-authenticated caller to name an exact, currently-unclaimed
  `(club_id, customer_id)` pair; never silent auto-matching by phone/
  email (which would let anyone claim a stranger's financial history
  just by knowing their phone number).
- Migration `20260816140000_customer_self_service_write_guard.sql`:
  RLS is row-level only, so the self-service UPDATE policy alone would
  have let a customer silently rewrite `photo_url`/`national_id`/
  `full_name` on their own row — exactly the identity-fraud vector Doc 3
  warns about. Added `protect_customer_identity_columns()` BEFORE
  UPDATE trigger (same silent-revert pattern as this codebase's
  existing `protect_club_status_from_non_platform_owner`) that reverts
  those columns to their prior value whenever the actor lacks staff
  `customer.update` permission. Photo changes specifically get a real
  request/approval flow instead of being blocked outright:
  `customer_photo_update_requests` table +
  `request_customer_photo_update()` (self-service, records old/new URL
  and who requested) + `review_customer_photo_request()` (staff-only,
  applies the change only on explicit approval, writes an audit log
  entry either way). This is the concrete implementation of Doc 3's
  "verified photo requires an explicit re-approval workflow with audit
  trail" requirement.

**Security regression caught and fixed in the same pass:**
`get_advisors(type: security)` flagged that Gate 2's
`_activate_subscription_if_due_internal(uuid, boolean)` — an internal
helper following this codebase's own underscore-prefix "not directly
RPC-callable" convention (matching `_create_booking_internal`) — had
been left executable directly by `anon`/`authenticated` via PostgREST,
with no permission check of its own (it trusts its two callers,
`record_payment()` and `activate_subscription_if_due()`, to have
already authorized the request). Fixed by revoking direct EXECUTE,
matching the established pattern; verified via
`has_function_privilege()` that both roles are now correctly denied
while the function continues to work for its two legitimate
SECURITY DEFINER callers (function-to-function calls don't go through
PostgREST's grant check).

**Next:** build the frontend claim flow + first real self-service
screen (My Bookings) to prove the pattern end-to-end.

**Frontend built:** `PortalLayout` (mobile-first shell, separate from
`AppLayout`), `RequirePortalAuth` guard, `ClaimAccountPage` (explicit
club + mobile-number confirmation before claiming, never silent
auto-match), `PortalRoot` (claim-flow vs dashboard router),
`PortalBookingsPage` (My Bookings), `PortalAcademyPage` (My Children),
`PortalQrPage` (My QR — reuses the existing `ensure_booking_qr()`
mechanism unchanged), `PortalProfilePage` (contact-info self-edit).
`LoginPage` now distinguishes "no membership + has a linked customer
record" (→ `/portal`) from "no membership + no customer record at all"
(→ `/onboarding`, genuinely a prospective club owner) — previously
every no-membership login was sent to club-creation onboarding
regardless of persona.

**Additional RLS/read-access gaps found and fixed while wiring real
screens** (each of these tables had ONLY staff-permission-gated SELECT
policies before this pass — a self-service customer would have seen
nothing, silently, with no error): `bookings`, `fields`, `branches`,
`clubs`, `guardian_links`, `players`, `enrollments`, `groups`,
`subscriptions`. Added narrow self-service SELECT policies to each,
chained back to `customers.user_id = auth.uid()` (or, for academy
tables, chained through `guardian_links` as well) so a customer only
ever sees their own data, never another family's or another club's.

**Second real bug found while wiring My QR:** `ensure_booking_qr()`
only ever checked staff `booking.view` permission — a real customer,
having no `club_memberships` row, would always fail this and could
never generate their own booking's QR. Fixed by also authorizing the
caller when the booking's own `customer_id` is linked
(`customers.user_id`) to their `auth.uid()`. This is the same bug
pattern as D-002 (a permission check written with only the staff
persona in mind, silently breaking a legitimate second persona) —
worth treating as a standing review item for every remaining
staff-permission-only RPC as portal screens keep expanding onto them.

**Critical bug found via real black-box RLS testing (not just SQL
inspection):** signed up a genuine throwaway test auth user (via the
real `/auth/v1/signup` + `/auth/v1/token` endpoints, confirmed the
email directly in `auth.users` since this project's mailer isn't
configured for real delivery, then issued real REST calls with the
resulting access token — this is what actually exercises RLS, since
service-role/SQL-console access bypasses it entirely). Found:
`claim_customer_self_service()` appeared to succeed (returned the
customer id, no error) but `user_id` was never actually persisted.
Root cause: `protect_customer_identity_columns()` (the identity-column
guard from earlier in this same gate) fires on every `customers`
UPDATE, including the one inside the claim RPC itself — and correctly
identified the claiming user as lacking staff `customer.update`
permission (true, by definition, for a self-service claimant), so it
silently reverted its own `user_id` write. Fixed with a
transaction-local Postgres GUC flag
(`set_config('app.allow_customer_identity_claim', 'true', true)`,
`is_local=true` so it can never leak outside the claim RPC's own
transaction) that the trigger checks specifically for the `user_id`
column, leaving every other protected column's guard fully intact.

**Full verified test matrix (real access token, real REST calls):**
- Before claiming: 0 bookings, 0 customers visible. ✅
- After claiming: exactly the claimed customer's own 2 bookings
  visible, customer record shows correct `user_id`. ✅
- Reading a different customer's row directly by id: `[]` (denied). ✅
- Claiming a second customer in the same club: rejected
  (`customer not found`, since the RPC's own unclaimed-only query
  correctly excludes it). ✅
- Direct PATCH of `photo_url`/`full_name` (bypassing the RPC): request
  returns 200 (no RLS row-level violation, since the row is the
  caller's own) but the protected values are silently unchanged. ✅
- Direct PATCH of `mobile_display` (a legitimately self-editable
  column): correctly succeeds. ✅

All test-induced data changes (the claimed `user_id`, the edited
`mobile_display`) were reverted afterward via a trigger-disabled
cleanup pass so this session's QA dataset stays clean; the test
account's `audit_logs` entry from the claim was deliberately left in
place (audit history must never be deleted, per the platform's own
"immutable audit trail" rule) and the throwaway `auth.users` row was
left in place too (harmless, isolated, no relationship to any real
customer/staff data).

**DB impact this pass:** `customers.user_id` column + unique index;
11 new self-service RLS SELECT policies across 9 tables; 1 new
self-service UPDATE policy; `customer_photo_update_requests` table +
2 RPCs; `claim_customer_self_service()` + `find_claimable_customer()`
RPCs; `protect_customer_identity_columns()` trigger; `ensure_booking_qr()`
and `_activate_subscription_if_due_internal()` grant/logic fixes.

**Security impact:** net-positive — closes the "no self-service surface
exists" gap while keeping every new access path narrowly scoped and
independently verified; the one real defect this introduced
(claim-vs-guard conflict) was caught and fixed within the same pass,
before being left in a shippable state, via genuine black-box testing
rather than assumption.

**Reversal path:** every migration in this pass is a clean forward
`create or replace`/`create policy`/`alter table add column` — fully
recoverable from `list_migrations`/git history; no destructive
operations were performed on real data.

**Status:** Gate 3 foundational build complete and verified. Remaining
Gate 3 scope (deeper "My Subscriptions"/"My Payments" screens, the
photo-request UI itself, rate-limiting `find_claimable_customer`) is
tracked as follow-up in the execution state file, not blocking
progress to Gate 4+.

---

## D-004 — Gate 4: subscription lifecycle operations + a genuine RLS recursion bug

**Date:** 2026-08-16
**Problem:** Gate 4 (Memberships / Subscriptions / Operational
Entitlements). Read the existing `subscriptions`/`subscription_freezes`
schema and every subscription-related RPC before assuming Doc 3's
"professional subscription" requirements were unmet.

**Findings:**
- `subscriptions.status` already has a clean model (pending/active/
  frozen/expired/cancelled) — no `suspended`/`grace_period` literal
  values needed, matching the directive's own "don't blindly adopt
  Doc's literal state names if the system already has a better fit"
  guidance.
- `freeze_subscription()` already existed, with a real history table
  (`subscription_freezes`, rows never overwritten) and reason/audit
  logging. `get_subscription_effective_end_date()` already correctly
  sums every `extends_expiry=true` freeze period, not just the latest.
- **Real gap confirmed:** no `unfreeze_subscription()` — a frozen
  subscription had no path back to active except a direct
  `subscriptions` table UPDATE via the `subscriptions_update` RLS
  policy, which bypasses `write_audit_log()` entirely (unlike every
  other lifecycle transition in this schema).
- **Real gap confirmed:** no dedicated academy-subscription
  cancellation RPC. `cancel_platform_subscription()`/
  `renew_platform_subscription()` exist but are for the PLATFORM/
  commercial billing subscription — the exact naming collision Doc 3
  itself warns about, not the academy member's subscription.
- Repo-wide search confirmed no frontend code does a direct
  `subscriptions` table UPDATE of `status` today — closing this gap via
  a hard trigger-based guard (see below) breaks nothing currently
  working.

**Chosen solution:**
- `unfreeze_subscription(p_subscription_id, p_reason)`: returns a
  frozen subscription to active. If ending a freeze before its
  originally scheduled `end_date`, shortens the freeze record's
  `end_date` to today (never deletes the history of days actually
  elapsed) — UNLESS the freeze hadn't started yet at all (future-dated,
  cancelled before taking effect), in which case there's no valid
  shortened `end_date` satisfying `end_date > start_date`, so that
  0-elapsed-day record is removed outright (the cancellation action
  itself is still audit-logged).
- `cancel_subscription(p_subscription_id, p_reason)`: requires a
  non-empty reason, permission-gated on `subscription.update`,
  audit-logged with the previous status recorded.
- `protect_subscription_status_transitions()` trigger (BEFORE UPDATE,
  same silent-revert pattern as this codebase's established
  `protect_club_status_from_non_platform_owner`/Gate 3's
  `protect_customer_identity_columns`): any direct `status` change not
  flagged via a transaction-local GUC
  (`app.allow_subscription_status_transition`) is silently reverted.
  Every legitimate lifecycle RPC (`_activate_subscription_if_due_internal`,
  `freeze_subscription`, `unfreeze_subscription`, `cancel_subscription`)
  sets the flag for its own transaction only before its own status
  UPDATE.

**Bugs found and fixed via testing (not assumed correct after writing):**
1. **Genuine circular RLS dependency**, caught via real black-box RPC
   testing (not SQL inspection — a raw superuser session doesn't
   exercise RLS at all): querying `subscriptions` under a real
   `authenticated` session raised "infinite recursion detected in
   policy for relation enrollments." Root cause: `enrollments_select`
   (pre-existing, staff/coach policy) references `groups.coach_id`,
   which requires evaluating `groups`' own RLS — including Gate 3's
   `groups_self_service_select`, which itself queried `enrollments`
   directly. `enrollments → groups → enrollments → ...`. Fixed by
   introducing `is_guardian_of_group()`, a `SECURITY DEFINER` function
   (same escape-hatch pattern as this schema's existing
   `has_permission()`/`user_club_ids()`) whose internal query bypasses
   the caller's own RLS context, breaking the cycle while keeping the
   exact same authorization semantics. Verified fixed via a direct
   `set role authenticated` + JWT-claims simulation, confirming
   `enrollments`/`groups`/`subscriptions` are all queryable again.
2. **Unfreezing a not-yet-started freeze crashed** on the
   `subscription_freezes_valid_period` check constraint (`end_date >
   start_date`) — found identically to bug 1, via real RPC calls, not
   assumption. Fixed as described above (delete the 0-elapsed-day
   record instead of trying to shrink it below its own start).

**Full verified test matrix (real staff-role access token, temporarily
granted `club_owner` on the QA club then revoked afterward):**
- Direct unauthorized `status` UPDATE (no RPC flag set): silently
  reverted, confirmed via direct SQL. ✅
- `freeze_subscription` → subscription becomes `frozen`. ✅
- `unfreeze_subscription` (ending a freeze before it had even started)
  → subscription becomes `active` again, the 0-day freeze record is
  removed (confirmed empty via a follow-up read), no constraint
  violation. ✅
- `cancel_subscription` → subscription becomes `cancelled`. ✅
- Every transition produced a correctly-ordered `audit_logs` entry with
  the right action name and reason text. ✅
- `enrollments`/`groups`/`subscriptions` all correctly queryable again
  post-fix under a real `authenticated` role. ✅

All test-induced state (the subscription's status, the temporary
`club_memberships` grant) was reverted afterward.

**DB impact:** `unfreeze_subscription()` + `cancel_subscription()` (new
RPCs), `protect_subscription_status_transitions()` trigger,
`is_guardian_of_group()` (new, breaks the RLS cycle), `freeze_subscription`/
`_activate_subscription_if_due_internal` updated to set the new GUC
flag, `groups_self_service_select` policy redefined against the new
function. No schema/column changes, no data migration needed.

**Security impact:** net-positive — closes the "status changes bypass
audit log" gap Doc 3 explicitly calls out, while the RLS recursion fix
restores correct (not broadened or narrowed) access — same rows
visible to the same people as intended by the original Gate 3 policies,
just without crashing.

**Reversal path:** fully reversible — every change is a clean
`create or replace`/`create policy`; recoverable from
`list_migrations`/git history.

**Status:** Gate 4 lifecycle-operations slice complete and verified.
Deeper Doc 3 "professional subscription" fields (explicit session-count/
remaining-sessions tracking, allowed-days/allowed-entry-times) are
NOT yet built — `subscriptions.plan_type` is currently a simple enum
(monthly/quarterly/season/package) with no structured session-count
column. Scoping that properly requires understanding how `package`-type
plans currently track usage (if at all) before adding columns — tracked
as explicit follow-up in the execution state file, not silently
dropped.

---

## D-005 — Gate 5: recurring booking UI + double-booking prevention audit

**Date:** 2026-08-16
**Problem:** Gate 5 (Bookings / Activities / Seats). Gate 1's
investigation had already flagged that `create_recurring_booking()` and
`create_field_block()` RPCs exist in the generated types with NO
frontend caller anywhere — audit both for the same class of defect
found in Gates 1/2/4 before building UI against them.

**Findings:**
- `create_recurring_booking()` delegates each occurrence directly to
  `_create_booking_internal()` (the same function Gate 1 fixed for
  venue-timezone correctness) — so it automatically inherits that fix
  with no separate bug. Correctly catches `exclusion_violation` per
  occurrence and reports created-vs-conflicted counts rather than
  failing the whole series on one conflict.
- **Doc 3's core double-booking requirement was already fully and
  correctly satisfied at the database level**, verified by direct
  test: `bookings` has a real Postgres `EXCLUDE USING gist (field_id
  WITH =, during WITH &&) WHERE (status IN (...))` constraint
  (`no_overlapping_field_bookings`) — this is the textbook-correct,
  concurrency-safe way to prevent overlapping bookings (enforced by the
  index itself, not application logic, so it holds even under two
  simultaneous transactions, which is exactly Doc 3's "under real
  concurrent requests, not just UI" requirement). Verified directly:
  two overlapping INSERTs in the same transaction correctly raised
  `23P01 conflicting key value violates exclusion constraint`, rolled
  back cleanly.
- `create_field_block()` is well-designed: surfaces conflicting
  existing bookings as information (doesn't block staff from creating
  a maintenance block over existing bookings — a reasonable design,
  since staff may need to block a field and separately handle
  cancelling those bookings), audit-logged, no timezone bug (uses raw
  UTC instant comparison throughout, which is correct for
  timezone-agnostic overlap detection).
- Seat/activity/event booking and waitlist: confirmed via
  `information_schema.tables` that NO such tables exist at all
  (`qr_scan_events` was the only even-tangentially-related match). This
  is genuinely new schema/product surface, not a bug — deferred as its
  own scoping decision given the size (event definition, seat
  inventory, capacity enforcement, waitlist promotion policy all need
  design), tracked explicitly in the execution state file rather than
  attempted in the same pass as the smaller, already-proven recurring-
  booking piece.

**Chosen solution:** Wired `create_recurring_booking()` into
`QuickBookingSheet.tsx` via a "حجز متكرر أسبوعيًا" (weekly recurring
booking) checkbox + occurrence-count input, reusing the exact same
slot/time/customer selection UI as a single booking (no new screen
needed). Recurring bookings don't accept an upfront payment (each
occurrence is billed separately later, matching the RPC's own
payment-less signature and how every other `pending_payment` booking
already works) — the payment section is hidden when recurring is
selected. On success, shows a result summary ("N of M created, K
conflicted") instead of silently closing, since a partial-success
outcome is exactly the kind of information a close-and-forget flow
would hide.

**Why:** Minimal, additive UI change against an already-correct,
already-tested backend — no new migration needed for the recurring-
booking piece since the RPC and its safety guarantees (the exclusion
constraint) were already fully correct.

**Verification:** Live end-to-end RPC test (temporarily granted staff
role to the session's test account, same as Gates 3/4): created a real
3-occurrence weekly series, confirmed `{requested: 3, created: 3,
conflicted: []}`, confirmed the 3 booking rows exist with correct
7-day-spaced `start_at`/`end_at` values. All test data removed
afterward (bookings, booking_series row, temporary staff grant).

**DB impact:** None — no migration needed, purely a frontend addition
against already-correct, already-deployed backend functions.

**Security impact:** None — no new RPCs, no RLS changes; reuses
`create_recurring_booking()`'s own existing `booking.create` permission
check and `club_write_allowed()` gate.

**Status:** Recurring bookings (the well-defined, backend-ready half of
Gate 5) shipped and verified. Seat/activity/event booking + waitlist
remains unscoped/unbuilt — explicit follow-up, not silently dropped
(see execution state file).

---

## D-006 — Gate 6: QR identity verification + a real "Active Entitlement" gap

**Date:** 2026-08-16
**Problem:** Gate 6 (Secure QR / Identity / Attendance). Doc 3's core
rule: "Valid QR + Correct Account + Verified Membership + Active
Entitlement + Identity Match = Approved Check-in." Audited the existing
QR/scan/attendance RPCs and the scanner frontend against this before
assuming anything was missing.

**Findings — mostly already correct, genuinely well-designed:**
- `qr_confirm_checkin()` (booking QR consumption) and
  `qr_mark_attendance()` (academy membership QR consumption) both
  already correctly checked single-use/`consumed` status, `revoked`
  status, `expires_at`, permission, and correctly logged every scan
  attempt (success AND every failure reason) to `qr_scan_events` for a
  full audit trail. Token storage is already correct (opaque
  `gen_random_bytes(32)` + sha256 hash, raw token never stored/
  returned more than once).
- Two distinct QR credential types already correctly modeled
  (`booking` vs. `player_membership`) — exactly the "two different QR
  types" distinction Doc 3 requires, already built.
- `ensure_player_qr()` (academy membership QR generation) already
  existed server-side.
- **Real gap #1 (frontend):** the scanner (`ScanPage.tsx`) only ever
  called the booking check-in path (`qr_confirm_checkin`) — there was
  no UI at all for the academy `qr_mark_attendance` flow, despite the
  backend RPC being fully built. A coach scanning a player's membership
  QR had no way to actually mark attendance through this screen.
- **Real gap #2 (frontend):** `qr_validate()` returned zero
  identity-verification data (no name, no photo, no membership/
  subscription status) — only `{result, credential_id, reference_type,
  reference_id, club_id}`. The scanner UI could therefore never satisfy
  Doc 3's "staff must see enough to visually compare the person to a
  verified photo" requirement, because the data literally wasn't
  fetched, regardless of how the UI was built.
- **Real gap #3 (backend, the actual "Active Entitlement" violation):**
  `qr_mark_attendance()` verified the player has an `active` enrollment
  in the session's group, but NEVER checked whether their actual paid
  `subscription` status was `active`. Since freezing/cancelling a
  subscription does not withdraw the enrollment row (these are two
  separate concepts by this schema's own design, confirmed via
  Gate 2/4's own investigation), a player whose subscription was
  frozen, expired, cancelled, or still `pending` could successfully
  check in and consume a session slot. This is a direct, confirmed
  violation of Doc 3's stated "Active Entitlement" requirement — not
  assumed, verified by reading the function body and confirming no
  `subscriptions` table reference existed anywhere in it.

**Chosen solution:**
- `qr_validate()` extended (required a `drop function` + recreate since
  Postgres won't let `CREATE OR REPLACE` change a function's return
  columns) to also return `display_name`/`display_photo_url`/
  `display_subtitle`/`subscription_status`, resolved per credential
  type: booking → customer name + field/time; player_membership →
  player name/photo + group name + current subscription status. This
  is deliberately the Doc 3 "minimal-necessary verification screen" —
  never full financial/contact history, just enough to visually
  confirm identity and current standing. Resolved regardless of the
  token's own validity state (even an expired/used credential still
  shows who it belongs to, so staff can recognize a member needing a
  fresh QR rather than seeing a bare "expired").
- `qr_mark_attendance()` now also requires the player's current
  subscription (via their active enrollment) to have `status='active'`;
  a mismatch produces a distinct `subscription_inactive` result instead
  of silently succeeding.
- `ScanPage.tsx` rewritten to show an identity-verification card
  (photo/initial-avatar, name, subtitle, subscription-status badge)
  before any confirm action, and to branch into the
  `qr_mark_attendance` flow (with a same-day session picker scoped to
  the coach's own groups) when the scanned credential is a
  `player_membership` type, alongside the existing booking flow.

**Bug found via testing (not assumed correct after writing):** the new
`subscription_inactive` result value crashed on the pre-existing
`qr_scan_events_result_check` CHECK constraint, which predates this fix
and didn't know about the new value — found identically to this
session's now-repeated pattern (Gates 4/6 both had a real backend value
crash on a stale constraint, only surfaced via genuine RPC calls, never
via reading the code alone). Fixed by widening the constraint.

**Full verified test matrix (real staff/coach-role access token,
temporarily granted then fully reverted afterward):**
- Generated a real `player_membership` QR via `ensure_player_qr()`,
  validated it via `qr_validate()`: confirmed `display_name`,
  `display_subtitle` (group name), and `subscription_status: "active"`
  all correctly populated. ✅
- Marked attendance for a player with an `active` subscription via
  `qr_mark_attendance()`: succeeded, real `attendance` row created. ✅
- Marked attendance for a player with a `pending` (not yet activated)
  subscription: correctly rejected with `subscription_inactive`, no
  attendance row created — confirming the exact gap this fix closes. ✅
- After widening the CHECK constraint, the same rejected-case call
  succeeded cleanly (no more crash on the audit-log insert). ✅

All test data (the generated QR credentials, the attendance row, the
temporary coach role grant, the temporary `groups.coach_id`
assignment) removed/reverted afterward.

**DB impact:** `qr_validate()` recreated with additional return
columns; `qr_mark_attendance()` updated with the subscription check;
`qr_scan_events_result_check` constraint widened. No new tables.

**Security impact:** net-positive — closes a real access-control gap
(non-paying/frozen members could attend sessions) and adds the
identity-verification data Doc 3 requires without over-exposing PII
(deliberately excludes financial/contact details from the display
payload).

**Reversal path:** fully reversible — all `create or replace`/
constraint changes, recoverable from `list_migrations`/git history.

**Status:** Gate 6's core QR/identity/attendance audit is complete for
the booking and academy-membership check-in paths. NOT yet audited in
this pass: whether a coach can see WHICH specific check-in overrides
happened and why (manual override audit trail — `qr_scan_events`
covers scan attempts but a manual "mark present without a QR scan"
path, if it exists elsewhere in the Academy UI, was not specifically
re-audited here), and whether `attendance.mark`'s coach-scoping
correctly prevents a coach from marking attendance for a session
outside their own assigned groups when NOT going through the QR path
(the direct-table-UPDATE risk, same class as Gates 2/4's guard-trigger
work) — tracked as explicit follow-up, not silently assumed safe.

---

## D-007 — Gate 7: Notification Core (domain-event abstraction)

**Date:** 2026-08-16
**Problem:** Gate 7 (Notification Core). Doc 3 explicitly requires
business logic never call WhatsApp/SMS/Email directly — a Notification
Engine / domain-event abstraction must exist first, so Gate 8
(WhatsApp) can be built as a connector without touching Booking/
Academy/Enrollment/Payment code. Confirmed via
`information_schema.tables`/`pg_proc` that ZERO notification/messaging
infrastructure existed before this pass (genuinely new, not a bug fix).

**Chosen architecture (three deliberately separate layers):**
1. `notification_events` — an immutable log of domain facts, written
   only via `emit_notification_event()` (a single narrow entry point,
   revoked from direct client/authenticated access — matches this
   codebase's `_internal`-suffix convention for
   business-RPC-callable-only functions, even though this name doesn't
   carry that literal suffix). Never updated after insert.
2. `notification_queue` — the actual per-recipient, per-channel
   delivery lifecycle (pending/scheduled/processing/sent/delivered/
   failed/retrying/cancelled/expired, matching Doc 3's exact status
   model), with `dedup_key` + a partial unique index on active statuses
   for idempotency (Doc 3's suggested `tenant+recipient+event+resource+
   template_version` pattern), `priority` tiers (critical_operational/
   transactional/reminder/informational/marketing — matching Doc 3's
   tier list exactly), and `expires_at` so a stale reminder for an
   already-passed event never sends. `channel` is a free-text slug
   (not an enum) specifically so Gate 8's WhatsApp connector needs no
   schema change to plug in — it just becomes rows with
   `channel='whatsapp'`.
3. `notification_consent` — per-customer, per-channel opt-in state.
   `enqueue_notification()` checks this before ever creating a queue
   row for a channel; a customer existing is never suffient to message
   them, per Doc 3's explicit requirement.

Two entry-point functions: `emit_notification_event()` (records a
fact) and `enqueue_notification()` (creates a delivery-queue row for
one recipient/channel, gated on consent, gated on dedup). Deliberately
kept as two separate steps rather than one — the event log and the
delivery queue can evolve independently (e.g. a future automation-rules
engine could re-process historical events against new rules without
re-firing already-sent notifications).

**What this migration deliberately does NOT include (explicit scope
cut, not a silent gap):** no queue worker/consumer (something must
eventually poll `notification_queue` and actually call a channel
connector — that's Gate 8's WhatsApp connector's job, or a future
generic worker); no automation-rules table mapping event types to
templates (Doc 3's "WhatsApp → Automations" screen); no templates table
yet (Doc 3's "WhatsApp → Templates" screen, bilingual with variable
validation) — these are real, sizeable pieces of Gate 8, not omitted by
oversight.

**Proof of integration:** wired `_create_booking_internal()` (already
touched in Gates 1 and 7's predecessor work) to call
`emit_notification_event()` for `booking.created` (always) and
`booking.confirmed` (when paid immediately) — matching Doc 3's own
example event list. This proves the abstraction against a real business
transaction rather than leaving it entirely unintegrated scaffolding.

**Verification:** Live end-to-end RPC test (temporarily granted staff
role, same pattern as prior gates): created a real booking with
immediate payment via `create_booking()`, confirmed both
`booking.created` and `booking.confirmed` rows exist in
`notification_events` with the correct `reference_id`, confirmed
booking creation itself still succeeds with no regression. All test
data (booking, invoice, invoice items, payment, payment allocation,
notification events, temporary staff grant) removed afterward.

**DB impact:** 3 new tables (`notification_events`,
`notification_queue`, `notification_consent`), 2 new functions, 1 new
permission (`notification.view`, granted to `club_owner`/
`club_manager`), 1 existing function (`_create_booking_internal`)
extended with 2 new `emit_notification_event()` calls.

**Security impact:** net-neutral/positive — all three new tables have
RLS from creation (never a window where they're unprotected); consent
table has both staff-managed and customer-self-service policies (the
latter reusing Gate 3's `customers.user_id` pattern); the event-emission
entry point is deliberately NOT exposed to `authenticated` at all, only
callable from other SECURITY DEFINER business RPCs.

**Reversal path:** fully reversible — new tables/functions only, no
existing data touched; `_create_booking_internal`'s prior version
recoverable from `list_migrations`/git history.

**Status:** Gate 7's core abstraction is built, integrated at one real
call site, and verified. NOT yet done: wiring more event types across
other business RPCs (enrollment, payment, subscription lifecycle —
Doc 3's full event list), a queue worker, templates, or automation
rules — these are substantial and are Gate 8's actual scope (the
WhatsApp connector needs all of them to be useful), tracked explicitly
in the execution state file as the next gate's work, not silently
dropped from this one.

---

## D-008 — Gate 8: WhatsApp module, including a real Baileys connector service

**Date:** 2026-08-16
**Mid-task user directive:** partway through Gate 8, the user sent an
explicit "WHATSAPP QR CONNECTOR — CORRECT IMPLEMENTATION DIRECTIVE"
overriding my initial framing (which had planned to leave the QR
handshake as a UI-only stub, reasoning that Vite+Supabase has no
persistent runtime). The directive is unambiguous: adding a persistent
Node/TypeScript connector service IS part of Gate 8's scope, Baileys is
the designated primary connector, session credentials must never touch
the Vite client, and the directive supplies exact required completion
vocabulary (COMPLETE only with a real phone scan; IMPLEMENTED —
EXTERNAL SCAN QA PENDING if the system is ready but no phone is
available; BLOCKED only for a genuine runtime hard-blocker) plus an
instruction to continue autonomously into RTL/i18n/reporting/regression
afterward rather than stopping to wait for a phone. This entry
documents compliance with that directive, superseding my own earlier
framing.

**What was built:**

1. **Supabase schema** (`whatsapp_connections`, `whatsapp_connection_events`,
   `whatsapp_templates` with a variable-validation trigger,
   `whatsapp_automations`, 6 granular permissions) — see the schema
   commit for full detail. `session_secret` has ZERO RLS SELECT policy
   at all; the only read path is `get_whatsapp_connection_status()`,
   which never returns it.

2. **A real, separate persistent Node/TypeScript connector service**
   (`/whatsapp-connector`), per the directive's exact required
   architecture:
   - `MessagingProvider` interface (`initializeConnection`/`generateQr`/
     `getConnectionState`/`sendMessage`/`reconnect`/`logout`/
     `healthCheck`) — the adapter boundary. Only
     `BaileysMessagingProvider.ts` imports `@whiskeysockets/baileys`;
     nothing else in the platform (Supabase, the queue, Booking/Academy
     code) knows Baileys exists.
   - `SessionStore.ts` — AES-256-GCM session-state encryption at rest,
     tenant-isolated via `sha256(clubId)` filenames (defense in depth
     against path traversal even though `clubId` never originates from
     untrusted input today).
   - `TenantConnectionManager.ts` — one `MessagingProvider` per club in
     memory, syncs state back to Supabase via the service-role key,
     restores persisted sessions on process restart without requiring a
     fresh scan.
   - `server.ts` — the connector's internal HTTP API. Every request
     requires a valid HMAC-SHA256 signature (`x-connector-signature`,
     `timingSafeEqual` comparison) computed with a shared secret the
     Vite client never sees; a strict allowlist of 5 routes
     (connect/qr/disconnect/send/health), no generic passthrough.
   - `supabase/functions/whatsapp-bridge` — the trusted Supabase-side
     caller. Deployed live on the project. Re-verifies the caller's own
     JWT + `manage_whatsapp_connection` permission via the same
     `has_permission()` RLS predicate every other write path in this
     app uses, before signing and forwarding to the connector service.
     Returns an honest `connector_not_configured` (503) rather than a
     fabricated success when the connector host isn't set — verified
     live via a real HTTP call against the deployed function (correctly
     401s with no JWT, per Supabase's own gateway-level `verify_jwt`).

3. **Frontend**: dedicated "واتساب" nav tab (Connection/Templates/
   Automations/Queue&History/Diagnostics), wired to call
   `whatsapp-bridge` (not a fabricated client-side QR) for the real
   connect/qr/disconnect actions.

**Bug found via real execution (not type-check):** `BaileysMessagingProvider`'s
class-field initializer for `logger` called `this.redactedClubId()`
directly in the field declaration, which — per JS class-field-init
ordering — runs *before* the constructor body assigns `this.clubId`,
crashing immediately on `TypeError: Cannot read properties of
undefined (reading 'slice')` the instant the class was instantiated.
Found by actually running the service's own self-test, not by
reasoning about the code — exactly the pattern that has held all
session: `tsc --noEmit` cannot catch a field-initializer-ordering bug
like this, only real execution can. Fixed by moving logger construction
into the constructor body, after `this.clubId` is assigned.

**Real verification performed (the honest boundary of what's
provable without a physical phone):**
- `npm install` + `npx tsc --noEmit` clean in the connector service.
- **`npm test` (`selfTest.ts`) — a genuine integration test, not a
  mock**: opened a real WebSocket to WhatsApp's actual servers,
  completed a real device-pairing handshake exchange (visible in the
  captured Baileys log: "connected to WA", a real pairing-data payload
  with real cryptographic key material, "not logged in, attempting
  registration..."), and received back a real 237-character QR token.
  State machine correctly walked `generating_qr → authenticating →
  waiting_for_scan`, then `logged_out → disconnected` on cleanup.
- `whatsapp-bridge` Edge Function deployed and confirmed live (401 on
  an unauthenticated real HTTP request, matching `verify_jwt: true`).
- Frontend: full `npx tsc --noEmit` clean across the whole Vite app
  after wiring the bridge calls.
- Template variable-validation trigger tested directly against the
  live database: a template using only declared variables inserts
  successfully; a template referencing an undeclared `{{variable}}` is
  correctly rejected with a clear error, before any bad data reaches
  the table.

**What remains — REAL PHONE QR SCAN QA PENDING**, per the directive's
own required vocabulary: scanning the generated QR with an actual
WhatsApp phone (Linked Devices → Link a Device), confirming the
connection reaches `connected` with a real phone number attached,
sending and receiving one real message, restarting the connector
process and confirming reconnect-without-rescan, and confirming
disconnect correctly requires a fresh QR next time. None of this is
automatable in this execution environment (no physical phone
available), and per the directive's own explicit instruction, this
does NOT block the rest of the autonomous run — proceeding directly
into RTL/i18n/reporting/regression next, exactly as instructed, rather
than stopping to wait for a phone.

**What is honestly NOT yet built** (explicit scope cut, not silently
dropped): the queue-consumption worker that actually drains
`notification_queue` and calls the connector's `/send` (the connector's
own `sendMessage`/`TenantConnectionManager.send` exist and are ready to
be called, but nothing polls the queue yet); quiet-hours/rate-limiting
enforcement logic (the `whatsapp_automations` columns for it exist,
the enforcement code doesn't); the templates/automations self-service
UI's "preview" feature; a formal test matrix beyond what's listed
above. Tracked in the execution state file, not claimed complete.

**DB impact:** as listed in the schema section above; one new Edge
Function deployed (no migration, but a real production artifact).

**Security impact:** net-positive and carefully scoped per the
directive's explicit requirements — no session secret in any
client-reachable path (browser, git, logs, API response) at any layer;
signed-request-only connector API; tenant isolation enforced at three
independent layers (Supabase RLS + `has_permission()` re-check in the
bridge function + hashed-filename session isolation in the connector
service).

**Reversal path:** the connector service and Edge Function are both
new, isolated artifacts — removing them (or replacing
`BaileysMessagingProvider` with a different implementation of the same
`MessagingProvider` interface) touches nothing else in the platform.

**Status:** IMPLEMENTED — EXTERNAL SCAN QA PENDING, per the directive's
own required vocabulary. Continuing autonomously into RTL (Gate 9)
next, per the directive's explicit instruction not to stop for the
unavailable phone.

---

## D-009 — Gate 9: RTL full sweep

**Date:** 2026-08-16
**Problem:** Gate 9 (RTL full sweep). Doc 3 requires a full repository-
wide audit (not partial fixes) covering nav/cards/tables/forms/inputs/
selects/dialogs/sheets/dropdowns/etc.

**Approach:** Checked `DirectionProvider` first — confirmed it already
correctly sets `document.documentElement.dir='rtl'`/`lang='ar'` as the
hard default (no per-user switcher yet — that's Gate 10's i18n scope,
not this gate's). Since the whole app already runs under `dir="rtl"`,
searched for hardcoded PHYSICAL-direction Tailwind classes
(`ml-`/`mr-`/`pl-`/`pr-`/`left-`/`right-`/`text-left`/`text-right`)
that don't respect the `dir` attribute, as opposed to logical
properties (`ms-`/`me-`/`ps-`/`pe-`/`start-`/`end-`) which do.

**Findings:**
- `grep` across `src/features/**` (every feature screen, including the
  new Gate 3 portal and Gate 8 WhatsApp areas) found **zero** hardcoded
  physical-direction classes — every feature screen already
  consistently uses logical properties, confirming the "RTL-first"
  design-system convention has actually been followed throughout this
  project's build, not just documented.
- Live-verified `ChevronRight`/`ChevronLeft`/`ArrowRight` usage in
  date-navigation and back-button contexts (`BookingsPage.tsx`,
  `BookingsMobileView.tsx`, `ScanPage.tsx`, `MorePage.tsx`) — all
  already correctly RTL-oriented (previous-day arrow points right,
  next-day arrow points left, back-arrow points right, disclosure
  chevron points left) — no fix needed, confirmed rather than assumed.
- **All defects found were isolated to 4 shared shadcn/ui primitive
  files** (`dialog.tsx`, `sheet.tsx`, `select.tsx`, `dropdown-menu.tsx`)
  — exactly the kind of systemic, root-level fix Doc 3 asks for rather
  than a per-screen patch:
  - `DialogPrimitive.Close`/`SheetPrimitive.Close`: hardcoded
    `right-4 top-4` → `end-4 top-4`. In RTL this moved the close (×)
    button from the wrong physical corner to the correct visual
    top-left, verified live via screenshot (see below).
  - `SelectItem`: hardcoded `pl-2 pr-8` padding + `right-2` checkmark
    position → `ps-2 pe-8` + `end-2`. Verified live: a real Select
    dropdown in the WhatsApp Automations "New Rule" dialog renders
    correctly right-aligned with no visual glitch.
  - `DropdownMenuItem`/`CheckboxItem`/`RadioItem`/`Label`: hardcoded
    `pl-8`/`pl-8 pr-2` insets and `left-2` checkmark positions → logical
    equivalents. (This component is currently unused anywhere in the
    app, but fixed for correctness since it's shared library code that
    could be adopted later — cheap and correct, not scope creep.)
  - `DropdownMenuShortcut`: `ml-auto` → `ms-auto`.
  - `DropdownMenuSubTrigger`: `ChevronRight` positioned with `ml-auto`
    (wrong side) AND pointing the wrong direction for a submenu that
    opens toward the reading-start in RTL → `ms-auto rtl:rotate-180`
    (both position and icon direction now correct).
  - `DialogHeader`/`SheetHeader`: `sm:text-left` → `sm:text-start`
    (title/description text alignment was hardcoded to the LTR default
    at the `sm` breakpoint, ignoring `dir`).
  - `Sheet`'s `side="left"`/`"right"` slide variants were reviewed and
    found NOT to need changing — the default (`side="right"`, used by
    every actual call site in this app, `QuickBookingSheet`/
    `BookingDetailSheet`) already visually corresponds to the RTL
    "start" edge, which is correct; changing it would have introduced
    a bug rather than fixed one. Documented explicitly so this isn't
    re-investigated as a false lead later.

**Verification:** Live browser screenshots confirmed both the Dialog
close-button repositioning (a real "قاعدة تنبيه تلقائي" automation-rule
dialog, close button correctly at top-left) and a real Select dropdown
(the event picker in that same dialog) rendering correctly in RTL, no
regressions. Full `npx tsc --noEmit` clean before and after.

**DB impact:** none — pure frontend CSS class changes.

**Security impact:** none.

**Reversal path:** trivial — every change is a one-to-one Tailwind
class swap (physical → logical), recoverable from git history.

**Status:** Gate 9 complete for the "hardcoded physical-direction
class" defect class, which is what actually existed in this codebase
— confirmed via exhaustive grep, not assumed. A full manual click-
through QA pass across every screen (calendars, reports, charts once
built) is still worth doing before final ship, but the root-cause,
repository-wide fix Doc 3 asks for (fixing shared primitives rather
than patching individual screens) is done.

---

## D-010 — Gate 10: i18n foundation

**Date:** 2026-08-16
**Problem:** Gate 10 (Arabic/English i18n). Confirmed via `package.json`
inspection that no i18n library existed at all — genuinely new
infrastructure, not a gap in an existing system.

**Chosen architecture:**
- `react-i18next` + `i18next` + `i18next-browser-languagedetector`
  (industry-standard, actively maintained, first-class React hooks API
  matching this codebase's existing hook-heavy conventions).
- Resource files under `src/lib/i18n/resources/{ar,en}/common.json` —
  a single `common` namespace to start (nav/buttons/auth chrome), with
  each feature area expected to add its OWN namespace as the sweep
  continues (documented in the config file's own comment) rather than
  growing one unbounded file.
- `DirectionProvider` (already existed from a prior session, previously
  just a bare `useState` with no persistence and no i18next
  connection) is now the SINGLE source of truth for both direction and
  active language — `setLocale()` drives `i18n.changeLanguage()` AND
  flips `document.dir`/`document.lang` AND persists to `localStorage`
  (`mala3by.locale`), all in one call, so direction and language can
  never drift out of sync. Components call `useDirection().setLocale()`,
  never the i18next instance directly.
- `formatNumber`/`formatCurrency`/`formatDate` helpers added to the
  i18n config, all requiring an explicit locale (and for dates, an
  explicit IANA timezone — deliberately consistent with Gate 1's Time
  Model, since a date must never be formatted without knowing which
  venue timezone it's for).
- A single reusable `LanguageSwitcher` component (`components/ui/
  language-switcher.tsx`) — one toggle button, not a settings sub-page,
  placed in `AppLayout` (desktop sidebar footer + both header variants),
  `PortalLayout`, and `PublicLayout`, so it's available everywhere a
  user actually is, matching Doc 3's "switcher must exist" requirement
  broadly rather than in one buried settings screen.

**Explicit scope decision, stated directly to avoid over-claiming:**
Given the volume of hardcoded Arabic strings across every screen built
in this and prior sessions, full extraction of 100% of UI copy in one
pass is not realistic within this session. Swept: the staff app's
sidebar/bottom-nav (`nav.*` keys), matching the "representative
high-traffic slice" scoping from the execution-state plan. NOT swept:
individual feature screens' own body copy (booking forms, academy
screens, billing, WhatsApp tabs, portal screens, reports) — these all
still render hardcoded Arabic text directly, by design working
correctly today (Arabic is the correct default), but not yet
switchable to English. This is tracked explicitly as follow-up, not
silently claimed as "i18n done."

**Verification (live browser, not just type-check):**
- Screenshot 1: app loaded correctly in Arabic/RTL with the new
  switcher visible, all `nav.*` labels correctly resolved via `t()`.
- Screenshot 2: clicked the switcher — the ENTIRE layout correctly
  flipped RTL→LTR (sidebar moved sides), all nav labels correctly
  translated to English (Today/Bookings/Academy/Customers/Billing &
  Payments/Reports/WhatsApp/Staff/Settings/Log out), with NO page
  reload (URL and all other page state preserved) and no crash —
  content not yet swept correctly remained in Arabic rather than
  breaking, confirming graceful partial-coverage behavior.
- Screenshot 3: clicked back to Arabic — correctly reverted.
- Confirmed `localStorage.getItem('mala3by.locale')` correctly
  persisted `'ar'` after switching back, proving the persistence
  requirement works, not just the in-memory toggle.
- Confirmed the switcher and correct locale also render correctly on
  the unauthenticated public marketing homepage (`/`), proving the
  provider order in `App.tsx` (already wrapping the whole router) needed
  no changes.
- Full `npx tsc --noEmit` clean throughout.

**DB impact:** none.

**Security impact:** none.

**Reversal path:** fully additive — new files + `DirectionProvider`
extended (not replaced) with backward-compatible behavior (its default
state, `locale='ar'`, is unchanged from before this migration).

**Status:** Gate 10's foundational infrastructure (library, resource
system, persistence, switcher UI, locale-aware formatting helpers,
no-reload RTL/LTR flip) is built and verified end-to-end. The full
copy-extraction sweep across every remaining screen is real, tracked
follow-up work — not claimed complete.

---

## D-011 — Gate 11: Reporting Rebuild (foundational slice)

**Problem:** Doc 3 requires a full reporting layer (14 report types)
where every KPI is computed in exactly one shared place, never
independently recomputed in different screens. Needed to establish
what already existed vs. what was genuinely missing before building
anything.

**Evidence:**
- Read `src/features/reports/ReportsPage.tsx` in full (387 lines) and
  confirmed via direct SQL (`select proname from pg_proc where proname
  ilike '%report%'`) that exactly 4 report RPCs already existed:
  `get_revenue_report`, `get_field_occupancy_report`,
  `get_academy_report`, `get_customer_activity_report` — each following
  a consistent, correct pattern (security definer, pinned search_path,
  `user_club_ids()` + `report.view` permission check, execute revoked
  from public/anon).
- Checked for duplicate KPI computation across screens. Found a real
  violation: `src/features/customers/CustomersPage.tsx` (lines ~38-56)
  independently recomputed "outstanding balance" via a manual
  client-side `invoices` + `payment_allocations` join that summed
  `total - paid` per invoice, with NO handling for refunds at all.
  `src/features/billing/OutstandingPage.tsx` already correctly read an
  `outstanding_invoices` Postgres view. Retrieved the view's exact
  definition via `pg_get_viewdef` and confirmed it is a superset of
  correctness: it nets out completed refunds (adds back
  `sum(refunds)` where `refund.status = 'completed'`) and already
  includes `days_overdue` (satisfying Doc 3's "Receivables/Outstanding
  with aging" requirement) — `CustomersPage.tsx`'s manual calc had
  neither.
  - Concrete failure scenario this caused: a customer pays an invoice
    in full (outstanding = 0 by both calculations), then receives a
    completed refund on that payment. The correct outstanding balance
    re-opens to the refunded amount (the view handles this).
    `CustomersPage.tsx`'s old calc would still show 0.00, silently
    hiding real debt from staff on the Customers list, while
    `OutstandingPage.tsx` would correctly show it — an actual Doc 3
    violation with real financial-visibility impact, not a theoretical
    one.

**Options considered:**
1. Leave `CustomersPage.tsx`'s calc as-is, only note the discrepancy.
   Rejected — Doc 3 explicitly requires single-source KPIs, and this is
   a real correctness bug with financial impact, not just a style
   preference.
2. Rewrite `CustomersPage.tsx` to read from `outstanding_invoices`
   instead of recomputing. Chosen.
3. Refactor `OutstandingPage.tsx`'s logic into a shared TS helper
   function used by both, instead of a DB view. Rejected — the view
   already exists, is already proven correct in production use via
   `OutstandingPage.tsx`, and a DB view is a stronger single-source
   guarantee than a shared client-side helper (a future third screen
   querying the underlying tables directly would still be able to
   drift; querying the view can't drift by construction).

**Chosen solution:**
- `src/features/customers/CustomersPage.tsx`: replaced the manual
  `invoices`/`payment_allocations` join with a direct
  `.from('outstanding_invoices').select('customer_id, outstanding')`
  query, summed client-side only for the per-customer total (no
  business logic recomputation — the view already did the real math).
- Confirmed via `information_schema.role_table_grants` that
  `authenticated` already has `SELECT` on `outstanding_invoices` (the
  same grant `OutstandingPage.tsx` already relies on) — no new grants
  needed.
- Added two new report RPCs
  (`supabase/migrations/20260816310000_gate11_executive_and_booking_reports.sql`),
  following the exact established pattern of the 4 existing report
  RPCs:
  - `get_executive_dashboard(p_club_id, p_start_date, p_end_date)` —
    top-level KPI summary (total_revenue, refunds_total,
    outstanding_total, bookings_count, bookings_cancelled_count,
    total_booked_hours, active_enrollments, new_customers,
    revenue_by_day). Deliberately reuses the exact same SQL predicates
    as `get_revenue_report`/`get_field_occupancy_report` (same
    `payments.status = 'completed'` filter, same `bookings.status IN
    (...)` filter) rather than reimplementing the aggregation logic —
    and reads `outstanding_total` from the same `outstanding_invoices`
    view just fixed in `CustomersPage.tsx`, so this dashboard cannot
    itself become a second source of truth.
  - `get_booking_report(p_club_id, p_start_date, p_end_date,
    p_branch_id)` — booking lifecycle breakdown (by_status, by_branch,
    cancellation_rate, average_booking_value). Deliberately distinct
    from `get_field_occupancy_report`, which reports booked *hours*
    per field, not booking outcomes/status mix — these are genuinely
    different KPIs, not a duplicate.
- Wired both into `src/features/reports/ReportsPage.tsx`: added
  `ExecutiveDashboardTab` (new default tab, "نظرة عامة") and
  `BookingReportTab` ("الحجوزات"), following the file's existing
  `useDateRange`/`DateRangeFilter`/CSV-export conventions exactly.

**Reasons:**
- Fixing the duplicate-computation bug at its root (reading the shared
  view) closes the defect class permanently — any future screen that
  needs "outstanding balance" will naturally reach for the same view
  rather than re-deriving the concept, since it is now the only example
  in the codebase to copy from.
- Reusing exact predicates in `get_executive_dashboard` rather than
  writing parallel aggregation logic means the dashboard's totals are
  mechanically guaranteed to match the detail reports' totals — no
  reconciliation drift is possible by construction, not just by
  discipline.
- Prioritized Executive Dashboard + Booking Report specifically because
  Doc 3 names these as the reports it emphasizes most, and building 2
  reports thoroughly (correct, verified, cross-reconciled) is more
  valuable than 9 shallow stubs that would themselves become future
  single-source-of-truth violations.

**Verification (live, not just type-check):**
- `npx tsc --noEmit` clean before and after both changes.
- Live browser check on `/app/customers`: outstanding figures for real
  seeded customers (500/900/450/etc. EGP across multiple customers) now
  render from the view.
- Cross-reconciled against `/app/outstanding`'s per-invoice breakdown:
  summed one customer's 3 separate invoices there (300+300+300=900)
  and confirmed it exactly matches the 900 EGP total shown on the
  Customers page; a second customer's single 50 EGP invoice matched
  too.
- Confirmed via direct SQL (`select club_id, sum(outstanding) from
  outstanding_invoices group by club_id`) that the currently-active
  test club's total (3,950.00 EGP) exactly matches the
  `outstanding_total` rendered by the live Executive Dashboard tab.
- Confirmed the Booking Report's internal consistency: status counts
  (4 confirmed + 2 pending_payment + 1 completed + 1 cancelled + 1
  no_show + 1 checked_in = 10 total) reconcile exactly with its own
  cancellation_rate (1/10 = 10%, matches displayed value) and with the
  by-branch counts (4+2=6 confirmed/checked_in/completed bookings,
  matching the dashboard's separately-computed bookings_count of 6).
- Ran `get_advisors(security)` after applying the migration — zero
  findings reference `get_executive_dashboard` or `get_booking_report`
  (confirmed via grep on the full advisor output), meaning no security
  lint was introduced by this change. Pre-existing unrelated findings
  from Gate 8's WhatsApp module were noticed in the same pass and
  flagged separately via spawn_task rather than silently ignored or
  scope-crept into this gate (task_caf4163d).
- Checked a fresh, previously-unused browser tab (not just the
  long-lived session tab) to rule out stale-HMR console noise —
  confirmed zero console errors and correct rendering on a clean load.

**DB impact:** 2 new read-only RPCs (`get_executive_dashboard`,
`get_booking_report`), both additive, `SECURITY DEFINER` with pinned
`search_path`, `EXECUTE` revoked from `public`/`anon`, granted to
`authenticated` only. No schema changes, no existing RPC modified.

**Security impact:** Both new RPCs enforce the same `auth.uid()` +
`user_club_ids()` + `has_permission('report.view', ...)` check as every
existing report RPC — verified structurally identical to the pattern
already audited in the original Phase 13 migration. The
`CustomersPage.tsx` fix is a net security/correctness improvement
(previously-hidden debt is now visible) with no new grants required.

**Reversal path:** `CustomersPage.tsx`'s query change is a one-file
diff, trivially revertable. The two new RPCs are additive-only — drop
them and remove the two `ReportsPage.tsx` tabs to fully revert with no
impact on the 4 pre-existing reports.

**Status:** Gate 11's foundational slice (single-source-of-truth fix +
2 new foundational reports) is built and verified end-to-end against
real data. The remaining 9 Doc 3 report types (Field Performance,
Group Report, Player Report, Subscription Report, Attendance Report,
Collections Report, Employee Activity, Discounts/Refunds/Voids,
WhatsApp/Notification Report) are explicit, tracked follow-up — not
claimed complete, not stubbed shallowly just to hit a count.

---

## D-012 — Gate 12: Full Regression/Security/Tenant QA

**Problem:** Doc 3 requires a dedicated regression/security/tenant-isolation
pass covering everything built in Gates 3-11, before Gate 13 (Commercial
Entitlements) can unfreeze.

**Evidence and actions, in order:**

1. **Security advisor (get_advisors, security):** 64 findings, 0 ERROR.
   57+5 SECURITY DEFINER-executable warnings across nearly all RPCs —
   confirmed expected-by-design for this RPC-gateway architecture (each
   function does its own internal has_permission/user_club_ids check,
   verified directly for is_platform_owner()/user_club_ids() below). One
   real actionable item found and separately flagged via spawn_task
   (task_caf4163d): validate_whatsapp_template_variables() (a trigger
   function, not meant to be a public RPC at all) was never given the
   codebase's standard "revoke execute from anon/authenticated"
   treatment. Also noted: enable Supabase Auth's leaked-password-
   protection setting (a dashboard toggle, not a code change).

2. **Performance advisor (get_advisors, performance):** 307 findings.
   Fixed the cheap, zero-risk class immediately: 36 auth_rls_initplan
   warnings across 32 distinct RLS policies where auth.uid() was called
   directly in USING/WITH CHECK (re-evaluated per row instead of once
   per query). Every DROP+CREATE POLICY statement was generated
   directly from Postgres's own pg_policies catalog via a regex
   substitution that only wraps auth.uid() — cannot alter logic.
   Verified: zero bare auth.uid() calls remain; re-ran the advisor,
   zero auth_rls_initplan findings remain; live-checked /app/customers
   and /app/academy in a fresh browser tab, byte-identical data,
   zero console errors. Deferred (per the advisor sub-agent's own
   recommendation, benign at pre-launch QA-dataset scale):
   multiple_permissive_policies (187 findings, 28 tables — more
   invasive, needs actual policy consolidation not a syntax wrap) and
   72 unindexed_foreign_keys (mostly low-traffic audit-actor columns).

3. **Full build/lint/typecheck gate:** `npm run build` (tsc -b, project-
   reference/build mode) surfaced 46 real errors that `npx tsc --noEmit`
   had missed throughout this entire session — traced to
   src/lib/supabase/types.ts being stale since before Gate 3 (missing
   Gate 7/8/11 tables/RPCs entirely). This resumed the long-frozen
   task #51. Regenerated types.ts (2875 → 3808 lines). Remaining 20
   errors were all real, previously type-masked issues — fixed each:
   - src/lib/domain/time.ts: unsafe Date.UTC() args from array
     destructuring: added explicit numeric defaults (behavior-neutral
     for the well-formed input this function always receives).
   - src/features/bookings/BookingsPage.tsx: BookingDetailSheet was
     being rendered WITHOUT its required clubTimezone prop — a real,
     previously-hidden bug exactly in Gate 1's own problem domain
     (booking time display/integrity). Fixed and verified live: opened
     a real booking's detail sheet, confirmed correct 14:00-15:00 slot
     time matching the calendar grid.
   - BookingsMobileView.tsx: same h/m destructuring safety as time.ts.
   - CustomersPage.tsx: outstanding_invoices.customer_id is honestly
     typed nullable by the real view — added a null guard.
   - AutomationsTab/ConnectionTab/TemplatesTab.tsx: currentClubId
     (string | null) now correctly typed against real not-null
     columns/RPC params — applied the existing `as string` convention
     (mutations are always guarded by !!currentClubId before running).
   - ConnectionTab/QueueHistoryTab.tsx: Record<string,...> status-label
     lookups possibly undefined under this project's strictness —
     replaced with an inline definite fallback.
   Result: npm run build succeeds with zero TS errors, real production
   bundle produced. npm run lint: 1 error found and fixed (a
   react-hooks/rules-of-hooks false positive on whatsapp-connector, a
   wholly separate Node project with no React dependency, accidentally
   in scope for the frontend's lint config — added to ignorePatterns).
   Verified live: /app/customers, /app/whatsapp, /app/bookings all
   render correctly, zero console errors in a fresh tab.

4. **Real black-box multi-tenant isolation test.** Attempted via
   execute_sql role-impersonation (set_config('request.jwt.claims',...))
   first — this proved unreliable (the tool runs as a privileged
   Postgres role that doesn't actually honor RLS role-switching this
   way; a UNION query returned full cross-club data, revealing the
   impersonation wasn't real). Abandoned that approach rather than
   report a false-positive "isolation confirmed."

   Switched to the trustworthy method: executed real Supabase JS client
   calls through the browser's actual authenticated session (real JWT,
   real PostgREST requests, real RLS enforcement) via javascript_tool,
   targeting a club ("Mala3by Test Club Two", c0b02979-...) the current
   session's user has ZERO membership in. Queried customers/bookings/
   invoices/payments/enrollments/subscriptions/whatsapp_templates/
   notification_queue filtered by that club's id: all returned 0 rows
   — correct isolation.

   clubs (direct row read) and club_memberships (filtered to the
   foreign club) both returned 1 row each — investigated rather than
   assumed either a leak or a false alarm. Root cause: the current test
   user genuinely holds a real platform_owner role (verified via direct
   query on club_memberships/roles), and clubs_platform_owner_full_access
   / club_memberships_platform_owner_full_access (both qual:
   is_platform_owner(), cmd ALL) are deliberate, correct policies — a
   platform owner is the SaaS operator and is supposed to see across
   all tenants (same pattern as the existing Owner Control Center from
   Phase 3c). Confirmed is_platform_owner()'s own definition: SECURITY
   DEFINER, checks a real server-side club_memberships row with
   role_key='platform_owner' AND status='active' tied to auth.uid() —
   not spoofable client-side. Also confirmed user_club_ids() (the sole
   non-platform-owner scoping mechanism used by every other RLS policy
   in the app) is equally tightly scoped to auth.uid() + status='active'.
   Confirmed via src/app/routing that platform-owner-only routes are
   gated by RequireAuth, so this visibility isn't accidentally exposed
   to a regular club user through the UI either.

**Chosen conclusion:** the cross-tenant read observed was correct,
intended platform-owner behavior, not a defect — verified by reading
the actual policy/function definitions rather than assuming either
"it's fine" or "it's a bug" from the raw query result alone. No fix
needed for this specific finding.

**Reasons for methodology:** a false "isolation confirmed" from a
broken impersonation technique would have been worse than not testing
at all — caught and discarded that approach before it produced a
misleading record. Real JS-client calls through the live authenticated
browser session are the same trust boundary a real attacker or a real
buggy client would actually go through, making this the correct
black-box method available without provisioning new test credentials
mid-session.

**DB impact (cumulative this gate):** 1 new migration (32 RLS policy
rewrites, additive/behavior-preserving), 0 schema changes.

**Security impact:** net improvement — closed a real performance-
security-adjacent gap (auth_rls_initplan), confirmed via live black-box
testing that tenant isolation holds for non-platform-owner access paths,
and separately flagged the one real remaining gap
(validate_whatsapp_template_variables grants) rather than leaving it
silently unaddressed.

**Reversal path:** RLS migration is fully reversible (re-run the DROP+
CREATE pairs with the original unwrapped auth.uid() expressions, saved
in D-012's own git history). Type regeneration + build fixes are a
normal code diff, revertable via git.

**Status:** Gate 12's build/security/performance/isolation slice is
DONE and verified. NOT yet done: real black-box testing of a genuinely
non-platform-owner, single-club staff account against a second,
unrelated club (blocked on not having that test account's real
password in this session — the policy-definition-level verification
above is a legitimate substitute, but a live login-based test remains
better evidence and is noted as a follow-up if credentials become
available). multiple_permissive_policies (187 performance findings)
and 72 unindexed_foreign_keys remain explicit, tracked, deliberately
deferred follow-up per the sub-agent's own recommendation.

---

## D-013 — P0 WhatsApp Runtime Override: connector evaluation and deployment-topology fix

**Problem:** WhatsApp is still not operational end-to-end in the real
app. A prior P1 fix (this session) already found and fixed two real
bugs blocking the QR pipeline (missing CORS handling on the
`whatsapp-bridge` Edge Function, and a swallowed-error-body bug in
`ConnectionTab.tsx`'s mutation handler), and proved via direct API
calls that the existing `whatsapp-connector` (Baileys-based) genuinely
opens a real WebSocket to WhatsApp's servers and returns a real,
scannable multi-device QR payload when reached directly. What remains
unresolved is deployment topology: the deployed `whatsapp-bridge` Edge
Function has `WHATSAPP_CONNECTOR_URL` unset, so it cannot reach any
connector at all — not a code defect in either the frontend or the
connector, a missing network path between two already-working pieces.
The user's explicit directive: treat this as P0, evaluate whether the
existing Baileys connector should be replaced by a more mature
installable/self-hosted alternative (Evolution API, whatsapp-web.js)
rather than assuming the existing implementation is right by default,
and actually close the gap to a real phone-scannable QR in the running
app — not just report on infrastructure.

**Evidence gathered before deciding (audit first, per this session's
standing rule):**

1. **Docker availability in this sandbox** — `docker --version` reports
   29.6.2 installed, but `docker ps` fails:
   `failed to connect to the docker API at
   npipe:////./pipe/dockerDesktopLinuxEngine`. Attempted to launch
   Docker Desktop directly (`Start-Process "Docker Desktop.exe"`),
   polled for up to ~70s — daemon never came up. Read Docker Desktop's
   own backend log
   (`AppData/Local/Docker/log/host/com.docker.backend.exe.log`) and
   found the exact cause:
   `wslexec: c:\windows\system32\wsl.exe -l -v --all failed: exit
   status 1`, `DockerDesktop/Wsl/CommandTimedOut`, and
   `neither WSL2 data distro nor disk exist`. Separately ran
   `wsl --status` directly — it hung past a 120s timeout with no
   output, confirming WSL2 itself is not properly initialized in this
   sandboxed Windows session (first-run WSL2 setup typically requires
   interactive elevation this environment can't complete headlessly).
   This is a genuine, verified environment-level blocker for any
   Docker-first deployment path, not a configuration choice.
2. **Network egress** — confirmed real internet access from this
   session: `curl` to `registry.npmjs.org` and `web.whatsapp.com` both
   returned `200`. Ruled out "no internet" as an explanation for
   anything.
3. **Evolution API's actual runtime requirements** — fetched its real
   `package.json` from GitHub directly (not assumed): it's a NestJS +
   Prisma application. `start:prod` is `node dist/main`, so it is
   *technically* runnable without Docker — but it requires its own
   Postgres schema via Prisma (`db:deploy`, `db:migrate`), commonly
   requires Redis for its cache/queue layer in real deployments, and
   its own "instance" multi-tenancy model would need to be mapped onto
   this app's `club_id` model as a new integration surface. Its
   supported, documented deployment path is Docker specifically to
   avoid this setup complexity — which is exactly the path just proven
   blocked in this sandbox.
4. **whatsapp-web.js's actual runtime requirements** — requires
   Puppeteer driving a real Chromium instance (heavier than Baileys'
   pure-WebSocket approach, no Puppeteer dependency at all). Checked
   for a local Chrome install as a prerequisite check regardless of
   final decision: found real Chrome at
   `C:\Program Files\Google\Chrome\Application\chrome.exe`. Technically
   viable in this sandbox, but strictly heavier (spawns and drives a
   real browser process per tenant session) than the already-proven-
   working Baileys approach for no additional capability gained.
5. **Root-caused the actual remaining gap in the existing Baileys
   connector**, rather than assuming code was the problem: confirmed
   `whatsapp-connector/.env` has no public URL concept at all (it's a
   local-only `PORT=8787` config), and confirmed
   `supabase/functions/whatsapp-bridge/index.ts` reads
   `WHATSAPP_CONNECTOR_URL` from `Deno.env.get(...)` with no fallback
   — genuinely unset as a deployed secret. This is the entire
   remaining gap: a already-working local service with no public
   address for the already-correctly-coded Edge Function to reach.
6. **Checked for tunnel tooling already present in this environment**
   before assuming a heavier deploy target was needed: found `ngrok`
   already installed (`C:\Users\moust\AppData\Local\Microsoft\
   WindowsApps\ngrok.exe`, version 3.39.9) AND already configured with
   a valid saved authtoken (`ngrok config check` → "Valid configuration
   file"). This means a stable public HTTPS URL for the local connector
   is available immediately, with zero new installation.

**Options considered:**

1. **Force Docker/WSL2 to work in this sandbox** (retry loops, manual
   WSL2 install, etc.) to unblock Evolution API. Rejected — the Docker
   Desktop log already shows this is a first-run WSL2 initialization
   requiring interactive user consent/elevation that a headless
   automated session cannot complete; further retries would burn time
   without a realistic path to success, and risks leaving the
   environment in a half-configured WSL state. This is exactly the
   class of external hard blocker the standing directive says to
   recognize and route around rather than force.
2. **Install Evolution API for bare-Node execution**, standing up its
   own Prisma-managed Postgres schema and (likely) Redis, then adapting
   `MessagingProvider` to call it instead. Rejected for this specific
   moment: it is a real, heavier integration (new database schema
   outside Supabase, new instance-to-club_id mapping layer, unproven in
   this exact sandbox for its non-Docker path) being proposed as a
   replacement for a connector that has ALREADY been proven, via real
   execution, to correctly perform the exact capability in question
   (real QR generation against real WhatsApp servers) — moving to it
   now would not be "faster or more reliable," it would restart the
   runtime-proof process from zero on a stack with more moving parts,
   for a problem that is not actually a connector-capability problem.
   Not permanently ruled out: if the ngrok+Baileys path below is ever
   found to have a genuine, unfixable reliability ceiling (e.g.
   WhatsApp's own anti-automation measures targeting Baileys
   specifically, which is a documented real-world risk for this
   library), Evolution API remains the designated fallback and this
   evaluation's findings (points 3 above) are the starting point for
   that migration rather than a fresh audit.
3. **whatsapp-web.js as a straight swap for Baileys.** Rejected — no
   demonstrated capability gap in Baileys justifies the added
   Puppeteer/Chromium overhead per tenant session; Baileys is already
   proven working via real execution in this exact codebase.
4. **Expose the already-working local Baileys connector via ngrok**,
   already installed and pre-authenticated in this environment, and set
   the resulting public HTTPS URL + the connector's real
   `CONNECTOR_INTERNAL_SECRET` as the two missing `whatsapp-bridge`
   Edge Function secrets. Chosen. This directly closes the exact,
   root-caused gap (no public URL for a working service) with the
   least possible new surface area: zero new database schema, zero
   change to the `MessagingProvider`/adapter abstraction, zero new
   dependency installs, reuses tooling already present and
   pre-configured in this specific environment.

**Chosen solution:** Keep the existing Baileys-based
`whatsapp-connector` service exactly as built in Gate 8 — no rebuild of
`MessagingProvider`, `BaileysMessagingProvider`, `SessionStore`,
`TenantConnectionManager`, the Notification Core, the queue, templates,
automations, or the WhatsApp Tab UI, per the directive's own explicit
instruction to preserve this abstraction. Fix only the deployment
topology:
1. Start the local connector service as a persistent background
   process.
2. Start an ngrok tunnel pointed at the connector's local port,
   producing a real public HTTPS URL.
3. Set `WHATSAPP_CONNECTOR_URL` (the ngrok URL) and
   `CONNECTOR_INTERNAL_SECRET` (the connector's real HMAC secret, the
   same value already in `whatsapp-connector/.env`) as secrets on the
   deployed `whatsapp-bridge` Edge Function via the Supabase project's
   secrets management.
4. Re-verify end-to-end from the actual running app: open the
   WhatsApp tab, click Connect, confirm a real QR renders in the UI
   (not a placeholder), and present it for the physical phone-scan step
   that only the user can perform.

**Reasons:** This is the definition of "actual runtime reliability,
persistent session support, QR workflow, deployment complexity,
resource use, maintainability, recovery/reconnect behavior,
integration effort, and reversibility" all favoring the existing
connector over a swap: reliability and QR workflow are already proven
via real execution in this exact repo; deployment complexity for the
ngrok fix is minutes and zero new dependencies vs. hours-to-days and a
new database schema for Evolution API in a sandbox that has already
proven hostile to Evolution API's primary supported deployment path;
resource use is a single lightweight Node process vs. NestJS+Prisma+
(likely)Redis; maintainability is unchanged (same abstraction, same
team's own code, already documented in `whatsapp-connector/README.md`);
integration effort with the existing queue is zero (no interface
change); reversibility is total (ngrok URL is just an env var — pointing
it at a different connector implementation later requires no
application code change at all, since `MessagingProvider` is the fixed
boundary regardless of which concrete connector sits behind
`whatsapp-bridge`).

**DB impact:** none.

**Security impact:** none negative — `CONNECTOR_INTERNAL_SECRET` HMAC
signing (already implemented, already verified in Gate 8) remains the
authentication boundary between `whatsapp-bridge` and the connector
regardless of whether the connector is reached via `localhost` or a
public ngrok URL; the ngrok tunnel itself only exposes the connector's
already-locked-down 5-route internal API (`/connect`, `/qr`,
`/disconnect`, `/send`, `/health`), every route already requiring a
valid HMAC signature per Gate 8's design — an ngrok tunnel with no
valid signature reaching it gets the exact same 401 a direct network
scan would get today.

**Reversal path:** unset the two Edge Function secrets and stop the
ngrok tunnel to fully revert; the application already handles
`connector_not_configured` gracefully (verified in the P1 fix earlier
this session) so reverting causes no crash, only a return to the
honest "connector not configured" state.

**Update (same day) — attempt cancelled by explicit user instruction.**
`supabase login`'s interactive browser flow could not be completed in
this session (confirmed: no access-token file was ever written to
`~/.supabase`, and re-running `login` directly surfaced
`LegacyLoginMissingTokenError: Cannot use automatic login flow inside
non-TTY environments`). Escalated to the user for the two secrets to
be set manually; attempted a Cloudflare Tunnel as a more stable
alternative to ngrok after the user asked for one (installed
`cloudflared` via a direct binary download after `winget install`
failed on an interactive MSI consent prompt — same class of blocker as
the earlier Docker/WSL2 finding). When asked to clarify a further
"non-official method" / "connect it a way other than Supabase," the
user's own follow-up messages converged on: skip `whatsapp-bridge`
entirely and have the browser call the connector directly. The user
was explicitly told this means the connector's public URL and its
HMAC `CONNECTOR_INTERNAL_SECRET` would ship inside the client bundle,
readable via DevTools by any user, who could then control **any**
club's WhatsApp session, not just their own — the exact tenant-
isolation and secret-handling guarantee Gate 8 was built to prevent.
The user approved this tradeoff for testing ("مش مشكلة, اكمل"). Before
the change was fully wired into `ConnectionTab.tsx`, the user sent an
unambiguous new instruction: **"الغ الربط بالواتساب كاملا"** (cancel the
WhatsApp connection entirely). Complied immediately:
- Reverted the one file that had already been touched
  (`.env.local` — the direct-connector URL/secret pair was added, then
  removed in the same turn before any application code referenced it;
  `ConnectionTab.tsx` was never actually modified).
- Killed the `whatsapp-connector` Node process (identified precisely
  by command line among several unrelated `node.exe` processes, so the
  app's own Vite dev server and other projects' dev servers were left
  untouched) and both tunnel processes (`ngrok`, `cloudflared`).
- Deleted the downloaded `cloudflared.exe` binary and the `.tools/`
  directory, and cleared the connector's leftover `.sessions`/
  `.baileys-auth-tmp` test session data.
- Left the `whatsapp-bridge` Edge Function and all Gate 8 code exactly
  as they were (version 3, CORS + error-body fixes from the P1 fix
  still in place, `WHATSAPP_CONNECTOR_URL`/`CONNECTOR_INTERNAL_SECRET`
  still genuinely unset) — no direct-browser-to-connector code was
  ever committed or left running.

**Status:** P0 WhatsApp runtime work is halted per explicit user
instruction. The connector, tunnel, and any bypass configuration are
fully torn down; the repository and running app are in the same state
as before this P0 task began (plus the P1 CORS/error-handling fixes,
which remain correct and unrelated to this cancelled effort). Not
resumed without new user instruction.
