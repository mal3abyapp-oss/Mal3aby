# RLS Matrix

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. `club_memberships.branch_id` is replaced by the `membership_branches` join table (see [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column)); `qr_credentials` access rows are split into validate vs. confirm actions; `audit_logs` has no UPDATE policy for any role. See [RLS_SECURITY.md](RLS_SECURITY.md) for the mandatory `SECURITY DEFINER` function discipline this matrix assumes.

## Policy Pattern

Every tenant-scoped table follows this shape. See [ARCHITECTURE.md](ARCHITECTURE.md#rls-strategy) for the full helper-function code, and [RLS_SECURITY.md](RLS_SECURITY.md) for the mandatory rules every `SECURITY DEFINER` function must follow (pinned `search_path`, no trusting client-supplied `club_id`, `auth.uid()`-only identity, internal permission re-check, scoped `EXECUTE` grants, cross-tenant tests).

```sql
-- membership helper
create or replace function auth.user_club_ids() returns setof uuid
language sql security definer stable
set search_path = public, pg_temp as $$
  select club_id from club_memberships
  where user_id = auth.uid() and status = 'active'
$$;

-- permission helper
create or replace function auth.has_permission(p_key text, p_club_id uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp as $$
  select exists (
    select 1 from club_memberships cm
    join role_permissions rp on rp.role_id = cm.role_id
    join permissions p on p.id = rp.permission_id
    where cm.user_id = auth.uid()
      and cm.club_id = p_club_id
      and cm.status = 'active'
      and p.key = p_key
  )
$$;

-- branch-scope helper: true if the membership has no explicit branch rows (all branches)
-- or an explicit row matching the target branch
create or replace function auth.has_branch_access(p_membership_id uuid, p_branch_id uuid) returns boolean
language sql security definer stable
set search_path = public, pg_temp as $$
  select
    not exists (select 1 from membership_branches where membership_id = p_membership_id)
    or exists (
      select 1 from membership_branches
      where membership_id = p_membership_id and branch_id = p_branch_id
    )
$$;

-- SELECT: club membership is sufficient
create policy "select_own_club" on <table>
  for select using (club_id in (select auth.user_club_ids()));

-- INSERT/UPDATE: membership + specific permission
create policy "insert_with_permission" on <table>
  for insert with check (auth.has_permission('<table>.create', club_id));

create policy "update_with_permission" on <table>
  for update using (auth.has_permission('<table>.update', club_id));

-- DELETE: no policy at all on financial/operational tables — hard delete is impossible via RLS
```

**Branch-scoped roles** (Branch Manager, Receptionist) add a check against `auth.has_branch_access()` using the relevant `club_memberships.id` and the row's `branch_id`, resolving zero-rows-in-`membership_branches` as "all branches" per [DECISIONS.md ADR-015](DECISIONS.md#adr-015--membership-branch-scope-is-a-join-table-not-a-single-column). Platform Owner uses a separate bypass policy checked against a platform-level permission key, not `user_club_ids()`.

**Test requirement:** every table below ships with a pgTAP test proving User A (Club A member) cannot SELECT/INSERT/UPDATE a Club B row through any path — including a raw PostgREST call, not just the UI. See [TEST_PLAN.md](TEST_PLAN.md).

---

## Role × Table Matrix

Legend: **S**=Select, **I**=Insert, **U**=Update, **D**=Void/Reverse (status transition — never a hard `DELETE`, see [PROJECT_RULES.md](PROJECT_RULES.md) rule 3). `–` = no access. `(own)` = restricted to their own club/branch/assignment.

| Table | Platform Owner | Club Owner | Club Manager | Branch Manager | Receptionist | Accountant | Academy Manager | Coach | Scanner |
|---|---|---|---|---|---|---|---|---|---|
| `clubs` | S,I,U | S,U (own) | S | S | S | S | S | – | – |
| `branches` | S,I,U | S,I,U | S,I,U | S,U (own) | S | S | S | – | – |
| `club_memberships` (staff) | S,I,U,D | S,I,U,D | S,I,U | S (branch) | – | – | – | – | – |
| `membership_branches` | S,I,U,D | S,I,U,D | S,I,U | S (own) | – | – | – | – | – |
| `customers` | S | S,I,U | S,I,U | S,I,U | S,I,U | S | S,I,U | – | – |
| `players` (excludes `medical_notes`) | S | S,I,U | S,I,U | S,I,U | S,I | S | S,I,U | S (assigned groups) | – |
| `players.medical_notes` (gated column) | S* | S,U* | S,U* | – | – | – | S,U | S* (assigned only) | – |
| `guardian_links` | S | S,I,U | S,I,U | S,I,U | S,I | S | S,I,U | – | – |
| `fields` | S | S,I,U | S,I,U | S,U | S | S | S | S | – |
| `field_operating_hours` / `field_blocks` | S | S,I,U | S,I,U | S,U | S | S | S | S | – |
| `pricing_rules` | S | S,I,U | S,I,U | S,U | S | S | – | – | – |
| `bookings` | S | S | S,I,U,D | S,I,U,D | S,I,U,D | S | – | – | – |
| `invoices` | S | S | S,I,U | S,I | S,I | S,I,U,D | S,I | – | – |
| `invoice_items` | S | S | S,I,U | S,I | S,I | S,I,U | S,I | – | – |
| `payments` (no `invoice_id` column) | S | S | S | S | S,I | S,I,U,D | – | – | – |
| `payment_allocations` | S | S | S | S | S | S,I,U | – | – | – |
| `refunds` | S | S | S,I | S | – | S,I | – | – | – |
| `qr_credentials` (validate only) | S | S | S,I | S,I | S,I | – | S,I | S (assigned, player type) | S (validate only) |
| `qr_credentials` (confirm/consume via RPC) | S | S | S,I,U | S,I,U | S,I,U | – | S,I,U | – | S (booking check-in confirm) |
| `qr_scan_events` (insert via RPC only, never direct) | S (all) | S (own club) | S (own club) | S (own branch) | S (own scans) | – | S (own club) | S (own scans) | S (own scans) |
| `programs` / `seasons` / `age_groups` | S | S | S,I,U | S,I,U | S | – | S,I,U,D | – | – |
| `groups` / `group_schedule_slots` | S | S | S,I,U | S,I,U | S | – | S,I,U,D | S (assigned, read-only) | – |
| `enrollments` | S | S | S,I,U | S | S | S | S,I,U | S (assigned) | – |
| `subscriptions` | S | S | S,I,U | S | S | S | S,I,U | – | – |
| `subscription_freezes` | S | S | S,I | S | – | – | S,I | – | – |
| `training_sessions` | S | S | S | S | S | – | S,I,U | S,I,U (assigned only) | – |
| `attendance` | S | S | S | S | – | – | S | S,I,U (assigned sessions only) | S (QR check-in only) |
| `audit_logs` (**no UPDATE for any role**) | S (all) | S (own club) | S (own club) | S (own branch) | – | – | – | – | – |
| Reports (RPCs) | S (all clubs) | S (own club) | S (own club) | S (own branch) | – | S (financial) | S (academy) | – | – |

\* `players.medical_notes` visibility requires the explicit `player.medical_notes.view`/`.update` permission — see [DECISIONS.md ADR-019](DECISIONS.md#adr-019--medical-notes-are-a-permission-gated-field-not-a-default-visible-one) and the column-protection pattern in [RLS_SECURITY.md](RLS_SECURITY.md#sensitive-column-protection-medical_notes). Platform Owner's `S*` here means "can view if the permission model grants it," not an automatic bypass — Platform Owner does not need routine access to individual clubs' medical data.

**Customer (future portal) role:** intentionally has no row in this matrix — no portal access exists in V1 (see [PROJECT_BRIEF](../README.md), Section 14). The `customers`/`players` schema does not block adding scoped self-service RLS later; it simply isn't granted yet.

---

## Audit Trigger Scope

Per [PROJECT_BRIEF](../README.md) Section 58, these actions always write an `audit_logs` row (actor, action, entity, before/after, timestamp, `club_id`, `branch_id`, reason where applicable):

- Booking cancellation
- Price / discount edits
- Payment void
- Refund
- Subscription freeze
- Manual status change (booking, subscription, enrollment)
- Permission / role changes (`club_memberships`, `membership_branches`, `role_permissions`)
- Club suspension/reactivation
- Manual QR override (offline fail-closed fallback — see [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy))

Implementation: table triggers for simple before/after captures on direct mutations; explicit `audit_logs` inserts inside RPCs for business actions that don't map to a single row UPDATE (e.g. refund, freeze). **`audit_logs` itself accepts `INSERT` only from these trusted triggers/RPCs (`SECURITY DEFINER`) — never a direct client insert, and never any `UPDATE`/`DELETE` from any role** (see [DECISIONS.md ADR-020](DECISIONS.md#adr-020--audit-logs-are-immutable-no-role-can-update-or-delete-them)).

`qr_scan_events` follows the same insert-only-via-RPC pattern — see [DATABASE_BLUEPRINT.md](DATABASE_BLUEPRINT.md#qr_scan_events).

---

## Verification Checklist (Phase 2 gate)

For at least `bookings`, `invoices`, `payments`, and `customers`:

- [ ] User A (Club A membership) SELECT on Club B row → 0 rows returned
- [ ] User A INSERT into Club B (`club_id` spoofed in payload) → rejected
- [ ] User A UPDATE on Club B row → 0 rows affected
- [ ] User A DELETE attempt on any financial table → rejected (no policy exists)
- [ ] User A/any role UPDATE or DELETE attempt on `audit_logs` → rejected (no policy exists for any role)
- [ ] Direct PostgREST call (not through app code) with User A's JWT against Club B data → same denials as above
- [ ] Receptionist without `payment.refund` permission → refund INSERT rejected
- [ ] Receptionist without `player.medical_notes.view` → `medical_notes` not present in player query result
- [ ] Coach → sees only `training_sessions`/`attendance` for their assigned groups, nothing else
- [ ] Branch Manager with an explicit `membership_branches` row for Branch 1 only → cannot act on Branch 2 data of the same club
- [ ] Branch Manager with zero `membership_branches` rows → can act across all branches of their club
- [ ] Platform Owner → SELECT succeeds across multiple clubs
- [ ] Every `SECURITY DEFINER` function → cross-tenant call rejected (see [RLS_SECURITY.md](RLS_SECURITY.md#verification-checklist-part-of-phase-14-gate) for the full function-level checklist)
