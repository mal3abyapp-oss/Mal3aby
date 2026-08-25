# Current Authorization Model (Discovery — Stage 1)

> Produced 2026-08-25 as Stage 1 of the **STAFF ACCESS CONTROL & CUSTOM ROLES** phase, before any implementation. Pure read-only investigation of the live Supabase project (`gxkrtlvpjwxhcqdisyob`) and the repo. Nothing in this document was modified to make it true — it records what already exists.

## Model shape today

```
User (auth.uid())
  └─ club_memberships (user_id, club_id, role_id, status, has_cash_custody)   -- ONE role per membership, per club
        ├─ roles (id, key, name, name_ar)                                     -- GLOBAL, 9 fixed rows, no club_id
        │     └─ role_permissions (role_id, permission_id)                    -- GLOBAL many-to-many
        │           └─ permissions (id, key, description)                     -- GLOBAL, 51 fixed rows
        └─ membership_branches (membership_id, branch_id)                    -- empty = all branches
              ↓
        has_permission(key, club_id)  /  user_has_branch_access(club_id, branch_id)  /  has_branch_access(membership_id, branch_id)
              ↓
        RLS policies (real security boundary) + RPC bodies (SECURITY DEFINER, re-check has_permission)
              ↓
        Frontend: roleKey-string checks (nav visibility / route redirect) — UX only, not a security boundary
```

## 1 — `roles` / `permissions` / `role_permissions`: global, read-only via RLS, no club scoping

- `roles` columns: `id, key, name, name_ar`. **No `club_id` column.** `UNIQUE(key)`.
- Exactly one `SELECT`-only RLS policy on each of `roles`, `permissions`, `role_permissions` (`qual: auth.uid() IS NOT NULL`). **Zero INSERT/UPDATE/DELETE policies exist on any of the three** — RLS is enabled *and forced*, so even `platform_owner` cannot write to them through PostgREST today (unlike `clubs`/`club_memberships`, which each have an explicit platform-owner ALL-policy). The seed migration says so directly:
  > `-- Reference/seed data: readable by any authenticated user, never user-editable in V1 (no INSERT/UPDATE/DELETE policy exists).` (`20260815120000_phase2_identity_multitenant_rls.sql:301-305`)
  > Table comment: `'Seeded role catalogue -- reference/labeling only. Authorization decisions use permissions, never role keys (ADR-014).'`
- **Confirmed with certainty: the 9 roles and 51 permissions are a single global catalogue shared identically by every club on the platform.** There is no data-model seam today for Club A's "receptionist" to differ from Club B's, or for a club to add a 10th role. Every `invite_staff_member`/`set_staff_role` call resolves `p_role_key` against this same shared table for every club in the system.
- **Implication for this phase: custom per-club roles require new schema. This is not a case where the existing tables "can be extended" by just adding rows — the RLS/ownership model of `roles` itself is global-and-locked by design (ADR-014), and correctly so for the 9 system roles. The new capability is additive alongside it, not a rewrite of it.**

## 2 — Real roles (9) and permissions (51 keys) today

| role key | name_ar | active memberships (production) |
|---|---|---|
| club_owner | صاحب النادي | 7 |
| coach | مدرب | 2 |
| platform_owner | مالك المنصة | 2 |
| scanner | ماسح QR | 2 |
| academy_manager | مدير الأكاديمية | 1 |
| receptionist | موظف استقبال | 1 |
| branch_manager | مدير الفرع | 1 |
| club_manager | مدير النادي | 1 |
| accountant | محاسب | 1 |

51 permission keys exist, spanning: `booking.*` (create/update/cancel/view/discount.apply/discount.override), `customer.*` (create/update/view), `player.*` (create/update/view/medical_notes.view/medical_notes.update), `enrollment.*`, `subscription.*` (+freeze.create), `session.*`, `attendance.*`, `invoice.*`, `payment.*` (create/view/refund/verify/methods.view/methods.manage), `field.*`, `branch.*`, `club.update`, `pricing.*`, `qr.scan`/`qr.checkin.confirm`, `report.view`, `staff.*` (create/update — **no staff.suspend/staff.reactivate/staff.role.assign as distinct keys; all staff-mutation RPCs currently gate on the single `staff.update` key**), `notification.view`, `manage_whatsapp_connection`, `academy.group.manage`, `academy.program.manage`.

