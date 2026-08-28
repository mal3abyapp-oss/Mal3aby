# Commerce Pro — Phase C2 Report: POS Rebuild

Written 2026-08-28, by the C2 subagent (isolated worktree
`worktree-agent-aeaae06c1e4315baf`), per `COMMERCE_PRO_UPGRADE_PLAN.md`
Section 5 and `AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: POS rebuild
(category strip, product cards, barcode input, layout) only. Cart
STATE/mutation logic, payment panel, and discounts are unchanged and
explicitly deferred to Phase C3, per the task's own scope boundary.

## 1. What was built

### Category strip
A horizontal, `overflow-x-auto` chip row above the product grid:
"All Products" (with a live count of all loaded active products),
one chip per active category from `list_shop_categories` (ordered by
`display_order` then `name_ar`, matching the RPC's own ordering — no
client-side re-sort needed beyond stabilizing ties), each showing its
`image_url` as a small round thumbnail via the shared `ProductThumb`
(falls back to no icon if unset — no placeholder icon clutter on a
small chip), its name, and a product count. The count is derived from
the already-fetched `list_shop_products` result client-side
(`categoryCounts` via a single `useMemo` reduce) — **no N+1 query per
chip**, exactly as instructed. RTL correctness: the strip uses plain
`overflow-x-auto`, no manual left/right logic — this app mounts with
`dir="rtl"` globally, and CSS logical scrolling means "scroll toward
more content" already goes the physically-correct direction in both
directions without extra code (same reasoning already established and
verified for `Sheet`'s `side` prop in this codebase — see
`sheet.tsx`'s own comment).

Selecting a chip filters the grid **client-side** (`filteredProducts`
in a `useMemo`), not via a new server round-trip — the full active
product list for the club is already fetched for search purposes, so
re-filtering it client-side on category click is instant and avoids
adding a network request to what should be the fastest, most-repeated
interaction on the whole screen. (The plan allowed either approach;
client-side was chosen for latency, not because the RPC lacks
`p_category_id` — it does have it, confirmed by reading the current
`list_shop_products` signature in
`20260828100200_shop_product_media_category_ux_rpcs.sql`, kept
available for the search input's own server-side query — just not used
for category filtering specifically.)

### Best Sellers chip — real data only, honestly conditional
`get_shop_top_products(p_club_id, p_limit)` already exists
(`20260826231553_shop_top_products_report_rpc.sql`, powers
`ReportShopPage.tsx`) and reports real `units_sold` from actual
completed/returned sale history — never fabricated. It is wired in as
an additional "Best Sellers" chip, shown **only if the call succeeds
and returns at least one row** (`hasBestSellers` in
`CategoryStrip`'s props). Confirmed by reading its own migration
comment that it is gated on `report.view`, a permission distinct from
(and broader/more sensitive than) `shop.view`/whatever gates POS
access itself — a cashier role that can sell but not see reports is a
real, intentional combination this project's own permission matrix
allows. A denial from this RPC is treated exactly like
`fetchStockByProduct`'s existing fail-open contract (established in
C1): `fetchTopProductIds` returns `null` on any error, and the chip
simply does not render — never a page-level error, never a
fabricated/empty "Best Sellers" section. No "Favorites" concept was
built (nothing in the schema/RPC layer backs it — it would have been
invented data, so it was skipped, exactly as instructed).

### Product cards
Replaced the old text-only 2–3 col button grid with real image-forward
cards (`ProductGrid` in `ShopPOSPage.tsx`, 2/3/4 columns responsive —
one fewer breakpoint than `ShopProductsPage.tsx`'s 2–5 col grid,
deliberately, since POS cards need to stay large touch targets even at
narrow widths, whereas the products *management* page is desktop/mouse
-oriented data browsing):
- Image via the shared `ProductThumb` (see "Shared component
  extraction" below), `aspect-square`, `loading="lazy"`, real
  no-layout-jump fallback.
- Name, price (`MoneyDisplay`).
- Real stock via `get_shop_inventory_balances` (`stockFor` helper),
  same aggregate-across-locations-and-variants approach as
  `ShopProductsPage.tsx`'s `fetchStockByProduct` (Phase C1) — summed
  `on_hand` per `product_id`. Same fail-open contract: if the call
  errors (e.g. `inventory.view` missing for this role), `stockFor`
  returns `qty: null` and the card renders with no stock badge, fully
  clickable — stock is an enrichment, a missing permission must never
  block the sell screen itself.
- **Out-of-stock handling (qty <= 0 when known)**: card is visually
  disabled (`opacity-50`, `cursor-not-allowed`, `aria-disabled`), a
  red "Out of stock" badge overlays the image with the specific
  reason, `disabled` on the underlying `<button>` so it is not
  clickable/keyboard-activatable, and the `onClick` handler itself
  also short-circuits (`!disabled &&`) as defense in depth. The
  product is still fully visible (image, name, price) — never hidden,
  per the explicit instruction "the cashier should see it exists but
  can't sell it."
- **Low-stock badge**: shown (amber, "Low stock") whenever
  `0 < qty <= product.reorderLevel`, using each product's own
  `reorder_level` — never a hardcoded global threshold. A product with
  `reorder_level = null` never shows this badge (matches
  `ShopProductsPage.tsx`'s own `isLow` logic in Phase C1, kept
  consistent rather than inventing a different rule for POS).
- **Touch target sizing**: cards are large tap targets by construction
  (full card is clickable, `aspect-square` image at minimum ~140px on
  a 2-col mobile layout, `p-2` content padding) — well above this
  project's own smallest documented touch-target convention
  (`size-9`/36px icon buttons elsewhere in this same file for
  cart +/-/remove, which are secondary, lower-frequency controls, not
  the primary tap target). The category chips use an explicit `h-11`
  (44px) height, matching the "primary, rapid-tap POS control" sizing
  reasoning documented inline. This was checked against
  `button.tsx`'s own `size` variants (`icon`: `h-9 w-9`,
  `lg`: `h-10`) — chips and cards both meet or exceed the largest
  existing convention in this codebase.

### Barcode input
A dedicated `<Input>` (separate from the free-text product search),
`dir="ltr"` (barcodes are numeric/LTR regardless of app locale, same
convention already used for phone numbers/SKUs elsewhere in this file),
with a `ScanBarcode` icon, wired via a `ref` (`barcodeInputRef`) rather
than `autoFocus` — `autoFocus` only fires once on mount, but a cashier
needs the input refocused **after every scan** without clicking back
into it. `refocusBarcodeInput()` is called after every successful
add-to-cart, every "not found" result, and every "out of stock"
result, via a `window.setTimeout(..., 0)` so the refocus runs after the
triggering state update/re-render has committed (a same-tick
`.focus()` call can lose the race against React's own re-render in some
cases — deferring one tick is the standard safe pattern for this).

Matching logic on Enter (`handleBarcodeSubmit`):
1. Exact match against a loaded product's own `barcode` column first.
   If that product `has_variants`, the match is treated as ambiguous
   (a product-level barcode scan can't tell you which variant) and
   opens the existing variant picker instead of guessing — consistent
   with how tapping a variant-bearing product card already behaves.
2. If no product-level match, falls back to searching variant
   `barcode` values. `list_shop_product_variants` returns `barcode`
   per variant (confirmed live in `20260828083000_..._enforce_module_
   active.sql`'s current definition) — a plain product-level barcode
   scan that turns out to actually be a *variant's* barcode is found
   here and added directly (unambiguous — a variant barcode identifies
   exactly one variant), no picker needed, matching the instruction
   "add directly to cart if unambiguous."
3. No match anywhere → a specific, translated "no product or variant
   matches barcode '{{code}}'" message (`shop.pos.barcodeNotFound`),
   rendered as `role="alert"`, input cleared and refocused — never a
   silent no-op, never a crash (the whole variant-scan fallback is
   wrapped so a network error during the fallback surfaces the same
   translated failure path rather than an unhandled rejection).
4. A matched but **out-of-stock** item shows a specific "X is out of
   stock and can't be added" message instead of silently adding it —
   consistent with the out-of-stock card behavior above.

**Debounce/rapid-entry**: deliberately NOT added. Reasoned through
explicitly rather than defaulted to "add a debounce because scanners
are fast" — a hardware barcode scanner emits real, distinct keydown
events through the browser's normal input pipeline (it is not a
synthetic-event firehose that needs coalescing), and the actual catalog
match only runs once, on the input's committed value, at the single
moment `Enter` fires — there is no code path that runs per-keystroke
that scan speed could overwhelm. The one genuine repeat-scan case
(the same barcode scanned twice in a row) is already handled correctly
by the existing, unmodified `addToCart` increment-if-present logic —
two scans of the same item legitimately means two units, which is
exactly what happens.

### Layout
- Desktop/tablet (`lg:` and above, 1024px+): unchanged
  `lg:grid-cols-[1fr_360px]` split preserved — no concrete reason was
  found during this phase to change it, so it was kept rather than
  changed for its own sake, per the plan's own "preserve ... or improve
  it if you find a concrete reason to" instruction.
- Mobile/tablet below `lg` (checked against this project's own
  established mobile breakpoint — `PlatformLayout.tsx` uses `md:hidden`
  for its own mobile nav split, i.e. the project's mobile/desktop line
  is at 768px, and `lg` here is 1024px, so the cart panel is hidden
  below 1024px, one step more conservative than the nav's own 768px
  cutoff — deliberate, since a squeezed 360px cart column is usable
  down to roughly tablet width but not on a phone-width product grid):
  the cart panel is hidden entirely from the main layout and replaced
  with (a) a fixed bottom bar showing a running item count and
  subtotal that opens (b) the cart in a `Sheet` (this project's own
  existing drawer primitive, already used for `PlatformLayout.tsx`'s
  mobile nav and `QuickBookingSheet.tsx`) — a genuine product-first
  flow, matching the explicit instruction not to squeeze the cart
  alongside the grid on mobile.
- **Deferred to C3, stated explicitly**: the mobile cart Sheet reuses
  the exact same `CartPanel` component as desktop (same customer
  picker, same payment method select, same complete-sale button) — it
  is fully functional, not a stub, but it is visually just "the same
  panel in a Sheet" rather than a purpose-built mobile checkout flow
  (e.g. a multi-step review→pay flow, larger payment-method tap
  targets tuned specifically for a bottom sheet, a dedicated numeric
  keypad for partial-payment amount entry). Building that dedicated
  mobile *checkout interaction* is Phase C3's scope (owns "payment
  panel, cash tender/change, multi-payment") — this phase only had to
  solve "how does a mobile cashier reach the cart at all," which it
  does, end to end, including completing a sale from the Sheet.

### Shared component extraction
Per the task's explicit instruction to consider extracting
`ProductThumb`/`ImagePlaceholder` rather than reinventing them: created
`src/features/shop/shop-media.tsx` containing both components, verbatim
from their Phase C1 definitions in `ShopProductsPage.tsx` (no behavior
change). `ShopProductsPage.tsx` now imports them instead of defining
them locally (its own `ImageOff` icon import was removed since it is
no longer used directly there). `ShopPOSPage.tsx` imports the same
module for its product-card and category-chip thumbnails. Verified via
`git diff` that `ShopProductsPage.tsx`'s change is a pure
extraction — the removed lines are exactly the two function bodies
that moved, nothing else in that file changed.

### Cart logic — confirmed unchanged
`CartLine` shape, `addToCart`, `updateQuantity`, `removeLine`, the
`create_shop_sale` mutation call (same RPC args, same
`p_idempotency_key: crypto.randomUUID()` per-attempt generation, same
partial-payment math), and the post-sale reset are byte-for-byte the
same logic as the pre-C2 file — only moved into the module scope
unchanged and, in `CartPanel`'s case, extracted into a component that
receives them as props. One net-new query invalidation was added
on sale success (`shop-pos-stock`) so a completed sale's stock
consumption is reflected in the product grid's stock badges without a
manual refresh — an additive fix, not a change to sale/cart semantics.

### i18n
Added to both `src/lib/i18n/resources/en/common.json` and
`ar/common.json`, appended to the existing `shop.pos.*` block:
`allProducts`, `bestSellers`, `categoryStripLabel`,
`barcodePlaceholder`, `barcodeNotFound`, `barcodeOutOfStock`,
`outOfStock`, `lowStockBadge`, `stockCount`, `cartTitle`, `viewCart`,
`viewCartWithTotal`. Both files validated to parse as JSON after
editing (`node -e "JSON.parse(...)"`, confirmed both OK).

## 2. Deliberately deferred to Phase C3 (stated, not silently dropped)

- **Mobile checkout interaction polish** (dedicated review→pay steps,
  tuned payment-method tap targets, a numeric keypad for partial
  payment): the mobile cart Sheet is fully functional today (same
  `CartPanel`, same complete-sale call), just not yet a bespoke mobile
  flow. See "Layout" above for the reasoning.
- **Cart line thumbnails**: the plan's C1 report and this phase's own
  instructions scoped image-forward treatment to the product-picking
  grid; cart lines remain text rows with +/-/remove, matching the
  explicit instruction that cart line UX is C3's scope ("cart
  STATE/behavior identical to today ... only the surrounding chrome").
- **Payment panel, cash tender/change calculator, split-tender UI,
  discount UI**: untouched, exactly as scoped — `CartPanel` still uses
  the pre-existing plain `<select>`-style payment method dropdown
  (via the existing shared `Select` component) and the existing
  partial-payment checkbox/amount flow, unchanged from before this
  phase.

## 3. Verification performed

- **`npx tsc -b`**: clean, 0 errors.
- **`npm run lint`**: 0 errors, 12 pre-existing warnings — identical
  set to the one Phase C1 documented (`AuthProvider.tsx`,
  `DirectionProvider.tsx`, `PortalClubProvider.tsx`, `badge.tsx`,
  `button.tsx`, `official-collection-receipt-fields.tsx`,
  `QuickBookingSheet.tsx`, `PlatformOwnersPage.tsx`, and 3 Supabase
  Edge Functions) — confirmed none are in any file this phase touched.
  Zero new warnings introduced.
- **`npm run test -- --run`**: 99 passed, 95 skipped, 2 test files
  fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`) on
  `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — identical
  pre-existing environment gap to the one C1 documented and verified
  via `git stash` (this worktree has no `.env.local`); not attempted
  to be worked around, reported honestly instead, matching C1's own
  precedent.
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: 117
  tests total, 78 passed, 39 failed. **Every single failure is
  `[webkit-desktop]` browser executable missing**
  (`browserType.launch: Executable doesn't exist at
  .../ms-playwright/webkit-2336/Playwright.exe`, with Playwright's own
  "please run `npx playwright install`" message) — a pre-existing
  local tooling gap in this environment, not a code regression: every
  failing test is on marketing/login/route-guard/responsive-viewport
  pages entirely outside the Shop module, none of which this phase
  touched, and every non-webkit browser project's copy of the exact
  same tests passed (78/78 of the non-webkit executions). Not worked
  around (installing a browser binary is an environment change, not a
  code fix, and out of this phase's scope) — reported honestly as an
  environment gap rather than silently ignored or claimed as a pass.
- **No live DB credentials available in this worktree** (same
  constraint C1 hit) — every RPC signature/behavior claim above (
  `list_shop_products`'s `p_category_id` support,
  `list_shop_product_variants`'s `barcode` column,
  `get_shop_inventory_balances`'s permission gate,
  `get_shop_top_products`'s `report.view` gate and real-data
  computation) was verified by reading the actual latest live
  migration for each function directly, not assumed or guessed.

## 4. Evidence taxonomy

Everything in this report is **CODE VERIFIED** — confirmed by reading
the actual current RPC definitions, running the real
typecheck/lint/unit-test/E2E toolchain against the real repository, and
inspecting the actual diff. No browser/live-database interaction was
possible in this worktree (no `.env.local`, matching Phase C1's own
documented constraint), so **no claim above is BROWSER VERIFIED or
LIVE VERIFIED** — this is stated explicitly rather than implied.
Concretely unverified by direct interaction (would need a live club
with real Shop data + credentials + a real barcode scanner or scanner
emulation to fully close):
- Actual barcode-scan Enter-key matching against real product/variant
  rows.
- Actual category-chip filtering and Best Sellers chip visibility
  against a real permission-restricted (non-`report.view`) cashier
  role.
- Actual mobile Sheet open/close and bottom-bar visibility in a real
  browser viewport.
- Actual out-of-stock/low-stock badge rendering against real
  `get_shop_inventory_balances` data.

## 5. Commit

Committed locally to this worktree's own branch
(`worktree-agent-aeaae06c1e4315baf`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`.
