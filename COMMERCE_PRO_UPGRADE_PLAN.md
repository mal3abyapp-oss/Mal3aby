# Mal3aby Commerce Pro — Upgrade Plan

Written 2026-08-28. Scope: Shop/POS/Product Catalog/Categories/Sales/
Returns/Invoices/Receipts/Inventory UX/Shop Reporting only. Not another
platform-wide audit — this is a finite feature-build queue (Phases
C1–C10), executed under Zero-Idle per the governing directive.

## 1. Current-state findings (design review)

Read `ShopPOSPage.tsx`, `ShopProductsPage.tsx`, `ShopSalesPage.tsx`,
`ShopInventoryPage.tsx`, `ShopStockCountPage.tsx`, `ReportShopPage.tsx`,
the full `shop_*` schema (catalog, sales, sale_items, sale_returns,
inventory locations/balances/movements, stock counts), and
`create_shop_sale`/`return_shop_sale`'s live definitions before writing
this plan. Confirmed, not assumed:

- **POS today**: text-only product buttons in a 2–3 col grid (no
  images), no category filter/strip, no barcode-specific input path,
  plain `<select>` for payment method, single payment method per sale
  (partial-only via one amount field, no split-tender), cart lines are
  text rows with +/-/remove only (no thumbnails), no discount UI, no
  hold/resume, no cash tender/change calculator.
- **Product catalog today**: a primitive table
  (`ShopProductsPage.tsx`), `shop_products.image_url` exists as a
  single nullable text column — no multi-image, no thumbnail strategy,
  no upload UI at all.
- **Categories today**: flat list, no icon/image, no display order, no
  POS-facing selector at all.
