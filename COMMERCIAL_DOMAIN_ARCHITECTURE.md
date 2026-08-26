# Commercial Domain Architecture — Shop / Inventory / Sales / Returns

Status: implemented incrementally starting 2026-08-26. This document
describes the actual implemented architecture, updated as each phase
lands — not an aspirational design written once and abandoned.

## 1. Why this document exists

The Shop/Inventory/Sales/Returns module is the first genuinely new
commercial domain added to Mal3aby since the original booking/academy
build. It touches real money (invoices/payments/refunds) and real
physical stock. Getting the invariants wrong here is expensive to
unwind once real clubs have real inventory and real customers running
through it — so the architecture is written down before the schema is,
and referenced by every migration that follows.

## 2. Non-negotiable reuse (confirmed via direct schema inspection, not assumed)

- **Invoices remain the single financial source of truth.** A shop
  sale creates ordinary rows in the existing `invoices` and
  `invoice_items` tables — no `shop_invoices` table, ever.
  `invoice_items` already has a polymorphic `reference_type` /
  `reference_id` pair (confirmed live: existing values are
  `'booking'`, `'subscription'`, `'club_membership'`, no CHECK
  constraint restricting the value) — a shop sale line is
  `reference_type = 'shop_sale_item'`, `reference_id = <shop sale
  item id>`. Price/quantity/line_total already live directly on
  `invoice_items`, giving price-snapshot behavior for free — no
  separate snapshot table needed.
- **Payments/refunds remain the canonical tables — but `record_payment()`
  is NOT called directly for a shop sale's initial payment.** Read its
  full body (`pg_get_functiondef`) before assuming this: it derives a
  mandatory `v_booking_branch_id` exclusively by joining through
  `bookings` / `subscriptions` / `club_membership_subscriptions`, and
  a custody-holding staff member's cash payment is HARD REJECTED
  (`'cash collection requires a branch-scoped booking -- this invoice
  has none'`) whenever that join finds nothing — which it always will
  for a shop sale's invoice. Its notification payload logic is also
  entirely booking/academy-shaped. Modifying `record_payment()` to
  understand a fourth domain risks regressing three already-correct,
  heavily-tested flows for one new one. Instead, `create_shop_sale`
  follows `_create_booking_internal`'s own established precedent
  (confirmed via its own `pg_get_functiondef` — it does NOT call
  `record_payment()` either): it inlines its own minimal
  payment-insertion + cash-shift-gate logic directly into the invoice
  it creates. The `payments`/`payment_allocations` TABLES are still
  the one and only place a shop sale's money is recorded — only the
  RPC entrypoint is domain-specific, exactly mirroring how bookings
  and shop sales are actually two different entrypoints today, not
  one shared function pretending to be domain-agnostic.
  `create_refund(p_payment_id, p_amount, p_reason)` IS safely
  reusable unmodified for shop refunds — its signature and body are
  genuinely payment-scoped with no booking-specific joins (confirmed:
  `v_membership_id_to_cancel`/`v_booking_ref` resolve to `null` for a
  non-booking/non-membership payment via LEFT JOIN, no exception path
  assumes a booking exists). No `shop_payments`, no `shop_refunds`
  tables regardless. Note `create_refund()` itself independently
  requires `payment.refund` (not a new shop-specific key) — a shop
  return RPC checks `shop.sale.refund` at its own layer for the
  return/restock decision, then calls `create_refund()` which
  re-checks `payment.refund` for the money movement. Both `accountant`
  and `club_owner` already hold `payment.refund` (confirmed via
  role_permissions read) and were granted `shop.sale.refund` in the
  same seed migration, so this composes correctly by construction —
  documented here explicitly rather than left as an implicit
  coincidence.
- **Cash shift discipline is reused, not re-implemented.** Whatever
  gate `create_booking_internal`'s cash-shift check uses for a booking
  cash payment applies identically to a shop cash sale — same RPC
  pattern, same `has_cash_custody` concept on `club_memberships`, same
  `cash_shifts` table.
- **Audit is `write_audit_log(p_club_id, p_action, p_entity_type, p_entity_id, p_before, p_after, p_reason)`
  exclusively.** No second audit table for commercial actions.
- **Customer identity is the existing `customers` table.** A shop
  buyer is never a second identity — every sale links `customer_id`
  to the same canonical customer used by bookings/academy/memberships.
- **Branch scope uses the existing branch-scope helper** (confirmed
  live: `caller_accessible_branch_ids()` pattern already established
  for finance reports) — a Branch Manager's shop/inventory visibility
  is scoped exactly the way their booking/finance visibility already
  is, not a second scoping mechanism.
- **Permissions follow the existing `<domain>.<action>` key convention**
  on the existing `permissions` / `role_permissions` /
  `club_role_permissions` tables — new keys, same tables, same
  `has_permission(key, club_id)` / `permission_set_escalates()` /
  `caller_permission_keys()` machinery already used by every other
  club-scoped permission. No second permission system for shop.
- **RLS discipline matches the existing FORCE ROW LEVEL SECURITY
  posture** already applied project-wide (`force_rls_defense_in_depth`,
  `force_rls_remaining_tables`) — every new commercial table gets RLS
  enabled AND forced from its first migration, not added later.

