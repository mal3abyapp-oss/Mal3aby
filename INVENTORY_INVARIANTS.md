# Inventory Invariants

Enforced server-side, verified live. See COMMERCIAL_DOMAIN_ARCHITECTURE.md
for full schema/RPC context; this document lists the specific
invariants and how each is enforced.

## 1. Balance is never manually editable

`shop_inventory_balances` has no INSERT/UPDATE/DELETE RLS policy for
any client role. The only write path is
`_apply_shop_inventory_movement_internal()`, a `SECURITY DEFINER`
function revoked from `authenticated`/`anon`/`public` — reachable only
from other `SECURITY DEFINER` functions (`receive_shop_stock`,
`transfer_shop_stock`, `adjust_shop_stock`, `create_shop_sale`,
`return_shop_sale`), never directly.

## 2. Every balance change has exactly one corresponding movement row

`_apply_shop_inventory_movement_internal()` inserts into
`shop_inventory_movements` in the same statement it updates
`shop_inventory_balances` — there is no code path that updates one
without the other.

## 3. Stock never goes negative

`_apply_shop_inventory_movement_internal()` checks
`v_current_on_hand < p_quantity` before applying an `'out'`-direction
movement and raises `insufficient stock: X available, Y requested`.
Live-verified: depleting a balance to exactly zero then attempting one
more unit out is denied cleanly.

## 4. Concurrency: exactly one writer wins per (location, product, variant)

`_apply_shop_inventory_movement_internal()` locks the balance row with
`SELECT ... FOR UPDATE` before reading/checking/updating it, inside the
caller's own transaction. Two concurrent decrements against the same
row serialize on this lock — the second to acquire it sees the
already-decremented balance and is correctly denied if it would go
negative.

**Evidence label: ARCHITECTURALLY CONCURRENCY VERIFIED** — row-locking
is a well-established Postgres mechanism, not a novel technique, but
true parallel execution was not directly demonstrated in this session's
testing (the SQL tool used is inherently sequential). Sequential
depletion (10 → 5 → 0 → denied) was live-verified and confirms the
non-negative guarantee holds under the same code path a concurrent
writer would take.

## 5. One (location, product, variant) has exactly one balance row

Enforced by a unique index on
`(location_id, product_id, COALESCE(variant_id, <sentinel-uuid>))`.

**Historical note**: the original implementation used a plain
`UNIQUE (location_id, product_id, variant_id)` constraint, which never
conflicts when `variant_id IS NULL` (SQL's own NULL-inequality
semantics) — silently duplicating a balance row on every movement for
every non-variant product. Found by adversarial testing, already
corrupting two real products before the fix. See
COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 10 for the full writeup and
repair procedure. Live-reverified clean after the fix — a fresh
sequence of movements on the same product stays at exactly one row.

## 6. Every movement records its cause

`reference_type`/`reference_id` link a movement back to the business
event that caused it (`shop_sale`, `shop_sale_return`, `shop_transfer`,
`shop_supplier`) wherever one exists. Adjustment/damage/loss movements
instead require a non-null `reason` (table CHECK constraint), since
there is no other business-event row to point at.

## 7. Cross-club/cross-location isolation

Every write RPC re-derives `club_id` from the location row itself
(never trusts a client-supplied club_id for authorization) and checks
`has_permission(..., v_club_id)`. `transfer_shop_stock` additionally
checks `v_club_id != v_dest_club_id` explicitly. Live-verified: transfer
across two different clubs' locations denied; receive against another
club's location denied even for an authorized user of the caller's own
club.

## 8. Archived products/variants cannot receive NEW sales

`create_shop_sale()` filters `status = 'active'` on both
`shop_products` and `shop_product_variants` when resolving a sale line
— independent of any UI filtering. Live-verified: archiving a product
mid-session, then attempting to sell it, is denied with `product not
found or inactive`. Same for a variant.

## 9. Idempotency on sale and return

`create_shop_sale` and `return_shop_sale` both accept an optional
`p_idempotency_key`, scoped `(club_id, key)` uniquely (mirroring
`payments.idempotency_key`'s own established pattern). A retried call
with the same key returns the original operation's id instead of
creating a duplicate. Live-verified for both RPCs: identical key twice
→ one sale/return, one payment, one set of inventory movements.
