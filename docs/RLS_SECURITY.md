# RLS & Security Definer Discipline

This file documents the specific, mandatory rules for any PostgreSQL function that runs with elevated privilege, and for protecting sensitive columns that RLS alone cannot restrict at the column level. Added as part of the Mandatory Architecture Corrections pass (2026-08-15). Read together with [RLS_MATRIX.md](RLS_MATRIX.md) (the policy pattern and per-table permission matrix), [ARCHITECTURE.md](ARCHITECTURE.md#rls-strategy), and [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md) (the business-abuse threat catalogue and the Security Gate every phase must pass — added 2026-08-15, final pre-implementation pass).

## Why this file exists

RLS policies protect rows. They do not, by themselves, protect columns, and they are bypassed *by design* inside any function marked `SECURITY DEFINER` (which runs with the privileges of the function's owner, not the calling user). Every atomic multi-table operation in this system — booking creation, invoice numbering, QR consume, refunds, enrollment capacity checks — necessarily uses `SECURITY DEFINER` to write across tables the calling user's own RLS policies wouldn't otherwise let them touch directly. That power has to be re-earned inside the function itself, explicitly, every time.

## Mandatory rules for every `SECURITY DEFINER` function

1. **Pin `search_path` explicitly.** Every `SECURITY DEFINER` function sets `SET search_path = public, pg_temp` (or the specific minimal schema list it needs) in its definition. Never rely on the caller's or the database's default search path — an unpinned `search_path` inside a `SECURITY DEFINER` function is a classic privilege-escalation vector (a malicious or shadowing object earlier in the path could be executed with the function owner's privileges).

2. **Never trust a `club_id` (or any tenant-scoping value) passed as a plain argument without verifying it against the caller's actual membership.** If a function accepts `p_club_id uuid`, its first real statement re-derives the caller's authorized club(s) from `club_memberships` via `auth.uid()` and checks `p_club_id` is among them — or, better, doesn't accept `club_id` as an argument at all where it can instead be derived server-side from the referenced row (e.g. derive `club_id` from the `field_id` being booked, not from a client-supplied parameter). A `club_id` argument is a suggestion from an untrusted client until the function proves otherwise.

3. **Always resolve identity via `auth.uid()`, never a client-supplied user ID.** Any "who is doing this" value (`created_by`, `received_by`, `marked_by`, `scanner_user_id`, etc.) is set from `auth.uid()` inside the function, never accepted as a parameter from the client.

4. **Check the specific permission inside the function, not just at the RLS layer.** Even though the outer RLS policy on the target table(s) may already gate `INSERT`/`UPDATE`, a `SECURITY DEFINER` function bypasses those same policies for its own writes — so the function must perform its own explicit `auth.has_permission('<specific.key>', v_club_id)` check before doing anything privileged. Relying on "the caller could have inserted directly anyway" is not sufficient reasoning, because the function may do more than a direct insert would have allowed (e.g. numbering an invoice, consuming a QR credential).

5. **Grant `EXECUTE` only to the roles that need it**, via `REVOKE EXECUTE ... FROM PUBLIC` followed by explicit `GRANT EXECUTE ... TO <role>` — never leave a privileged function callable by any authenticated user by default. Supabase's `authenticated` role should not automatically have `EXECUTE` on every function; grant per-function based on the permission model, not as a blanket default.

6. **Every `SECURITY DEFINER` function ships with a cross-tenant test.** At minimum: User A (Club A membership) calls the function with a Club B target (via a spoofed argument, a Club B row reference, or any other path) and the call is rejected — not silently scoped, not partially executed, rejected before any write happens. See [TEST_PLAN.md](TEST_PLAN.md) for how this integrates into the pgTAP suite.

## Sensitive column protection: `medical_notes`

RLS operates at row granularity, not column granularity — a `SELECT` policy that lets a Receptionist read a `players` row cannot, by itself, hide just the `medical_notes` column from them while showing everything else. Two patterns are viable in PostgreSQL; V1 uses the first for simplicity:

**Chosen approach — restricted view:** A `players_safe` (or similarly named) view excludes `medical_notes` and is what roles without `player.medical_notes.view` query through in the UI layer; the underlying `players` table (including `medical_notes`) is queried directly only by roles that hold the permission, gated by an additional RLS check on the base table itself (`medical_notes IS NULL OR auth.has_permission('player.medical_notes.view', club_id)` is not expressible as a column-level RLS predicate, so this is enforced by which relation — `players` vs `players_safe` — the client is authorized/expected to query, backed by application-layer discipline in `features/players/`). Global search explicitly selects only the safe column set, never `SELECT *` against `players`.

**Alternative considered, not used in V1:** PostgreSQL column-level privileges (`REVOKE SELECT (medical_notes) ON players FROM some_role`) — more "correct" at the database level but heavier to manage per-role in Supabase's role model for V1's scale; revisit if the view-based approach proves insufficient.

## `SECURITY DEFINER` Function Inventory

> **Added 2026-08-15 (final comprehensive audit)** — consolidated here because no single file previously listed every planned privileged function in one place; each was scattered across [ARCHITECTURE.md](ARCHITECTURE.md) and [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) prose. This table is now the canonical name and purpose for each. If a function isn't in this list by the time it's implemented, it either doesn't need `SECURITY DEFINER` (use a normal RLS-scoped call instead) or this list is out of date and must be corrected first.

| Function | Purpose | Why `SECURITY DEFINER` is needed | Introduced |
|---|---|---|---|
| `auth.user_club_ids()` | Returns the caller's active club memberships | Reads `club_memberships` for `auth.uid()` — the core RLS building block | Phase 2 |
| `auth.has_permission(p_key, p_club_id)` | Checks whether the caller holds a given permission in a club | Joins `club_memberships`/`role_permissions`/`permissions` — same reason as above | Phase 2 |
| `auth.has_branch_access(p_membership_id, p_branch_id)` | Checks branch-scope access for a membership | Reads `membership_branches` with the zero-rows-means-all-branches semantic | Phase 2/3 |
| `get_club_platform_access(p_club_id)` | Returns `full`/`grace`/`blocked` for a club | Combines `clubs.status` + `platform_subscriptions` — must read tables the caller's own RLS wouldn't otherwise expose in this shape | Phase 3b |
| `auth.club_write_allowed(p_club_id, p_action_category)` | Thin wrapper gating writes by access level + category | Calls `get_club_platform_access()` internally | Phase 3b |
| `create_platform_subscription(...)` | Activates a club's first paid period or starts a trial | Writes `platform_subscriptions` (Platform-Owner-only table) on behalf of the caller | Phase 3b |
| `renew_platform_subscription(...)` | Creates the next period, linked via `previous_subscription_id` | Same — Platform-Owner-only table write | Phase 3b |
| `change_platform_plan(...)` | Ends the current period early, starts a new one on a different plan | Same | Phase 3b |
| `cancel_platform_subscription(...)` | Sets `lifecycle_status = 'cancelled'` with a reason | Same | Phase 3b |
| `record_platform_payment(...)` | Records a club's payment to Mala3by, marks the invoice paid | Same | Phase 3b |
| `reverse_platform_payment(...)` | Reverses a mistaken platform payment record | Same | Phase 3b |
| `extend_grace_period(...)` | Per-subscription override of `grace_period_days_snapshot` | Same | Phase 3b |
| `complete_new_club_onboarding(...)` | Atomically creates `clubs`+`branches`+`club_memberships`+trial `platform_subscriptions` | The **highest-risk function in the system** — reachable by a caller with no prior `club_memberships` row to validate against at all; the function itself is the entire trust boundary (see [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values)) | Phase 3d |
| `create_booking(...)` | Validates + creates a booking + invoice + optional payment atomically | Multi-table write across `bookings`/`invoices`/`invoice_items`/`payments`/`payment_allocations` in one transaction | Phase 6 |
| `create_recurring_booking(...)` | Creates a `booking_series` row + N individually-checked `bookings` rows | Same multi-table reasoning, plus must run the exclusion-constraint check N times inside one transaction | Phase 6 |
| `create_field_block(...)` | Creates a `field_blocks` row after checking for booking conflicts | Reads `bookings` across the target window and must surface conflicts atomically with the block's creation decision | Phase 6 |
| `ensure_booking_qr(p_booking_id)` | Idempotently generates/regenerates a booking's QR credential | Writes `qr_credentials`, a table normal client roles don't insert into directly | Phase 6 |
| `create_invoice(...)` / invoice numbering step | Allocates the next `invoice_number` from `invoice_number_sequences` and creates the `invoices` row | Must serialize concurrent numbering via row-level locking on `invoice_number_sequences`, a table with no general client write access | Phase 7 |
| `create_refund(...)` | Validates refundable balance, inserts `refunds` + reversing `payment_allocations` + audit entry | Multi-table atomic write, needs to compute refundable balance from data the caller doesn't have direct aggregate access to safely | Phase 7 |
| `qr_validate(p_token)` | Read-only token lookup + status/expiry check, logs to `qr_scan_events` | Reads `token_hash`-keyed `qr_credentials` without exposing the hash itself, and writes `qr_scan_events` which has no direct client insert | Phase 8 |
| `qr_confirm_checkin(p_token)` | Atomically consumes a booking QR credential and transitions the booking to `checked_in` | Multi-table atomic write (`qr_credentials` + `bookings` + `qr_scan_events`) | Phase 8 |
| `qr_mark_attendance(p_token, p_session_id)` | Validates a player QR and atomically upserts the attendance row | Writes `attendance` + `qr_scan_events` without consuming the reusable player credential | Phase 12 |
| `create_enrollment(...)` | Capacity-safe enrollment creation (`SELECT ... FOR UPDATE` on `groups`) | Needs a row lock most client roles can't safely orchestrate themselves without a race | Phase 11 |
| `generate_training_sessions(p_group_id, p_through_date)` | Idempotent on-demand session generation | Bulk-inserts `training_sessions` via `ON CONFLICT DO NOTHING`, a pattern not exposed to direct client insert | Phase 12 |
| `get_revenue_report(...)` and sibling report functions | Parameterized read-only aggregate reports | Aggregates across tables a given role may only partially have direct `SELECT` on (e.g. a report combining data a Receptionist can't otherwise join) | Phase 13 |

**Any function not on this list that later turns out to need `SECURITY DEFINER` must be added here before merge — this list is the audit trail for "why does this function bypass RLS," not just a checklist item.**

## Verification checklist (part of Phase 14 gate)

- [ ] Every `SECURITY DEFINER` function in `supabase/migrations/` has an explicit `SET search_path`
- [ ] No `SECURITY DEFINER` function trusts a client-supplied `club_id`/user-id argument without re-verification
- [ ] Every privileged function has a passing cross-tenant rejection test
- [ ] `EXECUTE` grants are role-specific, not blanket `PUBLIC`/`authenticated`
- [ ] `medical_notes` does not appear in any global search query or any role's default player list view without the `player.medical_notes.view` permission
- [ ] `audit_logs` has zero `UPDATE`/`DELETE` policies for any role (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them))