## 3. Module entitlement model (directive Section 3/4)

New table: `club_modules` — one row per (club_id, module_key), module_key
in `('fields', 'academy', 'shop')`. Two-level state, matching directive
Section 4's explicit distinction between platform commercial
entitlement and club operational configuration:

- `entitled` (boolean, platform-controlled): has the Platform Owner
  turned this module on for this club commercially? Defaults:
  `fields = true`, `academy = true` for every existing club at
  migration time (directive Section 113 — no existing tenant loses
  access to what it's already using); `shop = false` for everyone
  (opt-in only, directive Section 114).
- `active` (boolean, club-owner-controlled, only meaningful when
  `entitled = true`): has the Club Owner actually turned the module on
  for day-to-day use? A club can be `entitled=true, active=false` —
  platform has unlocked Shop, owner hasn't configured/launched it yet.
  `active` can never be `true` while `entitled` is `false` (CHECK
  constraint) — flipping `entitled` off is a hard platform-level kill
  switch regardless of the club's own `active` state.

No `configured` state as a separate column — "configured" is derived
from whether the club has at least one product/branch-location set up,
not stored state (avoids a third boolean that can drift from reality).

Effective-module-on for enforcement purposes is always
`entitled AND active` — computed inline in every gate, not cached.

Disabling a module never deletes data (directive Section 5) — every
gate is a read/write **denial**, never a cascade. Re-enabling restores
full visibility of preserved history immediately.

## 4. Product / Catalog domain

- `shop_products` — club-scoped (not academy-scoped — directive
  Section 12 decision, see below), `name_ar`/`name_en`, `category_id`
  (nullable, own `shop_categories` table), `description`, `status`
  (`active`/`archived` — never hard-deleted once referenced by a sale
  or inventory movement), `image_url`, `has_variants` (boolean —
  determines whether sales/inventory operate at the product level or
  the variant level for this product).
- **Ownership decision (directive Section 12): Product belongs to the
  Club, never to an Academy.** A club with 3 academies and one shop
  must not get 3 copies of the same shirt. Academy-specific
  merchandising (if ever needed) would be a *category* or a *sales
  channel tag* on the club-owned product, never a duplicate product
  row — this keeps physical inventory singular per club, matching
  directive Section 6's "one Club Shop can serve club merchandise,
  academy merchandise, and reception sales" preferred model.
- `shop_product_variants` — only rows exist for products with
  `has_variants = true`; a non-variant product sells directly against
  a single implicit "default" inventory line (modeled as one
  variant-less row keyed by `product_id` in inventory, not a fake
  variant, to avoid forcing every simple product through variant
  machinery). Variant dimensions: `size`, `color` (both nullable text,
  not a generic key/value option engine — directive Section 10's own
  "do not build an oversized options engine" instruction, reliably
  covers the two named dimensions without overengineering), `sku`
  (unique per club), `barcode` (unique per club, nullable), `price`
  (overrides product base price when set), `status`.
- Barcode/SKU uniqueness scope: **per club**, not globally — a
  multi-tenant barcode collision across two unrelated clubs is
  expected and harmless (directive Section 11: distinct domain from
  Membership/Booking/Attendance QR, confirmed no overlap by
  construction — different table, different value format, never
  compared cross-domain).

## 5. Inventory domain

- `shop_inventory_locations` — club-scoped, `kind` in `('branch',
  'warehouse')`. A `'branch'` location is 1:1 with an existing
  `branches` row (`branch_id` FK, unique). A `'warehouse'` location is
  club-level with no branch FK (directive Section 14 — "do not
  pretend warehouses are branches"). A club gets zero warehouse
  locations by default; created explicitly.
- `shop_inventory_balances` — the only source of "how much stock is
  here right now", keyed by (location_id, product_id, variant_id
  nullable). **Never manually editable** — every balance row is
  maintained exclusively by triggers/RPCs reacting to movement rows,
  never a direct UPDATE from application code (directive Section 13).
  `on_hand` only for the first implementation — `reserved`/`available`
  columns are deliberately deferred (directive Section 15: "do not
  invent complexity without current use" — nothing in this phase
  reserves stock ahead of a completed sale, so the distinction has no
  consumer yet; the column can be added later without a breaking
  migration since `available` would just become `on_hand - reserved`).
- `shop_inventory_movements` — append-only ledger, the historical
  source of truth "why is stock 17". Every balance change is the
  result of exactly one movement row. `movement_type` in
  `('opening_balance', 'purchase_receipt', 'sale', 'sale_return',
  'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out',
  'damage', 'loss', 'stock_count_adjustment')` (directive Section 16's
  own list, verbatim). Columns: club_id, location_id, product_id,
  variant_id, quantity (always positive; direction is encoded by
  movement_type, not by sign — avoids a sign-convention bug class),
  movement_type, actor_id, reference_type/reference_id (same
  polymorphic pattern as invoice_items — points at the sale, transfer,
  adjustment, or count that caused this movement), reason (required
  for adjustment/damage/loss, nullable otherwise), created_at.

## 6. Stock deduction timing (directive Section 38 — explicit policy, not a guess)

**Chosen rule: stock is deducted at the moment a sale is marked
`completed`, which for the cash/immediate-payment POS flow this phase
implements happens synchronously inside the same RPC/transaction that
creates the invoice and records the payment.** A `draft`/unpaid sale
never touches inventory. This phase does not implement a
"reserve-on-invoice, deduct-on-payment" two-step flow (no
`pending_payment` sale ever holds stock) — POS sales in this
implementation are created already fully paid (cash-in-hand or
immediate card/transfer confirmation), matching how `create_booking_internal`
already treats an immediate-confirmation booking payment. If a future
phase adds an unpaid/invoice-first shop flow, stock reservation would
be a new, explicit, separately-documented state — never silently
inferred from invoice existence.

Cancelling a `draft` sale before completion: no inventory or finance
effect (nothing was ever deducted). Cancelling/returning a
`completed` sale: handled by the Returns domain (Section 8), never by
mutating the original sale or invoice.

## 7. Sale domain

- `shop_sales` — club_id, branch/location_id (the point of sale),
  customer_id (**required, not nullable** — a real, live constraint
  discovered by E2E testing, not an assumption: `invoices.customer_id`
  is `NOT NULL` project-wide, with zero walk-in/anonymous exception
  anywhere else in this codebase; the original design here assumed
  otherwise and was corrected the same session it was caught, before
  reaching the frontend). Every shop sale resolves a real `customers`
  row first — the POS UI reuses this project's existing
  customer-search/quick-create pattern, it does not invent a "walk-in"
  concept), sold_by (staff actor),
  invoice_id (FK, one sale : one invoice), status in `('draft',
  'completed', 'cancelled', 'partially_returned', 'returned')`
  (directive Section 39's own list), created_at. **No separate
  sale_reference/sequence table** — the sale's real invoice_number
  (generated by the existing `issue_invoice_number()`, same atomic
  `ON CONFLICT DO UPDATE ... RETURNING` sequence pattern already used
  project-wide) already IS the sale's authoritative human-readable
  reference, since every completed sale has exactly one real invoice.
  Inventing a second numbering scheme for the same event would be
  pure duplication with no operational benefit (directive Section 83's
  own "if useful operationally" qualifier — it isn't, here).
- `shop_sale_items` — sale_id, product_id, variant_id nullable,
  quantity, unit_price (snapshot at sale time — never re-read from
  the live product), line_total, returned_quantity (running total,
  updated only by the Returns domain, enforced `<= quantity`).
- A `completed` sale's items are immutable. Correcting a mistake is
  always a return + a new sale (directive Section 44 — exchange model),
  never an edit to historical `shop_sale_items` rows.

## 8. Returns / Refunds domain (directive Section 41/42/43/44/45 — kept explicitly separate)

- `shop_sale_returns` — references the original `shop_sales` row,
  never a free-floating "return this product" action. Lines reference
  specific `shop_sale_items` rows with a `returned_quantity` that can
  never push `shop_sale_items.returned_quantity` past
  `shop_sale_items.quantity` (server-enforced, not UI-enforced).
- **Physical return and financial refund are two independent flags on
  the same return record, not one combined action**: `restock =
  boolean` (did this return actually put the item back on the shelf —
  false for damaged-on-return goods) and `refund_payment_id` (nullable
  FK to a real `refunds` row created via the existing `create_refund()`
  RPC — null if this was a physical-return-only action with no money
  moving, e.g. a goodwill exchange). Restocking triggers a
  `sale_return` inventory movement only when `restock = true`. A
  refund only ever happens through `create_refund()` against the
  original payment — never a new, separate shop-refund code path.

## 9. Finance/reporting non-duplication (directive Section 47/48/54)

Revenue is counted exactly once: from `invoices`/`payments`, full
stop. Shop operational reports (units sold, top products, low stock)
read from `shop_sales`/`shop_sale_items`/`shop_inventory_movements`
for *quantities and product-level breakdowns only* — every monetary
figure a shop report shows is re-derived by joining back to the real
`invoices`/`payments` rows for that sale's `invoice_id`, never
independently summed from `shop_sale_items.line_total` as if it were
its own ledger. This is the concrete mechanism that prevents the
double-counting directive Section 48 warns about — there is
structurally only one place money is summed.

## 10. What this phase does NOT implement (explicitly deferred, not silently dropped)

- Stock reservation (`reserved`/`available` split) — no current
  consumer; column-compatible to add later.
- Supplier/procurement beyond a minimal `shop_suppliers` lookup table
  (name/phone/email/notes/active) referenced optionally from
  `purchase_receipt` movements — no accounts-payable engine.
- COGS/gross-profit reporting — deferred until a reliable per-unit
  cost basis is confirmed as wanted; a `cost_price` field is captured
  on receipt movements for future use but no report claims it as
  authoritative profit yet (directive Section 49's own explicit
  caution).
- Per-variant/per-location reorder automation — a lightweight
  `reorder_level` field only, no automated purchasing.
