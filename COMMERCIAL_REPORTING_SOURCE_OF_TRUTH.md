# Commercial Reporting — Source of Truth

## The rule

Inventory tracks physical units. Invoices/payments/refunds track
money. A report must never calculate revenue from stock movements, and
must never sum money independently of the real `invoices`/
`invoice_items`/`payments` rows.

## What each report RPC actually reads

| RPC | Reads | Money figures come from |
|---|---|---|
| `get_shop_top_products` | `shop_products` + `shop_sale_items` (units) + `invoice_items` (money) | `invoice_items.line_total`, joined via `shop_sale_items.invoice_item_id` |
| `get_shop_inventory_summary` | `shop_products` + `shop_inventory_balances` | none — deliberately no revenue figure (directive's own explicit warning against a misleading revenue card in an inventory context) |
| `list_shop_sales` / `get_shop_sale_detail` | `shop_sales` + `invoices` (money) + `shop_sale_items` (units) | `invoices.total`, real invoice row |
| `list_shop_inventory_movements` | `shop_inventory_movements` | none — units only |
| `get_customer_shop_purchases` (Customer 360) | `shop_sales` + `invoices` + `shop_sale_items` | `invoice_items`-derived line totals |

No RPC in this module independently sums `shop_sale_items.line_total`
or `shop_sale_items.quantity * shop_sale_items.unit_price` as a
standalone revenue figure — every monetary column joins back to the
real `invoice_items`/`invoices` row.

## Reconciliation, verified

For every completed QA sale tested this session:

```
invoices.total == SUM(invoice_items.line_total)
                == SUM(payment_allocations.amount)  [when fully paid]
                == SUM(shop_sale_items.quantity * shop_sale_items.unit_price)
```

matched exactly, including for a sale with a partial return applied
(paid=1000, refunded=500, net=500 — directive Section 116's own
mandated scenario, reproduced exactly).

## Inventory reconciliation, verified

For a tracked QA product/location, the stored `shop_inventory_balances.on_hand`
was independently re-derived from the full `shop_inventory_movements`
ledger (summing `+quantity` for `opening_balance`/`purchase_receipt`/
`sale_return`/`transfer_in`/`adjustment_in`, `-quantity` for
`sale`/`transfer_out`/`adjustment_out`/`damage`/`loss`) and confirmed
to match exactly at every step of a receive → receive → sell → return
→ adjust sequence.

This same reconciliation technique is what caught the critical
balance-duplication bug documented in COMMERCIAL_DOMAIN_ARCHITECTURE.md
Section 10 — the movement ledger's own running total was correct
throughout; only the stored balance row was silently duplicated. The
fix consolidated the duplicate rows by summing them, which was only
trusted after independently re-deriving the correct total from the
ledger first (not merely assuming the duplicate rows summed
correctly).

## Deliberately not built in this phase

- A "Sales by Branch" cross-tab beyond what `list_shop_sales`'s
  location filter already provides implicitly through the sale's own
  `location_id`.
- Stock Count sessions / variance reporting — no stock-count feature
  exists yet in this phase (see COMMERCIAL_DOMAIN_ARCHITECTURE.md
  Section 10's deferred list); a future phase would report
  count-vs-system variance from that feature's own tables, not
  fabricated here.
- Damage/Loss as separate report tabs — both are already fully visible
  as `movement_type` filters on `list_shop_inventory_movements`; a
  dedicated report page was judged unnecessary duplication rather than
  a missing feature.
