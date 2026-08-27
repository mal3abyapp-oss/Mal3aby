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
`create_shop_sale` also carries its own `shop_sales.idempotency_key`
(unique per club) to correctly dedupe the zero-payment case, where a
retried partial/unpaid sale would otherwise have no `payments` row to
match on.

## 10. Stock deduction is unconditional on payment completeness

`create_shop_sale()` deducts stock for every line item in the same
transaction that creates the invoice, before any `payments` row is
inserted, and does so identically whether `p_payment_amount` equals the
full subtotal, a smaller partial amount, or zero. Live-verified: a sale
for 2 units at 100 each (subtotal 200) created with `p_payment_amount =
120` immediately deducted the full 2 units from `shop_inventory_balances`
(11 → 9) while `payment_allocations` correctly totaled only 120,
outstanding 80. Collecting the remaining 80 via the existing
`record_payment()` RPC (unmodified, reused as-is) brought outstanding
to exactly 0 without any further inventory movement — confirming
payment collection and stock deduction are correctly independent
operations, never re-triggering each other. See
COMMERCIAL_ACCOUNTING_RULES.md for the full policy reasoning.

## 11. Stock Count posts through the canonical movement engine, never a direct balance write

`complete_shop_stock_count()` computes `variance = counted_quantity -
system_quantity` per line and, for every non-zero variance, calls
`_apply_shop_inventory_movement_internal()` with `movement_type =
'stock_count_adjustment'` and direction derived from the sign of the
variance — the same choke point every other Shop write RPC uses.
`shop_stock_count_items.system_quantity` is a point-in-time snapshot
taken at `start_shop_stock_count()`, never a live-computed value, so a
count session's variance is stable even if other movements occur
against the same location in a separate, unrelated transaction before
completion (the balance itself remains the authoritative current
value; the snapshot only fixes what "system quantity at count time"
meant for this session's variance/audit record).

**Completion is idempotent and immutable**: the count row is locked
(`for update`) at the start of `complete_shop_stock_count()`; if
already `'completed'`, the function returns the same id without
positing anything again (verified live: second completion call on an
already-completed count leaves the movement count at exactly 1 and the
balance unchanged). A `'completed'` count can never be cancelled
(enforced both in `cancel_shop_stock_count()` and by `complete_shop_stock_count()`
rejecting a `'cancelled'` count). Only one `draft`/`in_progress` count
may exist per location at a time (partial unique index on
`shop_stock_counts(location_id) WHERE status IN ('draft','in_progress')`),
preventing two overlapping sessions from double-adjusting the same
balance.

Live-verified full mandated scenario: system 10 → counted 8 → variance
-2 → one `stock_count_adjustment` movement of quantity 2 (direction
'out') → balance 8; second completion attempt → same id returned, no
second movement, balance still 8; second session system 8 → counted 11
→ variance +3 → movement quantity 3 (direction 'in') → balance 11.
Independently reconciled the full movement ledger by hand
(`+10 -2 +3 = 11`) against the stored balance — exact match.
