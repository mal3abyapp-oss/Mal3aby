# Security & Anti-Fraud

> **Added 2026-08-15 (final pre-implementation)** as part of the Final Pre-Implementation Directive. This file is the reference for the **Security Gate** every phase must pass (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)) and consolidates the business-abuse threat model that sits alongside — not instead of — [RLS_SECURITY.md](RLS_SECURITY.md)'s `SECURITY DEFINER`/RLS mechanics. RLS_SECURITY.md answers "how do we write a privileged function safely"; this file answers "what specific abuse scenarios must every financial/operational domain resist."

## Core Security Principle

**Design assuming any user may attempt an unauthorized operation, tamper with frontend-supplied values, or call the API directly.** The frontend is never the security boundary. Real protection lives in, in order of authority:

```
PostgreSQL Constraints (exclusion constraints, unique indexes, check constraints)
→ RLS (row-level tenant isolation)
→ Permissions (permission-key checks, never role-key comparisons)
→ Secure RPCs (SECURITY DEFINER, atomic, server-derived values)
→ Transactions (atomicity across multi-table writes)
→ Audit Logs (immutable record of every sensitive mutation)
```

Every layer exists because the layer above it can be bypassed by a sufficiently motivated or malicious client. A UI that hides a button is a UX convenience, not a control — the actual control is the database rejecting the underlying mutation regardless of how it was invoked.

## Trust Nothing From Frontend

The following values, when they appear in any client request, are **never trusted as-is** — they are either re-derived entirely server-side or independently re-validated against the database before use, in every RPC that touches them:

