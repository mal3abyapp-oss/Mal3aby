# Staff Permission Matrix

> Produced 2026-08-26 as part of the **STAFF ACCESS CONTROL & CUSTOM ROLES** phase. This is a **default-recommendation reference only** — the actual source of truth for what any role can do is always the live `role_permissions` (system roles) / `club_role_permissions` (custom roles) tables in the database, resolved server-side by `has_permission()`. A Custom Role can differ from every row below; this table exists to document what the 9 seeded system roles carry as of this phase, verified live via SQL.

| Permission | Owner | Manager | Branch Mgr | Reception | Accountant | Academy Mgr | Coach | Scanner |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| booking.view | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| booking.create | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| booking.update | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| booking.cancel | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| customer.view | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| customer.create | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| player.view | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| enrollment.view | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| attendance.mark | ✅ | ✅ | ✅ | — | — | ✅ | ✅ | — |
| payment.view | ✅ | ✅ | ✅ | ✅ | ✅ | — | — | — |
| payment.create | ✅ | ✅ | ✅ | ✅ | — | — | — | — |
| payment.refund | ✅ | — | — | — | — | — | — | — |
| invoice.view | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | — |
| report.view | ✅ | ✅ | ✅ | — | ✅ | — | — | — |
| staff.view | ✅ | ✅ | — | — | — | — | — | — |
| staff.create | ✅ | ✅ | — | — | — | — | — | — |
| staff.update | ✅ | ✅ | — | — | — | — | — | — |
| roles.view | ✅ | ✅ | — | — | — | — | — | — |
| roles.manage | ✅ | ✅ | — | — | — | — | — | — |
| club.update | ✅ | — | — | — | — | — | — | — |
| branch.update | ✅ | — | ✅ | — | — | — | — | — |
| field.update | ✅ | — | ✅ | — | — | — | — | — |
| qr.scan | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |
| qr.checkin.confirm | ✅ | ✅ | ✅ | ✅ | — | — | ✅ | ✅ |

**Full detail** (all 54 permission keys, verified live per role): see `role_permissions` in the DB, or `list_club_roles()` / `get_club_role_permissions()` RPCs from the Roles UI (`/app/staff/roles`), which always reflect the live, current truth.

## Verified live (SERVER VERIFIED, 2026-08-26)

Every ✅/— above for Reception, Accountant, Coach, Scanner, Club Manager was empirically confirmed via SQL-level RLS impersonation against real production fixture identities on club `6ca5315e-e199-4531-9fb1-1df358cda087` — not inferred from the seed migration alone. See the phase's final report for the exact query results.

## Custom role example (acceptance test)

A custom role named "Evening Booking Officer" / "مسؤول حجوزات مسائي" was created with exactly `booking.view` and assigned to a real fixture membership, then verified live:

| Check | Result |
|---|---|
| Sees bookings | ✅ true |
| Can create booking | ❌ false |
| Sees finance | ❌ false |
| Sees staff | ❌ false |
| Sees customers | ❌ false |
| Sees settings | ❌ false |

This matches the user's own explicit acceptance example verbatim. The test role and its temporary assignment were both cleaned up after verification — zero QA residue left in production.
