# Commercial Permission Matrix

## Permission catalog

| Key | Meaning | Depends on |
|---|---|---|
| `shop.view` | View shop: products, sales, returns | — |
| `shop.product.manage` | Create/edit/archive products and variants | `shop.view` |
| `shop.sale.create` | Sell products at the point of sale | `shop.view` |
| `shop.sale.refund` | Process returns and refunds | `shop.view` |
| `inventory.view` | View inventory balances and movement history | — |
| `inventory.receive` | Receive new stock into a location | `inventory.view` |
| `inventory.adjust` | Record stock adjustments, damage, and loss | `inventory.view` |
| `inventory.transfer` | Transfer stock between locations | `inventory.view` |
| `inventory.count` | Run and confirm physical stock counts | `inventory.view` |
| `inventory.cost.view` | View product cost/margin data | `inventory.view` |

All 10 keys live in the existing `permissions` table (same table every
other club-scoped permission uses — no second permission system) and
are wired into the existing `permission_dependencies` table for
server-side dependency enforcement, matching the project's own
established convention.

## Default role matrix (seeded, live-verified)

| Role | shop.view | shop.product.manage | shop.sale.create | shop.sale.refund | inventory.view | inventory.receive | inventory.adjust | inventory.transfer | inventory.count | inventory.cost.view |
|---|---|---|---|---|---|---|---|---|---|---|
| `club_owner` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `accountant` | ✅ | — | — | ✅ | ✅ | — | — | — | — | ✅ |
| `receptionist` | ✅ | — | ✅ | — | — | — | — | — | — | — |
| `branch_manager` / `club_manager` / `academy_manager` / `coach` / `scanner` | — | — | — | — | — | — | — | — | — | — |

Reasoning (not arbitrary — mirrors each role's existing posture on the
equivalent booking/finance permissions):

- `club_owner`: full superset, matching its existing unconditional
  access to every other permission.
- `accountant`: financial visibility (view + cost + refund) but no
  product/inventory mutation — mirrors its existing lack of
  `booking.create`/`field.create`. It verifies money, it doesn't
  operate the floor.
- `receptionist`: can sell (view + sale.create) but not refund, not
  inventory mutation, not product management — mirrors its existing
  lack of `payment.refund`/`pricing.update`.
- Every other existing system role: none by default. Shop is a new
  domain these roles were never scoped for; a club owner grants access
  explicitly (via a custom role or a future direct role-permission
  edit) if their operating model needs it — the seed migration never
  silently expands what an existing role can already do.

## Custom roles

The existing `club_roles`/`club_role_permissions` custom-role machinery
is reused unmodified. `permission_set_escalates()` (the existing
escalation guard used by every role-CRUD RPC) applies to `shop.*`/
`inventory.*` keys exactly as it does to every other key — a
non-owner cannot grant a custom role a Shop/Inventory permission they
don't hold themselves.

The Role Editor UI groups these 10 keys into two real groups — "Store /
Shop" and "Inventory" (directive Section 6's own explicit "Group
clearly" instruction) — with human-readable labels/descriptions, never
raw permission keys as the primary label.

## Platform-side authorization (separate domain)

Shop/Inventory has no platform-level permission of its own — a
Platform Owner or Platform Staff member accesses club Shop data
exclusively through the existing Master Admin support-session
mechanism:

- `has_platform_support_access(club_id, p_require_manage)` gates every
  Shop write RPC identically to how it gates the Master Admin core
  RPCs (club role CRUD, staff role assignment).
- Starting a MANAGE support session itself requires
  `platform.support.start_manage` (or `is_platform_owner()`); a VIEW
  session requires `platform.support.start_view`.
- Platform Staff Shop management is therefore governed entirely by the
  existing Platform Roles system (`platform.support.start_view`/
  `start_manage`, `platform.club.view`/`manage`) — not a new,
  parallel Shop-specific platform permission.

Live-verified: a restricted Platform Staff role holding only
`platform.club.view` + `platform.support.start_view` can read Shop
data via a VIEW session but is denied both direct mutation and any
attempt to escalate to a MANAGE session — the same
dynamic-enforcement pattern already proven for the Platform Staff core
feature.

## Live security verification summary

| Test | Result |
|---|---|
| VIEW-mode support session, Shop mutation attempt | DENIED |
| MANAGE-mode support session, Shop mutation | ALLOWED, correctly attributed (`acting_as_platform_admin=true`) |
| Cross-club Shop mutation while a different club's support session is active | DENIED |
| Restricted Platform Staff (VIEW-only), Shop read via VIEW session | ALLOWED |
| Restricted Platform Staff (VIEW-only), Shop mutation via VIEW session | DENIED |
| Restricted Platform Staff (VIEW-only), attempt to start a MANAGE session | DENIED |
| Ordinary club owner, platform-only `set_club_module_entitlement` | DENIED |
| Ordinary club owner, cross-club product/location injection | DENIED |
