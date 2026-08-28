# Commerce Pro — Phase C8 Report: Inventory Dashboard, Receiving UX, Transfer UX, Stock Count UX Polish

Written 2026-08-28, in isolated worktree `worktree-agent-a54e861d4050b793a`
(built on top of C1–C7, already merged in this worktree), per
`COMMERCE_PRO_UPGRADE_PLAN.md` Section 5 (Phase C8) and
`AGENT_ORCHESTRATION_GOVERNANCE.md`.

## 1. Reading performed before writing any code

Read the full plan (`COMMERCE_PRO_UPGRADE_PLAN.md`, all sections, especially
§2 invariant 8) and `AGENT_ORCHESTRATION_GOVERNANCE.md` (all three
incidents) in full. Read `COMMERCE_C1` through `COMMERCE_C7` reports in
full, confirming C7 already added `shop_sale_items.unit_cost_snapshot`,
`get_shop_stock_valuation`, and the paginated/filtered
`list_shop_inventory_movements`.

Read, directly from their live migration files, before writing anything:
`ShopInventoryPage.tsx` (pre-C8), `receive_shop_stock`'s current body
(`20260826210513_shop_inventory_write_rpcs.sql` — confirmed single-product-
per-call), `transfer_shop_stock`'s current body
(`20260826210534_shop_inventory_write_rpcs_transfer_adjust.sql` — also
confirmed single-item, not multi-item as the task brief left open),
`adjust_shop_stock`'s current body (same file), `get_shop_inventory_balances`'s
current body (`20260828083000_shop_read_rpcs_enforce_module_active.sql`),
`_apply_shop_inventory_movement_internal` (the single choke point every
inventory mutation goes through —
`20260826210415_shop_inventory_movement_apply.sql`),
`get_shop_inventory_summary`'s latest body
(`20260828095500_fix_shop_inventory_summary_out_of_stock_missing_variants.sql`),
`get_shop_stock_valuation`/`list_shop_inventory_movements`/
`get_customer_shop_purchases`/`get_shop_top_products`'s C7-extended bodies
(`20260828170200_shop_c7_report_rpc_extensions.sql`), `list_shop_products`'s
C1-extended body (image_urls/image_url,
`20260828100200_shop_product_media_category_ux_rpcs.sql`), the
`shop_products`/`shop_product_variants`/`shop_sales`/`shop_sale_items`/
`shop_sale_returns`/`shop_sale_return_items`/`shop_suppliers` schemas
(`20260826210231_shop_catalog_schema.sql`,
`20260826210846_shop_sales_schema.sql`), `shop.reports.view_profit`'s seed
(`20260828170150_shop_reports_view_profit_permission_seed.sql`), and
`ShopStockCountPage.tsx` in full (already had a real, dedicated,
previously-validated session lifecycle UI — start/count/complete).

Also read `shop-media.tsx` (`ProductThumb`, C1's shared thumbnail
component), `ShopDashboardPage.tsx` (C6, for the house KPI-row/rollup
pattern and the `get_shop_stock_valuation`-gating precedent used by
`ShopProfitReport.tsx`), `ShopReportsPage.tsx` (the manual tab-strip
pattern used for Product Detail's tabs — confirmed no existing Shop screen
uses the Radix `Tabs` primitive), `StatCard`/`MoneyDisplay`/`Badge`
components, and `router.tsx`'s existing `/app/shop/*` route tree.

## 2. Scope confirmation

- `receive_shop_stock`: confirmed single-product-per-call (task brief was
  correct).
- `transfer_shop_stock`: confirmed **also** single-item-per-call (task
  brief left this open — checked directly, not assumed). It already
  writes two linked movements per call (`transfer_out`/`transfer_in`
  sharing one `reference_id`), but only for one product/variant at a time.
- Neither RPC needed `DROP FUNCTION` treatment — both are extended by
  adding brand-new, additively-named RPCs (`receive_shop_stock_batch`,
  `transfer_shop_stock_batch`), not by changing either existing function's
  signature or return shape. Invariant 8 (§2.8 of the plan) does not apply
  to any RPC touched this phase — see §7 below for the explicit statement
  per RPC.

## 3. Inventory Dashboard (plan item 1)

Upgraded `ShopInventoryPage.tsx` in place (not a new page/route) with a
real dashboard section above the existing balances table/movement
history/dialogs:

