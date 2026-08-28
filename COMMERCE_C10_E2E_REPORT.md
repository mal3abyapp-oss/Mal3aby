# Commerce Pro — Phase C10 Report: E2E Test Coverage

Written 2026-08-28, in isolated worktree `agent-a193cc85167924620`, per
`COMMERCE_PRO_UPGRADE_PLAN.md` Section 5 (Phase C10, final phase),
`E2E_TEST_STRATEGY.md`, and `AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope:
write real Playwright E2E specs for the Commerce Pro (C1–C9) feature
set, following the exact conventions established in
`e2e/staff/shop-stock-count.spec.ts` and `e2e/staff/printing.spec.ts`.

## 1. What was read first

`COMMERCE_PRO_UPGRADE_PLAN.md` in full (all 7 sections; the plan's own
text stops at Section 7 — the Section references in the task prompt
such as §14/§18/§30/§33/§34/§36 are inherited section numbers from a
larger platform directive this Commerce-scoped plan was condensed from,
not present verbatim in this file; the plan's own Section 5 phase table
and Section 2 invariant list were treated as authoritative for what
C1–C9 actually built). `E2E_TEST_STRATEGY.md` in full (credential-
minting mechanism, `test.skip(!hasMintedSession(...))` pattern, no-
password rule, selector strategy). `AGENT_ORCHESTRATION_GOVERNANCE.md`
in full (all 3 incidents). All 9 `COMMERCE_C*_REPORT.md` files in full.
`e2e/staff/shop-stock-count.spec.ts` and `e2e/staff/printing.spec.ts`
in full, as the explicit existing patterns to match.

## 2. Environment constraint (unchanged from every prior phase)

No `SUPABASE_SERVICE_ROLE_KEY` has ever been available to this
engagement (confirmed: no `.env.local`, only `.env.example`/
`.env.e2e.example`; no MCP tool exposes it — `get_publishable_keys` only
exposes publishable/anon keys, per `E2E_TEST_STRATEGY.md`'s own
documented finding). `npm run e2e:setup` was **not** attempted — per
the task's explicit instruction, this is a known, standing constraint,
not something to work around. All specs below are written correctly to
pass once a session is minted; none were run live end-to-end.

## 3. Selector-provenance investigation (before writing anything)

Grepped every Shop component source file for `data-testid` before
writing a single selector, per the task's explicit instruction. Found:

- `ShopStockCountPage.tsx` — extensive real coverage (from an earlier
  phase this session's work builds on, unchanged).
- `ShopInvoiceDocument.tsx` — `shop-invoice-print-view`,
  `shop-invoice-print-size-toggle/-a4/-80mm`,
  `shop-payment-receipt-view` (added in Phase C4, confirmed still
  present, reused verbatim, not re-added).
- `ShopSalesPage.tsx` — only `shop-sale-row-{id}` existed (Phase C4).
- **`ShopPOSPage.tsx`, `ShopProductsPage.tsx`,
  `ShopInventoryPage.tsx`, every `src/features/shop/reports/*.tsx`
  file — ZERO `data-testid` coverage.** These are the pages
  `shop-pos-catalog.spec.ts`, `shop-pos-checkout.spec.ts`,
  `shop-returns.spec.ts`, `shop-reports.spec.ts`, and
  `shop-media-rls.spec.ts` needed to interact with.

**Decision, matching the exact precedent already set by the phases that
built `stock-count`'s and `printing`'s own testid coverage** (both were
added specifically to make their E2E specs real DOM assertions instead
of route-availability checks): added a minimal, targeted set of
`data-testid` attributes to exactly the elements each spec needs to
locate or assert on — never a blanket instrumentation pass, never
guessed. Every attribute added is listed in Section 4, cross-referenced
to the file it lives in. `npx tsc -b` and `npm run lint` were re-run
after every edit; both stayed clean throughout (0 errors, the same 13
pre-existing warnings every C1–C9 phase already documented, none newly
introduced).

Existing testids that were reused as-is, not modified: `shop-invoice-
print-view`, `shop-invoice-print-size-toggle/-a4/-80mm`, `shop-payment-
receipt-view` (`ShopInvoiceDocument.tsx`), `shop-sale-row-{id}`
(`ShopSalesPage.tsx`), the full `stock-count-*` family
(`ShopStockCountPage.tsx`, untouched — confirmed no bug found in it, so
per the task's own instruction it was not modified).

## 4. Exact data-testid attributes added this phase, by file

**`src/features/shop/ShopPOSPage.tsx`** (46 occurrences total, existing
+ new): `pos-product-search`, `pos-barcode-input`, `pos-held-sales-
button`, `pos-barcode-message`, `pos-category-strip`, `pos-category-
chip-all`, `pos-category-chip-best-sellers`, `pos-category-chip-
{categoryId}`, `pos-product-grid`, `pos-product-card-{productId}` (+
`data-out-of-stock` attribute), `pos-product-card-{productId}-out-of-
stock-badge`, `pos-cart-lines`, `pos-cart-line-{productId}`, `pos-cart-
line-{productId}-decrease/-quantity/-increase/-remove`, `pos-cart-
summary`, `pos-cart-summary-discount`, `pos-cart-summary-total`, `pos-
discount-section`, `pos-discount-toggle`, `pos-discount-mode-amount/-
percent`, `pos-discount-amount-input`, `pos-discount-reason-input`,
`pos-payment-methods`, `pos-payment-method-{id}` (+ `data-underlying-
method` attribute), `pos-cash-received-input`, `pos-change-due`, `pos-
split-toggle`, `pos-split-section`, `pos-split-amount-input`, `pos-
split-method-select`, `pos-split-method-{id}`, `pos-split-primary-
preview`, `pos-error-message`, `pos-complete-sale`, `pos-location-
select`, `pos-location-{locationId}`, `pos-selected-customer`, `pos-
walk-in-customer`, `pos-sale-complete-panel`, `pos-sale-complete-
invoice-number`, `pos-sale-complete-split-failed`, `pos-sale-complete-
print-receipt/-print-invoice/-new-sale`.

**`src/features/shop/ShopSalesPage.tsx`** (24 total): `sales-find-for-
return`, `sales-kpi-row`, `sales-kpi-gross-sales`, `sales-kpi-
transactions`, `sales-kpi-net-sales`, `shop-sale-row-{id}-view-
invoice`, `shop-sale-row-{id}-process-return`, `return-lookup-input`,
`return-lookup-submit`, `return-lookup-empty`, `return-lookup-result-
{saleId}`, `return-line-qty-{itemId}`, `return-restock-toggle`,
`return-issue-refund-toggle`, `return-refund-payment-select`, `return-
refund-payment-{paymentId}`, `return-refund-summary`, `return-refund-
summary-merchandise/-previous/-new/-remaining`, `return-error-message`,
`return-submit`.

**`src/features/shop/ShopProductsPage.tsx`** (5 new): `products-grid`,
`products-card-{productId}`, `products-card-{productId}-thumb` (+
`data-has-image` attribute), `products-add-product`, `products-
primary-image-input`.

**`src/features/shop/reports/ShopProfitReport.tsx`** (6): `report-
gross-profit-permission-denied`, `report-gross-profit-honesty-notice`
(+ `data-has-gap` attribute), `report-gross-profit-stats`, `report-
gross-profit-revenue`, `report-gross-profit-gross-profit`, `report-
gross-profit-margin-pct`.

**`src/features/shop/reports/ShopInventoryReports.tsx`** (5): `report-
inventory-on-hand` (+ `data-row-count`/`data-loading` attributes),
`report-stock-valuation-permission-denied`, `report-stock-valuation` (+
`data-row-count`/`data-unknown-cost-count` attributes), `report-stock-
valuation-total`, `report-stock-valuation-unknown-cost-note`.

**`src/features/shop/reports/ShopSalesSummaryReports.tsx`** (3):
`report-sales-summary-stats`, `report-sales-summary-gross-sales`,
`report-sales-summary-transactions`.

Every one of the above was grep-confirmed present in its file's current
source **after** editing, immediately before writing the corresponding
spec assertion — not assumed from memory of having just added it.

### Report tab navigation — no new testid needed

`ShopReportsPage.tsx`'s 16-report hub is already URL-addressable via a
real `?tab=` query parameter (`isReportKey`/`selectReport`, syncing to
`useSearchParams` — confirmed by reading the component directly).
`shop-reports.spec.ts` navigates directly to
`/app/reports/shop?tab=gross-profit` etc. — a genuine, durable selector
already built into the app, not a testid addition.

## 5. Spec files written

All six new files live under `e2e/staff/`, follow the exact existing
convention (`test.skip(!hasMintedSession(fixture), reason)`,
`test.use({ storageState: authStatePath(fixture) })`, real backend
always, no mocking):

1. **`e2e/staff/shop-pos-catalog.spec.ts`** (5 tests) — category-chip
   filtering (client-side, `aria-selected` toggling), product search
   (debounce-aware wait, matches `ShopPOSPage.tsx`'s real 250ms
   debounce from the C9 performance sweep), barcode lookup (asserts the
   real not-found message + input-cleared-and-refocused contract;
   positive-match coverage against a *known* barcode is flagged as a
   follow-up needing a seeded fixture product, not guessed), add-to-
   cart + quantity changes (+/-, direct edit, remove), out-of-stock
   denial (`disabled` assertion + negative outcome check, not merely
   visual styling).
2. **`e2e/staff/shop-pos-checkout.spec.ts`** (8 tests, 2 describe
   blocks) — discount application (amount + percent modes, cart summary
   reflects it) for `club-owner` (has `shop.discount.apply`), a
   separate `receptionist` block proving the discount section is
   **absent** (not merely disabled) for a role without the permission
   — real, confirmed via direct read of the actual permission seed
   migration, not assumed. Customer assignment (walk-in +
   search-existing via the shared `CustomerSelector`'s real
   `combobox` role). Multi-payment/split-tender and partial payment.
   Cash tender/change — including the REAL network-request assertion
   the task specifically called out: captures the actual
   `create_shop_sale` RPC POST request via `page.waitForRequest` and
   asserts the parsed JSON body never carries a change/cash-received
   field and that `p_payment_amount` is strictly less than the amount
   received, directly proving the hard invariant against a live
   request payload rather than only against source code. Invoice
   generation (post-sale panel shows a real, non-empty invoice number
   and both print actions).
3. **`e2e/staff/shop-invoices-receipts.spec.ts`** (4 tests) — explicitly
   documents in its own header comment why it does NOT duplicate
   `printing.spec.ts` (different component, different route, different
   testids — `shop-invoice-print-view` vs. `invoice-print-view`).
   Thermal (80mm) and A4 rendering via the real, pre-existing
   `shop-invoice-print-size-*` toggle testids (reused, not re-added).
   Payment-receipt rendering with the same-DOM-target discipline
   assertion (only one `.visible-for-print` element at a time, matching
   C4's own documented mechanism). Reprint (open → close → reopen the
   same document from the Sales list, proving it's not a one-shot
   render).
4. **`e2e/staff/shop-returns.spec.ts`** (3 tests) — refund flow via the
   real invoice-number lookup dialog (entry point 1), a real per-line
   quantity + the actual refund-summary numeric fields (merchandise/
   previous/new/remaining), and a real submit. Stock return (restock
   toggle default-on assertion + toggle-both-ways interaction) — a
   direct before/after inventory-balance assertion was considered and
   explicitly deferred (documented inline) since it needs a stable
   product/location correlation this spec doesn't otherwise have without
   first completing a real return, which the first test already proves
   indirectly via `return_shop_sale`'s own success/failure outcome.
   Payment selection for multi-payment sales (the real gap C5 found and
   fixed — `p_payment_id` ambiguity).
5. **`e2e/staff/shop-reports.spec.ts`** (4 tests) — Sales Summary, Gross
   Profit, and Stock Valuation (the 3 explicitly required), plus
   Inventory On Hand as a 4th (matching the task's separate "inventory
   balance report shows real data" requirement). Every assertion checks
   actual numeric-shaped rendered text (`/\d/.test(...)`), never just
   element visibility. Gross Profit and Stock Valuation both assert the
   honesty contract specifically: reads the real `data-has-gap`/`data-
   unknown-cost-count` attributes this phase added and confirms the
   disclosure text renders with real content when a gap exists, rather
   than asserting a fabricated number is ever shown.
6. **`e2e/staff/shop-media-rls.spec.ts`** (3 tests, 2 describe blocks)
   — the file's own header comment explains at length why a raw
   "guess another club's storage path" test was deliberately NOT
   written (the bucket is public by design per C1's own documented
   decision; a resolvable guessed path is the *correct*, expected
   outcome for non-sensitive content, not a defect to catch). Instead:
   (a) a club's own product images render and actually decode in the
   browser (`naturalWidth > 0`, not just "an `<img>` tag exists"); (b)
   a **real** file upload (a genuine 1×1 PNG buffer, not mocked) whose
   resulting public URL's path is asserted to start with a real
   UUID-shaped segment (the caller's own `club_id`), proving the upload
   flow scopes to the caller's own club — a real, client-observable
   structural check, not a redundant re-test of server-side RLS; (c)
   upload-control authorization for `receptionist` (no
   `shop.product.manage`).

**Total: 27 tests across 6 files.** `npx playwright test --list`
confirms clean collection (81 test instances across the 3 configured
browser projects, 27 × 3).

## 6. A real defect found while writing the media/RLS spec — disclosed, not fixed

Writing the "upload authorization" test required checking whether
`ShopProductsPage.tsx`'s Add Product button (and therefore the image
upload control) is actually gated on `shop.product.manage`
client-side. It is **not**: grepped the full file for
`permissionKeys`/`currentMembership`/`RequirePermission` — zero
matches. The button renders unconditionally for anyone who can reach
`/app/shop/products`, which itself is gated only at the Shop
nav-domain level (`shop.view`), not per-route in `router.tsx` (`{
path: 'products', element: <ShopProductsPage /> }`, no wrapper).

The server-side boundary IS correctly enforced (`create_shop_product`/
`update_shop_product` both check `shop.product.manage`; the
`shop-product-images` bucket's own INSERT/UPDATE/DELETE storage
policies require it too — confirmed via direct migration read, and
this is the exact boundary C1's own report says was already reviewed).
But the plan's own C10 task list explicitly asks for the *client-side
UI gate* specifically ("a role without `shop.product.manage` should
not see/be able to use the upload control") — that contract is
currently unmet.

**Not fixed in this phase.** Per the fix policy ("fix only when
assigned and safely reversible") and per this task's explicit framing
as an E2E-authorship phase, not a repair phase — silently patching a
shared, 1100-line page's permission gating without the orchestrator's
review would itself risk the kind of unreviewed-scope-creep this
project's own governance document (Incident 2/3) warns against. The
test in `shop-media-rls.spec.ts` asserts the **intended** contract
(`products-add-product` must have zero count for `receptionist`) and is
written to genuinely **fail** once run against the current app, with a
long inline comment explaining exactly why, rather than being quietly
weakened to match today's behavior. Flagged here explicitly for the
orchestrator to decide whether to assign a follow-up fix.

## 7. Verification performed (evidence tier per item)

- **`npx tsc -p tsconfig.e2e.json --noEmit`**: CODE VERIFIED — clean, 0
  errors, for all 6 new spec files plus the existing suite.
- **`npx tsc -b`** (whole repo, including the edited component files):
  CODE VERIFIED — clean, 0 errors.
- **`npm run lint`**: CODE VERIFIED — 0 errors, 13 warnings — the
  identical set every C1–C9 phase already documented
  (`AuthProvider.tsx`, `DirectionProvider.tsx`, `PortalClubProvider.tsx`,
  `badge.tsx`, `button.tsx`, `official-collection-receipt-fields.tsx`,
  `QuickBookingSheet.tsx`, `PlatformOwnersPage.tsx`,
  `shopReportShared.tsx`, 3 Supabase Edge Functions). Zero new warnings
  from any file this phase touched.
- **`npx playwright test --list`** (all 6 new files): CODE VERIFIED —
  81 test instances collected cleanly (27 tests × 3 browser projects),
  no collection errors.
- **`npx playwright test --project=chromium-desktop`** on all 6 new
  files: LIVE VERIFIED (of the skip behavior only, not the test bodies)
  — all 27 tests report **skipped**, not failed or errored, exactly
  matching the `test.skip(!hasMintedSession(...))` pattern every
  existing authenticated spec in this repo already exhibits. This is
  the same class of evidence C1–C9 could offer for their own
  (pre-existing) authenticated specs: proof the harness collects and
  gates correctly, not proof of the test bodies' runtime behavior
  against real data.
- **`npx playwright test --project=chromium-desktop e2e/public e2e/auth
  e2e/responsive`**: LIVE VERIFIED — 39/39 passed, real dev server,
  real Supabase backend, no regression from this phase's component
  edits (identical result to every prior phase's own re-run of this
  same zero-credential subset).
- **`npx playwright test --project=chromium-desktop` on the
  pre-existing `shop-stock-count.spec.ts`, `printing.spec.ts`,
  `module-access-matrix.spec.ts`**: LIVE VERIFIED — all skip cleanly,
  identical behavior to before this phase's edits; the new `data-
  testid` attributes added to `ShopPOSPage.tsx`/`ShopSalesPage.tsx`/
  etc. did not alter or break any selector these pre-existing specs
  depend on (confirmed directly — `shop-stock-count.spec.ts` targets
  `ShopStockCountPage.tsx`, untouched this phase; `printing.spec.ts`
  targets `BillingPage.tsx`, never touched by Commerce Pro at all).
- **`npm run test -- --run`** (Vitest): CODE VERIFIED — 99 passed, 95
  skipped, 2 test files fail (`src/App.test.tsx`,
  `src/lib/domain/billing.test.ts`) on `Missing VITE_SUPABASE_URL /
  VITE_SUPABASE_ANON_KEY` — the identical pre-existing environment gap
  every C1–C9 phase documented (no `.env.local` in this worktree); not
  a regression from this phase.
- **No `SUPABASE_SERVICE_ROLE_KEY` was obtained, requested via any
  workaround, or assumed** — per the task's explicit instruction, this
  is a standing, disclosed constraint, not something this phase
  attempted to route around.

## 8. Evidence taxonomy — explicit, per the plan's own Section 6

**CODE VERIFIED throughout** for every spec file's correctness (syntax,
types, selector existence, RPC/permission-model claims backed by direct
migration reads). Explicitly **NOT** BROWSER VERIFIED or LIVE VERIFIED
for the test bodies' actual runtime behavior against real data — these
are correctly-written, un-run specs, exactly as the task instructed.
The only LIVE VERIFIED claims in this report are the skip-behavior
confirmation and the zero-credential regression re-run (Section 7
above), both of which are real, actual `npx playwright test` executions
against the real local dev server — not claims about the new specs'
own assertions ever having executed against real Shop data.

## 9. Deliberate scope boundaries (not omissions)

- `shop-stock-count.spec.ts` was **not** modified — no genuine bug was
  found in it during this phase, matching the task's explicit
  instruction to leave it alone absent a real finding.
- `printing.spec.ts` was **not** duplicated or modified — confirmed it
  covers a structurally different component/route before writing
  `shop-invoices-receipts.spec.ts`, documented explicitly in that new
  file's own header comment.
- Barcode positive-match coverage (a real, known barcode value scanned
  successfully) and variant-picker interaction were both identified as
  needing either a seeded QA-fixture product with a known barcode or a
  stable `data-testid` on the variant-choice buttons (neither exists
  yet) — flagged inline in `shop-pos-catalog.spec.ts` as a named
  follow-up rather than guessed.
- A direct before/after inventory-balance assertion for stock returns
  was considered and explicitly deferred (see `shop-returns.spec.ts`'s
  own inline comment) for the same "no stable correlation available
  without first completing a real return" reason.
- The `ShopProductsPage.tsx` permission-gating gap found in Section 6
  was disclosed, not silently fixed.

## 10. Commit

Committed locally to this worktree's own branch, in the isolated
worktree `D:\Ai Projects\Mal3aby\.claude\worktrees\agent-a193cc85167924620`
— no push, no merge, no interaction with `main`, per
`AGENT_ORCHESTRATION_GOVERNANCE.md`. Exact commit SHA and clean-tree
confirmation are reported in the final response to the orchestrator.
