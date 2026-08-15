# Database Blueprint

This is a table-by-table blueprint, not a migration file. Migrations are written when Phase 2 begins (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)).

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. See [DECISIONS.md](DECISIONS.md) ADR-011 through ADR-020 for the reasoning behind every change in this revision.

## Conventions (apply to every table unless noted)

- `id uuid primary key default gen_random_uuid()`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz` — trigger-maintained on any mutable table
- `created_by uuid references auth.users(id)` where provenance matters
- `club_id uuid not null references clubs(id)` on every tenant-scoped table — **denormalized onto child tables directly, not only inferred via join**, so RLS policies stay simple and fast
- `status` — explicit `check` constraint or enum, never free text
- All money columns use `numeric(12,2)` — never `float`/`double` (see [DECISIONS.md ADR-016](DECISIONS.md#adr-016--money-is-numeric1220-never-floatdouble))
- All timestamps are `timestamptz`, never naive local timestamps (see [DECISIONS.md ADR-018](DECISIONS.md#adr-018--all-timestamps-are-timestamptz-club-owns-a-display-timezone))
- No hard `DELETE` on any row once it is operationally or financially recorded — see the explicit list in [PROJECT_RULES.md](PROJECT_RULES.md) rule 3. Master/reference data (e.g. an unused field) is disabled via `status = 'inactive'`, not deleted.

---

## Platform

### `clubs`
Purpose: top-level tenant. **No `organizations` layer above this in V1** — see [DECISIONS.md ADR-011](DECISIONS.md#adr-011--organizations-removed-entirely-from-v1-schema).
Columns: `name`, `name_ar`, `name_en` (nullable), `logo_url` (nullable), `club_code` (unique, short slug used in invoice numbering — e.g. `MAL`), `currency` (single operating currency, e.g. `EGP` — see [DECISIONS.md ADR-017](DECISIONS.md#adr-017--single-currency-per-club-no-multi-currency-in-v1)), `timezone` (default `Africa/Cairo`), `tax_info jsonb` (nullable), `invoice_settings jsonb`, `subscription_activation_policy` (`manual` | `first_payment` | `full_payment`, default `first_payment` — see [DECISIONS.md ADR-013](DECISIONS.md#adr-013--subscription-activation-policy-is-a-club-setting-not-a-hardcoded-rule)), `status` (`active` | `grace_period` | `suspended` — see [DECISIONS.md ADR-025](DECISIONS.md#adr-025--grace-period-is-7-days-by-default-per-club-overridable-ends-early-on-manual-payment-confirmation) and [ADR-026](DECISIONS.md#adr-026--grace-period-blocks-new-commitments-but-allows-collecting-on-existing-ones)).
PK: `id`. No FK (top of tenant hierarchy). RLS ownership: root of `club_id` scoping for everything below.
**No `organization_id` column exists anywhere in this schema.**
**`status` is not a manually-flipped flag alone** — `grace_period`/`suspended` transitions are computed from `platform_subscriptions` at query time (lazy, on-access — see ADR-025), not exclusively driven by a scheduled job.

### `branches`
Purpose: physical locations under a club.
Columns: `club_id`, `branch_code` (unique per club, used in invoice numbering — e.g. `FAY`), `name`, `address`, `phone`, `opening_hours jsonb`, `status` (`active` | `inactive`).
PK: `id`. FK: `club_id → clubs`. RLS: scoped by `club_id`.

---

## Platform Billing

**Structurally separate from club billing** (`invoices`/`payments`/`payment_allocations`/`subscriptions` below, which represent a club's own customer transactions). This section represents money flowing from a **club to Mala3by** — see [DECISIONS.md ADR-022](DECISIONS.md#adr-022--platform-billing-is-a-structurally-separate-domain-from-club-billing). All four tables here are **Platform Owner only** — no club-side role has write access, and club-side roles see only a read-only summary of their own club's platform subscription status (via a restricted view), never these tables directly.

### `platform_plans`
Purpose: catalogue of platform subscription plans. **V1 has exactly one seeded row** (see [DECISIONS.md ADR-023](DECISIONS.md#adr-023--single-flat-platform-plan-manually-managed-in-v1)) — the table exists so a second plan is additive later, not a schema change.
Columns: `name` (e.g. `Standard`), `default_price numeric(12,2)`, `default_grace_period_days int` (default `7`), `status` (`active` | `archived`).
PK: `id`. Platform-Owner-only RLS (no `club_id` — this table is not tenant-scoped, it's platform-owned reference data).

### `platform_subscriptions`
Purpose: the billing relationship between one club and the platform — one row per club (a club has exactly one active platform subscription at a time).
Columns: `club_id`, `plan_id`, `price_override numeric(12,2)` (nullable — falls back to `platform_plans.default_price` when null), `grace_period_days` (nullable — falls back to `platform_plans.default_grace_period_days` when null, see [DECISIONS.md ADR-025](DECISIONS.md#adr-025--grace-period-is-7-days-by-default-per-club-overridable-ends-early-on-manual-payment-confirmation)), `billing_cycle` (`monthly` | `annual`), `current_period_start`, `current_period_end`, `grace_period_started_at` (nullable — set when the club first enters grace_period, cleared on return to active), `status` (`active` | `grace_period` | `suspended` | `cancelled`).
PK: `id`. Unique: `club_id`. FKs: `club_id → clubs`, `plan_id → platform_plans`. Platform-Owner-only RLS.

### `platform_invoices`
Purpose: what a club owes the platform for a billing period.
Columns: `club_id`, `platform_subscription_id`, `invoice_number` (globally sequential, platform-wide — not per-branch, since this is Mala3by's own numbering, not a club's), `period_start`, `period_end`, `amount numeric(12,2)`, `due_date`, `status` (`pending` | `paid` | `overdue` | `void`).
PK: `id`. Unique: `invoice_number`. FKs: `club_id → clubs`, `platform_subscription_id → platform_subscriptions`. Platform-Owner-only RLS. No hard delete once issued — same no-hard-delete rule as club-level financial records (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 3).

### `platform_payments`
Purpose: manual/offline record of a club's payment to Mala3by (see [DECISIONS.md ADR-024](DECISIONS.md#adr-024--platform-subscription-payment-is-manualoffline-in-v1)) — no payment gateway in V1.
Columns: `platform_invoice_id`, `amount numeric(12,2)`, `method` (`bank_transfer` | `cash` | `other`), `reference` (nullable text), `recorded_by` (references `auth.users` — always a Platform Owner), `recorded_at`.
PK: `id`. FK: `platform_invoice_id → platform_invoices`. Platform-Owner-only RLS. Recording a payment here is the trigger that moves the club's `platform_subscriptions.status` (and `clubs.status`) back to `active` — see the activation RPC in [ARCHITECTURE.md](ARCHITECTURE.md#platform-billing-strategy).

---

## Identity & Access

### `profiles`
Purpose: 1:1 extension of `auth.users` with app-level identity data.
Columns: `user_id` (references `auth.users`, unique), `full_name`, `phone` (nullable), `avatar_url` (nullable).
PK: `id`. Unique: `user_id`. RLS: a user can read/update their own row; Platform/Club Owner can read profiles of users with a membership in their club.

### `roles`
Purpose: seeded role catalogue — not user-editable in V1. **Reference/labeling only** — actual authorization decisions are made against `permissions`, never against a role key (see [DECISIONS.md ADR-014](DECISIONS.md#adr-014--permissions-not-role-keys-are-the-authorization-source-of-truth)).
Columns: `key` (unique — `platform_owner`, `club_owner`, `club_manager`, `branch_manager`, `receptionist`, `accountant`, `academy_manager`, `coach`, `scanner`), `name`, `name_ar`.
PK: `id`. Seeded via `seed.sql`.

### `permissions`
Purpose: catalogue of discrete permission keys — **the authorization source of truth**.
Columns: `key` (unique, e.g. `booking.create`, `payment.refund`, `player.medical_notes.view`), `description`.
PK: `id`. Seeded via `seed.sql`.

### `role_permissions`
Purpose: join table — which role has which permission.
Columns: `role_id`, `permission_id`.
PK: composite `(role_id, permission_id)`. FKs: `role_id → roles`, `permission_id → permissions`. Not user-editable in V1 (code/seed-managed).

### `club_memberships`
Purpose: **the RLS anchor table** — which user works at which club with which role. Branch scope is **not** a single column here — see `membership_branches` below (see [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column)).
Columns: `user_id`, `club_id`, `role_id`, `status` (`active` | `inactive`).
PK: `id`. Unique: `(user_id, club_id, role_id)`. FKs: `user_id → auth.users`, `club_id → clubs`, `role_id → roles`. RLS: a user reads their own memberships; management requires `staff.update`/`staff.create` permission scoped to that club.
**No `branch_id` column on this table.**

### `membership_branches`
Purpose: explicit branch scoping for a membership. **Semantics: zero rows for a membership = access to all branches of that club. One or more rows = access restricted to exactly those branches.** This is the resolved semantic per [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column) — documented explicitly because the "no rows" meaning is easy to get backwards.
Columns: `membership_id`, `branch_id`.
PK: `id`. Unique: `(membership_id, branch_id)`. FKs: `membership_id → club_memberships`, `branch_id → branches`. RLS: scoped via joined `club_memberships.club_id`.

---

## People

### `customers`
Purpose: any person the club has a relationship with — walk-in booker, guardian, or both. Not necessarily a player.
Columns: `club_id`, `full_name`, `mobile_display` (nullable — as entered), `normalized_mobile` (nullable — E.164-normalized via a shared utility, see [DECISIONS.md ADR-012](DECISIONS.md#adr-012--phone-numbers-are-normalized-mobile-is-not-a-hard-unique-constraint)), `whatsapp` (nullable), `email` (nullable), `national_id` (nullable), `date_of_birth` (nullable), `gender` (nullable), `address` (nullable), `notes` (nullable), `photo_url` (nullable), `emergency_contact jsonb` (nullable), `created_by`.
PK: `id`. **No hard unique constraint on mobile.** Index: `(club_id, normalized_mobile)` (non-unique, `WHERE normalized_mobile IS NOT NULL`) — used to surface likely duplicates in the create/search UI, not to block a save. See [DECISIONS.md ADR-012](DECISIONS.md#adr-012--phone-numbers-are-normalized-mobile-is-not-a-hard-unique-constraint) for the reasoning (shared family numbers, no-phone customers, multiple input formats are all legitimate in this market). RLS: scoped by `club_id`.

### `players`
Purpose: academy participants — distinct from `customers` (see [DECISIONS.md ADR-002](DECISIONS.md#adr-002--guardian-is-not-a-separate-entity-from-customer)).
Columns: `club_id`, `full_name`, `date_of_birth`, `gender` (nullable), `photo_url` (nullable), `medical_notes` (nullable — **sensitive, permission-gated**: `player.medical_notes.view` / `player.medical_notes.update`, not visible to Receptionist by default and never included in global search results — see [DECISIONS.md ADR-019](DECISIONS.md#adr-019--medical-notes-are-a-permission-gated-field-not-a-default-visible-one)), `status` (`active` | `inactive`).
PK: `id`. RLS: scoped by `club_id`. Column-level protection on `medical_notes` enforced via a restricted view or column-privilege pattern — see [RLS_SECURITY.md](RLS_SECURITY.md#sensitive-column-protection-medical_notes).

### `guardian_links`
Purpose: many-to-many between `customers` (as guardians) and `players`.
Columns: `customer_id`, `player_id`, `relationship` (`father` | `mother` | `guardian` | `other`), `is_primary boolean` (default `false`).
PK: `id`. Unique: `(customer_id, player_id)`. FKs: `customer_id → customers`, `player_id → players`. RLS: scoped via joined `club_id` (both sides share the same club by constraint/trigger check).

---

## Facilities

### `fields`
Purpose: bookable units. No separate `facilities` layer in V1.
Columns: `club_id`, `branch_id`, `name`, `sport` (text, e.g. `football`, `padel` — not an enum, so new sports don't require a migration), `indoor boolean`, `capacity` (nullable), `default_duration_minutes` (default `60`), `status` (`active` | `maintenance` | `inactive`), `maintenance_status` (nullable text), `images jsonb` (nullable), `notes` (nullable).
PK: `id`. FKs: `club_id → clubs`, `branch_id → branches`. RLS: scoped by `club_id`.

### `field_operating_hours`
Purpose: unified hours model — branch/club-level fallback is a row with `field_id null`, avoiding three parallel hours systems.
Columns: `club_id`, `branch_id` (nullable), `field_id` (nullable — null applies to all fields in the branch), `day_of_week` (0-6), `open_time`, `close_time`.
PK: `id`. RLS: scoped by `club_id`.

### `field_blocks`
Purpose: maintenance windows, holidays, manual closures.
Columns: `club_id`, `field_id`, `start_at`, `end_at`, `reason`, `type` (`maintenance` | `holiday` | `manual`), `created_by`.
PK: `id`. FK: `field_id → fields`. RLS: scoped by `club_id`.

---

## Pricing

### `pricing_rules`
Purpose: rule-priority price resolution — not a rule-engine DSL.
Columns: `club_id`, `field_id` (nullable — null applies to all fields in branch/club), `day_of_week` (nullable), `date_specific` (nullable date, for holiday-specific pricing), `start_time`, `end_time`, `price_per_hour numeric(12,2)`, `priority int` (higher wins on overlap).
PK: `id`. FK: `field_id → fields`. RLS: scoped by `club_id`.

---

## Booking

### `bookings`
Purpose: the core operational record.
Columns: `club_id`, `branch_id`, `field_id`, `customer_id`, `start_at`, `end_at`, `during tstzrange` (generated, stored — `tstzrange(start_at, end_at, '[)')`), `status` (`pending_payment` | `confirmed` | `checked_in` | `completed` | `cancelled` | `no_show`), `total_price numeric(12,2)`, `discount_amount numeric(12,2)` (default `0`), `notes` (nullable), `cancelled_reason` (nullable), `created_by`.
PK: `id`. FKs: `field_id → fields`, `customer_id → customers`.
**Exclusion constraint** (confirmed scope per [DECISIONS.md ADR-021](DECISIONS.md#adr-021--exclusion-constraint-covers-pending_payment-confirmed-and-checked_in)):
```sql
EXCLUDE USING gist (field_id WITH =, during WITH &&)
  WHERE (status IN ('pending_payment', 'confirmed', 'checked_in'))
