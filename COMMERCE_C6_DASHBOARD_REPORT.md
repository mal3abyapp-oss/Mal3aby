# Commerce Pro — Phase C6 Report: Shop Dashboard

Written 2026-08-28, in isolated worktree `worktree-agent-a29a825c8e18cff2b`
(built on top of C1–C5, already merged in this worktree), per
`COMMERCE_PRO_UPGRADE_PLAN.md` Section 5 (Phase C6) and
`AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: a dedicated Shop dashboard
page only.

## 1. Route placement decision

Read `src/app/routing/router.tsx`, `ShopLayout.tsx`, `ShopNav.tsx`
before deciding. `/app/shop`'s existing index route is `ShopPOSPage` —
the checkout/point-of-sale screen. **Decision: new page at
`/app/shop/dashboard`, additional and reachable from `ShopNav.tsx`, NOT
the new default landing page.** Reasoning: POS is the highest-frequency,
most time-critical daily action for a cashier (ring up a sale, every
transaction, all day). A dashboard is a glance-once-a-day,
manager/owner-facing surface. Demoting checkout behind an extra click
for every cashier to make room for a dashboard would be a real UX
regression for a retail POS app, not a neutral IA choice. Documented
inline in both `ShopDashboardPage.tsx`'s header comment and at the two
route/nav edit sites so a future phase doesn't "fix" this by swapping
the index route without re-deriving the same reasoning.

Added `ShopDashboardPage` import + lazy route (`src/app/routing/router.tsx`)
and a new `shop.nav.dashboard` tab (`src/features/shop/components/ShopNav.tsx`,
`LayoutDashboard` icon) between "Sell" and "Products".

## 2. What was reused vs. what was new

Read `get_shop_top_products`'s and `get_shop_inventory_summary`'s
**latest** live definitions before writing anything —
`get_shop_inventory_summary`'s current body is the
`20260828095500_fix_shop_inventory_summary_out_of_stock_missing_variants.sql`
version (the "sellable units" rewrite fixing the never-stocked-variant
undercount), confirmed via direct migration read, not assumed from the
original `20260826231553` version.

**Reused unchanged, no new RPC:**
- `get_shop_sales_kpis` (C5) — scoped to today via
  `p_start_date`/`p_end_date` both set to the current date. Drives the
  KPI row directly (transaction count, gross sales, discount, refund,
  net sales, items sold, average basket — the exact 7 columns C5
  already returns; nothing duplicated).
- `get_shop_top_products` — `p_limit: 5`, scoped to today.
- `get_shop_inventory_summary` — low-stock/out-of-stock **counts** for
  the KPI row (already correct per the Aug 28 fix above).
- `get_shop_inventory_balances(p_low_stock_only=true)` — the actual Low
  Stock **list** (not just a count), per-location rows, sliced to 8 for
  the dashboard card. Deliberately did NOT modify this RPC's row shape:
  its documented never-stocked-variant gap (a variant with zero balance
  rows anywhere is invisible to `p_low_stock_only`) is called out in
  that RPC's own migration comment as a known, deliberately-deferred
  issue because other callers (receive/transfer/adjust dialogs) depend
  on its current row shape — re-confirmed that reasoning still holds
  and left it untouched rather than bundling an unrelated fix into this
  phase.
- `list_shop_sales` — Recent Sales (limit 8, today) and, separately, a
  second call with `p_limit: 500` (today only, so bounded in practice)
  for the client-side Sales-by-Cashier rollup (see Section 4).

**New, genuinely missing (3 RPCs, one migration,
`supabase/migrations/20260828160000_shop_dashboard_rpcs.sql`):**
- `get_shop_sales_by_category(p_club_id, p_start_date, p_end_date)` →
  `category_id, category_name, units_sold, revenue` — no existing RPC
  aggregates BY category; `list_shop_sales`'s `p_category_id` is a
  filter, not a rollup. Revenue re-derived from `invoice_items.line_total`
  (never independently summed), matching every other Shop revenue RPC.
  Uncategorized products group under a null-id row rather than being
  dropped.
- `get_shop_payment_method_mix(p_club_id, p_start_date, p_end_date)` →
  `method, transaction_count, total_amount` — checked whether C5's
  `list_shop_sales`/`get_shop_sales_kpis` already carried enough to
  derive this client-side first; they don't, because a sale can have
  more than one payment (split-tender, C3) and `p_payment_method` is a
  filter (EXISTS subquery), not a breakdown — deriving client-side would
  either double-count a sale under multiple methods or be unable to
  attribute the right amount per method. Sums `payments.amount` via
  `payment_allocations` (the correct source of truth for "how much of
  which method was actually collected"), not `invoices.total`.
- `list_shop_recent_returns(p_club_id, p_limit)` → `return_id, sale_id,
  invoice_number, processed_by_name, restock, reason, created_at,
  refund_amount, refund_method` — C5's `get_shop_sale_returns_history`
  is deliberately per-sale (`p_sale_id` required, built for the Sale
  Detail dialog). A club-wide, recency-ordered feed needed a new,
  narrowly-scoped RPC; same shape/join pattern as the per-sale version
  (refund amount/method only populate when a refund actually happened —
  a restock-only return correctly shows null, not 0).

All three are **brand-new function names** — no existing `RETURNS
TABLE` shape was changed, so invariant 8 (explicit `DROP FUNCTION`
before changing a return shape) does not apply to any of them; each is
a plain new `CREATE OR REPLACE FUNCTION` with its own `revoke`/`grant`.
Documented explicitly in the migration file's own header comment so a
future reviewer doesn't need to re-derive that this migration is exempt
from invariant 8.

Every table/column referenced (`shop_categories.name_ar`,
`shop_products.category_id`, `invoice_items.line_total`,
`payments.method`/`.status`, `payment_allocations.amount`,
`refunds.payment_id`/`.status`, `shop_sale_returns.*`) was confirmed via
direct schema read (`20260826210231_shop_catalog_schema.sql`,
`20260815210000_phase6_booking_billing_schema.sql`,
`20260815250000_phase7_billing_core.sql`,
`20260826210846_shop_sales_schema.sql`) before being used — no column
name was guessed.

## 3. "Who sold it" — derived client-side, no 4th new RPC

`fetchSalesByCashier` calls `list_shop_sales` a second time (today only,
`p_limit: 500`, well above realistic daily transaction volume for a
single club/day) and groups by `sold_by_name` client-side. Checked
first whether this needed a new RPC: the Sales page's own cashier
filter (C5) already proved deriving cashier breakdowns client-side from
`list_shop_sales` rows is a viable, correctly-scoped pattern for this
data volume (see C5 report Section 3a) — reused the same reasoning
rather than adding a fourth new RPC for a rollup this cheap to compute
for a single day's data.

## 4. Profitability — honest, not fabricated

Re-confirmed `shop_sale_items`'s schema directly
(`20260826210846_shop_sales_schema.sql`): `id, sale_id, product_id,
variant_id, quantity, unit_price, line_total, returned_quantity,
invoice_item_id` — **no cost column**, unchanged through C1–C5. No
cost-at-sale snapshot exists anywhere in this codebase today.

**Correction found during this phase**: the plan's own §3 lists
`shop.reports.view_profit` as a permission to gate profitability
reporting behind. Grepped every C1–C5 migration for it —
**it was never actually seeded**; it only exists in the plan document,
not in the live permission catalog (confirmed via direct migration
read, not assumed). Since this section carries no real numbers at all
(only an honest "not tracked yet" notice, no query, no data), there is
nothing sensitive to gate behind a dedicated permission — it renders
under the same `shop.view`/`report.view` gate as the rest of the
dashboard. Did not seed `shop.reports.view_profit` unprompted since
permissions are out of C6's scope; flagging the plan-vs-reality gap
here for whichever future phase (C7, cost-at-sale) actually needs it.

The dashboard shows a dashed-border notice card:
> "Cost data not yet tracked — profitability reporting requires Phase
> C7's planned cost-at-sale feature."

No fabricated margin number, no silent omission — exactly the plan's
own instruction.

## 5. Sections built (6 of the plan's 7 recommended, one deliberately deferred)

- **KPI row** (8 `StatCard` tiles): Today Sales, Today Net Sales,
  Orders, Average Order Value, Items Sold, Returns, Low Stock, Out of
  Stock — the plan's exact recommended set. Reused `StatCard`
  (`src/components/ui/stat-card.tsx`) unmodified — C5's `ReactNode`
  value-type widening already supports rendering `<MoneyDisplay>`
  inside a tile, confirmed by reading the component before using it, no
  further change needed.
- **Top Products** — table, reused `get_shop_top_products`.
- **Sales by Category** — new bar-style rollup (`get_shop_sales_by_category`).
- **Payment Method Mix** — new bar-style rollup
  (`get_shop_payment_method_mix`).
- **Low Stock (list, not just count)** — table, reused
  `get_shop_inventory_balances(p_low_stock_only=true)`, sliced to 8,
  "View all" links to `/app/shop/inventory`.
- **Recent Sales** — table, reused `list_shop_sales` (limit 8, today),
  "View all" links to `/app/shop/sales`.
- **Recent Returns** — table, new `list_shop_recent_returns` (limit 6).
- **Sales by Cashier** — table, derived client-side (Section 3).

**Deliberately deferred: Sales Trend (day-by-day chart).** The plan
itself explicitly permits deferring this ("only if you can derive
genuine day-by-day data cheaply... if deferred, say so") and explicitly
warns against decorative charts with no operational value. Every other
section on this dashboard is scoped to "today" by design (matching the
KPI row's own single-day default) — a real day-by-day trend needs a
deliberate date-bucketing design (how many days back, which timezone
bucket boundary, whether it double-counts a sale that straddles
midnight `Africa/Cairo` vs. UTC) that deserves its own considered pass,
not a rushed addition bolted onto a dashboard whose every other number
is intentionally single-day-scoped. Left for a future phase (C7, which
already owns the report suite) rather than shipped half-considered.

## 6. i18n

New `shop.nav.dashboard` key and a full `shop.dashboard.*` subtree (43
keys: title/description, 8 KPI labels, 6 section headers, empty-state
strings, profitability notice, 15 shared column labels) added to both
`src/lib/i18n/resources/en/common.json` and `ar/common.json`. Verified
programmatically: both files parse as valid JSON, and the full `shop`
namespace (425 keys each) is set-identical between `en` and `ar` — zero
keys only in one language, checked by walking both trees and diffing
the flattened key lists, same method C5 used.

## 7. Files changed / added

- `src/features/shop/ShopDashboardPage.tsx` — new page, all 8 sections
  above.
- `src/app/routing/router.tsx` — new lazy `ShopDashboardPage` import +
  `path: 'dashboard'` child route under `ShopLayout`.
- `src/features/shop/components/ShopNav.tsx` — new "Dashboard" tab.
- `src/lib/i18n/resources/en/common.json`,
  `src/lib/i18n/resources/ar/common.json` — new `shop.nav.dashboard` +
  `shop.dashboard.*` keys.
- `src/lib/supabase/types.ts` — hand-added type entries for
  `get_shop_payment_method_mix`, `get_shop_sales_by_category`,
  `list_shop_recent_returns` — no live DB in this worktree to regenerate
  from, same constraint C1–C5 all documented.
- `supabase/migrations/20260828160000_shop_dashboard_rpcs.sql` — the
  three new RPCs above.

### New RPC signatures (exact)

```sql
get_shop_sales_by_category(
  p_club_id uuid, p_start_date date default null, p_end_date date default null
) returns table(category_id uuid, category_name text, units_sold numeric, revenue numeric)