- **KPI row**: Total SKUs (`get_shop_inventory_summary.active_products`,
  unchanged C6-era RPC), Stock Value (`get_shop_stock_valuation`, C7's
  RPC, summed client-side across every location/product row where
  `line_value` is non-null), Low Stock, Out of Stock (both from
  `get_shop_inventory_summary`).
- **Stock Value gating**: the RPC itself enforces
  `inventory.view AND shop.reports.view_profit` (C7's own gate,
  unchanged). The dashboard's `fetchStockValue` call is made
  unconditionally with `retry: false`; on `isError` the tile renders a
  literal "Hidden" label instead of a money figure — the exact same
  call-unconditionally/catch-isError pattern `ShopProfitReport.tsx` (C7)
  already established, not a new client-side permission check. Everyone
  else (without the grant) still sees Total SKUs/Low Stock/Out of Stock —
  quantity-only info, per the task's own instruction.
- **Recent Receipts / Transfers / Adjustments / Damage-Loss**: four small
  tables, each the last 4 rows of `list_shop_inventory_movements` filtered
  by `p_movement_type` (C7's own filter, reused unmodified — Receipts =
  `purchase_receipt`; Transfers = `transfer_out`+`transfer_in` merged and
  re-sorted client-side; Adjustments = `adjustment_in`+`adjustment_out`;
  Damage/Loss = `damage`+`loss`). No new RPC was needed or added for this
  — confirmed the existing filter covers every required movement type
  before writing any SQL.
- **Product stock rows**: the existing balances table gained a
  `ProductThumb` image column (reusing C1's shared `shop-media.tsx`
  component, cross-referenced from `list_shop_products.image_url` by
  `product_id`), a Reorder Level column, and a stock-status badge column
  (IN STOCK / LOW STOCK / OUT OF STOCK, derived client-side from
  `on_hand`/`reorder_level` — no schema or RPC change needed for this).
  Clicking a product name opens the new Product Detail dialog.

## 4. Product Detail / Stock History (plan Section 21)

New `ProductDetailDialog` component inside `ShopInventoryPage.tsx`, opened
by clicking a product in the balances table. Six tabs, using the same
manual button-strip tab pattern `ShopReportsPage.tsx` already established
(not the Radix `Tabs` primitive — confirmed no prior Shop screen uses it):

| Tab | Data source | New RPC? |
|---|---|---|
| GENERAL | `list_shop_products` (client-filtered to one product) | No |
| STOCK (location → quantity) | `get_shop_inventory_balances` (client-filtered) | No |
| MOVEMENTS | `list_shop_inventory_movements(p_product_id=...)` — filter already existed pre-C7 | No |
| SALES HISTORY | **`list_shop_product_sales_history`** (new) | **Yes** |
| RETURNS | **`list_shop_product_returns`** (new) | **Yes** |
| SUPPLIER | Derived client-side from the MOVEMENTS tab's own `purchase_receipt` rows (`reference_type`/`reference_id`) + a `shop_suppliers` name lookup | No |

### Why SALES HISTORY and RETURNS needed genuinely new RPCs (checked, not assumed)

Before writing any new SQL, every existing sales/returns RPC was checked
for whether it could already answer "history for this one specific
product across every customer":

- `get_customer_shop_purchases` — wrong shape: requires a `customer_id`,
  it's per-customer, not per-product-across-all-customers.
- `get_shop_top_products` — wrong shape: aggregate-only (one row per
  product, `units_sold`/`revenue` totals), no per-sale line detail, no
  customer identity, no date-level granularity.
