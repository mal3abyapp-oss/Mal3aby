# Commerce Pro — Phase C7 Report: 16-Report Suite + Profitability (Cost-at-Sale)

Written 2026-08-28, in isolated worktree `worktree-agent-ac15c792a607b3833`
(built on top of C1–C6, already merged in this worktree), per
`COMMERCE_PRO_UPGRADE_PLAN.md` Section 5 (Phase C7) and
`AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: cost-at-sale snapshot schema
+ `create_shop_sale` extension, then the 16-report suite.

## 1. Reading performed before writing any code

Read the full plan (`COMMERCE_PRO_UPGRADE_PLAN.md`, all sections,
especially §2 invariant 8), `AGENT_ORCHESTRATION_GOVERNANCE.md` (all
three incidents), and all six prior reports (`COMMERCE_C1` through
`COMMERCE_C6`) in full before writing anything.

Read `ReportShopPage.tsx`, `useDateRangeReport.ts`, `fetchFullReport.ts`,
`report-print-header.tsx` (`ReportPrintButton`/`ReportPrintHeader`),
`FinanceReportsPage.tsx` (the house pattern for a multi-report hub with
a URL-addressable `?tab=` switcher — confirmed as the correct precedent
to reuse rather than inventing 16 top-level routes), `ShopSalesPage.tsx`
(C5's own filter/pagination/print-full template, effectively a working
example of report #2 already), `ShopInventoryPage.tsx`'s movement
list/print-full wiring, C5's `list_shop_sales`/`get_shop_sales_kpis`
live definitions, C6's `get_shop_sales_by_category`/
`get_shop_payment_method_mix`/`list_shop_recent_returns` live
definitions, `create_shop_sale`'s **true latest** live body
(`20260828120200_create_shop_sale_discount.sql`, confirmed via `grep -rl`
across all migrations and comparing timestamps — this is its 4th
consecutive extension: partial payment → discount → now cost snapshot),
the full `shop_inventory_movements`/`shop_inventory_balances`/
`shop_stock_counts`/`shop_stock_count_items`/`shop_products`/
`shop_product_variants`/`shop_sale_items`/`shop_suppliers` schemas
(direct migration reads, not assumptions), `receive_shop_stock`'s live
body (to find the actual supplier↔movement linkage:
`reference_type='shop_supplier'`, `reference_id=p_supplier_id`, both
nullable), and `get_shop_inventory_balances`'/
`list_shop_inventory_movements`'/`get_shop_inventory_summary`'s latest
live bodies.

### Correction found: the plan's stated `useDateRangeReport` param-name mismatch does not exist

The task brief warned that Shop's `get_shop_top_products`/
`get_shop_inventory_summary` might use different param names than
`useDateRangeReport`'s hardcoded `p_start_date`/`p_end_date`. Checked
directly: both RPCs' real signatures
(`get_shop_top_products(p_club_id uuid, p_start_date date default null,
p_end_date date default null, p_limit integer default 10)`,
`get_shop_inventory_summary(p_club_id uuid)`) already use exactly
`p_start_date`/`p_end_date` — there is no mismatch in the current code.
`ReportShopPage.tsx` itself doesn't use the shared hook only because it
predates it (hand-writes the same `p_start_date`/`p_end_date` call
inline) — not because of an incompatibility. This phase's own new
report components use `useDateRange()` (the date-state half of that
file) directly and call `supabase.rpc()` themselves rather than
`useDateRangeReport<T>()` the generic wrapper, because most of this
phase's RPCs need additional filter params beyond the hook's
`extraParams` convenience and because several reports (Category Sales,
Payment Method Mix wrappers) needed `.maybeSingle()`/array-mapping
logic the generic hook doesn't provide — a deliberate, documented
choice, not a rediscovery of a real mismatch.

## 2. Cost-at-sale snapshot (built first, per the task's own ordering)

### Investigation

Confirmed via direct schema read (`20260826210231_shop_catalog_schema.sql`,
unchanged through C1–C6) that neither `shop_products` nor
`shop_product_variants` has ever had a cost column. The only cost data
anywhere is `shop_inventory_movements.unit_cost`, populated exclusively
by `receive_shop_stock()` on `movement_type='purchase_receipt'`; every
other movement type (including both `transfer_out`/`transfer_in`,
confirmed via `transfer_shop_stock`'s live body) always passes `null`
for `unit_cost`.

### Derivation method chosen: **last cost** (documented, not silently assumed)

For each sale line, at the moment of sale, `create_shop_sale` now looks
up the most recent `purchase_receipt` movement's `unit_cost` for that
exact `(product_id, variant_id)`, **club-wide across all locations**
(not scoped to the selling location) — because `transfer_*` movements
never carry `unit_cost` themselves, so scoping to one location would
silently miss the true last-known cost for stock that arrived via an
inter-location transfer rather than a direct receipt.

**Documented limitations (honest, not hidden):**
1. Last cost, not FIFO or weighted-average — if two purchase receipts
   at different unit costs exist, only the chronologically most recent
   one is used, never a blended figure.
2. A product/variant with no `purchase_receipt` movement ever (e.g.
   only `opening_balance` or a costless manual adjustment) gets a
   `null` snapshot — never defaulted to 0, never inferred from
   `base_price`.
3. Never backfilled or recalculated after insert — a snapshot taken at
   sale time is permanent even if a later purchase receipt arrives at a
   different cost; rewriting it would silently change a completed
   sale's own historical cost basis, the same reasoning the plan's
   invariants already apply to discounts.

### Schema

`supabase/migrations/20260828170000_shop_cost_at_sale_snapshot.sql` —
`shop_sale_items.unit_cost_snapshot numeric` (nullable, additive, with
a `>= 0`-or-null check constraint).

### `create_shop_sale` extension

`supabase/migrations/20260828170100_create_shop_sale_cost_snapshot.sql`
— the full live body was copied verbatim from
`20260828120200_create_shop_sale_discount.sql` (confirmed latest) and
only the per-item-loop `INSERT INTO shop_sale_items` gained the new
`unit_cost_snapshot` column, populated by a correlated subquery
(ordered `created_at desc limit 1`) exactly matching the derivation
above. **Signature is completely unchanged** (still the same 10 params,
same order) and the function `RETURNS uuid` (a scalar), not a
`RETURNS TABLE` — so invariant 8 does not apply at all here; a plain
`CREATE OR REPLACE` in place is correct and safe (confirmed: no `DROP
FUNCTION` needed, no grant re-statement required, though the grants
were re-stated anyway as harmless defense-in-depth so the migration
file is self-contained).

## 3. Report suite — what was built vs. deferred

All 16 items were built. No item was deferred, though several were
deliberately scoped lighter per the plan's own explicit allowance
(Supplier Purchase Activity) or deliberately reuse an existing surface
rather than duplicating it (Sales Summary → links to C6's Dashboard).

| # | Report | RPC(s) used | New/Extended |
|---|---|---|---|
| 1 | Sales Summary | `get_shop_sales_kpis` (C5) | Reused, unmodified |
| 2 | Sales Detail | `list_shop_sales` (C5) | Reused, unmodified |
| 3 | Product Sales | `get_shop_top_products` | Extended: `p_offset`, `p_category_id` |
| 4 | Category Sales | `get_shop_sales_by_category` (C6) | Reused, unmodified |
| 5 | Payment Method Sales | `get_shop_payment_method_mix` (C6) | Reused, unmodified |
| 6 | Cashier Sales | `list_shop_sales` (C5) + client rollup | Reused, unmodified (client-side aggregation, matching C6's own precedent) |
| 7 | Customer Purchases | `get_customer_shop_purchases` | Extended: `p_start_date`, `p_end_date`, `p_limit`, `p_offset` |
| 8 | Returns / Refunds | `list_shop_sale_returns` | **New** |
| 9 | Inventory On Hand | `get_shop_inventory_balances` | Reused, unmodified |
| 10 | Stock Movement Ledger | `list_shop_inventory_movements` | Extended: `p_start_date`, `p_end_date`, `p_movement_type` |
| 11 | Low Stock | `get_shop_inventory_balances(p_low_stock_only)` | Reused, unmodified |
| 12 | Out of Stock | `get_shop_inventory_balances` + client filter | Reused, unmodified |
| 13 | Stock Valuation | `get_shop_stock_valuation` | **New** |
| 14 | Gross Profit / Margin | `get_shop_gross_profit` | **New** |
| 15 | Supplier Purchase Activity | `get_shop_supplier_purchase_activity` | **New** |
| 16 | Stock Count Variance | `list_shop_stock_count_variance` | **New** |

### Item 1 — Sales Summary: reuse decision, documented

C6's Shop Dashboard already covers every genuine "summary" need (KPI
row, top products, category/payment breakdowns, low stock, recent
activity — all "today"-scoped). Building a second, separate Sales
Summary report here would either duplicate the dashboard with a
date-range picker bolted on, or become a shallower page with less
information than the dashboard already has. **Decision**: Sales
Summary in this report suite is a genuine, date-range-scoped KPI card
(reusing `get_shop_sales_kpis`, the same RPC the Sales page's own KPI
row uses) plus explicit links to both the live Dashboard and the Sales
Detail report below — giving the suite a real, addressable "summary"
entry point without re-deriving what C6 already built well.

### Item 6 — Cashier Sales: client-side rollup, same precedent as C6

Derived client-side from `list_shop_sales` (`p_limit: 500` for the
selected date range), matching C6's own "Sales by Cashier" dashboard
precedent and C5's own reasoning for why `shop_sales.sold_by` has no
FK path to `profiles` for PostgREST embedding. The 500-row bound is
disclosed on-screen (`shop.reports.cashierSales.boundNote`) — a very
wide date range with genuinely more than 500 sales will undercount,
documented rather than silently wrong.

### Item 8 — Returns / Refunds: new RPC, not an extension of C6's dashboard feed

`list_shop_recent_returns` (C6) is deliberately narrow — no filters,
fixed `p_limit` default of 10, no `p_offset` — built for a dashboard
card. Extending it in place would be scope creep on a function the
Dashboard already depends on for a specific, narrow purpose. New RPC
`list_shop_sale_returns` with the same join shape plus real filters
(date range, refunded-only/not) and real pagination.

### Items 9/11/12 — Inventory On Hand / Low Stock / Out of Stock

All three reuse `get_shop_inventory_balances` unmodified. Low Stock
inherits that RPC's own documented never-stocked-variant gap (a
variant with zero balance rows anywhere is invisible to
`p_low_stock_only`) — the same gap C6 found and deliberately left
unfixed because other callers (receive/transfer/adjust dialogs) depend
on the current row shape. This report's on-screen note discloses the
gap rather than silently inheriting it. Out of Stock filters to
`on_hand === 0` client-side since the RPC has no dedicated zero-only
flag and balances are already a bounded, per-club dataset — not the
kind fetchFullReport's pagination contract exists for (confirmed:
`ShopInventoryPage.tsx` itself already consumes this same RPC
unpaginated).

### Item 10 — Stock Movement Ledger: mandatory pagination, as instructed

`list_shop_inventory_movements` already had `p_limit`/`p_offset`.
Extended additively with `p_start_date`/`p_end_date`/`p_movement_type`
— real operational filters this table's own size makes necessary.
Server-side pagination via the shared pager UI plus "Print Full
Report" (`fetchFullReport.ts`, capped at 8000 rows, never silently
truncated).

### Item 13 — Stock Valuation: cost source decision, documented

Uses the **same** "last purchase-receipt cost, club-wide" source as the
cost-at-sale snapshot, for consistency — documented explicitly in the
RPC's own migration comment: a point-in-time valuation of current
on-hand stock ("what would it cost to replace what's on the shelf
right now") is conceptually the same signal as "most recent purchase
cost," and reusing it means Stock Valuation and Gross Profit never
silently disagree about what "cost" means for the same product. A unit
never yet received shows `unit_cost`/`line_value` as `null` (rendered
"Cost unavailable"), never fabricated as 0; the on-screen total
excludes those and discloses how many rows were excluded.

### Item 14 — Gross Profit / Margin: the honesty requirement, enforced structurally

`get_shop_gross_profit` computes `revenue_known_cost`/`cost_of_goods`/
`gross_profit`/`margin_pct` **only** from `shop_sale_items` rows with a
non-null `unit_cost_snapshot`, and separately returns
`known_cost_lines`/`cost_unavailable_lines`/`cost_unavailable_revenue`.
This is enforced in the SQL itself (two CTEs, `known`/`unknown`, split
on `unit_cost_snapshot is null`), not left to the frontend to remember
to filter — a caller cannot accidentally compute a fabricated margin
by forgetting to exclude null-cost lines, because the RPC never returns
them mixed in. The report page renders an explicit, unmissable notice
(`shop.reports.gp.honestyNoticeWithGap`) stating exactly how many
lines and how much revenue were excluded for lacking a known cost, any
time the gap is non-zero, and a positive "every line has a known cost"
notice when it is zero. Any sale before the cost-at-sale column existed
correctly shows 100% of its lines excluded from every money figure —
never a fabricated number.

Gated on the new `shop.reports.view_profit` permission (see §4 below)
in addition to `report.view`.

### Item 15 — Supplier Purchase Activity: lighter report, per the plan's own allowance

`shop_suppliers` is confirmed a minimal lookup table (name/phone/email/
notes/is_active only — no procurement/accounts-payable engine, per
that table's own schema comment). The only purchase↔supplier linkage
anywhere is `receive_shop_stock` writing
`reference_type='shop_supplier'`, `reference_id=p_supplier_id` onto the
movement row it creates, and `p_supplier_id` is optional there. This
report is therefore genuinely light, as anticipated: one row per
supplier (receipt count, total quantity, total cost value, last
receipt date) plus an explicit "no supplier recorded" bucket for
receipts that were never attributed — never silently dropped from the
total.

### Item 16 — Stock Count Variance: summary/list across counts, not a UX rebuild

Reuses `shop_stock_counts`/`shop_stock_count_items` exactly as-is —
`variance` is already a `GENERATED ALWAYS STORED` column
(`counted_quantity - system_quantity`), never recomputed by this
report. One row per counted line across every completed count in
range, with a "non-zero variance only" toggle (default on) so a
manager can see which specific lines had the biggest discrepancy
without opening each count individually. This does not touch or
duplicate `ShopStockCountPage.tsx`'s own dedicated count-session UX.

## 4. New permission: `shop.reports.view_profit` — seeded this phase

C6's own report flagged that the plan's §3 lists
`shop.reports.view_profit` as a permission to gate profitability
reporting behind, but it was never actually seeded — C6 had nothing
real to protect with it (its profitability section was only a "not
tracked yet" text notice, no query, no data) and correctly deferred
seeding it to "whichever future phase (C7, cost-at-sale) actually needs
it."

C7 is that phase. Seeded in
`supabase/migrations/20260828170150_shop_reports_view_profit_permission_seed.sql`
(runs before the RPC-extension migration, confirmed via timestamp
ordering), following the exact `shop.discount.apply` seed pattern:
`club_owner`-only by default (matching this codebase's existing posture
on other commercially-sensitive views, e.g. `shop.settings.manage`),
with a `permission_dependencies` row requiring `report.view`. Both
`get_shop_gross_profit` and `get_shop_stock_valuation` check this
permission **in addition to** `report.view`/`inventory.view`
respectively — a role without the grant sees a real, translated
"permission denied" state on those two report tabs specifically, every
other report in the suite is unaffected.

## 5. Frontend architecture

### Hub page pattern: reused, not invented

`FinanceReportsPage.tsx` already established the house pattern for a
multi-report hub: one page, a URL-addressable `?tab=` switcher, each
report as its own `Report*Content` component. Sixteen separate
top-level routes would have fragmented `ShopNav`/`ReportsNav` far
beyond what a scrollable tab strip can reasonably hold; this pattern
keeps every report independently deep-linkable while keeping the
existing `/app/reports/shop` route meaningful — **same URL, same nav
entry point, richer content**. `ReportShopPage.tsx` (top-products +
inventory-summary only) is superseded as the route's target by the new
`ShopReportsPage.tsx` hub; the old file is left in the tree (unused,
harmless) rather than deleted, in case a narrower rollback is ever
needed.

### Files added

- `src/features/shop/ShopReportsPage.tsx` — the hub, 16-tab switcher.
- `src/features/shop/reports/shopReportShared.tsx` — shared pager
  (`useOffsetPager`, `PagerControls`), `ReportHeaderActions`
  (print + print-full buttons), `FullPrintNote` — centralizing the
  boilerplate every report repeats, mirroring this codebase's own
  stated reasoning for `useDateRangeReport.ts` existing.
- `src/features/shop/reports/ShopSalesSummaryReports.tsx` — items 1–2.
- `src/features/shop/reports/ShopSalesReports.tsx` — items 3–7.
- `src/features/shop/reports/ShopReturnsReport.tsx` — item 8.
- `src/features/shop/reports/ShopInventoryReports.tsx` — items 9–13,
  15–16.
- `src/features/shop/reports/ShopProfitReport.tsx` — item 14.

### Print-full / pagination discipline

Every report whose underlying data can genuinely grow large (Sales
Detail, Product Sales, Returns, Stock Movement Ledger, Customer
Purchases, Stock Count Variance) uses the exact same `fetchFullReport`
contract every other report in this app uses: bounded 50-row screen
query, an explicit on-demand "Print Full Report" action that pages
through the *same* RPC with the *same* filters, capped at 8000 rows,
with an unmissable truncation notice if the cap is ever hit. Reports
whose data is structurally small and bounded (Category Sales, Payment
Method Mix, Inventory On Hand/Low Stock/Out of Stock, Stock Valuation,
Supplier Activity) do not carry pagination/print-full UI at all — this
is a deliberate omission, not an oversight, since offering pagination
controls for a dataset that cannot exceed one row per category/
location/supplier would be UI noise with no real function.

### Router change

`src/app/routing/router.tsx` — `ReportShopPage` import replaced with
`ShopReportsPage`; the `reports/shop` route element updated to the
new component. Same `RequireNavDomain domain="reports"` +
`RequireShopModule` gating, unchanged.

## 6. i18n

New `shop.reports.*` subtree (21 top-level keys, ~90 leaf strings)
added to both `src/lib/i18n/resources/en/common.json` and
`ar/common.json` via a small merge script (to avoid hand-editing a
100KB+ JSON file at this scale) — verified programmatically after: both
files parse as valid JSON, and the full `shop` namespace is
set-identical between `en`/`ar` (zero keys only in one language),
walking both trees and diffing the flattened key lists, the same method
every prior phase used. `git diff --stat` on both files shows a clean,
minimal diff (125 insertion lines each, no reformatting noise).

## 7. New/extended RPC signatures (exact)

```sql
-- Extended (invariant 8: unchanged return shape, safe in-place per the
-- plan's own carve-out; old-signature overload explicitly dropped)
get_shop_top_products(
  p_club_id uuid, p_start_date date default null, p_end_date date default null,
  p_limit integer default 10, p_offset integer default 0, p_category_id uuid default null
) returns table(product_id uuid, product_name_ar text, units_sold numeric, units_returned numeric, revenue numeric)

list_shop_inventory_movements(
  p_club_id uuid, p_product_id uuid default null, p_location_id uuid default null,
  p_limit integer default 50, p_offset integer default 0,
  p_start_date date default null, p_end_date date default null, p_movement_type text default null
) returns table(movement_id uuid, location_name text, product_name_ar text, variant_label text,
  movement_type text, quantity numeric, unit_cost numeric, actor_id uuid, reference_type text,
  reference_id uuid, reason text, created_at timestamptz)

get_customer_shop_purchases(
  p_club_id uuid, p_customer_id uuid, p_start_date date default null, p_end_date date default null,
  p_limit integer default 100, p_offset integer default 0
) returns table(sale_id uuid, invoice_id uuid, invoice_number text, sale_status text, product_name_ar text,
  variant_label text, quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric,
  created_at timestamptz)

-- create_shop_sale: signature and return type BOTH unchanged (still 10
-- params, still returns uuid) -- invariant 8 does not apply; body only
-- gained cost-snapshot logic in the existing item-insert loop.
create_shop_sale(
  p_club_id uuid, p_location_id uuid, p_customer_id uuid, p_items jsonb, p_payment_method text,
  p_payment_reference text default null, p_idempotency_key uuid default null, p_payment_amount numeric default null,
  p_discount_amount numeric default 0, p_discount_reason text default null
) returns uuid

-- New (no existing RETURNS TABLE shape changed, invariant 8 not applicable)
list_shop_sale_returns(
  p_club_id uuid, p_start_date date default null, p_end_date date default null,
  p_restock_only boolean default null, p_refunded_only boolean default null,
  p_limit int default 50, p_offset int default 0
) returns table(return_id uuid, sale_id uuid, invoice_number text, processed_by_name text, restock boolean,
  reason text, created_at timestamptz, refund_amount numeric, refund_method text)

get_shop_stock_valuation(p_club_id uuid, p_location_id uuid default null)
returns table(location_id uuid, location_name text, product_id uuid, product_name_ar text, variant_id uuid,
  variant_label text, on_hand numeric, unit_cost numeric, line_value numeric)
-- gated on inventory.view AND shop.reports.view_profit

get_shop_gross_profit(
  p_club_id uuid, p_start_date date default null, p_end_date date default null,
  p_category_id uuid default null, p_product_id uuid default null
) returns table(revenue_known_cost numeric, cost_of_goods numeric, gross_profit numeric, margin_pct numeric,
  known_cost_lines bigint, cost_unavailable_lines bigint, cost_unavailable_revenue numeric)
-- gated on report.view AND shop.reports.view_profit

get_shop_supplier_purchase_activity(
  p_club_id uuid, p_start_date date default null, p_end_date date default null, p_supplier_id uuid default null
) returns table(supplier_id uuid, supplier_name text, receipt_count bigint, total_quantity numeric,
  total_cost_value numeric, last_receipt_at timestamptz)

list_shop_stock_count_variance(
  p_club_id uuid, p_start_date date default null, p_end_date date default null, p_location_id uuid default null,
  p_nonzero_only boolean default false, p_limit int default 100, p_offset int default 0
) returns table(stock_count_id uuid, location_name text, completed_at timestamptz, product_name_ar text,
  variant_label text, system_quantity numeric, counted_quantity numeric, variance numeric, counted_by_name text)
```

## 8. Deliberate scope boundaries (not omissions)

- No item from the 16-report list was deferred. Items 15 (Supplier
  Purchase Activity) is deliberately lighter, per the plan's own
  explicit allowance, because the underlying data (`shop_suppliers`) is
  genuinely thin.
- Sales Summary (item 1) deliberately reuses C6's Dashboard rather than
  re-deriving the same KPI/breakdown content a second time — see §3.
- Cashier Sales (item 6) deliberately stays a client-side rollup rather
  than a new RPC, matching C6's own established precedent for this
  exact same computation.
- `get_shop_inventory_balances`'s documented never-stocked-variant gap
  in `p_low_stock_only` mode is inherited by the Low Stock report, not
  re-fixed here — same reasoning C6 already applied (other callers
  depend on the current row shape); disclosed on-screen.
- No new schema beyond `shop_sale_items.unit_cost_snapshot` — every
  other report reuses existing tables exactly as they are.
- `parent_category_id`/nested categories remain out of scope (unchanged
  from C1) — Category Sales groups flat, matching the schema.

## 9. Verification performed (evidence tier per item)

- **`npx tsc -b`**: CODE VERIFIED — clean, 0 errors (three unused-import
  errors caught and fixed during self-review before this final run:
  `ShopInventoryReports.tsx`'s unused `error` destructure,
  `ShopReturnsReport.tsx`'s unused `StatusBadge` import,
  `ShopSalesReports.tsx`'s unused `ShoppingCart` import).
- **`npm run lint`**: CODE VERIFIED — 0 errors, 13 warnings total (the
  same 12 pre-existing warnings C1–C6 all documented, plus exactly one
  new warning on `shopReportShared.tsx` — a `react-refresh/only-export-
  components` warning from exporting both a hook and components from
  one file, the identical benign category as `AuthProvider.tsx`/
  `DirectionProvider.tsx`'s own pre-existing warnings; not a real
  defect).
- **`npm run test -- --run`**: CODE VERIFIED — 99 passed, 95 skipped, 2
  test files fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`)
  on `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — confirmed
  this worktree has no `.env.local`, the identical pre-existing
  environment gap C1–C6 all documented; not re-investigated as new, no
  regression from this phase's work.
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: CODE
  VERIFIED — 117 tests, 78 passed, 39 failed, every failure
  `[webkit-desktop]` on a browser-executable-missing error
  (`ms-playwright/webkit-.../Playwright.exe` not installed), entirely
  outside the Shop module — identical failure count and root cause to
  C1–C6's own documented results; not re-investigated as new.
- **RPC/schema fidelity**: CODE VERIFIED by direct migration read —
  `create_shop_sale`'s true latest body,
  `shop_products`/`shop_product_variants`/`shop_sale_items`/
  `shop_inventory_movements`/`shop_inventory_balances`/
  `shop_stock_counts`/`shop_stock_count_items`/`shop_suppliers`/
  `shop_categories`/`refunds`/`shop_sale_returns` schemas,
  `receive_shop_stock`'s/`transfer_shop_stock`'s live bodies (to
  confirm the real supplier↔movement linkage and that transfers never
  carry `unit_cost`), and `get_shop_inventory_balances`'/
  `list_shop_inventory_movements`'/`get_shop_top_products`'/
  `get_customer_shop_purchases`'/`_shop_module_active`'s/
  `has_permission`'s latest live definitions were all read directly
  from their real migration files before being relied on or extended —
  no column name was guessed.
- **Invariant 8 compliance**: explicitly re-checked for every RPC this
  phase touches, not just new ones. Three extended RPCs
  (`get_shop_top_products`, `list_shop_inventory_movements`,
  `get_customer_shop_purchases`) changed their parameter list but kept
  their `RETURNS TABLE` row shape byte-identical — per the plan's own
  §2 invariant 8 carve-out, this is safe as a plain `CREATE OR REPLACE`
  on a new overload (new function identity to Postgres), and the old
  overload was explicitly dropped in every case to prevent a stale,
  unfiltered version staying callable. `create_shop_sale`'s signature
  and scalar return type are both fully unchanged, so invariant 8 does
  not apply to it at all. No `RETURNS TABLE` row shape was ever changed
  in place anywhere in this phase — the fourth-time mistake this
  invariant exists to prevent was not repeated.
- **No live DB credentials in this worktree** — confirmed (same
  constraint as C1–C6); not worked around, no attempt made to route
  around it. Migration SQL was reviewed manually for syntax/logic
  correctness against the real, current live schema/RPC definitions,
  including a structural check that every function definition's `$$;`/
  `$function$;` closing delimiter count matches its opening count, and
  that every `revoke`/`grant` pair is present for every function
  touched.
- **Live RLS/RPC calls, browser/UI interaction**: ENVIRONMENT-BLOCKED,
  not LIVE VERIFIED / BROWSER VERIFIED — same three blockers C1–C6 all
  documented (no `.env.local`, no Docker-backed local Supabase stack,
  and creating a Supabase branch for a disposable test is a material
  paid-service change requiring explicit user go-ahead, not taken
  unilaterally). Recommendation unchanged: approve a Supabase branch
  for a real impersonation/report-load test — especially the cost-at-
  sale snapshot's actual population on a real `create_shop_sale` call
  against fixture data with a real prior `receive_shop_stock` receipt,
  and the two `shop.reports.view_profit`-gated reports' real
  permission-denial behavior for a non-owner role — or run the
  equivalent from a session with real credentials/local stack.

## 10. Commit

Committed locally to this worktree's own branch
(`worktree-agent-ac15c792a607b3833`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`.
