# Commercial Accounting Rules

## Revenue is counted exactly once

`invoices` / `payments` / `payment_allocations` / `refunds` are the
sole source of financial truth for the Shop module, exactly as they
already are for bookings/academy/memberships. A shop sale creates
ordinary `invoices` and `invoice_items` rows (new `reference_type =
'shop_sale_item'` value on the existing polymorphic column) — never a
parallel `shop_invoices` table.

Every operational report that shows a monetary figure (`get_shop_top_products`'s
`revenue` column) re-derives it by joining back to the real
`invoice_items.line_total` for that sale item — never by independently
summing `shop_sale_items.line_total` as if it were its own ledger.
This is the concrete mechanism, not a policy statement: there is
structurally only one `SUM()` of money in the whole module.

Live-verified (directive Section 116's own mandated scenario): sell 2
units at 500 → invoice 1000 → pay 1000 → return 1 unit → refund 500 →
final state: stock 9, `paid = 1000`, `refunded = 500`, net financial
result = 500, with zero double-counting across `invoices`, `payments`,
`invoice_items`, and `shop_sale_items`.

## Stock deduction timing

**Chosen policy**: stock is deducted synchronously, inside the same
transaction that creates the invoice and payment, at the moment a sale
is marked `completed`. This phase does not implement an unpaid/
pending-payment shop invoice — `create_shop_sale()` always creates an
already-fully-paid sale (`p_payment_method` is required, and the
inserted `payments` row amount equals the invoice subtotal exactly).

There is therefore no "stock reserved for an abandoned unpaid invoice"
scenario to guard against in this phase. If a future phase adds an
unpaid/invoice-first flow, stock reservation (the deferred
`reserved`/`available` balance split, see COMMERCIAL_DOMAIN_ARCHITECTURE.md
Section 10) would need to be implemented as an explicit, separately
documented state — never silently inferred from invoice existence.

## Cash handling

A cash shop sale is gated by the exact same cash-shift-custody check
`_create_booking_internal()`/`record_payment()` already enforce: a
staff member with `has_cash_custody = true` must have an open
`cash_shifts` row for the sale's branch, or the sale is denied with
`cash collection requires an active cash shift`. `create_shop_sale()`
inlines this check rather than calling `record_payment()` directly —
see COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 6/7 for why
`record_payment()` is not safely reusable here (its branch-scope
derivation is hard-coded to bookings/subscriptions/memberships and
would reject every cash shop sale outright).

No parallel cash ledger exists — the sale's payment row is a normal
`payments` row, reconciled by the club's existing cash-shift close
flow exactly like any other cash payment.

## Returns vs. refunds — two independent decisions

A return has two independent flags, matching real operational
reality:

- `restock` (boolean): did the physical item come back in sellable
  condition? Triggers a `sale_return` inventory movement only when
  true. A damaged-on-return item can be accepted (money refunded)
  without restocking.
- `refund_payment_id` (nullable): was money actually returned? Calls
  the existing `create_refund()` RPC completely unmodified against the
  sale's original payment — no parallel refund engine. A goodwill
  exchange (restock without refund) and a financial-only refund
  (refund without restock) are both valid, independent combinations.

`create_refund()` itself independently requires the `payment.refund`
permission (not a new shop-specific key) — `return_shop_sale()` checks
`shop.sale.refund` at its own layer for the return/restock decision,
then `create_refund()` re-checks `payment.refund` for the money
movement. Both `accountant` and `club_owner` hold `payment.refund`
already and were granted `shop.sale.refund` in the same seed
migration, so this composes correctly by construction.

## Return quantity is bounded server-side, not just in the UI

`shop_sale_items.returned_quantity` is checked against `quantity`
(`returned_quantity <= quantity`, both a table CHECK and an explicit
RPC-level check with a friendly error message) on every return line.
Live-verified: attempting to return more than the remaining sold
quantity is denied with the exact remaining amount quoted back.

## No hard deletes of financial or inventory history

Products, variants, sales, and inventory movements are never
hard-deleted once they carry real history — archived (`status =
'archived'`) instead. `shop_sale_items`/`invoice_items`/
`shop_inventory_movements` foreign keys to a product/variant remain
valid regardless of that product/variant's current status.
