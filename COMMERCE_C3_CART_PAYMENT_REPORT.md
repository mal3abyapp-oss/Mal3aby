# Commerce Pro — Phase C3 Report: Cart UX, Customer Selection, Payment Panel, Discounts, Hold/Resume

Written 2026-08-28, by the C3 subagent (isolated worktree
`worktree-agent-a814984a90ce2bdf8`), per `COMMERCE_PRO_UPGRADE_PLAN.md`
Section 5 and `AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: cart line
upgrade, discounts, customer selection polish, payment panel,
hold/resume. `ShopPOSPage.tsx`'s C2-built category strip, product
cards, barcode input, and responsive layout are preserved unchanged;
only the cart/payment side (previously untouched by C2) was rebuilt.

## 1. What was built

### Cart line upgrade
Each cart line in `CartPanel` (`src/features/shop/ShopPOSPage.tsx`) now
shows: a real image thumbnail (`ProductThumb`, reused from C2's shared
`shop-media.tsx`), product name + variant label, unit price, a
number-input for direct quantity entry alongside the existing +/-
buttons (all three paths — `updateQuantity`, `setQuantityDirect`, and
`addToCart`'s increment-if-present branch — call the same
`availableFor()` stock lookup and reject/clamp consistently), line
total, and a remove button. "Clear cart" opens a real `Dialog`
confirmation step (`clearCartConfirmOpen`) rather than clearing
instantly. Stock-limit feedback: exceeding available stock (on add, on
+/-, or on direct quantity entry) sets a translated `shop.pos.stockLimitReached`
message and refuses the change client-side — explicitly documented as
UX-layer feedback only; `create_shop_sale`'s own item-loop /
`_apply_shop_inventory_movement_internal` call remains the actual
enforcement boundary, matching C2's own "defense-in-depth, not the
security boundary" framing for the out-of-stock card disable.

Stock lookup was upgraded from C2's product-only aggregate
(`fetchStockByProduct`) to a **variant-aware** map (`fetchStock`
returning `{byProduct, byVariant}`, keyed by `get_shop_inventory_balances`'
own `variant_id` column) so a cart line for a specific variant is
validated against that variant's real balance, not the whole product's
aggregate across all its variants.

### Discounts
Read `invoices.discount`'s current usage first (per instruction):
confirmed it exists, defaults to `0`, and `create_shop_sale` hardcoded
it to `0` on every insert — no other RPC or trigger touches it (the
only other `.discount` column in the codebase,
`subscriptions.discount`, is a different table with its own unrelated
immutability trigger; confirmed by direct grep before writing any
migration, no conflict).

- **New migration**: `supabase/migrations/20260828120200_create_shop_sale_discount.sql`
  — extends `create_shop_sale` with **appended** `p_discount_amount
  numeric default 0`, `p_discount_reason text default null` (10-arg
  signature; old 8-arg overload explicitly dropped, matching the
  grant-leak-prevention precedent from
  `20260827003243_fix_create_shop_sale_grant_leak_and_drop_orphaned_overload.sql`,
  applied proactively in the same migration this time). Every other
  line of the function body is byte-preserved from the current live
  definition (`20260827003217_create_shop_sale_partial_payment.sql`,
  confirmed as latest via direct migration read before writing).
  Discount is validated (`>= 0`, `<= subtotal`), gated on
  `shop.discount.apply` for any non-zero amount, and applied once at
  creation into both `invoices.discount`/`invoices.total` and the new
  `shop_sales.discount_amount`/`discount_reason` columns — never
  retrofitted onto an existing invoice (no UPDATE path touches either
  column anywhere).
- **New migration**: `supabase/migrations/20260828120100_shop_c3_schema.sql`
  adds `shop_sales.discount_amount numeric not null default 0 check (>=
  0)` and `shop_sales.discount_reason text` (additive, mirrors
  `invoices.discount`; `shop_sales` gets its own copy because Shop
  reports query `shop_sales` directly today, confirmed via grep of
  every `get_shop_*_report` RPC — none currently join `invoices` for
  totals).
- **New migration**: `supabase/migrations/20260828120000_shop_discount_permissions_seed.sql`
  seeds `shop.discount.apply` and `shop.discount.override_limit`,
  following `20260826205943_shop_inventory_permissions_seed.sql`'s
  exact pattern (permission insert, `club_owner` grant, a
  `permission_dependencies` row: `shop.discount.apply` depends on
  `shop.sale.create`, `shop.discount.override_limit` depends on
  `shop.discount.apply`). `receptionist` is **deliberately not
  granted** `shop.discount.apply` by default — mirrors the booking
  domain's own documented security gate found while reading
  `20260815220000_phase6_booking_billing_rls.sql` ("Receptionist has no
  discount capability without an explicit grant" — SECURITY_ANTI_FRAUD.md).
  **Discount-limit design decision**: confirmed via full grep of
  `supabase/migrations` and `src/features/shop` that no discount-limit/
  max-discount-threshold concept exists anywhere in this codebase
  today. Per the task's own explicit instruction, the deliberate
  default is **"no limit enforced — `shop.discount.apply` alone is
  sufficient"**; `shop.discount.override_limit` is seeded (so the key
  exists for a future limit-concept phase to reference) but is **not
  checked anywhere** in `create_shop_sale` — documented in both the
  permission-seed migration and the RPC migration's own comments, not
  silently left half-wired.
- **POS UI**: fixed-amount/percentage toggle (`discountMode`), amount
  input, optional reason text, hidden entirely (not merely disabled)
  when `currentMembership.permissionKeys` lacks `shop.discount.apply`
  — matching this codebase's own established client-side permission
  pattern (`currentMembership?.permissionKeys.includes(...)`, confirmed
  via grep of `PaymentGatewayConnectionsCard.tsx`/`CashShiftPage.tsx`/
  etc. before use). Cart summary shows an explicit Subtotal / Discount
  / Total breakdown. Percent-to-amount conversion happens client-side
  for display only and is clamped to `[0, subtotal]`; `create_shop_sale`
  re-validates the resolved amount server-side regardless.

### Customer selection polish
An explicit **"Walk-in Customer"** button is now distinct from "no
customer selected yet." `create_shop_sale`'s `p_customer_id is null`
requirement was **not weakened** — confirmed via
`20260826211221_fix_create_shop_sale_require_customer.sql`'s own
comment that this was a deliberate fix (an earlier "walk-in without a
customer" design was tried and reversed after live testing; every
invoice in this codebase requires a real customer, zero exceptions).
The safer choice per the task's own instruction was taken: a real,
system-marked `customers` row per club, created lazily.

- **New migration**: `supabase/migrations/20260828120100_shop_c3_schema.sql`
  adds `customers.is_walk_in boolean not null default false` plus a
  partial unique index (`idx_customers_one_walk_in_per_club`, `where
  is_walk_in = true`) — the real concurrency backstop for "at most one
  walk-in row per club."
- **New migration**: `supabase/migrations/20260828120300_shop_walk_in_customer_rpc.sql`
  — `get_or_create_shop_walk_in_customer(p_club_id)`, gated on
  `shop.sale.create`, idempotent find-or-create with a
  `unique_violation` catch-and-reread for the concurrent-first-use race.
- **Quick-add inline customer**: solved by reusing the existing shared
  `CustomerSelector` component (`src/components/ui/customer-selector.tsx`,
  Customer 360 directive's "ONE place staff search for or create a
  customer") rather than building a second implementation — it already
  routes creation through `upsert_customer`, which is itself gated on
  `customer.create` server-side (confirmed the exact permission key via
  reading `upsert_customer`'s body directly, not guessed). No new
  quick-add UI was hand-built; the existing, already-hardened one was
  wired in.

### Payment panel
Replaced the plain `<select>` with large tappable method buttons
sourced from `payment_method_configs` (`fetchPaymentMethods`, filtered
`is_active = true`, ordered by `display_order`) — confirmed no
dedicated `list_payment_method_configs` RPC exists (grepped for one
before writing this page); the exact same direct-table-query pattern
`PaymentMethodsCard.tsx`/`BillingPage.tsx` already use against this
table was reused, relying on the table's own
`payment_method_configs_select_club_staff` RLS policy (any club staff
member may SELECT — no extra permission required to see the checkout
list, matching `customer_visible` screening being a portal-only
concern). Never a hardcoded CASH/CARD/INSTAPAY/WALLET/BANK/ONLINE list.

- **Cash tender/change**: "Amount Received" input + computed "Change"
  (`received - primaryAmount`), displayed prominently. **Verified this
  is never sent to any RPC** — `cashReceivedInput`/`cashReceived`/
  `changeDue` are referenced nowhere in `saleMutation`'s body (grepped
  the full file to confirm); only `primaryAmount` (`total` minus any
  split amount) is passed as `p_payment_amount`.
- **Multi-payment / split-tender**: implemented exactly per the plan's
  §5 decision — sequential `create_shop_sale` (primary amount/method)
  + `record_payment` (remainder/second method) against the same
  invoice, reusing both already-hardened RPCs rather than widening
  `create_shop_sale`'s transaction. `record_payment`'s current
  signature/behavior (`20260826073053_club_membership_record_payment_widen.sql`,
  confirmed latest) was read in full: it requires `payment.create`
  (confirmed `receptionist` already has this permission from the
  booking-domain seed, `20260815220000_phase6_booking_billing_rls.sql`
  — the split-tender path works for the realistic default cashier
  role), and independently enforces "amount cannot exceed outstanding
  balance" against the invoice.
  **Failure handling**: if `create_shop_sale` succeeds and the
  follow-up `record_payment` fails, the sale is NOT presented as
  failed — `saleMutation`'s `mutationFn` catches the second call's
  error into `splitPaymentFailed` and still resolves successfully;
  `onSuccess` still shows the completion panel with an explicit
  "sale completed, but the second payment failed" banner
  (`shop.pos.saleCompletedSplitFailed`) carrying the translated error.
- **Post-sale completion panel** (`SaleCompletePanel`): a single panel
  (not a dialog stack) — success icon, invoice number, total, the
  split-payment-failure banner when applicable, a "print receipt"
  action, and "new sale." **Print link correction during this phase**:
  initially linked to a fabricated `/billing/invoices/:id?print=...`
  route; confirmed via grep of `router.tsx` that no such route exists
  and that every other module's real navigation pattern is
  `/app/finance/payments?invoice=${invoiceId}` (which mounts
  `FinancePaymentsPage` → `BillingPage`, confirmed to read `?invoice=`
  as a deep link and expose `BillingPage`'s own real
  `print-target`/`data-print-size`/`window.print()` mechanism). Fixed
  to link there instead. A dedicated one-click thermal-receipt/A4-invoice
  print action is explicitly out of scope here — that is Phase C4's
  stated deliverable ("Invoice A4 redesign, thermal 80mm receipt,
  payment receipt").

### Hold / Resume
Implemented as a genuinely non-canonical draft, per the plan's own
load-bearing constraint (`create_shop_sale`'s header comment: stock
deducts at creation unconditionally, no pending-order concept).

- **New migration**: `supabase/migrations/20260828120100_shop_c3_schema.sql`
  — `shop_held_sales` (`id`, `club_id`, `customer_id` nullable,
  `held_by`, `held_at`, `note` nullable) and `shop_held_sale_items`
  (`id`, `held_sale_id`, `product_id`, `variant_id`, `quantity`). No FK
  into `invoices`/`payments`/`shop_sales`. RLS'd, club-scoped, no direct
  write policy (RPC-only, matching `shop_sales`' own convention).
- **New migration**: `supabase/migrations/20260828120400_shop_hold_resume_rpcs.sql`
  — `hold_shop_sale(p_club_id, p_items, p_customer_id, p_note)`,
  `list_held_shop_sales(p_club_id)`, `resume_shop_sale(p_held_sale_id)`,
  `discard_held_shop_sale(p_held_sale_id)`. All gated on
  `shop.sale.create`. `resume_shop_sale` re-derives product/variant
  name and price **live** (never trusts anything cached at hold time,
  matching `create_shop_sale`'s own "never trust a client price"
  posture) and deletes the held-sale row in the same call (cascades to
  its items) so a held sale can never be resumed twice or left orphaned
  — resuming is a one-shot "load back into the active cart" operation,
  it does **not** itself create a `shop_sales` row.
- **POS UI**: "Hold sale" button on the cart (opens a note dialog),
  "Held sales" button/badge in the header opening a `Sheet` list
  (customer name, held-by, item/unit counts, note, Resume/Discard
  actions). Resuming loads the returned rows into the client cart state
  and re-fetches the real customer row (never a fabricated placeholder
  name, matching `CustomerSelector`'s own "always fetch the real row"
  rule). If a held item's product/variant was archived between hold and
  resume, this is surfaced immediately as a clear warning
  (`shop.pos.resumedWithInactiveItems`) rather than silently letting the
  cashier discover it only when `create_shop_sale` rejects checkout —
  found and fixed during this phase's own review pass, not part of the
  original plan text but a direct consequence of "resume loads
  faithfully, doesn't re-check live availability."

### i18n
~50 new keys added to both `src/lib/i18n/resources/en/common.json` and
`ar/common.json` under `shop.pos.*` (cart/discount/walk-in/payment/
split/hold/resume strings). Verified programmatically: both files
parse as valid JSON, and the `shop.pos` key sets are identical between
`en` and `ar` (no missing translations either direction). A handful of
now-unused keys from the pre-C3 page (`methodCash`, `methodCard`,
`methodBankTransfer`, `methodWallet`, `partialPaymentLabel`,
`paidNowLabel`, `outstandingPreview`) were left in place rather than
deleted — confirmed via grep they are referenced nowhere else in
`src/`, so they are inert, not broken; removing them was not necessary
for correctness and risked a stray reference I might have missed.

## 2. Files changed / added

- `src/features/shop/ShopPOSPage.tsx` — substantially rebuilt (cart
  panel, payment panel, discount UI, hold/resume UI; C2's category
  strip/product grid/barcode input sections untouched).
- `src/lib/i18n/resources/en/common.json`, `ar/common.json` — new
  `shop.pos.*` keys.
- `src/lib/supabase/types.ts` — hand-added type entries for the new/
  changed RPCs (`create_shop_sale`'s new params, `get_or_create_shop_walk_in_customer`,
  `hold_shop_sale`, `list_held_shop_sales`, `resume_shop_sale`,
  `discard_held_shop_sale`) since this worktree has no live DB to
  regenerate types from (same constraint C1/C2 documented); matches
  C1's own precedent of hand-editing this file for new RPC signatures.
- `supabase/migrations/20260828120000_shop_discount_permissions_seed.sql`
- `supabase/migrations/20260828120100_shop_c3_schema.sql`
- `supabase/migrations/20260828120200_create_shop_sale_discount.sql`
- `supabase/migrations/20260828120300_shop_walk_in_customer_rpc.sql`
- `supabase/migrations/20260828120400_shop_hold_resume_rpcs.sql`

### New/changed RPC signatures (exact)

```
create_shop_sale(
  p_club_id uuid, p_location_id uuid, p_customer_id uuid, p_items jsonb, p_payment_method text,
  p_payment_reference text default null, p_idempotency_key uuid default null, p_payment_amount numeric default null,
  p_discount_amount numeric default 0, p_discount_reason text default null
) returns uuid