- `list_shop_sales(p_product_id=...)` (C5) — **checked carefully, this
  was the closest candidate and was almost mistakenly reused.** Its
  `p_product_id` filter is only an `EXISTS` clause to find *sales that
  contain this product at all* — the returned row is whole-sale-level
  (`total` = the entire invoice total across every product in that sale,
  `item_count` = the sale's total quantity across every product). For a
  sale containing more than one product, this RPC would show the wrong
  quantity/total for a "this product's own line" view. Confirmed by
  direct read of the RPC body
  (`20260828150000_shop_sales_filters_and_kpis.sql`) — not reused.
- `list_shop_sale_returns` (C7) — sale/return-event-level, not
  product-line-level; a return can cover multiple products in one event
  and this RPC has no way to isolate one product's own returned quantity.

Both gaps confirmed genuine. New RPCs, in
`supabase/migrations/20260828180100_shop_product_detail_history_rpcs.sql`:

```sql
list_shop_product_sales_history(
  p_club_id uuid, p_product_id uuid, p_variant_id uuid default null,
  p_start_date date default null, p_end_date date default null,
  p_limit int default 50, p_offset int default 0
) returns table(sale_id uuid, invoice_number text, customer_name text, sold_by_name text,
  variant_label text, quantity numeric, unit_price numeric, line_total numeric,
  returned_quantity numeric, sale_status text, created_at timestamptz)
-- gated on shop.view only (NOT shop.reports.view_profit -- this is
-- quantity/revenue-per-sale detail, not cost/margin, so it stays at the
-- same permission level as get_customer_shop_purchases)

list_shop_product_returns(
  p_club_id uuid, p_product_id uuid, p_variant_id uuid default null,
  p_start_date date default null, p_end_date date default null,
  p_limit int default 50, p_offset int default 0
) returns table(return_id uuid, sale_id uuid, invoice_number text, customer_name text,
  processed_by_name text, variant_label text, quantity numeric, restock boolean,
  reason text, refund_amount numeric, refund_method text, created_at timestamptz)
-- joins through shop_sale_return_items (the per-line table) down to
-- shop_sale_items.product_id, since list_shop_sale_returns's own grain
-- is the return EVENT, not the individual product line within it.
```

Both are brand-new functions — no existing `RETURNS TABLE` shape was
touched, so invariant 8 does not apply.

### SUPPLIER tab: confirmed no schema gap, not a missing RPC

`shop_products` has no `supplier_id` column (confirmed via direct schema
read, unchanged through C1–C7) — supplier association is per-receipt, per
the directive's own design, not per-product. The SUPPLIER tab is
therefore correctly derived client-side (distinct supplier names from the
product's own `purchase_receipt` movements, plus an explicit "N receipts
with no supplier recorded" count) rather than requiring a new RPC or a
new schema column.

## 5. Stock Receiving UX (plan Section 22) — transaction-boundary decision

**Decision: new atomic RPC (`receive_shop_stock_batch`), not a client-side
loop over the existing single-item `receive_shop_stock`.**

Reasoning, documented in the migration file's own header comment
(`supabase/migrations/20260828180000_shop_receive_transfer_batch_rpcs.sql`):
a real receiving document commonly has several line items. A client-side
loop calling the single-item RPC once per line would leave a genuine
inconsistent-state risk on partial failure (bad product id on line 3 of
5, a network drop, the tab closing mid-loop) — lines 1–2 would be
permanently committed as real inventory movements while lines 3–5 never
happened, with no way to tell from the resulting state alone that the
"receipt" was only half-posted, and no single audit-log entry tying the
partial set together as one failed document. This is exactly the failure
mode this module's other multi-step writes (`create_shop_sale`,
`transfer_shop_stock`'s own existing out+in pair) already avoid via one
all-or-nothing transaction. The new RPC wraps every line of one document
in a single Postgres function invocation — any line raising (bad
product/variant, non-positive quantity) rolls back the whole call via
Postgres's own transaction semantics, so it is never possible for a
receiving document to be half-posted.

`receive_shop_stock_batch(p_location_id uuid, p_items jsonb, p_supplier_id
uuid default null, p_reference_number text default null, p_notes text
default null) returns uuid` — each line still goes through
`_apply_shop_inventory_movement_internal` (the same choke point every
inventory mutation uses), so per-line invariants (balance row-lock,
`on_hand >= 0` for `out`-direction movements, product/variant club
ownership) are unchanged. Each line's own movement keeps
`reference_type='shop_supplier'`/`reference_id=p_supplier_id`, matching
the single-item RPC's existing convention — the function's own returned
receipt id is recorded once in the audit log entry
(`inventory.received_batch`), which carries the full line array and every
generated movement id, so the whole document is reconstructable from one
audit row instead of N disconnected single-line entries.

The original `receive_shop_stock` RPC is completely untouched — still a
valid, independently callable entrypoint; nothing else in the codebase
depends on its signature changing.

Frontend: `ReceiveStockDialog` rebuilt with supplier, reference/invoice
number, destination location, a dynamic list of product/variant/quantity/
unit-cost lines (add/remove), notes, and a running expected-total-cost
display (`Σ quantity × unit_cost` across valid lines, shown only when at
least one line has a unit cost entered). On success, a receipt summary
screen shows line count and total cost before the dialog closes.

## 6. Stock Transfer UX (plan Section 23) — same decision, same reasoning

`transfer_shop_stock` confirmed single-item (checked directly, not
assumed — see §2). Same transaction-boundary reasoning as receiving
applies identically here: a multi-line transfer document (e.g. moving 5
different products from a warehouse to a shop floor in one operation)
should not be able to half-post. New RPC:

`transfer_shop_stock_batch(p_source_location_id uuid, p_dest_location_id
uuid, p_items jsonb, p_notes text default null) returns uuid` — loops
every line, and for each line writes the SAME `transfer_out`/
`transfer_in` movement pair the existing single-item RPC writes (still
sharing one `reference_id` **per line**, so each line's own out/in
movements stay linkable exactly as before), all inside one transaction.
Returns a document-level `v_transfer_batch_id`, recorded in one audit log
entry (`inventory.transferred_batch`) alongside every line's own
`reference_id`, so the whole document is reconstructable from one audit
row.

The original `transfer_shop_stock` RPC is completely untouched.

Frontend: `TransferStockDialog` rebuilt with a FROM/TO location header, a
dynamic item list (product, available quantity at the FROM location —
queried live via `get_shop_inventory_balances(p_location_id=...)` per
line, unmodified RPC — and transfer quantity), a summary line, and a
confirmation screen after posting.

## 7. Stock Count UX polish (plan Section 24) — backend explicitly untouched

Read `ShopStockCountPage.tsx` in full before making any change, per the
task's explicit instruction that this backend (`start_shop_stock_count`,
`record_shop_stock_count_line`, `complete_shop_stock_count`,
`cancel_shop_stock_count`, `list_shop_stock_counts`,
`get_shop_stock_count_detail`) was already validated in an earlier Shop
Production Acceptance session and must not be rebuilt without a genuine,
newly-found bug. **No bug was found in this pass — none of these six RPCs
were touched, called with a different signature, or otherwise modified.**
Every change in this section is confined to `ShopStockCountPage.tsx`
itself:

- **Progress indicator**: a percentage bar + "`N / M` counted (`X`%)"
  label, computed client-side from the already-fetched
  `get_shop_stock_count_detail` line list (`countedQuantity !== null`).
- **Search + category filter within an open session**: client-side only,
  filtering the session's own already-fetched line list. Category is
  cross-referenced from `list_shop_products`'s existing
  `category_id`/`category_name_ar` columns (already returned, no RPC
  change) since `get_shop_stock_count_detail`'s own row shape has no
  category column and none was added — a real count session's line count
  is bounded to one location's product set, not report-scale, so a
  client-side filter over an already-fetched list is the correct scope
  (no new pagination/RPC filter needed).
- **Expected-vs-counted-vs-variance highlighting**: each line's row now
  gets a subtle whole-row tint (not just the variance cell) — red for
  shortage, green for surplus, neutral for matched/uncounted — and the
  variance cell itself uses red/green/neutral text with an explicit `+`/
  `0`/negative sign, matching the plan's own "+/-/0" instruction.
- **Completion summary**: expanded from 3 tiles (Matched/Shortage/
  Surplus) to 5 (adds Lines Counted, Net Qty Difference) plus a separate
  Value Difference panel.
  - **Value Difference cost source**: reuses the exact same "last
    purchase_receipt cost, club-wide" method C7 established for Stock
    Valuation/Gross Profit — calls `get_shop_stock_valuation` (C7's RPC,
    unmodified) and builds a `product_id::variant_id → unit_cost` lookup
    map client-side, only when a session is `completed` (never fetched
    for an in-progress session, avoiding wasted work).
  - **Honesty enforcement**: gated the same way Stock Valuation/Gross
    Profit are — the RPC itself requires `shop.reports.view_profit`, and
    on `isError` the summary shows "Value difference is hidden — you do
    not have permission..." instead of a money figure (never a fallback
    zero or fabricated number). For a permitted viewer, any line whose
    product/variant has no known cost (no `purchase_receipt` movement
    ever recorded) is **excluded** from the value-difference sum, and an
    explicit "N line(s) excluded — cost unavailable" notice is shown
    whenever that count is non-zero — the same never-fabricate,
    always-disclose-the-gap pattern `get_shop_gross_profit` (C7) already
    established structurally.

