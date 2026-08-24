# Security Baseline — 2026-08-24

This document freezes the security guarantees established across the
2026-08-21 → 2026-08-24 security/anti-fraud assurance cycle for the
Mal3aby platform (Supabase project `gxkrtlvpjwxhcqdisyob`). Everything
listed below is now **baseline** — a future change that weakens any
of these guarantees is a **regression**, not a design decision, and
must not ship without an explicit, reviewed reason recorded in a new
dated document, not by silently editing this one.

This is a closing document, not an open audit. It does not re-run the
large attack campaigns already accepted in prior rounds, and it does
not reopen findings that were already confirmed fixed and production-
retested without new evidence.

## 1. No direct financial DML on canonical financial-record tables

The following tables have **no direct client-side INSERT/UPDATE**
(revoked from both `anon` and `authenticated`) for their
transaction-record columns. Every legitimate write goes through a
`SECURITY DEFINER` RPC that enforces the real business invariant
(server-computed price, refundable-balance cap, idempotency,
government-receipt validation, etc.):

| Table | Grant state | Canonical write path |
|---|---|---|
| `payments` | INSERT revoked (anon+authenticated) | `record_payment()` |
| `bookings` | INSERT+UPDATE revoked (anon+authenticated) | `create_booking()`, `reschedule_booking()`, `cancel_booking()`, `mark_booking_no_show()` |
| `invoice_items` | INSERT+UPDATE revoked (anon+authenticated) | `create_booking()`, `create_enrollment_with_subscription()`, `renew_academy_subscription()`, `reschedule_booking()` |
| `refunds` | INSERT revoked (anon+authenticated) | `create_refund()` |
| `official_collection_receipts` | INSERT revoked (anon+authenticated) | `record_payment_with_official_receipt()` |

SELECT policies on all five tables are untouched — staff/self-service
reads are unaffected. Confirmed via repo-wide grep that no frontend
code performs a direct `.from(<table>).insert()/.update()` against any
of these five tables — the RPCs above are the sole legitimate write
surface, and none of them depend on the caller's own table grant
(they run as `SECURITY DEFINER`).

**Regression test**: any new RLS policy that grants direct client
INSERT/UPDATE on `payments`, `bookings`, `invoice_items`, `refunds`,
or `official_collection_receipts` again is itself the regression —
there is no legitimate reason to re-add one. `supabase/tests/
security_finance_regression.sql` TEST 1 (payments) documents the
original live reproduction and fix for this pattern; the same
reasoning applies verbatim to the other four tables (see migrations
`20260824400000`, `20260824410000`, `20260824420000`,
`20260824430000`).

## 2. Pricing, booking, payment, and refund mutation only via canonical RPCs

Follows directly from §1: because the tables themselves reject direct
writes, `create_booking()` / `reschedule_booking()` (server-computed
price via `resolve_field_price()`), `record_payment()` / `create_refund()`
(outstanding-balance and refundable-balance caps), and
`record_payment_with_official_receipt()` (government-compliance
validation) are the **only** paths capable of creating or mutating
these financial facts. No other RPC, trigger, or client code path may
be introduced that inserts into these five tables without going
through one of these functions.

## 3. `subscriptions.end_date` is immutable after insert

`protect_subscription_price_immutable()` (the `BEFORE UPDATE` trigger
on `public.subscriptions`) freezes `price`, `discount`,
`enrollment_id`, `plan_type`, `start_date`, **and `end_date`** against
any direct `UPDATE` — silently reverting the column to its prior value
rather than erroring, exactly like the other frozen columns. There is
no escape-hatch flag for `end_date` (unlike `status`, which
legitimately transitions in place via `freeze_subscription()`/
`unfreeze_subscription()`/`cancel_subscription()` using the
`app.allow_subscription_status_transition` GUC) — no genuine business
flow needs to change an existing row's `end_date` after creation.
`renew_academy_subscription()` always **inserts a new row** rather
than extending an old one; freeze/unfreeze extend effective coverage
via `subscription_freezes` spans, read through
`get_subscription_effective_end_date()`, never by touching the stored
`end_date`.

**Regression test**: `security_finance_regression.sql` TEST 12 — a
direct `UPDATE ... SET end_date = end_date + interval '365 days'`
under a real authenticated staff session must leave `end_date`
unchanged.

## 4. Every multi-tenant RPC checks ownership/permission inside the same lookup — no foreign-vs-missing signal

Every `SECURITY DEFINER` RPC that accepts a raw entity id
(`p_invoice_id`, `p_booking_id`, `p_subscription_id`,
`p_membership_id`, `p_player_id`, `p_field_id`, etc.) resolves that id
**and** verifies `club_id in (select user_club_ids()) and
has_permission(...)` in the **same** `WHERE`/lookup step, and raises
the **same** generic "not found or not authorized" message regardless
of which condition actually failed. A caller must never be able to
distinguish "this id belongs to another tenant" from "this id does
not exist anywhere" — that distinction is itself sensitive
information across tenant boundaries.

