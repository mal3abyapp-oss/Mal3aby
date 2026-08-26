# Shop / Inventory / Finance — Integration Model

One-page summary of how the Shop module's data model connects to the
pre-existing finance architecture. See COMMERCIAL_DOMAIN_ARCHITECTURE.md
for full detail; this is the map.

```
shop_products ──┬── shop_product_variants
                │
shop_sales ─────┼── shop_sale_items ──── invoice_items (reference_type='shop_sale_item')
   │            │         │                     │
   │            │         │                     └── invoices (real, existing table)
   │            │         │                            │
   │            │         │                            └── payment_allocations ── payments (real, existing)
   │            │         │
   │            │         └── returned_quantity (bounded by quantity)
   │            │
   │            └── shop_inventory_movements (movement_type='sale', reference_id=sale_id)
   │
shop_sale_returns ── shop_sale_return_items ── shop_inventory_movements (movement_type='sale_return')
   │
   └── refund_payment_id ──→ refunds (real, existing table, via create_refund())

shop_inventory_locations ── shop_inventory_balances (ONE row per location+product+variant)
                                    ↑
                                    │ maintained exclusively by
                          _apply_shop_inventory_movement_internal()
                                    ↓
                          shop_inventory_movements (append-only ledger)
```

## The three things that make this NOT a parallel system

1. **`invoice_items.reference_type = 'shop_sale_item'`** is one more
   value on the existing polymorphic column (already used for
   `booking`/`subscription`/`club_membership`) — not a new table.
2. **`create_refund()`** is called completely unmodified for shop
   refunds — not a `create_shop_refund()`.
3. **`payments`/`payment_allocations`** are the same tables a booking
   or academy payment uses — a shop sale's payment row is
   indistinguishable in shape from any other payment, distinguished
   only by which invoice it's allocated to.

## The one place Shop genuinely needed its own entrypoint

`create_shop_sale()` is a new RPC, not a call to `record_payment()` —
documented at length in COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 6/7:
`record_payment()`'s branch-scope derivation is hard-coded to
bookings/subscriptions/club_membership_subscriptions and would reject
every cash shop sale. `create_shop_sale()` inlines the same minimal
payment logic `_create_booking_internal()` already established as this
project's own precedent for a domain-specific sale entrypoint — not
because Shop needed different money-handling rules, but because the
existing generic payment RPC has domain-specific branch-resolution
logic baked in that a shop sale doesn't match.