- **Stock deduction policy (load-bearing, confirmed in
  `create_shop_sale`'s own header comment)**: stock is deducted at sale
  creation **unconditionally**, regardless of payment completeness —
  "Shop has no pending-order concept; every `shop_sale` is a completed
  physical transaction from creation." This is the single most
  important constraint on Hold/Resume (§11) and must not be violated.
- **Discount**: `invoices.discount` column **already exists**, currently
  hardcoded to `0` by `create_shop_sale`. No new schema needed for
  invoice-level discount — extend the RPC to accept and apply it.
- **Cost tracking**: `shop_inventory_movements.unit_cost` exists (set on
  `purchase_receipt`), but **no cost-at-sale snapshot exists anywhere**
  — `shop_sale_items` has no cost column. Historical sales have zero
  reliable cost data. Confirms the directive's own instruction: do not
  fabricate historical margin; add a forward-only snapshot column and
  report "Cost unavailable" for anything sold before it existed.
- **Multi-payment at sale time**: not supported today — `create_shop_sale`
  takes exactly one `p_payment_method`/`p_payment_amount`; any remainder
  is collected later through the separate, already-proven
  `record_payment()` RPC. Real split-tender (e.g. half cash, half card,
  in the same checkout) requires either (a) sequential
  `create_shop_sale` + `record_payment` calls from the client, or (b) an
  RPC extension accepting a payment-lines array. **Decision: (a) for
  this phase** — reuses two already-hardened, independently-audited RPCs
  instead of widening the sale-creation transaction's blast radius;
  documented as a deliberate choice, not an oversight.
- **Storage bucket precedent**: `official-receipts` bucket
  (`20260819200006_government_receipt_image_storage.sql`) is the exact
  pattern to follow — `club_id/entity_id/filename` path,
  `(storage.foldername(name))[1]::uuid in user_club_ids()` +
  `has_permission()` policies, bucket-level size/MIME limits set
  explicitly (`payment-proofs`/`official-receipts` precedent: 10MB,
  `{image/jpeg,image/png,application/pdf}` — images-only for product
  media, no PDF).
- **Invoice printing**: `BillingPage.tsx`'s A4/80mm toggle + `.print-target[data-print-size]`
  pattern (confirmed live this session, Phase 4) is the house pattern to
  extend for Shop invoices/receipts, not a new one.
- **Club branding for print**: no dedicated fields exist yet
  (`clubs` table has name/address but no logo/tax-id/commercial-reg/
  footer-note columns) — new, additive columns needed (§14).

## 2. Non-negotiable invariants carried into every phase

1. Stock deducts at sale creation, unconditionally. Hold/Resume (§11)
   must therefore be implemented as a **non-canonical draft** (a new,
   narrowly-scoped `shop_held_sales`/`shop_held_sale_items` staging
   table, RLS'd, holding no `payments`/`invoices`/inventory-movement
   rows at all) — never a partial `shop_sales` row.
2. Discounts never rewrite historical invoices. `create_shop_sale`
   applies a discount only at creation time into the existing
   `invoices.discount` column; a discount is never retrofitted onto an
   already-issued invoice.
3. "Change" is cashier-facing arithmetic only (`received - total`),
   never written as a payment allocation or any canonical row.
4. Refunds keep the existing, already-verified "original provider only"
   invariant (Payment Gateway Security Attack Matrix, `create_refund`/
   `create_gateway_refund_service`) — untouched by this phase.
5. Cost-at-sale is a new, forward-only snapshot. Never backfilled or
   inferred for historical rows.
6. Every new RPC follows the established pattern: `auth.uid()` check →
   `has_permission()`/`has_platform_support_access()` → `_shop_module_active()`
   → business logic → `write_audit_log()` (+ `write_audit_log_as_support`
   mirror where relevant).
7. Every new storage bucket: explicit size/MIME limits, `club_id`-prefixed
   path, RLS via `(storage.foldername(name))[1]::uuid in user_club_ids()`
   + `has_permission()`, never public unless deliberately decided
   (product images: **public bucket** is the correct choice here,
   unlike payment proofs/receipts — a product photo is not sensitive
   and public read avoids needing signed URLs for a catalog grid; INSERT/
   UPDATE/DELETE remain permission-gated, matching Shop's own existing
   "read broadly, write narrowly" posture on `shop.view`/`shop.product.manage`).

## 3. New permissions (additive, per §30)

- `shop.discount.apply` — apply a discount at POS checkout.
- `shop.discount.override_limit` — exceed a club-configured max-discount
  threshold (only if a threshold is configured; otherwise unused).
- `shop.reports.view_profit` — see Gross Profit/Margin reports (cost
  data is commercially sensitive; gated separately from `shop.reports.view`).
- `shop.settings.manage` — manage club branding/print settings (reuses
  existing `shop.product.manage`-adjacent scope, new key for clarity).
- `shop.returns.create` — process a return (currently folded into
  generic `shop.sale.create`/`shop.view` — split out for least-privilege).

No fragmentation beyond this. Club Owner retains full control via
existing role-composition mechanics.

## 4. Schema additions (all additive, all reversible, no destructive rewrite)

- `shop_products`: `image_urls jsonb` (ordered array of additional
  image paths; `image_url` stays as the primary-image column, renamed
  in UI language only — not renamed in DB to avoid touching every
  existing read RPC's column list unnecessarily).
- `shop_categories`: `image_url text`, `display_order integer not null default 0`,
  `parent_category_id uuid references shop_categories(id)` (nullable,
  safe — only added if the POS category-selector work in C1 finds a
  real use for nesting; if not needed, skipped to avoid speculative schema).
- `shop_sale_items`: `unit_cost_snapshot numeric` (nullable — populated
  going forward from the movement/cost data available at sale time;
  null for pre-existing rows, rendered as "Cost unavailable").
- `shop_sales`: `discount_amount numeric not null default 0`,
  `discount_reason text` (mirrors `invoices.discount`, kept in sync by
  the same RPC call — `shop_sales` needs its own copy since reports
  query the sale, not always the invoice).
- New `shop_held_sales` / `shop_held_sale_items` (draft-only, see §2.1
  above) — club-scoped, RLS'd, no FK into `invoices`/`payments`, holds
  `product_id`/`variant_id`/`quantity` only, `held_by`, `held_at`,
  `customer_id` nullable, `note` nullable.
- New `clubs` branding columns (additive):
  `shop_print_logo_url`, `shop_print_trading_name_ar`,
  `shop_print_trading_name_en`, `shop_print_address`,
  `shop_print_phone`, `shop_print_tax_number`,
  `shop_print_commercial_registration`, `shop_print_footer_note`,
  `shop_print_return_policy`. All nullable — render only what's
  configured, per §14's explicit "do not force all fields" instruction.
- New storage bucket: `shop-product-images` (public, 5MB limit,
  `{image/jpeg,image/png,image/webp}`).

## 5. Phase plan (execution order per §33, no approval gaps)

| Phase | Scope | Isolation |
|---|---|---|
| C1 | Product media (bucket+RLS+upload UI) + category UX (schema, POS selector, product grid/list toggle) | subagent, worktree |
| C2 | POS rebuild: layout, product cards w/ images+stock badges, barcode input, category strip, search | subagent, worktree |
| C3 | Cart UX, customer selection polish, payment panel (large controls, cash tender/change, multi-payment via sequential RPC calls), discount UI + RPC extension | subagent, worktree |
| C4 | Invoice A4 redesign, thermal 80mm receipt, payment receipt, club branding settings page + schema | subagent, worktree |
| C5 | Sales page KPIs/filters, Returns UX rebuild (from-sale entry point, refund summary) | subagent, worktree |
| C6 | Shop dashboard (new page) | subagent, worktree |
| C7 | Report suite (16 reports per §18), profitability (cost snapshot wiring) | subagent, worktree |
| C8 | Inventory dashboard, product detail/stock-history, receiving UX, transfer UX, stock-count UX polish | subagent, worktree |
| C9 | Responsive sweep (320–1920), RTL/i18n pass, performance (lazy-load, pagination, debounce) | primary, direct (cross-cutting verification, not isolated feature work) |
| C10 | Commerce E2E tests + Global regression + Live acceptance pass | primary + subagent mix |

Each phase's subagent gets explicit `isolation: "worktree"`, commits
locally only, reports back; primary independently reviews the diff and
re-verifies consequential (financial/inventory/RLS) claims before
merging — per standing governance, reinforced after Incidents 1–3.

## 6. Evidence taxonomy for this phase

CODE VERIFIED / LIVE VERIFIED (RLS-impersonation or real RPC calls
against real/QA-fixture data) / BROWSER VERIFIED (actual Playwright or
live browser interaction) / ENVIRONMENT-BLOCKED. No feature is called
"live verified" without an actual live call or browser interaction
proving it — matching this engagement's established discipline
throughout.

## 7. Closing report

`COMMERCE_PRODUCTION_ACCEPTANCE_REPORT.md`, written after C10, per §36.
