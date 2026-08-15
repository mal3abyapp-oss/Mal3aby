# Database Blueprint

This is a table-by-table blueprint, not a migration file. Migrations are written when Phase 2 begins (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)).

## Conventions (apply to every table unless noted)

- `id uuid primary key default gen_random_uuid()`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz` — trigger-maintained on any mutable table
- `created_by uuid references auth.users(id)` where provenance matters
- `club_id uuid not null references clubs(id)` on every tenant-scoped table — **denormalized onto child tables directly, not only inferred via join**, so RLS policies stay simple and fast
- `status` — explicit `check` constraint or enum, never free text
- Soft deletion via `status` transitions; hard `DELETE` used only for genuinely disposable draft data, never for anything financial or operational after it matters (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 3)

---

## Platform

### `clubs`
Purpose: top-level tenant.
Columns: `name`, `name_ar`, `name_en` (nullable), `logo_url` (nullable), `currency` (default `EGP`), `timezone` (default `Africa/Cairo`), `tax_info jsonb` (nullable), `invoice_settings jsonb`, `status` (`active` | `suspended`), `organization_id uuid` (nullable, reserved — see [DECISIONS.md ADR-006](DECISIONS.md#adr-006--no-organizations-layer-above-clubs-in-v1-schema)).
PK: `id`. No FK (top of tenant hierarchy). RLS ownership: root of `club_id` scoping for everything below.

### `branches`
Purpose: physical locations under a club.
Columns: `club_id`, `name`, `address`, `phone`, `opening_hours jsonb`, `status` (`active` | `inactive`).
PK: `id`. FK: `club_id → clubs`. RLS: scoped by `club_id`.

---

## Identity & Access

### `profiles`
Purpose: 1:1 extension of `auth.users` with app-level identity data.
Columns: `user_id` (references `auth.users`, unique), `full_name`, `phone` (nullable), `avatar_url` (nullable).
PK: `id`. Unique: `user_id`. RLS: a user can read/update their own row; Platform/Club Owner can read profiles of users with a membership in their club.

### `roles`
Purpose: seeded role catalogue — not user-editable in V1.
Columns: `key` (unique — `platform_owner`, `club_owner`, `club_manager`, `branch_manager`, `receptionist`, `accountant`, `academy_manager`, `coach`, `scanner`), `name`, `name_ar`.
PK: `id`. Seeded via `seed.sql`.

### `permissions`
Purpose: catalogue of discrete permission keys.
Columns: `key` (unique, e.g. `booking.create`, `payment.refund`), `description`.
PK: `id`. Seeded via `seed.sql`.

### `role_permissions`
Purpose: join table — which role has which permission.
Columns: `role_id`, `permission_id`.
PK: composite `(role_id, permission_id)`. FKs: `role_id → roles`, `permission_id → permissions`. Not user-editable in V1 (code/seed-managed).

### `club_memberships`
Purpose: **the RLS anchor table** — which user works at which club/branch with which role.
Columns: `user_id`, `club_id`, `branch_id` (nullable — null means all branches), `role_id`, `status` (`active` | `inactive`).
PK: `id`. Unique: `(user_id, club_id, role_id)`. FKs: `user_id → auth.users`, `club_id → clubs`, `branch_id → branches`, `role_id → roles`. RLS: a user reads their own memberships; management requires `staff.update`/`staff.create` permission scoped to that club.

---

## People

### `customers`
Purpose: any person the club has a relationship with — walk-in booker, guardian, or both. Not necessarily a player.
Columns: `club_id`, `full_name`, `mobile` (unique per club), `whatsapp` (nullable), `email` (nullable), `national_id` (nullable), `date_of_birth` (nullable), `gender` (nullable), `address` (nullable), `notes` (nullable), `photo_url` (nullable), `emergency_contact jsonb` (nullable), `created_by`.
PK: `id`. Unique: `(club_id, mobile)`. RLS: scoped by `club_id`.

### `players`
Purpose: academy participants — distinct from `customers` (see [DECISIONS.md ADR-002](DECISIONS.md#adr-002--guardian-is-not-a-separate-entity-from-customer)).
Columns: `club_id`, `full_name`, `date_of_birth`, `gender` (nullable), `photo_url` (nullable), `medical_notes` (nullable), `status` (`active` | `inactive`).
PK: `id`. RLS: scoped by `club_id`.

### `guardian_links`
Purpose: many-to-many between `customers` (as guardians) and `players`.
Columns: `customer_id`, `player_id`, `relationship` (`father` | `mother` | `guardian` | `other`), `is_primary boolean` (default `false`).
PK: `id`. Unique: `(customer_id, player_id)`. FKs: `customer_id → customers`, `player_id → players`. RLS: scoped via joined `club_id` (both sides share the same club by constraint/trigger check).

---

## Facilities

### `fields`
Purpose: bookable units. No separate `facilities` layer in V1 — see [DECISIONS.md](DECISIONS.md) reasoning under the general "no unnecessary layers" principle applied consistently with ADR-006.
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
Columns: `club_id`, `field_id` (nullable — null applies to all fields in branch/club), `day_of_week` (nullable), `date_specific` (nullable date, for holiday-specific pricing), `start_time`, `end_time`, `price_per_hour`, `priority int` (higher wins on overlap).
PK: `id`. FK: `field_id → fields`. RLS: scoped by `club_id`.

---

## Booking

### `bookings`
Purpose: the core operational record.
Columns: `club_id`, `branch_id`, `field_id`, `customer_id`, `start_at`, `end_at`, `during tstzrange` (generated, stored — `tstzrange(start_at, end_at, '[)')`), `status` (`pending_payment` | `confirmed` | `checked_in` | `completed` | `cancelled` | `no_show`), `total_price`, `discount_amount` (default `0`), `notes` (nullable), `cancelled_reason` (nullable), `created_by`.
PK: `id`. FKs: `field_id → fields`, `customer_id → customers`. **Exclusion constraint:** `EXCLUDE USING gist (field_id WITH =, during WITH &&) WHERE (status NOT IN ('cancelled','no_show'))` — see [DECISIONS.md ADR-007](DECISIONS.md#adr-007--double-booking-prevention-via-postgresql-exclusion-constraint). RLS: scoped by `club_id`, no DELETE policy.

---

## Billing

### `invoices`
Purpose: financial document, not tied to a single booking — can reference any combination of line items.
Columns: `club_id`, `branch_id`, `invoice_number` (unique per branch), `customer_id`, `status` (`draft` | `issued` | `void`), `subtotal`, `discount`, `tax` (default `0`), `total`, `issued_at` (nullable), `created_by`.
PK: `id`. Unique: `(branch_id, invoice_number)`. RLS: scoped by `club_id`, no DELETE policy.

### `invoice_items`
Purpose: line items — a booking, a subscription period, a registration fee, or ad hoc.
Columns: `invoice_id`, `description`, `reference_type` (`booking` | `subscription` | `registration_fee` | `other`), `reference_id` (nullable uuid, polymorphic), `quantity` (default `1`), `unit_price`, `line_total`.
PK: `id`. FK: `invoice_id → invoices`. RLS: scoped via joined `invoices.club_id`.

### `payments`
Purpose: money actually received.
Columns: `club_id`, `method` (`cash` | `card` | `bank_transfer` | `wallet` | `other`), `amount`, `status` (`completed` | `void` | `refunded`), `received_by`, `received_at`.
PK: `id`. RLS: scoped by `club_id`, no DELETE policy.

### `payment_allocations`
Purpose: bridges `payments` ↔ `invoices` many-to-many — supports split/partial payments (see [ARCHITECTURE.md](ARCHITECTURE.md#billing--financial-integrity-strategy)).
Columns: `payment_id`, `invoice_id`, `amount`.
PK: `id`. FKs: `payment_id → payments`, `invoice_id → invoices`. Check trigger: `SUM(amount) per payment_id ≤ payments.amount`. RLS: scoped via joined `club_id`.

### `refunds`
Purpose: append-only reversal record — never mutates the original `payments` row.
Columns: `payment_id`, `amount`, `reason`, `refunded_by`, `refunded_at`, `status` (`completed` | `void`).
PK: `id`. FK: `payment_id → payments`. RLS: scoped via joined `club_id`, no DELETE policy.

### `invoice_number_sequences`
Purpose: concurrency-safe per-branch invoice numbering (see [DECISIONS.md ADR-009](DECISIONS.md#adr-009--invoice-numbering-is-per-branch)).
Columns: `branch_id`, `year`, `last_number` (default `0`).
PK: `id`. Unique: `(branch_id, year)`. Updated only via `UPDATE ... RETURNING` inside the invoice-creation RPC.

---

## QR

### `qr_credentials`
Purpose: secure, hashed, single-use-capable tokens for check-in/attendance — never stores a raw token (see [DECISIONS.md ADR-005](DECISIONS.md#adr-005--qr-tokens-are-opaque-random-values-hashed-at-rest)).
Columns: `club_id`, `type` (`booking` | `subscription` | `player_membership`), `reference_id` (polymorphic uuid), `token_hash` (unique, SHA-256), `status` (`active` | `consumed` | `expired` | `revoked`), `single_use boolean` (default `true`), `expires_at`, `used_at` (nullable), `used_by` (nullable).
PK: `id`. Unique: `token_hash`. RLS: scoped by `club_id`; SELECT never exposes `token_hash` to non-privileged roles beyond what's needed to validate.

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
Purpose: the actual training cohort — the unit players enroll into.
Columns: `club_id`, `branch_id`, `program_id`, `season_id`, `age_group_id` (nullable), `coach_id` (references `auth.users` via membership), `assistant_coach_id` (nullable), `field_id`, `capacity`, `status` (`active` | `full` | `closed`).
PK: `id`. FKs: `program_id → programs`, `season_id → seasons`, `field_id → fields`. RLS: scoped by `club_id`; Coach role sees only groups where `coach_id = auth.uid()` or `assistant_coach_id = auth.uid()`.

### `group_schedule_slots`
Purpose: recurring weekly pattern a group trains on — source for session generation.
Columns: `group_id`, `day_of_week`, `start_time`, `end_time`.
PK: `id`. FK: `group_id → groups`. RLS: scoped via joined `groups.club_id`.

### `enrollments`
Purpose: a player's membership in a group.
Columns: `player_id`, `group_id`, `guardian_id` (references `customers`), `status` (`active` | `withdrawn`), `enrolled_at`.
PK: `id`. FKs: `player_id → players`, `group_id → groups`, `guardian_id → customers`. Unique: `(player_id, group_id)` where status = active (partial unique index). RLS: scoped via joined `groups.club_id`.

### `subscriptions`
Purpose: the billing period tied to an enrollment. **No stored `amount_paid`/`amount_remaining`** — always derived from `invoices`/`payments` (see [PROJECT_RULES.md](PROJECT_RULES.md) rule 8).
Columns: `enrollment_id`, `plan_type` (`monthly` | `quarterly` | `season` | `package`), `start_date`, `end_date`, `price`, `discount` (default `0`), `status` (`pending` | `active` | `frozen` | `expired` | `cancelled`).
PK: `id`. FK: `enrollment_id → enrollments`. RLS: scoped via joined `club_id`.

### `subscription_freezes`
Purpose: pause periods. `extends_expiry` defaults `true` — see [DECISIONS.md ADR-008](DECISIONS.md#adr-008--subscription-freeze-extends-expiry-by-default).
Columns: `subscription_id`, `start_date`, `end_date`, `reason`, `extends_expiry boolean` (default `true`), `created_by`.
PK: `id`. FK: `subscription_id → subscriptions`. RLS: scoped via joined `club_id`.

### `training_sessions`
Purpose: materialized, on-demand-generated occurrences of a group's schedule (see [ARCHITECTURE.md](ARCHITECTURE.md#academy-engine-design) generation strategy).
Columns: `group_id`, `field_id`, `coach_id`, `session_date`, `start_time`, `end_time`, `status` (`scheduled` | `completed` | `cancelled`).
PK: `id`. Unique: `(group_id, session_date)`. FKs: `group_id → groups`, `field_id → fields`. RLS: scoped via joined `club_id`; Coach sees only sessions for their groups.

### `attendance`
Purpose: per-player, per-session record.
Columns: `session_id`, `player_id`, `status` (`present` | `absent` | `excused` | `late`), `marked_by`, `marked_at`, `method` (`manual` | `qr`).
PK: `id`. Unique: `(session_id, player_id)`. FKs: `session_id → training_sessions`, `player_id → players`. RLS: scoped via joined `club_id`; Coach can only write for their own sessions.

---

## Audit

### `audit_logs`
Purpose: record of every sensitive mutation — see the trigger action list in [RLS_MATRIX.md](RLS_MATRIX.md#audit-trigger-scope).
Columns: `club_id`, `branch_id` (nullable), `actor_id`, `action`, `entity_type`, `entity_id`, `before jsonb` (nullable), `after jsonb` (nullable), `reason` (nullable).
PK: `id`. RLS: SELECT-only, scoped by `club_id` (branch-scoped roles see only their branch); no INSERT/UPDATE/DELETE via client — written only by triggers/RPCs running as `SECURITY DEFINER`.