## 8. New/extended RPC signatures (exact)

All four are brand-new functions. **Invariant 8 does not apply to any of
them** — no existing `RETURNS TABLE` (or any other) return shape was
changed in place; each is a distinct, newly-created function identity to
Postgres, so a plain `CREATE OR REPLACE` (functionally equivalent to
`CREATE` on a first definition) was correct and safe, no `DROP FUNCTION`
required, no prior grants at risk of being dropped since none existed
yet.

```sql
-- supabase/migrations/20260828180000_shop_receive_transfer_batch_rpcs.sql
receive_shop_stock_batch(
  p_location_id uuid, p_items jsonb, p_supplier_id uuid default null,
  p_reference_number text default null, p_notes text default null
) returns uuid
-- p_items: jsonb array of {product_id, variant_id, quantity, unit_cost}

transfer_shop_stock_batch(
  p_source_location_id uuid, p_dest_location_id uuid, p_items jsonb,
  p_notes text default null
) returns uuid
-- p_items: jsonb array of {product_id, variant_id, quantity}

-- supabase/migrations/20260828180100_shop_product_detail_history_rpcs.sql
list_shop_product_sales_history(
  p_club_id uuid, p_product_id uuid, p_variant_id uuid default null,
  p_start_date date default null, p_end_date date default null,
  p_limit int default 50, p_offset int default 0
) returns table(sale_id uuid, invoice_number text, customer_name text, sold_by_name text,
  variant_label text, quantity numeric, unit_price numeric, line_total numeric,
  returned_quantity numeric, sale_status text, created_at timestamptz)

list_shop_product_returns(
  p_club_id uuid, p_product_id uuid, p_variant_id uuid default null,
  p_start_date date default null, p_end_date date default null,
  p_limit int default 50, p_offset int default 0
) returns table(return_id uuid, sale_id uuid, invoice_number text, customer_name text,
  processed_by_name text, variant_label text, quantity numeric, restock boolean,
  reason text, refund_amount numeric, refund_method text, created_at timestamptz)
```