get_shop_payment_method_mix(
  p_club_id uuid, p_start_date date default null, p_end_date date default null
) returns table(method text, transaction_count bigint, total_amount numeric)

list_shop_recent_returns(
  p_club_id uuid, p_limit int default 10
) returns table(
  return_id uuid, sale_id uuid, invoice_number text, processed_by_name text,
  restock boolean, reason text, created_at timestamptz, refund_amount numeric, refund_method text
)
```

## 8. Deliberate scope boundaries (not omissions)

- Sales Trend chart — deferred, see Section 5.
- `get_shop_inventory_balances`'s never-stocked-variant gap in
  `p_low_stock_only` mode — pre-existing, documented, deliberately not
  touched (Section 2); this phase's Low Stock list inherits that same
  known limitation, not a new one it introduced.
- `shop.reports.view_profit` — not seeded (Section 4); a plan-vs-reality
  gap found and reported, not fixed, since permissions are out of C6's
  scope and this section carries no data to protect.
- No new permission keys, no schema changes, no writes at all — this
  phase is entirely additive read-only RPCs + one new page + routing/nav
  wiring, matching the plan's own C6 scope line ("Shop dashboard (new
  page)").

## 9. Verification performed (evidence tier per item)

- **`npx tsc -b`**: CODE VERIFIED — clean, 0 errors.
- **`npm run lint`**: CODE VERIFIED — 0 errors, 12 pre-existing
  warnings, identical set C1–C5 all documented (`AuthProvider.tsx`,
  `DirectionProvider.tsx`, `PortalClubProvider.tsx`, `badge.tsx`,
  `button.tsx`, `official-collection-receipt-fields.tsx`,
  `QuickBookingSheet.tsx`, `PlatformOwnersPage.tsx`, 3 Supabase Edge
  Functions). Zero new warnings from any file this phase touched.
- **`npm run test -- --run`**: CODE VERIFIED — 99 passed, 95 skipped, 2
  test files fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`)
  on `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — confirmed
  this worktree has no `.env.local`, the identical pre-existing
  environment gap C1–C5 all documented; not re-investigated as new.
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: CODE
  VERIFIED — 117 tests, 78 passed, 39 failed, every failure
  `[webkit-desktop]` on a browser-executable-missing error
  (`ms-playwright/webkit-2336/Playwright.exe` not installed), on
  marketing/login/route-guard/responsive-viewport pages entirely
  outside the Shop module — identical failure count and root cause to
  C1–C5's own documented results; not re-investigated as new.
- **RPC/schema fidelity**: CODE VERIFIED by direct migration read —
  `get_shop_inventory_summary`'s and `get_shop_top_products`'s LATEST
  live definitions, `get_shop_sales_kpis`'/`list_shop_sales`'s C5
  definitions, `shop_sale_items`/`shop_categories`/`shop_products`/
  `payments`/`payment_allocations`/`refunds`/`shop_sale_returns`/
  `invoice_items` schemas, and `_shop_module_active`/`has_permission`/
  `has_platform_support_access` signatures were all read from their
  real, latest migration files before being relied on or extended. No
  column name was guessed.
- **No live DB credentials in this worktree** — confirmed (same
  constraint as C1–C5), not worked around. Migration SQL was reviewed
  manually for syntax/logic correctness against the real, current live
  schema.
- **Live RLS/RPC calls, browser/UI interaction**: ENVIRONMENT-BLOCKED,
  not LIVE VERIFIED / BROWSER VERIFIED — same three blockers C1–C5 all
  documented (no `.env.local`, no Docker-backed local Supabase stack,
  and creating a Supabase branch for a disposable test is a material
  paid-service change requiring explicit user go-ahead, not taken
  unilaterally). Recommendation unchanged: approve a Supabase branch for
  a real dashboard-load test (especially the two new aggregate RPCs
  against real multi-payment-method/multi-category fixture data), or
  run the equivalent from a session with real credentials/local stack.

## 10. Commit

Committed locally to this worktree's own branch
(`worktree-agent-a29a825c8e18cff2b`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`. Exact
commit SHA and clean-tree confirmation reported to the orchestrator
directly (outside this file) after the commit is made.