**No `roles.*`/`roles.create`/`roles.update`/`roles.delete`/`finance.*`-prefixed keys exist today.** Finance-domain actions are split across `payment.*`/`invoice.*`/existing receipt RPCs' own `has_permission` checks (official-receipt issue/correct/reverse use permission keys established in earlier rounds of this project, outside this document's re-derivation scope) rather than a unified `finance.*` namespace.

## 3 — `has_permission()` is the real, consistently-used enforcement primitive

```sql
create or replace function public.has_permission(p_key text, p_club_id uuid)
returns boolean language sql security definer stable
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.club_memberships cm
    join public.role_permissions rp on rp.role_id = cm.role_id
    join public.permissions p on p.id = rp.permission_id
    where cm.user_id = auth.uid() and cm.club_id = p_club_id
      and cm.status = 'active' and p.key = p_key
  )
$$;
```
Used across ~50 tenant-scoped tables' RLS policies and inside nearly every write-path RPC body. **This is the correct pattern already in place — capability-based, not role-name-based — and this phase must keep using it, not replace it.**

### The narrow, deliberate exceptions to permission-key-based checks (not violations to "fix" — documented by design)
- `is_platform_owner()` checks `r.key = 'platform_owner'` directly — the one ADR-014-documented exception.
- `audit_logs` RLS: role-name-gated (`club_owner`/`club_manager`/`branch_manager`) rather than a permission key.
- 5 academy-content SELECT policies (`age_groups`, `group_schedule_slots`, `groups`, `programs`, `seasons`) exclude `accountant`/`scanner`/`coach` by name rather than requiring a permission key.
- `invite_staff_member`/`set_staff_role` block `p_role_key = 'platform_owner'` by literal string match — the only escalation guard that exists anywhere (see §5).

## 4 — Branch scope: real for operational/financial writes, absent for customer/academy-catalogue domains

`user_has_branch_access(club_id, branch_id)` / `has_branch_access(membership_id, branch_id)`: empty `membership_branches` rows for a membership = "all branches"; otherwise scoped to the listed branches. `is_platform_owner()` always bypasses.

**Branch-filtered today**: `attendance`, `bookings`, `booking_series`, `branches`, `enrollments`, `field_blocks`, `field_operating_hours`, `fields`, `groups`, `invoice_items`, `invoice_number_sequences`, `invoices`, `official_collection_receipts`, `payment_allocations`, `payments`, `pricing_rules`, `subscriptions`, `training_sessions`, `audit_logs` (branch_manager only).

**Club-scoped only, no branch filter** (a receptionist scoped to Branch A still sees/writes every row club-wide in these): `customers`, `players`, `guardian_links`, `portal_invites`, `age_groups`/`programs`/`seasons`/`group_schedule_slots` (these use role-name exclusion instead), `manual_payment_claims`, `refunds`, `qr_scan_events`.

