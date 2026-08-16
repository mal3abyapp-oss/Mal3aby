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
