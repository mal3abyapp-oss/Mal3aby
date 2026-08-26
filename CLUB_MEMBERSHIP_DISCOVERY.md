# CLUB MEMBERSHIP DISCOVERY

Read-only discovery pass completed before any Club Membership migration was
written. Sources: live DB inspection (`pg_get_functiondef`,
`information_schema`, `pg_policies`) plus a full frontend/backend sweep via
subagent. Findings below are the binding design constraints for this domain.

## 1. CRITICAL naming collisions (confirmed live)

- `club_memberships` — **already exists**, is the STAFF membership table
  (`user_id, club_id, role_id, status, has_cash_custody, custom_role_id`).
  Used everywhere this session for club_owner/accountant/receptionist etc.
  **Cannot be reused or renamed.**
- `subscriptions` / `subscription_freezes` — **already exist**, are the
  ACADEMY enrollment subscription system (`subscriptions.enrollment_id` FK).
  Completely different product. **Cannot be reused.**

**Resolution**: every new table/RPC/permission uses an unambiguous
`club_membership_` / `club_membership.` prefix:
`club_membership_plans`, `club_membership_subscriptions`,
`club_membership_freezes`; permissions `club_membership.*`.

## 2. Reference implementation: Academy subscriptions

The Academy `subscriptions`/`subscription_freezes` system is a proven,
production, structurally near-identical precedent (duration + price +
start/end date + freeze + renewal + activation-on-payment). Mirrored
directly rather than inventing new architecture:

- **One row per period, never mutated** — renewal never overwrites the old
  row; it inserts a brand-new row with a new `invoice_id`, leaving history
  intact. This alone satisfies "historical integrity" without a separate
  3rd "identity" table — the directive's own escape hatch ("إذا architecture
  الحالية تسمح بتحقيق نفس النتيجة ببنية أقل: يمكن استخدامها") applies.
- **Renewal is non-overlapping/sequential**: `renew_academy_subscription`
  requires the current row to be terminal (`not in ('pending','active',
  'frozen')`) before a new one can be created — this is the base pattern;
  Club Membership's EARLY renewal (Section 19 of the master directive)
  extends this by allowing renewal while still active, with the new row's
  `start_date` computed server-side as `current.end_date + 1 day`.
- **Freeze is date-range-based and derived, not "resume-computed"**:
  `subscription_freezes(start_date, end_date, extends_expiry)`, and
  `get_subscription_effective_end_date()` computes
  `base.end_date + sum(freeze durations where extends_expiry) `. The base
  `end_date` column is never mutated by freeze/unfreeze. `unfreeze` either
  deletes a not-yet-started freeze or truncates an in-progress one to
  today. This is more robust than an open-ended "frozen_at → resumed_at"
  model and is what Club Membership freeze mirrors exactly.
- **Activation gate**: `_activate_subscription_if_due_internal`, called
  from `record_payment` after allocating a payment to the linked invoice,
  flips `pending → active` once payment conditions are met, under
  `FOR UPDATE`. Academy has a per-club configurable policy
  (manual/first_payment/full_payment) — Club Membership does **not** need
  this configurability (directive requires simply: full completed payment
  activates); implemented as a direct, non-configurable rule.
- **Status transition protection**: a trigger
  (`protect_subscription_status_transitions`) blocks direct status writes
  outside a `set_config('app.allow_..._status_transition', 'true', true)`
  escape hatch set immediately before the sanctioned RPC's own UPDATE.
  Club Membership reuses this exact bypass-trigger pattern.
- **Display status is derived, never stored beyond the base states**:
  stored status wins for `expired/cancelled/frozen`; otherwise compared
  against `effective_end_date` at read time. No cron dependency required
  for correctness — matches directive Section 12 exactly.
- **Known pre-existing gap, explicitly NOT fixed**: `unfreeze_subscription`
  uses bare `current_date` (UTC session timezone), the same class of bug
  already fixed in Finance reports this session — but this is inside the
  Academy domain, explicitly baseline/off-limits. Club Membership's own
  RPCs use `club_local_day_bounds`-derived local-date logic from the start
  instead, so this defect class is not repeated in the new domain.

## 3. Payment/invoice integration (exact pattern to replicate)

`record_payment(p_invoice_id, ...)` already generically looks up ANY
pending row referencing the invoice and activates it — currently
hard-coded to the academy `subscriptions` table only. This RPC is widened
(the one necessary, minimal, explicit change to shared code) to also
check `club_membership_subscriptions` by `invoice_id`, calling a new
`_activate_club_membership_if_due_internal`. No other change to
`record_payment`'s existing behavior/formula.

`invoice_items.reference_type = 'club_membership'` /
`reference_id = club_membership_subscriptions.id` — same linkage style as
`reference_type = 'subscription'`.