| Value | Where it's actually derived |
|---|---|
| `club_id` | From the caller's `club_memberships` (via `auth.uid()`) or from the referenced row (e.g. the `field_id` being booked), never accepted as an unverified argument |
| `branch_id` | Same pattern — verified against `membership_branches` |
| `price` / `discount` | Recomputed server-side from `pricing_rules` + permission-gated discount logic at confirm time — see [Price Security](#price-security) |
| `role` | Hardcoded per-RPC (e.g. `complete_new_club_onboarding()` always assigns `club_owner`) or checked against `role_permissions`, never accepted as a request field |
| `permission` | Checked via `auth.has_permission()` inside the function, never assumed from a client claim |
| `status` (booking/invoice/subscription/etc.) | Only ever transitioned by the specific RPC responsible for that transition, following the documented state machine — never a raw client-supplied status string |
| `trial_days` / `subscription_kind` | Read from `platform_settings.default_trial_days` and hardcoded to `'trial'` respectively inside `complete_new_club_onboarding()` — see [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values) |
| `invoice_total` | Computed from `invoice_items` server-side, never accepted as a top-level field |
| `payment_status` | Only set by the payment/refund RPCs, never a direct client update |
| `booking_status` | Only set by `create_booking`, cancellation, check-in-confirm, or completion RPCs — see [Booking Security](#booking-security) |

If a value *should* be derivable from the database, the database is what derives it — a client-supplied copy of that value is, at best, a UI preview and never a write input.

## Booking Security

All operational booking writes go through `create_booking` (and its sibling cancellation/check-in RPCs) — **no direct client `INSERT` into `bookings` for the primary operational flow.** Before creating a booking, the RPC verifies, in order:

1. Caller is authenticated (`auth.uid()` non-null)
2. Caller holds an active `club_memberships` row for the target club
3. Caller's role has the `booking.create` permission
4. `get_club_platform_access(club_id)` allows `'new_commitment'` (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-access-strategy))
5. The field belongs to the claimed club/branch
6. The requested time falls within the field's operating hours and isn't inside a `field_blocks` window
7. The applicable `pricing_rules` produce the price actually charged (never the client's proposed price — see below)
8. Any requested discount is permitted by the caller's discount permission/limit (see [Discount Security](#discount-security))
9. The referenced customer exists and belongs to the same club

Only after all of the above does the RPC insert the row — and the **exclusion constraint is the final, unconditional line of defense** regardless of whether every RPC-level check above was implemented correctly, since it's enforced by Postgres itself against every write path:

```sql
EXCLUDE USING gist (field_id WITH =, during WITH &&)
  WHERE (status IN ('pending_payment', 'confirmed', 'checked_in'))
```

**Boundary behavior confirmed:** `10:00–11:00` + `11:00–12:00` → both succeed (no overlap, `[)` semantics). `10:00–11:00` + `10:30–11:30` → the second is rejected (genuine overlap). See [DECISIONS.md ADR-021](DECISIONS.md#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in).

## Price Security

The frontend may render a **preview** price for UX responsiveness, but that preview is never what gets charged. At `create_booking` confirm time, the RPC recomputes the final price server-side from `field_id` + `date` + `time` + `duration` + the applicable `pricing_rules` (highest-priority matching rule wins, per [ARCHITECTURE.md](ARCHITECTURE.md#pricing-engine)) + any approved discount, and that recomputed value — never a client-submitted number — is what's stored on the `bookings`/`invoices` row.

## Discount Security

Two explicit permissions, not a single blanket "can discount" flag:

- `booking.discount.apply` — can apply a discount at all
- `booking.discount.override` — can apply beyond whatever standard limit exists

**V1 simplification** (chosen over a numeric per-role percentage-limit engine, which is real added complexity with no current business signal on what the limits should be): Receptionist has no discount capability without an explicit grant; Manager holds `booking.discount.apply` by default. If/when a numeric limit system (e.g. "Receptionist may discount up to 10% without approval") proves necessary, it is added as a `role_permissions`-adjacent numeric setting later — not hardcoded into the UI now. No discount percentage is ever hardcoded in frontend code; the permission model is the only gate.

## Booking Cancellation & No-Show

**Cancellation** requires: the `booking.cancel` permission, a mandatory reason, and is logged with actor + timestamp to `audit_logs`. The row is never deleted — `status` transitions to `cancelled`.

**No-show** similarly never deletes the row: `status = 'no_show'`, `marked_by`, `marked_at`, optional `reason`. Appears in occupancy/no-show reports (see [ARCHITECTURE.md](ARCHITECTURE.md) Reporting Strategy) exactly like any other terminal booking state.

## Financial Security

Every one of: invoice issuance, payment recording, payment allocation, refund, and void/reversal goes through an RPC/transaction wherever atomicity is required across more than one row — never a direct client mutation of a financial table for these operations. This restates and applies [PROJECT_RULES.md](PROJECT_RULES.md) rule 3 (no hard deletes) and rule 8 (derived financial values) specifically as a fraud-prevention control, not just a data-hygiene one: a client that could directly `UPDATE payments SET amount = ...` or `DELETE FROM invoices` could trivially erase revenue or rewrite what was charged.

**No hard delete, ever, on:** `invoices`, issued `invoice_items`, `payments`, `payment_allocations`, `refunds`, `platform_payments`, `platform_subscriptions`. Corrections use `void`/`reversal`/`cancel`/`refund` per the transaction type — never `DELETE`. RLS itself has no `DELETE` policy on these tables (see [RLS_MATRIX.md](RLS_MATRIX.md)), so this isn't only application discipline — it's structurally impossible through the client.

### Issued Invoice Lock

Once `invoices.status = 'issued'`, `invoice_items`, price, total, and customer are **not** freely editable. A correction goes through a documented void/reissue flow: void the issued invoice (with reason, actor, timestamp — logged), then issue a new corrected invoice referencing the voided one. This mirrors real invoicing discipline (an issued invoice is a legal/financial record, not a draft) and prevents silently rewriting what a customer was told they owed.

### Payment Security

A confirmed payment's `amount` is never directly edited. A mistaken amount is corrected via **Reverse Payment** (see [DECISIONS.md ADR-011c](DECISIONS.md#adr-011c--refund-model-refunds-table--reversing-allocation-atomic-rpc)-adjacent reversal pattern, already established for `platform_payments`) followed by recording the correct payment — never an in-place `UPDATE`. Every reversal carries `reason`, `actor`, `timestamp`.

### Refund Security

The refund RPC validates, atomically, before writing anything:

1. The referenced payment exists
2. The payment belongs to the caller's club (cross-tenant check)
3. The caller holds `payment.refund`
4. `refund_amount > 0`
5. `refund_amount <= refundable_balance` (payment amount minus prior completed refunds — computed inside the same transaction, not read-then-checked separately, to close the concurrent-refund TOCTOU gap)

Only then: insert `refunds` row, insert the reversing `payment_allocations` entry, write the `audit_logs` entry — all in one transaction. See [DECISIONS.md ADR-011c](DECISIONS.md#adr-011c--refund-model-refunds-table--reversing-allocation-atomic-rpc).

## Separation of Duties

Not a banking-grade dual-control system — a simple, permission-key-enforced division of what each role can actually do, so no single front-line staff member holds every capability:

| Role | Can | Cannot |
|---|---|---|
| Receptionist | Create booking, collect payment, print invoice, scan QR | Refund, change permissions, view platform finances |
| Coach | View assigned groups, mark attendance | View financial records |
| Accountant | Financial records, refund, financial reports | Manage roles/permissions |

This is not a new role model — it's the existing [RLS_MATRIX.md](RLS_MATRIX.md) permission grants, restated here explicitly as a fraud-prevention property: the matrix was already designed this way, but it's worth stating outright that this separation is a deliberate control, not an incidental side effect of the permission system's shape.

## Audit Log Coverage

At minimum, these actions always write an `audit_logs` row (actor, action, entity, before/after, timestamp, `club_id`, reason where applicable) — this list is the canonical one, restated from and consistent with [RLS_MATRIX.md](RLS_MATRIX.md#audit-trigger-scope):

```
booking created · booking cancelled · booking price override · discount applied
field block created (Quick Field Block)
invoice issued · invoice voided
payment recorded · payment reversed · refund
subscription activated · subscription cancelled · subscription frozen · subscription renewed
platform subscription changed
role/permission changes · club suspension · trial extension · new club onboarding completed
```

**Immutability** (restated from [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)): `INSERT` only via trusted trigger/RPC; `SELECT` by authorized users; `UPDATE` and `DELETE` — never, for any role, including Platform Owner. History is not editable by anyone.

## QR Security

Restated from [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy) and [DECISIONS.md ADR-005](DECISIONS.md#adr-005--qr-tokens-are-opaque-random-values-hashed-at-rest)/[ADR-011d](DECISIONS.md#adr-011d--player-qr-is-reusable-booking-qr-is-consumable-scans-are-a-separate-log)/[ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation) as fraud-prevention properties specifically:

- **Opaque random token** — the server stores `token_hash` only, never the raw token; QR content never encodes a predictable/sequential ID.
- **Player QR is reusable** (`single_use = false`) — scanning validates and logs a `qr_scan_events` row but never consumes the credential; used for attendance/identification.
- **Booking QR flow is scan-then-confirm, never scan-consumes**: Scan → Validate → Show booking → Staff explicitly confirms check-in → atomic mutation. A QR merely passing in front of a camera never starts or completes a booking by itself.
- **Replay protection is atomic by construction**: the confirm-check-in RPC's `UPDATE ... WHERE status = 'active'` either succeeds once or returns zero rows on any subsequent attempt — "Already Checked In" is shown with the original timestamp and staff member, never a silent second success.
- **Every scan — successful or not — produces a `qr_scan_events` row**: credential, scanner, action, result, time, reference. This includes failed scans (expired, wrong club, no permission) where that information matters for security investigation, not only successful ones.

## Multi-Tenant Security

Every tenant-scoped table carries `club_id` (denormalized, per [ARCHITECTURE.md](ARCHITECTURE.md#rls-strategy)). RLS prevents a Club A user from `SELECT`/`INSERT`/`UPDATE`/`DELETE` on Club B data through **any** path — including a raw PostgREST/Supabase client call that bypasses the application UI entirely. This is tested explicitly, not assumed, per [RLS_MATRIX.md](RLS_MATRIX.md#verification-checklist-phase-2-gate).

**Platform Owner** uses ordinary Supabase Auth — never a `service_role` key in the frontend, ever, under any circumstance. Platform Owner's elevated access comes from Auth + platform-level permissions + RLS/RPC policies recognizing that permission, exactly the same mechanism as any other role, just with a broader grant — not a different, higher-trust authentication path.

## `SECURITY DEFINER` Discipline

Every function using `SECURITY DEFINER` follows the full checklist in [RLS_SECURITY.md](RLS_SECURITY.md): pinned `search_path`, identity via `auth.uid()` only, no trusting a client-supplied `club_id`, internal permission check, scoped `EXECUTE` grants, cross-tenant test. This file doesn't restate that checklist — see RLS_SECURITY.md directly.

## Session Permission Changes

If a permission is revoked from a staff member mid-session, the frontend UI may remain stale for a few seconds (cached client state). This is acceptable **because every mutation re-checks permission server-side at call time** — a stale UI showing a now-forbidden button produces a rejected RPC call, not an unauthorized write. The staleness is a UX lag, never a security gap.

## Capacity Security

Enrollment creation validates group capacity **inside the same transaction** as the insert, via `SELECT ... FOR UPDATE` locking the `groups` row — restated from [ARCHITECTURE.md](ARCHITECTURE.md#academy-engine-design) as a fraud/race-prevention property: if a group has one spot left and two receptionists submit simultaneously, exactly one enrollment succeeds; the row lock serializes the second attempt to see the now-full capacity.

## Platform Subscription Security

Every club operational write depends on `get_club_platform_access(club_id)` (see [ARCHITECTURE.md](ARCHITECTURE.md#platform-access-strategy)) — the frontend cannot claim or cache "subscription is active" as authorization; every write-path RPC re-derives access live from `platform_subscriptions` + `now()`.

## Trial Security

Public signup cannot specify `trial_days`, platform role, a paid subscription, subscription price, or `subscription_kind` — `complete_new_club_onboarding()` derives every one of these values server-side from `platform_settings`/hardcoded logic, never from the request payload. See [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values).

## Abuse Test Catalogue

Every item below is a required test — not aspirational, not "nice to have." Each maps to a specific control described above and must have a passing automated test before the owning phase's Security Gate passes (see [TEST_PLAN.md](TEST_PLAN.md) for how these integrate into the pgTAP/integration suite):

| # | Attempted abuse | Expected result |
|---|---|---|
| 1 | Change `club_id` manually in a request payload | Rejected — RPC re-derives/re-verifies `club_id` against actual membership |
| 2 | Change price manually in a booking request | Ignored — server recomputes price from `pricing_rules`, never trusts the submitted value |
| 3 | Change role in a request (e.g. signup payload claiming `platform_owner`) | Ignored/rejected — role is hardcoded or permission-derived server-side |
| 4 | Create a booking in an expired-access club | Rejected — `get_club_platform_access()` returns `blocked`, `'new_commitment'` denied |
| 5 | Create an overlapping booking | Rejected — exclusion constraint |
| 6 | Refund more than paid | Rejected — refund RPC validates against refundable balance atomically |
| 7 | Repeat QR check-in (replay) | Second confirm rejected — atomic `UPDATE ... WHERE status='active'` returns zero rows |
| 8 | Create an enrollment over group capacity | Rejected — `SELECT ... FOR UPDATE` + capacity check inside the same transaction |
| 9 | Edit an issued invoice directly | Rejected — no free-form update path once `status = 'issued'`; correction requires void/reissue |
| 10 | Delete a payment | Rejected — no `DELETE` RLS policy exists on `payments` |
| 11 | Read another club's data via direct API/PostgREST call | Rejected — RLS enforced regardless of client path, not just through the app UI |
| 12 | Public signup attempts to set `platform_owner` | Rejected — `complete_new_club_onboarding()` hardcodes `club_owner` |
| 13 | Public signup attempts a 365-day trial | Ignored — trial length always read from `platform_settings.default_trial_days`, never a client-supplied value |

## Security Findings Severity

| Severity | Definition | Exit Gate Impact |
|---|---|---|
| **P0 — Critical** | Cross-tenant data access, financial data corruption/loss, privilege escalation, ability to bypass payment/authorization entirely | **Blocks Exit Gate** |
| **P1 — High** | Bypassable business constraint with real financial/operational impact (e.g. double-booking under a specific race condition, refund overpayment in an edge case) | **Blocks Exit Gate** |
| **P2 — Medium** | Real but lower-impact issue (e.g. a permission check missing on a rarely-used admin action with no financial exposure) | Documented, fixed before general availability, does not block the current phase's gate if isolated and tracked |
| **P3 — Low** | Hardening opportunity, defense-in-depth improvement, no demonstrated exploit path | Logged in `PROJECT_STATE.md` Deferred/Technical Debt, addressed opportunistically |

**Any open P0 or P1 finding blocks that phase's Exit Gate** — see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for how the Security Gate integrates into every phase's completion criteria.

## Security Gate Checklist (applied per phase, where applicable)

- [ ] Tenant isolation passed — cross-club SELECT/INSERT/UPDATE/DELETE all rejected, tested via direct API call, not only through the UI
- [ ] Permission checks passed — every mutation gated by a permission key, verified server-side
- [ ] Direct API abuse test passed — the relevant rows from the Abuse Test Catalogue above, for this phase's domain
- [ ] Business constraints passed — exclusion constraints, unique indexes, check constraints all hold under concurrency
- [ ] Financial integrity passed — no hard deletes possible, derived values match the ledger, atomicity holds
- [ ] Audit coverage passed — every sensitive action in this phase's domain writes a correct audit entry
- [ ] Concurrency passed — race-condition tests for this phase's write paths (double-booking, over-capacity, double-refund, etc.) all resolve to exactly one winner
- [ ] No secret exposure — no service role key, no internal-only field, present in any frontend-reachable response
- [ ] RLS enabled and tested — every new table in this phase has RLS policies and a passing cross-tenant test
