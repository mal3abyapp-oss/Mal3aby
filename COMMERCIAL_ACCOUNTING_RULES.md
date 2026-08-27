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

## Payment model — partial/multi-payment (updated, see also INVENTORY_INVARIANTS.md)

**Discovery finding**: `record_payment()` already implements a fully
working partial/multi-payment engine — it computes the invoice's
outstanding balance as `total - SUM(payment_allocations) +
SUM(completed refunds)`, rejects any payment exceeding that balance,
and only flips dependent state (e.g. auto-confirming a pending
booking) once the outstanding balance reaches zero. This is real,
pre-existing, and already exercised by bookings/academy/memberships.

Per the explicit rule "if the existing Finance model already supports
multi-payment, extend Shop to use it correctly — do not choose a
restriction merely because the first implementation was easier",
`create_shop_sale()` was extended (not replaced) with an optional
`p_payment_amount` parameter:

- Omitted (or equal to the subtotal): identical to the original
  behavior — the sale is created fully paid in one step. Every
  pre-existing caller (the POS frontend, prior QA) is unaffected.
- A smaller positive amount: the sale is created with a partial
  `payments`/`payment_allocations` row; the remaining balance is
  collected later through the **existing, unmodified**
  `record_payment()` RPC against the same shop-sale invoice — proven
  live: `record_payment()` requires no special-casing to accept a
  `shop_sale_item`-sourced invoice, and its own outstanding-balance and
  overpayment guards apply identically.
- `p_payment_amount > subtotal` or negative: denied server-side.

No second payment engine was built. `payment_allocations` remains the
single source of truth for how much of any invoice — booking, academy,
membership, or shop — has been paid.

## Stock deduction timing

**Chosen policy: deduct at sale creation, regardless of payment
completeness.** Stock for every line item is deducted synchronously,
inside the same transaction that creates the invoice, *before* any
payment row is inserted — unconditionally, whether the sale is paid in
full, partially, or (in principle) not at all at creation time.

Reasoning, not a default taken because it was easier:

1. **Matches this project's own booking precedent.** `_create_booking_internal()`
   reserves the field slot the moment a booking is created at
   `pending_payment`, not at `confirmed` — the resource commitment
   happens at creation, the payment state is tracked independently.
2. **Matches physical retail reality.** A shop sale is not a
   reservation of future goods; it is a record of goods that already
   physically left the location. There is no "pending shop order"
   concept in this phase — every `shop_sales` row is `status =
   'completed'` from creation (see `shop_sales_status_check`). Deferred
   payment is a receivable against a completed sale, not a hold on
   unshipped inventory.
3. **Prevents the two failure modes named explicitly in this
   directive**: an abandoned unpaid invoice can never "permanently
   consume stock forever with no sale" — because there is no unpaid
   *pending* sale state to abandon; every sale is already completed and
   the goods are (by definition of a shop sale) already gone. And a
   paid sale can never lack a stock deduction, because deduction is
   unconditional at creation, not contingent on `p_payment_amount`.

Stock reservation (a `reserved`/`available` balance split for a
genuine pending/unpaid *order* flow, as opposed to a completed sale
with a receivable) remains explicitly out of scope — there is still no
"pending shop order" concept for it to serve. If a future phase adds
one, reservation must be built as its own explicit state, never
silently inferred from invoice payment status. See
INVENTORY_INVARIANTS.md for the live verification of this policy
(partial-payment sale with immediate full stock deduction).

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
