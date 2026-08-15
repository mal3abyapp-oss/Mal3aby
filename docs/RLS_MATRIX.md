# RLS Matrix

## Policy Pattern

Every tenant-scoped table follows this shape. See [ARCHITECTURE.md](ARCHITECTURE.md#rls-strategy) for the full helper-function code.

```sql
-- membership helper
create or replace function auth.user_club_ids() returns setof uuid
language sql security definer stable as $$
  select club_id from club_memberships
  where user_id = auth.uid() and status = 'active'
$$;

-- permission helper
create or replace function auth.has_permission(p_key text, p_club_id uuid) returns boolean
language sql security definer stable as $$
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

Branch-scoped roles add `and (cm.branch_id is null or cm.branch_id = <table>.branch_id)` to the permission check. Platform Owner uses a separate bypass policy checked against a platform-level permission key, not `user_club_ids()`.

**Test requirement:** every table below ships with a pgTAP test proving User A (Club A member) cannot SELECT/INSERT/UPDATE a Club B row through any path — including a raw PostgREST call, not just the UI. See [TEST_PLAN.md](TEST_PLAN.md).

---

## Role × Table Matrix

Legend: **S**=Select, **I**=Insert, **U**=Update, **D**=Void/Reverse (status transition — never a hard `DELETE`, see [PROJECT_RULES.md](PROJECT_RULES.md) rule 3). `–` = no access. `(own)` = restricted to their own club/branch/assignment.

| Table | Platform Owner | Club Owner | Club Manager | Branch Manager | Receptionist | Accountant | Academy Manager | Coach | Scanner |
|---|---|---|---|---|---|---|---|---|---|
| `clubs` | S,I,U | S,U (own) | S | S | S | S | S | – | – |
| `branches` | S,I,U | S,I,U | S,I,U | S,U (own) | S | S | S | – | – |
| `club_memberships` (staff) | S,I,U,D | S,I,U,D | S,I,U | S (branch) | – | – | – | – | – |
| `customers` | S | S,I,U | S,I,U | S,I,U | S,I,U | S | S,I,U | – | – |
| `players` | S | S,I,U | S,I,U | S,I,U | S,I | S | S,I,U | S (assigned groups) | – |
| `guardian_links` | S | S,I,U | S,I,U | S,I,U | S,I | S | S,I,U | – | – |
| `fields` | S | S,I,U | S,I,U | S,U | S | S | S | S | – |
| `field_operating_hours` / `field_blocks` | S | S,I,U | S,I,U | S,U | S | S | S | S | – |
| `pricing_rules` | S | S,I,U | S,I,U | S,U | S | S | – | – | – |
| `bookings` | S | S | S,I,U,D | S,I,U,D | S,I,U,D | S | – | – | – |
| `invoices` | S | S | S,I,U | S,I | S,I | S,I,U,D | S,I | – | – |
| `invoice_items` | S | S | S,I,U | S,I | S,I | S,I,U | S,I | – | – |
| `payments` | S | S | S | S | S,I | S,I,U,D | – | – | – |
| `payment_allocations` | S | S | S | S | S | S,I,U | – | – | – |
| `refunds` | S | S | S,I | S | – | S,I | – | – | – |
| `qr_credentials` | S | S | S,I | S,I | S,I | – | S,I | – | S (validate/consume only) |
| `programs` / `seasons` / `age_groups` | S | S | S,I,U | S,I,U | S | – | S,I,U,D | – | – |
| `groups` / `group_schedule_slots` | S | S | S,I,U | S,I,U | S | – | S,I,U,D | S (assigned, read-only) | – |
| `enrollments` | S | S | S,I,U | S | S | S | S,I,U | S (assigned) | – |
| `subscriptions` | S | S | S,I,U | S | S | S | S,I,U | – | – |
| `subscription_freezes` | S | S | S,I | S | – | – | S,I | – | – |
| `training_sessions` | S | S | S | S | S | – | S,I,U | S,I,U (assigned only) | – |
| `attendance` | S | S | S | S | – | – | S | S,I,U (assigned sessions only) | S (QR check-in only) |
| `audit_logs` | S (all) | S (own club) | S (own club) | S (own branch) | – | – | – | – | – |
| Reports (RPCs) | S (all clubs) | S (own club) | S (own club) | S (own branch) | – | S (financial) | S (academy) | – | – |

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
- Permission / role changes (`club_memberships`, `role_permissions`)
- Club suspension/reactivation
- Manual QR override (offline fail-closed fallback — see [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy))

Implementation: table triggers for simple before/after captures on direct mutations; explicit `audit_logs` inserts inside RPCs for business actions that don't map to a single row UPDATE (e.g. refund, freeze).

---

## Verification Checklist (Phase 2 gate)

For at least `bookings`, `invoices`, `payments`, and `customers`:

- [ ] User A (Club A membership) SELECT on Club B row → 0 rows returned
- [ ] User A INSERT into Club B (`club_id` spoofed in payload) → rejected
- [ ] User A UPDATE on Club B row → 0 rows affected
- [ ] User A DELETE attempt on any financial table → rejected (no policy exists)
- [ ] Direct PostgREST call (not through app code) with User A's JWT against Club B data → same denials as above
- [ ] Receptionist without `payment.refund` permission → refund INSERT rejected
- [ ] Coach → sees only `training_sessions`/`attendance` for their assigned groups, nothing else
- [ ] Platform Owner → SELECT succeeds across multiple clubs