This closes the systemic "lookup-then-authorize" pattern found and
fixed across 26 RPCs in the 2026-08-24 round (see git log
`f609caa`..`f6282c7`, and `af90c06` for the two fixed in the prior
segment): `record_payment`, `create_refund`, `void_invoice`,
`verify_manual_payment_claim`, `approve_payment_proof`,
`reject_payment_proof`, `close_cash_shift`,
`settle_employee_cash_liability`, `adjust_employee_cash_liability`,
`reverse_employee_cash_liability`, `set_staff_cash_custody`,
`deactivate_staff_member`, `reactivate_staff_member`,
`update_payment_method_config`, `cancel_booking`,
`mark_booking_no_show`, `reschedule_booking`, `cancel_subscription`,
`freeze_subscription`, `unfreeze_subscription`,
`renew_academy_subscription`, `update_player`,
`update_academy_membership`, `unlink_guardian_from_player`,
`set_primary_guardian`, `link_guardian_to_player`,
`create_field_pricing_rules`, `archive_field_pricing_rules`.

**Regression test**: `security_finance_regression.sql` TEST 13 — a
data-driven matrix that calls every RPC above twice (once with a real
id belonging to a different tenant, once with a guaranteed-nonexistent
id) under the same unauthorized session and asserts the two error
messages are byte-identical. Any new RPC of this shape must be added
as a new row to this matrix, not a new hand-written test block.

## 5. QR check-in re-verifies tenant/payment/status and prevents replay/concurrency

`qr_confirm_checkin()` independently re-checks, at confirmation time
(not trusting any earlier `qr_validate()` result):
- tenant/permission (`v_cred.club_id in user_club_ids()` +
  `has_permission('qr.checkin.confirm', ...)`) — a wrong-tenant scan
  returns `permission_denied`/`WRONG_TENANT`, never silently succeeds;
- credential status (`consumed`/`revoked`/`expired` all rejected
  before any mutation — replay of an already-used QR is blocked);
- booking status (`cancelled`/`no_show`/already-`checked_in` all
  rejected independently, even if the credential row were somehow
  bypassed);
- payment eligibility (`get_invoice_payment_summary` outstanding
  balance re-computed fresh at check-in time, never trusted from an
  earlier moment).

Row-level locks (`select ... for update`) on both `qr_credentials` and
`bookings` make the consume-and-mark-checked-in transition atomic,
closing the concurrent-double-scan race. This behavior was proven live
during the 2026-08-24 round's real booking-race test (two simultaneous
requests for the same slot) and via direct inspection of the current
live function body — no change was needed or made to this RPC in this
round.

**Regression test**: `security_finance_regression.sql` already
exercises the exclusion-constraint side of concurrency (TEST covering
`no_overlapping_field_bookings`); the QR-replay behavior itself is
enforced structurally by the function body above and is re-verified by
code inspection each time this document is revisited, per §9 below.

## 6. Customer Portal and staff isolation never rely on UI filtering

Every table a customer or staff member can reach has RLS **enabled
and forced** (`relrowsecurity` and `relforcerowsecurity` both `true`
on all 72 tables in `public`, confirmed via a direct `pg_class` sweep
in the 2026-08-24 round). Tenant scoping is enforced by
`user_club_ids()`/`has_permission()`/`has_branch_access()` inside RLS
policies and RPC bodies — never by hiding a button, omitting a nav
link, or filtering a list client-side. A staff member who edits
`localStorage`'s `currentClubId`/`activeClubId`, or calls an RPC
directly with a spoofed `p_club_id`, gets the exact same rejection a
real cross-tenant attacker would, because the server never trusts the
client's claim about which club it's acting on — only `auth.uid()`
from the verified session is ever used to resolve real membership.

## Remaining server-only (SERVER VERIFIED) legitimate-path cases

The following two functions' legitimate-path behavior is proven by
direct code inspection and by the identical, already-proven-correct
`club_id in (select user_club_ids()) and has_permission(...)`
predicate shape used everywhere else in this codebase — but a live,
non-destructive positive-path call could not be completed in this
closing review without creating new QA fixture data (no real
non-self-employee outstanding cash liability currently exists on any
reachable club), which this review was explicitly told not to do
unless necessary:

- `adjust_employee_cash_liability`
- `reverse_employee_cash_liability`

Both are **fixed and attack-side production-retested** (the
cross-tenant existence oracle is confirmed closed for both, via a real
unauthorized session against a real foreign-club liability) — only the
final "does the legitimate authorized path also still work" step
remains SERVER VERIFIED rather than LIVE VERIFIED. This is explicitly
recorded here rather than claimed as LIVE VERIFIED.

All other functions in the original sweep that were previously listed
as SERVER VERIFIED-only (`freeze_subscription`, `unfreeze_subscription`,
`renew_academy_subscription`, `update_academy_membership`,
`unlink_guardian_from_player`, `set_primary_guardian`,
`link_guardian_to_player`, `archive_field_pricing_rules`,
`update_payment_method_config`) were upgraded to **LIVE VERIFIED**
during this closing review using real, pre-existing fixture data
already present on the reachable QA club — no new accounts, customers,
bookings, or other QA artifacts were created to do this.

## Non-goals of this document

This baseline does not claim: WhatsApp/Baileys behavior (untouched,
out of scope), architecture changes (none made), new paid services
(none added), new customer-identity or multi-club model changes (none
made). It also does not re-litigate findings already accepted as
fixed in prior rounds without new evidence — see git history
`cffb880`..`722d723` for the full remediation trail this baseline
summarizes.
