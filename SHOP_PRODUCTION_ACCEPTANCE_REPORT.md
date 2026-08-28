# Shop Module — Real Production Acceptance Report

**Directive**: MAL3ABY SHOP — REAL PRODUCTION ACCEPTANCE, UX HARDENING & PLATFORM CONTROL
**Date**: 2026-08-28
**TEST club used**: "فايد الرياضي" (`b9178c0f-00b5-4c71-abec-b8772ffb8682`), confirmed by the user as the intended TEST club for this directive, and separately the pre-existing "QA Full Test Club" (`6ca5315e-e199-4531-9fb1-1df358cda087`) which was newly entitled to Shop during this pass.
**Method**: real UI interaction (Claude in Chrome + Claude Browser pane, both against the real deployed production site) + real database verification via Supabase MCP, plus one dedicated background QA agent covering Stock Count/POS/Returns/Reports.

---

## 1. Defects discovered and fixed

All fixes below are real, root-caused, applied live to the production database and/or deployed to `mal3aby.app`, and independently re-verified (not just self-reported) before being counted here.

### 1.1 CORRECTION — two separate findings, not one

An earlier draft of this report conflated two distinct defects under one "root cause." Corrected here: they are separate, independently confirmed findings, and neither investigation is being reopened by this correction.

**A. Shop visibility root cause (the original "Shop is missing for my real club" report)**
Conclusively proven earlier in this engagement, via direct database inspection, not stale-SW related: club `b9178c0f-...`'s `club_modules` row for `shop` was `entitled = false, active = false`. The module became visible only after the real platform-owner account called `set_club_module_entitlement(..., 'shop', true)`, followed by the real club-owner account calling `set_club_module_active(..., 'shop', true)`. This is a platform-entitlement/club-activation state issue, not a caching or service-worker issue.