```
`completed` is excluded from the constraint's `WHERE` clause because a completed booking is historical — its time range is in the past and cannot conflict with a new booking being created (the DB doesn't need to guard against something that can no longer be scheduled into). `cancelled`/`no_show` are excluded because they explicitly freed the slot. `[)` range semantics confirmed: a booking `10:00–11:00` and one `11:00–12:00` do not overlap.
RLS: scoped by `club_id`, no DELETE policy.

---

## Billing

### `invoices`
Purpose: financial document, not tied to a single booking — can reference any combination of line items.
Columns: `club_id`, `branch_id`, `invoice_number` (formatted `{club_code}-{branch_code}-{year}-{000001}`, values pulled from `clubs.club_code`/`branches.branch_code`, never hardcoded in function logic), `customer_id`, `status` (`draft` | `issued` | `void`), `subtotal numeric(12,2)`, `discount numeric(12,2)`, `tax numeric(12,2)` (default `0`), `total numeric(12,2)`, `issued_at` (nullable), `created_by`.
PK: `id`. **Unique constraint: `(branch_id, invoice_number)`** — enforced at the database level, verified under concurrency (see [TEST_PLAN.md](TEST_PLAN.md)). RLS: scoped by `club_id`, no DELETE policy.
**No `amount_paid`/`amount_remaining` columns** — see [DECISIONS.md ADR-013 note on ledger](DECISIONS.md) and the Financial Ledger section of [ARCHITECTURE.md](ARCHITECTURE.md#billing--financial-integrity-strategy). Outstanding balance is always derived from `payment_allocations` minus `refunds` at query time.

### `invoice_items`
Purpose: line items — a booking, a subscription period, a registration fee, or ad hoc.
Columns: `invoice_id`, `description`, `reference_type` (`booking` | `subscription` | `registration_fee` | `other`), `reference_id` (nullable uuid, polymorphic), `quantity` (default `1`), `unit_price numeric(12,2)`, `line_total numeric(12,2)`.
PK: `id`. FK: `invoice_id → invoices`. RLS: scoped via joined `invoices.club_id`. No hard delete once the parent invoice is issued.

### `payments`
Purpose: money actually received. **Corrected model — no `invoice_id` on this table** (see [DECISIONS.md ADR-011b](DECISIONS.md#adr-011b--paymentsinvoice_id-removed-payment_allocations-is-the-only-payment-invoice-relationship)). A payment's relationship to invoice(s) exists *only* through `payment_allocations`.
Columns: `club_id`, `branch_id`, `customer_id`, `method` (`cash` | `card` | `bank_transfer` | `wallet` | `other`), `amount numeric(12,2)`, `status` (`completed` | `void`), `reference` (nullable text — e.g. transfer reference), `received_by`, `received_at`.
PK: `id`. RLS: scoped by `club_id`, no DELETE policy.
**`payments.invoice_id` does not exist.** Any code, query, or doc referencing it is stale.

### `payment_allocations`
Purpose: bridges `payments` ↔ `invoices` many-to-many — the *only* place a payment is linked to an invoice. Supports split/partial payments (one payment funding multiple invoices, or partially funding one).
Columns: `payment_id`, `invoice_id`, `amount numeric(12,2)`.
PK: `id`. FKs: `payment_id → payments`, `invoice_id → invoices`. **Check trigger: `SUM(payment_allocations.amount) per payment_id ≤ payments.amount`**, evaluated per the payment's current status. RLS: scoped via joined `club_id`.

### `refunds`
Purpose: append-only reversal record — never mutates the original `payments` row, never deletes it (see [DECISIONS.md ADR-011c](DECISIONS.md#adr-011c--refund-model-refunds-table--reversing-allocation-atomic-rpc)).
Columns: `payment_id`, `amount numeric(12,2)`, `reason`, `refunded_by`, `refunded_at`, `status` (`completed` | `void`).
PK: `id`. FK: `payment_id → payments`. RLS: scoped via joined `club_id`, no DELETE policy.
Invariant enforced by the refund RPC (not by trigger alone, since it must be atomic with the reversing allocation): `SUM(refunds.amount WHERE status='completed' AND payment_id=$1) ≤ (payments.amount − SUM(disallocated amount))` — i.e. multiple refunds against one payment can never exceed that payment's refundable balance. See [ARCHITECTURE.md](ARCHITECTURE.md#billing--financial-integrity-strategy) for the exact RPC shape.

### `invoice_number_sequences`
Purpose: concurrency-safe per-branch invoice numbering.
Columns: `branch_id`, `year`, `last_number` (default `0`).
PK: `id`. Unique: `(branch_id, year)`. Updated only via `UPDATE ... RETURNING` inside the invoice-creation RPC.

---

## QR

QR is now three logically distinct concerns — credential type, consumption semantics, and scan history are no longer conflated. See [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy) and [DECISIONS.md ADR-011d](DECISIONS.md#adr-011d--player-qr-is-reusable-booking-qr-is-consumable-scans-are-a-separate-log).

### `qr_credentials`
Purpose: secure, hashed tokens. **Consumption behavior now varies by `type`** — a player/membership credential is reusable (`single_use = false`); a booking check-in credential is typically single-use (`single_use = true`), consumed only on explicit staff confirmation, not on scan alone (see Booking Check-in flow in [USER_FLOWS.md](USER_FLOWS.md)).
Columns: `club_id`, `type` (`booking` | `player_membership`), `reference_id` (polymorphic uuid — a `bookings.id` or `players.id`), `token_hash` (unique, SHA-256 — raw token never stored), `status` (`active` | `consumed` | `expired` | `revoked`), `single_use boolean` (default `true` for `booking`, `false` for `player_membership`), `expires_at`, `used_at` (nullable — last-consumed timestamp, retained for convenience but **not the audit trail**, see `qr_scan_events` below), `used_by` (nullable).
PK: `id`. Unique: `token_hash`. RLS: scoped by `club_id`; SELECT never exposes `token_hash` to non-privileged roles beyond what's needed to validate.
**`subscription` and generic `invoice` are not `qr_credentials` types.** An invoice QR, if present, encodes a lookup/verification reference — it is explicitly not an access credential and does not consume anything on scan (see [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy)).

### `qr_scan_events`
Purpose: **the actual audit/replay/attendance trace** — every scan, successful or not, is logged here independently of whatever state mutation happened to `qr_credentials`. This is what security investigation, attendance history, and check-in history are built from — not `qr_credentials.used_at`/`used_by` alone.
Columns: `club_id`, `credential_id` (nullable — null if the token didn't resolve to any credential, e.g. garbage/forged input), `scanner_user_id`, `action` (`validate` | `check_in` | `attendance_mark`), `result` (`success` | `already_used` | `expired` | `invalid` | `wrong_club` | `permission_denied`), `reference_type` (`booking` | `player_membership`, nullable), `reference_id` (nullable), `scanned_at`, `device_metadata jsonb` (nullable).
PK: `id`. FK: `credential_id → qr_credentials` (nullable). RLS: SELECT scoped by `club_id`; INSERT only via RPC (`SECURITY DEFINER`), never direct client insert.

---

## Academy

### `programs`
Purpose: top-level academy offering (e.g. "Football Academy 2026").
Columns: `club_id`, `name`, `name_ar`, `sport`, `status` (`active` | `archived`).
PK: `id`. RLS: scoped by `club_id`.

### `seasons`
Purpose: time-bounded period a program (or several) runs within.
Columns: `club_id`, `program_id` (nullable — a season can span programs), `name`, `start_date`, `end_date`.
PK: `id`. FK: `program_id → programs`. RLS: scoped by `club_id`.

### `age_groups`
Purpose: reusable age bracket catalogue (U8, U10, ... or Beginner/Intermediate/Advanced).
Columns: `club_id`, `name`, `min_age` (nullable), `max_age` (nullable).
PK: `id`. RLS: scoped by `club_id`.

### `groups`
Purpose: the actual training cohort — the unit players enroll into. `capacity` is enforced at enrollment time inside a database transaction (see `enrollments` below), never only checked by the UI.
Columns: `club_id`, `branch_id`, `program_id`, `season_id`, `age_group_id` (nullable), `coach_id` (references `auth.users` via membership), `assistant_coach_id` (nullable), `field_id`, `capacity int`, `status` (`active` | `full` | `closed`).
PK: `id`. FKs: `program_id → programs`, `season_id → seasons`, `field_id → fields`. RLS: scoped by `club_id`; Coach role sees only groups where `coach_id = auth.uid()` or `assistant_coach_id = auth.uid()`.

### `group_schedule_slots`
Purpose: recurring weekly pattern a group trains on — source for session generation.
Columns: `group_id`, `day_of_week`, `start_time`, `end_time`.
PK: `id`. FK: `group_id → groups`. RLS: scoped via joined `groups.club_id`.

### `enrollments`
Purpose: a player's membership in a group.
Columns: `player_id`, `group_id`, `guardian_id` (references `customers`), `status` (`active` | `withdrawn`), `enrolled_at`.
PK: `id`. FKs: `player_id → players`, `group_id → groups`, `guardian_id → customers`. Unique: `(player_id, group_id)` where status = active (partial unique index). RLS: scoped via joined `groups.club_id`.
**Capacity check is concurrency-safe:** the enrollment-creation RPC counts active enrollments for the target `group_id` and compares against `groups.capacity` **inside the same transaction that inserts the new enrollment row**, using a row lock on the `groups` row (`SELECT ... FOR UPDATE`) to serialize concurrent enrollment attempts for the same group — see [ARCHITECTURE.md](ARCHITECTURE.md#academy-engine-design). Two receptionists racing for the last spot cannot both succeed.

### `subscriptions`
Purpose: the billing period tied to an enrollment. **One subscription belongs to exactly one enrollment — this is an intentional V1 business rule, not an unexamined limitation** (see [DECISIONS.md ADR-013b](DECISIONS.md#adr-013b--one-subscription--one-enrollment-in-v1-is-a-deliberate-rule)). A future multi-group/multi-sport membership product is a different model, built when actually needed — it does not retrofit onto this table.
**No stored `amount_paid`/`amount_remaining`** — always derived from `invoices`/`payments`/`payment_allocations` (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 8).
Columns: `enrollment_id`, `plan_type` (`monthly` | `quarterly` | `season` | `package`), `start_date`, `end_date` (the **original**, contractually-agreed end date — never silently rewritten by a freeze, see below), `price numeric(12,2)`, `discount numeric(12,2)` (default `0`), `status` (`pending` | `active` | `frozen` | `expired` | `cancelled`).
PK: `id`. FK: `enrollment_id → enrollments`. Unique: `enrollment_id` (enforces the one-subscription-per-enrollment rule at the database level, not just convention). RLS: scoped via joined `club_id`.
**`end_date` is never overwritten in place.** The *effective* expiry (after freeze extensions) is a derived value — see `subscription_freezes` below and the `get_subscription_effective_end_date` RPC in [ARCHITECTURE.md](ARCHITECTURE.md#academy-engine-design). This preserves the original contracted date as a permanent, auditable fact while still correctly gating access.

### `subscription_freezes`
Purpose: pause periods. `extends_expiry` defaults `true` (see [DECISIONS.md ADR-008](DECISIONS.md#adr-008--subscription-freeze-extends-expiry-by-default)).
Columns: `subscription_id`, `start_date`, `end_date`, `reason`, `extends_expiry boolean` (default `true`), `created_by`.
PK: `id`. FK: `subscription_id → subscriptions`. RLS: scoped via joined `club_id`.
**Effective end date calculation** (deterministic, tested): `effective_end_date = subscriptions.end_date + SUM(freeze.end_date - freeze.start_date) FOR each subscription_freezes row WHERE extends_expiry = true`. This is computed by an RPC/view, never stored as a second mutable date column on `subscriptions` — `subscriptions.end_date` stays the permanent original fact.

### `training_sessions`
Purpose: materialized, on-demand-generated occurrences of a group's schedule.
Columns: `group_id`, `field_id`, `coach_id`, `session_date`, `start_time`, `end_time`, `status` (`scheduled` | `completed` | `cancelled`).
PK: `id`. **Unique: `(group_id, session_date, start_time)`** — stronger identity than `(group_id, session_date)` alone, correctly supporting the (currently unused but schema-safe) case of two sessions for the same group on the same day. FKs: `group_id → groups`, `field_id → fields`. RLS: scoped via joined `club_id`; Coach sees only sessions for their groups.
**Session generation RPC is idempotent** — an `INSERT ... ON CONFLICT (group_id, session_date, start_time) DO NOTHING` upsert, so re-running generation for an already-covered date range never creates duplicates.

### `attendance`
Purpose: per-player, per-session record.
Columns: `session_id`, `player_id`, `status` (`present` | `absent` | `excused` | `late`), `marked_by`, `marked_at`, `method` (`manual` | `qr`).
PK: `id`. **Unique: `(session_id, player_id)`** — enforced at the database level. Marking attendance again for the same player/session is always an `UPDATE`, never a second `INSERT`. FKs: `session_id → training_sessions`, `player_id → players`. RLS: scoped via joined `club_id`; Coach can only write for their own sessions.

---

## Audit

### `audit_logs`
Purpose: record of every sensitive mutation — see the trigger action list in [RLS_MATRIX.md](RLS_MATRIX.md#audit-trigger-scope).
Columns: `club_id`, `branch_id` (nullable), `actor_id`, `action`, `entity_type`, `entity_id`, `before jsonb` (nullable), `after jsonb` (nullable), `reason` (nullable).
PK: `id`. RLS: **`SELECT` only, scoped by `club_id`** (branch-scoped roles see only their branch). **No `UPDATE`, no `DELETE` policy exists for any role, including Club Owner and Platform Owner** — the audit trail is immutable by every client-facing path once written (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)). `INSERT` happens only via trusted triggers/RPCs running as `SECURITY DEFINER`, never direct client insert.

---

## Summary of Removed / Corrected Elements (for cross-reference during doc review)

- ❌ `organizations` table — does not exist
- ❌ `clubs.organization_id` — does not exist
- ❌ `payments.invoice_id` — does not exist; use `payment_allocations`
- ❌ `invoices.amount_paid` / `invoices.amount_remaining` — do not exist; derive from ledger
- ❌ `subscriptions.amount_paid` / `subscriptions.amount_remaining` — do not exist; derive from ledger
- ❌ `club_memberships.branch_id` — replaced by `membership_branches` join table
- ❌ `customers.mobile` unique constraint — replaced by `mobile_display` + `normalized_mobile` with a non-unique lookup index
- ✅ `clubs.club_code`, `branches.branch_code` — added, used in invoice numbering instead of hardcoded prefixes
- ✅ `clubs.subscription_activation_policy` — added
- ✅ `membership_branches` — added
- ✅ `qr_scan_events` — added
- ✅ `qr_credentials.type` — narrowed to `booking` | `player_membership` (was previously also listing `subscription`)
- ✅ `platform_plans`, `platform_subscriptions`, `platform_invoices`, `platform_payments` — added (Platform Billing domain, structurally separate from club billing, see [DECISIONS.md ADR-022](DECISIONS.md#adr-022--platform-billing-is-a-structurally-separate-domain-from-club-billing))
- ✅ `clubs.status` — widened from `active | suspended` to `active | grace_period | suspended` (see [DECISIONS.md ADR-025](DECISIONS.md#adr-025--grace-period-is-7-days-by-default-per-club-overridable-ends-early-on-manual-payment-confirmation))
- **Platform billing tables never reuse `invoices`/`payments`/`payment_allocations`** — those remain exclusively for a club's own customer billing.