`payments`/`payment_allocations`/`invoices`/`issue_invoice_number()` reused
completely unmodified otherwise. No new `club_membership_payments` table
(directive explicitly forbids this).

## 4. Customer linkage

Club Membership links directly to `customers.id` (no player/guardian
indirection needed, unlike Academy) — `club_membership_subscriptions.
customer_id uuid not null references customers(id)`. Staff-sale customer
search/create reuses `upsert_customer()` verbatim — no new customer RPC.

Customer photo: `customers.photo_url` already exists — no new column
needed for the digital card / QR scan display.

## 5. QR/Scanner

Single shared `qr_credentials` (`type` discriminator, `token_hash` =
`sha256(raw token)`, raw token = `gen_random_bytes(32)` hex, returned once)
+ `qr_scan_events` audit table. Existing `type` values: `booking`,
`player_membership`. Club Membership adds `type = 'club_membership'` to
this SAME machinery (not a new table), mirroring `ensure_player_qr`
(durable, `single_use=false`, `expires_at=null`) and extending
`qr_validate`'s type-branch to resolve `customers.full_name`/`photo_url`
and the membership's derived status. `qr_validate` already does tenant
validation (`wrong_club` diagnostic) and never trusts client-supplied
data — token lookup is always server-side.

## 6. Permission catalog

`src/lib/domain/permissionCatalog.ts` — add a new group
`club_membership` (or fold into a sensibly-named existing group) with
`club_membership.plan.view`, `club_membership.plan.manage` (sensitive,
requires plan.view), `club_membership.view`, `club_membership.create`
(requires view), `club_membership.renew` (requires view),
`club_membership.freeze` (requires view), `club_membership.cancel`
(sensitive, requires view), `club_membership.verify` (standalone, no
staff-management dependency — mirrors `cash.liability.view`'s
least-privilege pattern for the Scanner-only role). Every key is a real
row in `permissions` first (migration), then labeled in the catalog file
+ i18n, exactly matching the `cash.liability.*` precedent from this
session's own prior phase.

## 7. Customer Portal

New portal RPC `get_my_portal_club_memberships()` — SECURITY DEFINER,
hard-codes `customers.user_id = auth.uid()` inside the RPC body (NOT a
raw table select — this codebase explicitly closed that exact gap for
every other portal list endpoint). New route
`/portal/memberships` wrapped in `<RequirePortalCustomer>` (every child,
not just the parent — a previously-fixed gap in this same file).

## 8. Staff sale UI

Mirrors `EnrollmentSection.tsx`'s wizard-dialog structure: Customer
search/create → Plan select (locked price, discount only editable) →
start date (end date computed and shown, but SERVER remains the source of
truth — UI preview only) → price preview → one atomic sale RPC call. One
mutation call per sale, not client-orchestrated multi-step. Post-submit:
close dialog, deep-link to Finance payments for the actual collection
step (no duplicate payment form).

## 9. Audit

`write_audit_log(p_club_id, p_action, p_entity_type, p_entity_id,
p_before, p_after, p_reason)` — `actor_id` always server-derived. New
action strings (`club_membership_plan.created`, `club_membership.created`,
`club_membership.activated`, `club_membership.renewed`,
`club_membership.frozen`, `club_membership.resumed`,
`club_membership.cancelled`) added to the SAME `ACTION_LABELS`/
`ENTITY_LABELS` file in `src/lib/domain/audit.ts` — no parallel file.

## 10. Branch scope

No existing "plan available at N branches" join-table pattern exists
anywhere in the codebase (`groups.branch_id` is single-branch; staff
`membership_branches` is a different, staff-scope concept). Per the
directive's explicit ALL_BRANCHES/SELECTED_BRANCHES requirement, this
phase introduces the first such table: `club_membership_plan_branches
(plan_id, branch_id)` — empty set = all branches (mirroring
`user_has_branch_access`'s own "no rows = unrestricted" convention
exactly, for consistency of meaning across the whole app).

## 11. Navigation

New top-level `NavDomain = 'memberships'`, `NAV_DOMAIN_PERMISSIONS.
memberships = ['club_membership.view', 'club_membership.plan.view']`,
sidebar entry, lazy route `/app/memberships` wrapped in
`<RequireNavDomain domain="memberships">`. Never nested under Academy.

## 12. Date semantics baseline reused

`club_local_day_bounds(p_club_id, p_date)` (built in the prior Cash
Reconciliation phase) is reused directly for every "is this membership
active/expiring today" resolution — never `current_date` bare, never
browser timezone. Calendar-month/year arithmetic uses Postgres's native
`date + interval '1 month'` / `'1 year'` (correctly calendar-aware,
handles month-end/leap-year natively — verified in Section: DB Model).