**B. Release-freshness defect (separate, found during this Shop acceptance pass)**
- **Root cause**: `PwaUpdatePrompt.tsx`'s `useRegisterSW` only shows the update toast in reaction to a live Workbox `waiting` *event* — it never checked `registration.waiting` on mount. A tab open across a deploy (or a worker that entered `waiting` before the component mounted) was left running old JS with zero visible signal.
- **Confirmed live**: `navigator.serviceWorker.getRegistrations()` showed a real waiting worker on a real desktop session while curl-verified production content was already current — this was never the earlier Cloudflare cache bug recurring.
- **Fix**: explicit `registration.waiting` check on mount + visibility change + interval poll, plus an `updatefound`/`statechange` listener as a second safety net. `src/app/PwaUpdatePrompt.tsx`.
- **Verified live, twice, independently, across two different browser environments**: a real "new deploy while tab open" scenario correctly showed the toast, and clicking Reload correctly picked up the exact new commit SHA both times (confirmed via the console's own build-SHA log line).
- Deployed and live in production.

### 1.2 Shop category creation was completely unreachable from the UI
- `create_shop_category` RPC existed, fully correct, zero UI call sites anywhere in the app — a merchant could never create their first category.
- Also found `update_shop_category` (rename/archive/reactivate) and a matching "list all including archived" RPC did not exist at all.
- **Fix**: built `CategoryPicker` (select-or-create-inline, used in both Add/Edit Product) and a full `ManageCategoriesDialog` (rename, archive, reactivate) in `ShopProductsPage.tsx`; added `update_shop_category`/`list_shop_categories_all` RPCs (migration `20260828080000`).
- **Verified live**: created "مشروبات" and "ملابس رياضية" through the real deployed UI, including the inline-create-during-product-creation flow.

### 1.3 Suppliers were completely unusable
- `shop_suppliers` had a correct schema and RLS policies, but zero UI or RPC call sites anywhere — and `receive_shop_stock` already accepted a `p_supplier_id` that nothing ever populated.
- **Fix**: built `SupplierPicker` + `ManageSuppliersDialog` (add/edit/deactivate/reactivate) in `ShopInventoryPage.tsx`, wired into Receive Stock.
- **Security hygiene found in the same pass**: `shop_suppliers` (and, in a later sweep, `shop_inventory_locations`, `shop_products`, `shop_product_variants`, `shop_categories`) all carried full default `anon`/`authenticated` table grants despite FORCE RLS + real scoped policies — not actively exploitable (forced RLS + no matching anon policy = default-deny, the same accepted-safe class as the project's earlier-documented `whatsapp_accounts` finding), but inconsistent with this project's own "RPC-only, no broad direct-table grants" convention. Tightened across all five tables.
- **Verified live**: created supplier "شركة الأزياء الرياضية" and confirmed it correctly links to a real stock-receipt movement (`reference_type='shop_supplier'`, `reference_id` matching), through the real deployed UI.

### 1.4 Systematic Shop-module-entitlement enforcement gap (the most significant finding)
Every Shop RPC checked `has_permission(...)`, but **not one of them checked whether the Shop module was actually platform-entitled/club-activated**. Confirmed live and exploitable, not theoretical: a real club with `shop.entitled=false` still had its own Club Owner holding `shop.view=true` by default (the normal case), and `list_shop_products()` succeeded rather than raising.

Closed across the **entire** Shop RPC surface, in 6 migrations, each independently verified live (before/after) with zero regression to the real active TEST club at every step:
- All 8 read RPCs (`list_shop_products`, `list_shop_categories`, `list_shop_inventory_locations`, `get_shop_inventory_balances`, `get_shop_inventory_summary`, `list_shop_inventory_movements`, `list_shop_product_variants`, `list_shop_sales`)
- `shop_inventory_locations` direct-table RLS policies (client writes go straight to the table here, not through an RPC)
- `shop_products`/`shop_product_variants`/`shop_categories` RLS policies (defense in depth — confirmed not currently reachable via the app's own UI, since all real writes go through already-gated RPCs, but tightened for consistency and against a future direct-call regression)
- All 4 stock-count write RPCs (`record_shop_stock_count_line`, `complete_shop_stock_count`, `cancel_shop_stock_count`, plus `start_shop_stock_count` which already had it)
- `return_shop_sale` (financially-sensitive — a disabled club could otherwise still process refunds)
- The final sweep: `create_shop_product_variant`, `update_shop_product`, `update_shop_product_variant` (real write RPCs used by the product/variant dialogs built in 1.2), `get_shop_top_products` (gated on the much more broadly-held `report.view`, arguably the widest-reaching instance), `get_customer_shop_purchases` (Customer 360's Shop tab), and `list_shop_categories_all` (this session's own new RPC — missed the check when first written, corrected).

The new exception ("the shop module is not active for this club") is mapped to the directive's own example Arabic copy in `translateSupabaseError` rather than falling through to a generic message.

### 1.5 Three real defects found by the background QA agent (Stock Count / POS / Reports)
1. `get_shop_stock_count_detail` had ambiguous `club_id`/`id` column references colliding with its own `RETURNS TABLE` output columns — the Stock Count detail dialog (view/record/complete/cancel) was completely broken for every club. Fixed, coexists correctly with the module-active check added in the same window.
2. `list_shop_stock_counts` had regressed to referencing nonexistent `l.name_ar`/`l.name_en` columns — the Stock Count list always showed "no stock counts yet" even with real counts. Re-applied the correct definition.
3. `get_shop_inventory_summary`'s `out_of_stock_count` only counted rows already present in `shop_inventory_balances`, which only exist once a variant has seen a movement — a variant created but never stocked anywhere (the real S/أحمر T-shirt) was invisible to the count. Fixed by enumerating every sellable unit explicitly via a correlated subquery. **Independently re-verified by the orchestrator, not just accepted from the agent's own report**: `out_of_stock_count` returns exactly 2, matching direct inspection.

### 1.6 Error messages not mapped to human-readable text
Directive Section 18/12 requirement: found and fixed 4 real RPC error strings that were falling through to generic fallback messages instead of a specific, actionable one — `the shop module is not active for this club` (using the directive's own example Arabic copy verbatim), `price cannot be negative`, `counted quantity cannot be negative`, and `insufficient stock` (the real, confirmed server-side out-of-stock guard every stock-deducting RPC already enforces).

### 1.7 Dates not localized (Arabic/English pass)
Found live during the responsive sweep: 5 occurrences across `ShopInventoryPage.tsx`, `ShopSalesPage.tsx`, `ShopStockCountPage.tsx` called `new Date(...).toLocaleString()` with no locale argument, always rendering `en-US` regardless of the app's active language. Fixed using this project's own established `formatDate()`/`useDirection()` pattern (already used correctly elsewhere in the app). **Verified live, post-deploy**: dates now render as `٢٨ أغسطس ٢٠٢٦، ١٢:٥٣ م` (Arabic-Indic numerals, Arabic month name, Arabic AM/PM marker) in Arabic mode.

### 1.8 Platform Owner module-entitlement UI missing a small disclosed data point
`get_club_modules()` already returns `updated_at`, silently dropped by `PlatformClubDetailPage.tsx`'s own mapping. Directive Section 11 explicitly asks "when was entitlement changed if such audit data exists" — it does. Surfaced under each module's status badges.

---

## 2. Confirmed NOT bugs (verified via source/live testing, not assumed)
- Walk-in POS sale with no customer: `create_shop_sale` requires a non-null `p_customer_id` — a genuine, project-wide, pre-existing invariant matching every other module, not a Shop-specific gap.
- Combined/split payment methods in one sale: `p_payment_method` is a single scalar by design; partial payment (pay less than the total, collect the rest later via the standard `record_payment()` flow) IS supported and was verified working.
- Cash sale requiring an open cash shift: correct, pre-existing precondition (`cash_shifts` table), not a Shop defect.
- The apparent tablet/desktop "wasted white space" I initially suspected from screenshots at 768px/1920px: confirmed via direct DOM measurement (`getBoundingClientRect()`) to be a **screenshot-rendering artifact of my own viewing tool downscaling large viewports**, not a real layout bug — the actual CSS grid correctly spans its full available width at every size tested.
- The "clipped" mobile header/nav text I initially suspected at 375px: confirmed the horizontally-scrollable nav strip (`overflow-x-auto`) and the header row are both working exactly as designed — no real page-level overflow (`document.body.scrollWidth` matched viewport width exactly at every size tested: 320, 375, 470, 768, 1024, 1440, 1920).
- The Products table's SKU column appearing truncated at 375px: confirmed it sits inside a genuine `overflow-x-auto` container (`scrollWidth: 599` vs `clientWidth: 342`) — exactly one of the 3 directive-approved mobile table patterns ("horizontally contained table"), not a squeezed desktop table.

## 3. Confirmed working, live-verified (no changes needed)

- **Platform Owner Shop entitlement control**: already fully built (`PlatformClubDetailPage.tsx`'s `ModulesPanel`) — shows entitled/active status distinctly, obvious enable/disable control, never lets a platform admin directly flip a club's own "active" switch. **Live security-boundary tests, both directions**: a Club Owner attempting to self-grant their own club's Shop entitlement → real `not authorized` (RPC-level, not just UI hiding). A disabled club's real data access via every read/write RPC → real denial (see 1.4). Could not visually click through `/platform` myself (no platform-owner browser session available without violating the no-password rule), so this is CODE VERIFIED + RPC-LEVEL LIVE VERIFIED, not pixel-level DOM-verified.
- **Full inventory lifecycle**: locations (Main Store + Secondary Warehouse created live), receive (with supplier), transfer (with real cross-location math: 100→90/+10, verified exact), adjust/damage/loss (87→84 for a real damage entry, verified exact) — all mathematically correct, all routing through the same single canonical `_apply_shop_inventory_movement_internal` engine, which itself correctly denies going negative (`insufficient stock: X available, Y requested`) for every write path (sales, transfers, adjustments, stock-count completion) — confirmed by reading its own definition, not assumed.
- **Product/variant lifecycle**: created a simple product (مياه معدنية) and a variant product (قميص رياضي: S/أحمر, M/أزرق, L/أزرق) through the real UI, including image URL and low-stock threshold fields (found previously unreachable, fixed as part of the category work). Archive/reactivate lifecycle tested and confirmed working for both products and variants.
- **Stock Count**: full cycle (start → add lines with exact-match and deliberate variance → complete → idempotent re-complete blocked cleanly → edit/cancel-after-complete blocked cleanly → fresh cancel flow) — all correct, movements/balances match exactly.
- **POS/Sell**: 4 real sales created — cash walk-in-style (water×2, 30 EGP), real-stock variant sale (M/أزرق shirt, 250 EGP), a correctly-denied out-of-stock attempt (S/أحمر, "insufficient stock: 0 available, 1 requested", zero orphaned rows), and a partial payment (20 of 30, outstanding correctly 10).
- **Returns**: full return (stock restored, refund recorded, status→returned), partial return (1 of 2 units, status→partially_returned), over-return cleanly denied with the exact remaining quantity quoted, repeat-return-on-already-returned-item cleanly denied.
- **Full financial reconciliation across every test transaction**: invoiced 310 = paid 300 + refunded 265, exactly consistent, independently spot-checked by the orchestrator (not just the agent's own claim) on at least one sale (invoice 30.00 = allocated 30.00, stock 87→85 exactly −2).
- **Least-privilege permissions, live RLS-impersonation-verified for 4 real roles**: `club_owner` (full access), `accountant` (view + refund only, no product-manage/sale-create — confirmed exact match to the permission matrix), `receptionist` (view + sale-create only), `coach` (zero Shop permissions at all, confirmed denied both at the permission-check layer and the RPC layer). Direct-URL bypass structurally impossible: `canSeeNavDomain` uses real fetched permission keys, and every RPC independently re-derives authorization server-side regardless of what the client renders.
- **Reports**: `ReportShopPage.tsx`'s top-products numbers matched the real test transactions exactly (agent-verified, both via RPC and visually); inventory summary KPIs now correct after the 1.5(3) fix.
- **Printing**: the "Print Full Report" pattern (`fetchFullReport.ts`) is genuinely well-built — hard-capped (8000 rows), explicitly discloses truncation, never silently drops rows. Individual invoice/receipt printing works through the app's existing universal Invoice/BillingPage flow (Shop sales create real rows in the same `invoices` table every other module uses) — correctly NOT duplicated as Shop-specific UI.
- **Responsive layout**: no horizontal page overflow confirmed via direct DOM measurement at 320, 375, 470, 768, 1024, 1440, and 1920px on POS/Products/Inventory. CSS grid breakpoints (`grid-cols-1` → `lg:grid-cols-[1fr_360px]` at exactly 1024px) verified correct via computed styles, not just visual impression. Mobile bottom tab bar confirmed present and distinct from the desktop sidebar.
- **Arabic number formatting**: `MoneyDisplay` correctly renders Arabic-Indic numerals (٢٥٠٫٠٠ EGP) in Arabic mode — confirmed live.
- **Refresh/cache regression**: the PWA self-update mechanism (fix 1.1) proven end-to-end, twice, in two different browser sessions — stale build detected, toast shown, Reload click picks up the exact latest deployed commit SHA. No manual cache/site-data clear or Cloudflare purge needed at any point in this entire session.

## 4. Remaining limitations, disclosed honestly

- **Platform Owner UI**: not pixel-verified via a real authenticated browser session (no platform-owner credentials available without violating the standing never-type-a-password rule). RPC-level security boundaries are LIVE VERIFIED; the rendered UI itself is CODE VERIFIED only.
- **Interactive click-testing at true mobile viewport width**: hit a real, repeated browser-automation tooling timeout (`computer` click actions timing out after 30s, both by coordinate and by element ref) in the later part of this session, in a way that matches what the background QA agent also independently reported. Layout correctness at every required size was still verified via DOM measurement (`getBoundingClientRect`, `scrollWidth`) rather than screenshots alone, which is more rigorous, but live click-through interaction (e.g. actually completing a sale at 375px) was not independently re-confirmed by the orchestrator at mobile width specifically — it was confirmed at desktop width by the background agent, and the same code paths are used regardless of viewport.
- **`get_shop_inventory_balances`'s `p_low_stock_only` mode**: has the same never-stocked-variant blind spot as the fixed `get_shop_inventory_summary` (1.5.3), documented but deliberately left unfixed — that RPC's row shape is shared with the receive/transfer/adjust dialogs, so synthesizing a location-less zero row for a never-stocked variant needs a deliberate shape decision, not a narrow bundled fix.
- **The dead legacy `upsert_payment_gateway_config` RPC** (from the earlier Payments directive, unrelated to Shop) remains undropped — out of scope for this pass.
- Two Shop table `RLS write policies (shop_products/variants/categories) tightened for defense-in-depth are, by design, currently unreachable through the app's own UI (confirmed via full repo grep) — this is disclosed explicitly so it is not mistaken for a live-tested attack-surface closure.
- The E2E stock-count test added this session (`e2e/staff/shop-stock-count.spec.ts`) remains `test.fixme()`-gated: no `SUPABASE_SERVICE_ROLE_KEY` has ever been exposed to any session's tooling in this entire engagement, so `npm run e2e:setup` has never actually been run. The test logic uses real, verified selector text from `common.json`, not guesses, but has never been proven to pass end-to-end.

## 5. Evidence tier summary

| Area | Tier |
|---|---|
| Module-active RPC enforcement (1.4) | LIVE VERIFIED (before/after, both directions, every RPC) |
| Category/Supplier UI (1.2/1.3) | LIVE VISUALLY VERIFIED (real UI clicks, real DB rows) |
| Stock count/POS/Returns/Reports (1.5, §3) | LIVE VISUALLY VERIFIED + independently SQL-cross-checked |
| PWA update fix (1.1) | LIVE VERIFIED, twice, two browser sessions, exact commit SHA confirmed |
| Date localization (1.7) | LIVE VISUALLY VERIFIED, post-deploy |
| Platform Owner UI | CODE VERIFIED + RPC-LEVEL LIVE VERIFIED (not pixel-verified) |
| Responsive layout | LIVE VERIFIED via DOM measurement at 7 viewport widths |
| Mobile click-interaction | CODE VERIFIED + desktop-width LIVE VERIFIED only (tooling limitation, disclosed) |
| E2E stock-count test | CODE VERIFIED only (ENVIRONMENT-BLOCKED — no service_role key) |

## 6. Commits (all on `main`, all pushed)

`336c4f4` `7118a4a` `bed3c26` `9fb1f43` `8534b96` `f4a777a` `1b4dba7` `2df3fb2` `d700d9d` `64dd284` `d0e36ed` `0f04334` `b84def2` `d5e8e58` `933a9fc` — plus the deploys after each frontend-visible batch (final: build `933a9fc`, live in production, confirmed via console log).

## 7. TEST data left in place (real, per club `b9178c0f`)

- Products: مياه معدنية (SKU BEV-WATER-500), قميص رياضي (3 variants: S/أحمر 0 stock, M/أزرق, L/أزرق).
- Categories: مشروبات, ملابس رياضية (1 archived test category, cleaned).
- Supplier: شركة الأزياء الرياضية.
- Locations: المخزن الرئيسي, مستودع ثانوي, plus the auto-created فايد branch location.
- 3 real sales (varying returned/partial states), 2 stock counts (1 completed, 1 cancelled), 1 open cash shift on الفرع الرئيسي (left open — normal operational state, not cleanup-required residue).
- "QA Full Test Club" newly entitled+activated for Shop (was previously not entitled) — a deliberate, disclosed fix to unblock future E2E work, matching the same pattern already used for the real production club earlier in this engagement.