No existing RPC's signature or return shape was modified anywhere in this
phase. `receive_shop_stock`, `transfer_shop_stock`, `adjust_shop_stock`,
`get_shop_inventory_balances`, `get_shop_inventory_summary`,
`list_shop_inventory_movements`, `get_shop_stock_valuation`, and every
Stock Count RPC are all byte-identical to their pre-C8 definitions.

## 9. Frontend files changed

- `src/features/shop/ShopInventoryPage.tsx` — rewritten: dashboard KPI
  row + recent-activity rollups added above the existing balances table;
  balances table gained image/reorder-level/status columns and a
  click-through to the new `ProductDetailDialog`; `ReceiveStockDialog`
  and `TransferStockDialog` rebuilt for multi-item entry against the two
  new batch RPCs; `AdjustStockDialog` and `ManageSuppliersDialog`
  unchanged (adjust stays single-item — the plan scoped multi-item only
  to receiving/transfer, and a stock adjustment is conceptually always a
  single corrective action against one product/location, not a
  multi-line document).
- `src/features/shop/ShopStockCountPage.tsx` — polished only, as
  documented in §7. No RPC call signatures changed anywhere in this file.
- `src/lib/supabase/types.ts` — added `Args`/`Returns` entries for the
  four new RPCs, matching this file's existing hand-maintained format
  (no live DB to regenerate types from, per the same environment
  constraint every prior phase documented).
- `src/lib/i18n/resources/en/common.json` /
  `src/lib/i18n/resources/ar/common.json` — 47 new keys under
  `shop.inventory.*` (+ `common.done`) and 9 new keys under
  `shop.stockCount.*`, added via a small merge script (same method C7
  used) to avoid hand-editing a 100KB+ JSON file. Verified
  programmatically after: both files parse as valid JSON, and the full
  `shop` namespace is set-identical between `en`/`ar` (zero keys only in
  one language). `git diff --stat` on both files: 67 insertion lines
  each for the inventory-page pass, 9 more each for the stock-count pass
  — no reformatting noise.

## 10. Verification performed (evidence tier per item)