get_or_create_shop_walk_in_customer(p_club_id uuid) returns uuid

hold_shop_sale(p_club_id uuid, p_items jsonb, p_customer_id uuid default null, p_note text default null) returns uuid

list_held_shop_sales(p_club_id uuid) returns table(
  held_sale_id uuid, customer_id uuid, customer_name text, held_by uuid, held_by_name text,
  held_at timestamptz, note text, item_count bigint, total_quantity numeric
)

resume_shop_sale(p_held_sale_id uuid) returns table(
  customer_id uuid, product_id uuid, variant_id uuid, quantity numeric,
  product_name_ar text, product_name_en text, variant_size text, variant_color text,
  unit_price numeric, product_status text, variant_status text
)

discard_held_shop_sale(p_held_sale_id uuid) returns void
```

## 3. Design decisions and why (summary)

1. **Discount limit = "no limit, permission alone gates it."** No
   discount-limit concept exists anywhere in this codebase; inventing
   one would have been fabricating a business rule with no source of
   truth. `shop.discount.override_limit` is seeded for forward
   compatibility but intentionally inert.
2. **Walk-in = a real, lazily-created customer row**, not a relaxation
   of `create_shop_sale`'s NOT NULL customer requirement. That
   requirement was a deliberate, previously-reversed fix — weakening it
   again would reopen a closed bug.
3. **Split-tender = sequential `create_shop_sale` + `record_payment`**,
   exactly the plan's stated decision, with the sale's success and the
   second payment's success treated as genuinely independent outcomes
   in the UI.
4. **Change is display-only arithmetic**, verified by grep to never
   reach any RPC call.
5. **Hold/Resume is a non-canonical draft** with no FK into any
   financial/inventory table, consuming itself on resume so it can
   never be double-resumed or leak stock reservation semantics that
   don't exist in this system.
6. **Print actions link to the real existing invoice/payment view**,
   not a fabricated print route — a dedicated Shop receipt/invoice
   print experience is Phase C4's stated scope, not invented here.

## 4. What was deferred and why

- **A dedicated one-click print (thermal 80mm receipt / A4 invoice)**
  from the POS completion panel — explicitly Phase C4's scope per the
  plan's own phase table. This phase links to the real, working
  existing print surface (`BillingPage.tsx` via `/app/finance/payments?invoice=`)
  rather than fabricating a route that doesn't exist.
- **A discount-limit/max-discount-threshold system** — no such concept
  exists in this codebase yet; `shop.discount.override_limit` is seeded
  but not wired to anything, as documented above. Building the actual
  limit concept (where it would be configured, how it interacts with
  `shop.discount.override_limit`) is out of this phase's scope and was
  not invented from nothing.
- **Live RLS/RPC impersonation testing against a real database** — this
  worktree has no `.env.local`/Docker-backed local Supabase stack
  (confirmed via `npx supabase status`, same Docker-daemon-not-found
  error C1/C2 both hit) and no live DB credentials, matching both prior
  phases' documented constraint. Not worked around.
- **A live browser/E2E walkthrough of the new cart/discount/payment/
  hold-resume UI specifically** — no credentialed QA session or Docker
  stack available in this worktree (same constraint). The zero-
  credential E2E subset (`e2e/public`, `e2e/auth`, `e2e/responsive`) was
  re-run instead (see below) as the closest available regression
  signal, since it touches shared layout/RTL/responsive primitives this
  page also depends on (`Sheet`, `Dialog`, RTL logical properties).

## 5. Verification performed (evidence tier per item)

- **`npx tsc -b`**: CODE VERIFIED — clean, 0 errors, after fixing 3 real
  issues found during this pass: two `noUncheckedIndexedAccess`
  violations in the new variant-aware stock lookup, and a
  `setSplitMethodId` prop typed too narrowly to accept `null` for the
  "clear selection on toggle-off" path.
- **`npm run lint`**: CODE VERIFIED — 0 errors, 12 pre-existing warnings
  (identical set C1/C2 both documented — `AuthProvider.tsx`,
  `DirectionProvider.tsx`, `PortalClubProvider.tsx`, `badge.tsx`,
  `button.tsx`, `official-collection-receipt-fields.tsx`,
  `QuickBookingSheet.tsx`, `PlatformOwnersPage.tsx`, 3 Supabase Edge
  Functions). Zero new warnings introduced by this phase's changes,
  confirmed by file-by-file cross-check against the warning list.
- **`npm run test -- --run`**: CODE VERIFIED — 99 passed, 95 skipped, 2
  test files fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`)
  on `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — identical
  pre-existing environment gap C1/C2 both verified via `git stash`
  (this worktree has no `.env.local`); not re-investigated as new, per
  the task's own instruction.
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: CODE
  VERIFIED — 117 tests, 78 passed, 39 failed, every failure
  `[webkit-desktop]` browser-executable-missing
  (`ms-playwright/webkit-2336/Playwright.exe` not installed), on
  marketing/login/route-guard/responsive-viewport pages entirely
  outside the Shop module — identical to C2's own documented result and
  root cause; not re-investigated as new, per the task's explicit
  instruction to recognize this pre-existing environment gap.
- **i18n key parity**: CODE VERIFIED — both JSON files parse; `shop.pos`
  key sets are set-identical between `en` and `ar` (verified
  programmatically, not by eye).
- **RPC contract fidelity**: CODE VERIFIED by direct migration read,
  not assumed — `create_shop_sale`'s prior live definition
  (`20260827003217_.../20260827003243_...`), `record_payment`'s current
  definition (`20260826073053_club_membership_record_payment_widen.sql`),
  `payment_method_configs`' schema/RLS/permission model
  (`20260817060000_payment_method_configs.sql`), `upsert_customer`'s
  permission gate, and `receptionist`'s actual `payment.create` grant
  were all read from their real, latest migration files before being
  relied on in either the new RPCs or the frontend.
- **No live DB credentials in this worktree** — confirmed (same
  constraint as C1/C2); did not attempt to work around it. Migration
  SQL was reviewed manually for syntax/logic correctness (including
  catching and correcting one real design mistake during self-review:
  an initial `resume_shop_sale` draft used a session-scoped temporary
  table with no precedent anywhere in this codebase, a real risk under
  a pooled-connection deployment; reverted to a plain `RETURN QUERY`
  followed by `DELETE`, which is documented, standard, immediate-
  execution PL/pgSQL behavior and needed no new pattern).
- **Live RLS/RPC calls**: ENVIRONMENT-BLOCKED, not LIVE VERIFIED —
  same reasoning and same three blockers C1 documented in detail (no
  `.env.local`, no Docker, and creating a Supabase branch for a
  disposable test is a material paid-service change requiring explicit
  user go-ahead, not taken unilaterally). Recommendation unchanged from
  C1: either approve a Supabase branch for a real impersonation test,
  or run the equivalent from a session with real credentials/local
  stack.
- **Browser/UI interaction**: not performed — no credentialed session
  or local stack available to reach a real POS screen with a real club/
  product/customer/payment-method dataset in this worktree.

## 6. Commit

Committed locally to this worktree's own branch
(`worktree-agent-a814984a90ce2bdf8`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`. Exact
commit SHA and clean-tree confirmation reported to the orchestrator
directly (outside this file) after the commit is made.