**This is a real, pre-existing gap this phase inherits, not something broken by a prior round.** Extending branch scope into the customer/player/academy domains is in scope for Stage 5 only if a specific new custom-role combination in this phase actually needs it to be safe (e.g. a branch-scoped "reception" custom role that must not see another branch's customers) — otherwise it is recorded and deferred, not silently expanded.

## 5 — No privilege-escalation guard, no sole-owner protection (today)

- `invite_staff_member`, `set_staff_role`: gated on `staff.create`/`staff.update`; **block only the literal string `p_role_key = 'platform_owner'`.** A `club_manager` holding `staff.update` can promote anyone to `club_owner` today — no "can't grant a role stronger than your own" check exists.
- `deactivate_staff_member`/`set_staff_role`/`set_staff_branch_scope`/`set_staff_cash_custody`: no check anywhere for "is this the club's only active `club_owner`". A club can reach zero active owners today with no trigger/constraint stopping it. The only relevant trigger, `protect_club_membership_identity_columns`, guards against a *direct table UPDATE* changing `role_id`/`club_id`/`user_id` outside the RPC layer — it does not protect the RPCs themselves from removing the last owner.
- Frontend `StaffPage.tsx`'s `ASSIGNABLE_ROLES` list simply omits `club_owner`/`platform_owner` from its `<Select>` (UI-only) — a crafted RPC call bypassing the dropdown can still reach `club_owner` today, only `platform_owner` is actually server-blocked.

**These two gaps (no escalation guard beyond platform_owner, no sole-owner protection) are exactly what Sections 7 and 21 of this phase's directive require closing — real, proven, pre-existing gaps, not invented ones.**

## 6 — `audit_logs` / `write_audit_log` / `employee_cash_liabilities`

`audit_logs`: `id, club_id, branch_id, actor_id, action, entity_type, entity_id, before, after, reason, created_at`.
`write_audit_log(p_club_id, p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason)` — does **not** currently accept/write `branch_id`, even though the column exists and `audit_logs`' own RLS checks `branch_id IS NOT NULL` for branch_manager visibility. Pre-existing gap, noted, not fixed unless this phase's own new audit actions need it.

Existing staff/role audit actions already logged: `staff.branch_scope.set`, `staff.cash_custody.set`, `staff.invited`, `staff.reactivated`, `staff.role_changed`, `staff.suspended`.

`employee_cash_liabilities`: `id, club_id, branch_id, cash_shift_id, employee_id, kind, original_amount, outstanding, status, created_at, updated_at`.

## 7 — Frontend enforcement is 100% `roleKey`-string-based UX, never calls `has_permission()`

- The frontend never calls `supabase.rpc('has_permission', ...)`. Nav visibility, route redirects, and conditional UI are all `roleKey === '...'` string comparisons.
- `RequireNavDomain`/`RequirePlatformOwner` (`src/app/routing/RequireAuth.tsx`) are explicitly self-documented as UX-only, stating RLS is the real boundary.
- `src/lib/domain/navigation.ts`'s `ROLE_NAV_DOMAINS` is a **hand-maintained mirror** of `role_permissions`, self-documented as capable of drifting out of sync silently, and **fails open** (any unrecognized role key defaults to seeing every nav domain). This is the exact "just hiding a button" pattern the phase directive calls out — nav visibility today is not derived from real permissions at all, and a naive new custom role would default to seeing everything in the nav unless explicitly added to this map.
- Every sensitive write path found (`StaffPage.tsx`'s role dropdown, `SettingsPage.tsx`, `EntitlementsCard.tsx`, etc.) has its real enforcement in RLS/RPC `has_permission()` checks underneath the UI gate — confirmed no case where a `roleKey===` check is the *only* enforcement of a sensitive write, except the two escalation gaps in §5.

## 8 — Migration convention for adding permissions (to follow in Stage 3+)

Established pattern, confirmed across ~12 migrations:
```sql
insert into public.permissions (key, description) values ('domain.action', 'description') on conflict (key) do nothing;
insert into public.role_permissions (role_id, permission_id)
  select r.id, p.id from public.roles r, public.permissions p
  where r.key = '<role>' and p.key in ('domain.action', ...)
  on conflict do nothing;
```

## 9 — Numbers for backward-compatibility (Stage 4)

18 active memberships across 6 clubs with active staff; every one resolves to one of the 9 existing role keys (structurally guaranteed by the FK). No orphaned/unknown role currently in use.

## What this means for Stage 2+ (facts, not proposals)

1. Custom per-club roles = new schema (`club_roles` or similar, club-scoped, with its own permission-assignment join table) that **sits alongside**, not replaces, the existing global `roles`/`permissions`/`role_permissions`. System roles keep working exactly as today.
2. `has_permission()` is the right foundation to extend (widen its lookup to also check the new custom-role path) — not to replace.
3. Two real, pre-existing security gaps must be closed as part of this phase, server-side: privilege escalation beyond platform_owner, and sole-owner removal.
4. Frontend nav-permission derivation needs to move from the hand-maintained `ROLE_NAV_DOMAINS` fail-open map to a real permission-derived (ideally server-confirmed) model — this is Stage 8/9's actual starting point.
5. Branch-scope gaps in customer/player/academy domains are pre-existing and out of scope unless a specific new custom role in this phase requires closing them for safety.