- **`npx tsc -b`**: CODE VERIFIED — clean, 0 errors, after fixing an
  initial batch of errors from (a) the new RPC names not yet existing in
  `src/lib/supabase/types.ts` (added the four entries), (b) a malformed
  type-intersection cast on the product-detail movements query (removed,
  let it infer from the now-correct RPC return type), (c) an unused
  `Ban` icon import, (d) `TransferStockDialog` declaring `notes`/
  `setNotes` state but never rendering the input (added the missing
  field rather than deleting the unused state, since notes-on-transfer
  is a real, intended feature per the RPC's own `p_notes` param).
- **`npm run lint`**: CODE VERIFIED — 0 errors, 13 warnings, identical
  in count and content to the 13 pre-existing warnings C1–C7 all
  documented (confirmed by diffing the warning list before/after this
  phase's changes) — one transient new warning
  (`react-hooks/exhaustive-deps` on the Stock Count completion-summary
  `useMemo`, an unnecessary `productById` dependency left over from an
  earlier draft of that calculation) was caught and fixed during
  self-review before this final run, not left in the final count.
- **`npm run test -- --run`**: CODE VERIFIED — 99 passed, 95 skipped, 2
  test files fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`)
  on `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — confirmed
  this worktree has no `.env.local`, the identical pre-existing
  environment gap C1–C7 all documented; not re-investigated as new, no
  regression from this phase's work (exact same pass/skip/fail counts as
  C7's own documented run).
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: CODE
  VERIFIED — 117 tests, 78 passed, 39 failed, every single failure
  `[webkit-desktop]` on the same pre-existing
  `ms-playwright/webkit-.../Playwright.exe not installed` environment
  gap C1–C7 all documented (exact same 78/39 split) — none of the 39
  failures are in the Shop module (public/auth/responsive suites only,
  per the task's own instruction to re-run "the zero-credential E2E
  suite").
- **RPC/schema fidelity**: CODE VERIFIED by direct migration read for
  every RPC/table this phase relied on or extended (see §1's full
  citation list) — no column name, permission key, or existing-RPC
  behavior was guessed; every claim in this report about an existing
  RPC's current signature/shape was confirmed by reading that RPC's own
  latest live migration file immediately before writing code against it.
- **Invariant 8 compliance**: explicitly re-checked for all four new
  RPCs (see §8) — none change an existing `RETURNS TABLE` shape in
  place; none required a `DROP FUNCTION`; all four are net-new function
  identities to Postgres, correctly using a plain `CREATE OR REPLACE`.
  Zero existing RPCs were extended or modified anywhere in this phase (a
  deliberate scope boundary, not an oversight — the task's own framing
  left both receiving and transfer's transaction-boundary question open,
  and "add new batch RPCs, leave the single-item ones alone" was judged
  the narrower, lower-blast-radius choice over "extend the existing RPCs
  in place to accept an array").
- **No live DB credentials in this worktree**: confirmed (same
  constraint as C1–C7); not worked around, no attempt made to route
  around it. Both new migration files were manually reviewed for
  structural correctness — `$$`-delimiter open/close counts verified to
  match (2 function bodies per file, confirmed via direct grep count),
  every `revoke`/`grant` pair present and correctly scoped to
  `authenticated` only (never `public`/`anon`), matching every
  established RPC's own grant pattern in this module.
- **Live RLS/RPC calls, browser/UI interaction**: ENVIRONMENT-BLOCKED,
  not LIVE VERIFIED / BROWSER VERIFIED — same three blockers C1–C7 all
  documented (no `.env.local`, no Docker-backed local Supabase stack,
  creating a Supabase branch for a disposable test is a material
  paid-service change requiring explicit user go-ahead, not taken
  unilaterally). Recommendation unchanged from every prior phase:
  approve a Supabase branch for a real impersonation/RPC-call test —
  particularly worth prioritizing for this phase specifically are (a)
  `receive_shop_stock_batch`/`transfer_shop_stock_batch`'s actual
  atomic-rollback behavior on a deliberately-invalid mid-array line
  (confirm no partial commit occurs), and (b) the two new product-detail
  history RPCs' real join correctness against fixture sales/returns
  data — or run the equivalent from a session with real credentials/
  local stack.

## 11. Deliberate scope boundaries (not omissions)

- `adjust_shop_stock` was NOT given a batch variant — the plan scoped
  multi-item explicitly to receiving (§22) and transfer (§23) only; a
  stock adjustment is a single corrective action against one product/
  location by its own nature (damage/loss/manual correction), not
  naturally a multi-line document the way a supplier delivery or an
  inter-location move is.
- Product Detail's SUPPLIER tab does not add a `shop_products.supplier_id`
  column — confirmed the plan's own schema section (§4) never proposed
  one, and supplier-per-receipt (not supplier-per-product) is the
  directive's own confirmed design, reused rather than second-guessed.
- Stock Count's six canonical RPCs are byte-identical to their pre-C8
  definitions — no signature change, no new parameter, no behavior
  change of any kind, per the task's explicit instruction and this
  phase's own finding that no genuine bug existed to justify touching
  them.
- No new storage bucket, no new schema table/column anywhere in this
  phase — every new capability is either a client-side derivation from
  already-existing data or one of the four new, additive RPCs listed in
  §8.

## 12. Commit

Committed locally to this worktree's own branch
(`worktree-agent-a54e861d4050b793a`) — no push, no merge, no interaction
with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`.
