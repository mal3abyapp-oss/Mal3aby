# Commerce Pro — Phase C5 Report: Sales Page KPIs/Filters, Returns UX

Written 2026-08-28, in isolated worktree `worktree-agent-a8738cd56ab473c17`
(built on top of C1–C4, already merged in this worktree), per
`COMMERCE_PRO_UPGRADE_PLAN.md` Section 5 (Phase C5) and
`AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: Sales page KPIs, filters,
sale detail, Returns UX rebuild only. Reused C4's
`src/features/shop/ShopInvoiceDocument.tsx` (`ShopInvoiceDialog`) for
printable invoice/receipt viewing throughout — no second invoice
rendering system was built.

## 1. Payment-selection-ambiguity investigation — decision (b), a real gap

Read `return_shop_sale`'s live definition
(`20260828091500_shop_return_sale_module_active.sql`, confirmed latest
via direct migration read) and `create_refund`'s live definition
(`20260826073151_club_membership_create_refund_widen.sql`, confirmed
latest) in full before deciding.

**Finding**: the refund branch does
`select pay.id from payment_allocations pa join payments pay ... where
pa.invoice_id = v_sale.invoice_id limit 1` with no `order by` — an
arbitrary row whenever a sale's invoice has more than one payment
allocated to it. `create_refund()` itself validates strictly against
whichever payment row it receives (permission, subscription gate,
refundable balance = `payment.amount - sum of that payment's own prior
completed refunds`) — so the refund it creates is always financially
correct **for the payment row it is given**. The ambiguity is entirely
about *which payment method* absorbs the refund.

**Decision: (b), a real gap, not (a) or (c).** This matters for
concrete operational reasons: cash-drawer reconciliation (a cash refund
must debit the cash drawer, not silently attach to a card payment's
refundable balance), per-method refund reporting, and a customer's
reasonable expectation of a card refund landing back on their card
rather than as cash. C3 shipped split-tender checkout, making
multi-payment sales a real, non-edge case now.

**Fix**: `return_shop_sale` gained an additive, optional `p_payment_id
uuid default null` (`supabase/migrations/20260828150100_return_shop_sale_payment_selection.sql`).
When provided, it is validated server-side (must actually be a payment
allocated to *this* sale's invoice — never trusts a client-supplied id
blindly) and used directly. When omitted — every existing caller, and
the common single-payment-sale case where there's no real ambiguity —
behavior is byte-identical to today's arbitrary-first-row pick. The old
6-arg overload was explicitly dropped (`drop function if exists
... (uuid, jsonb, boolean, numeric, text, uuid)`), following the same
grant-leak-prevention precedent every prior Shop RPC signature change
in this engagement has used.

The Returns UX (Section 5 below) surfaces this: when a sale has more
than one payment and a refund is being issued, staff must explicitly
choose which payment to refund against (`shop.sales.refundPaymentChoiceLabel`);
for a single-payment sale, no extra step is shown.

## 2. Sales page KPIs

Added a KPI row to the top of `ShopSalesPage.tsx`: Sales (gross),
Transactions, Average Basket, Items Sold, Refunds, Net Sales — all from
a new RPC, `get_shop_sales_kpis` (`supabase/migrations/20260828150000_shop_sales_filters_and_kpis.sql`).

Checked whether `get_shop_top_products`/`get_shop_inventory_summary`
(both already read by `ReportShopPage.tsx`) already covered this before
adding anything new: `get_shop_top_products` is per-product, not a
single page-level aggregate; `get_shop_inventory_summary` is inventory-
only and explicitly documented as carrying no revenue figure by design.
Neither fits — a new, narrowly-scoped RPC was genuinely needed.

`get_shop_sales_kpis` accepts the *same* filter set as the extended
`list_shop_sales` (Section 3) so the KPI row always reflects exactly
the filtered view on screen — the page defaults to "Today" via the
filter state, not a hardcoded server-side "today" independent of the
filter UI. Money is re-derived from `invoices.total` /
`shop_sales.discount_amount` / the `refunds` ledger (via
`shop_sale_returns.refund_payment_id`) — never a second, independently
tracked figure, matching `COMMERCIAL_DOMAIN_ARCHITECTURE.md` Section 9's
"structurally only one place money is summed" mechanism that
`get_shop_top_products` already follows.

Reused `StatCard` (`src/components/ui/stat-card.tsx`), matching
`ReportShopPage.tsx`'s existing usage pattern. **`StatCard.value` was
widened from `string | number` to `ReactNode`** — needed to render a
real `<MoneyDisplay>` (locale-aware currency formatting + `<bdi>` RTL
isolation) inside a KPI tile instead of a bare formatted string. This is
backward-compatible: every existing caller passes a string/number, both
still valid under `ReactNode`, so no other call site's behavior changes
(confirmed via `tsc -b`/`lint` both clean, no other file needed edits).

## 3. Sales page filters

`list_shop_sales` was the only RPC to extend (confirmed via reading
`20260828083000_shop_read_rpcs_enforce_module_active.sql`, the latest
live definition — previously only `p_status`/pagination). Extended
additively per the plan's own performance section (§28 — server-side
filtering/pagination, not client-side on a full table scan):

```
list_shop_sales(
  p_club_id uuid, p_status text default null, p_limit int default 50, p_offset int default 0,
  p_start_date date default null, p_end_date date default null, p_branch_id uuid default null,
  p_cashier_id uuid default null, p_customer_id uuid default null, p_payment_method text default null,
  p_category_id uuid default null, p_product_id uuid default null, p_invoice_number text default null
)
returns table(
  sale_id uuid, invoice_number text, customer_name text, sold_by_name text, status text, total numeric,
  created_at timestamptz, branch_id uuid, item_count numeric, discount_amount numeric, refund_amount numeric,
  sold_by uuid
)
```

Old 4-arg overload dropped (`drop function if exists ... (uuid, text,
int, int)`) — a new parameter list creates a genuinely new overload
rather than replacing the old one in place, so it had to be dropped
explicitly to prevent an unfiltered stale version staying callable,
matching this engagement's established pattern.

Filter set matches the plan's list exactly: date range, branch,
cashier, customer, payment method, category, product, invoice number,
sale status. Branch filter resolves through
`shop_inventory_locations.branch_id` (`shop_sales` itself has no
`branch_id` column — only `location_id`, confirmed via direct schema
read). Payment method / category / product filters use `EXISTS`
subqueries (against `payment_allocations`/`shop_sale_items`) so a sale
with multiple items or payments is still returned once, never
duplicated.

`sold_by` (uuid) was appended to the return row specifically because
the cashier filter dropdown needs real ids, not just display names —
see Section 3a below for why this mattered.

### 3a. Cashier filter — a bug caught during self-review

An initial draft of the cashier-options fetch tried
`.from('shop_sales').select('sold_by, profiles!shop_sales_sold_by_fkey(full_name)')`
— this does not work: `shop_sales.sold_by` and `profiles.user_id` are
two *separate* foreign keys both pointing at `auth.users(id)`
(confirmed via direct schema read of `20260826210846_shop_sales_schema.sql`
and `20260815120000_phase2_identity_multitenant_rls.sql`); there is no
FK path from `shop_sales` to `profiles` for PostgREST to embed through,
and no constraint named `shop_sales_sold_by_fkey` exists. This would
have failed at runtime, not at compile time (`tsc` cannot catch a wrong
PostgREST embed string). Caught and fixed before commit: the cashier
filter's options are now derived client-side from the currently-loaded
`sales` rows themselves (each row already carries `sold_by`/
`sold_by_name` from the extended `list_shop_sales`) — no second query,
no invented RPC, and correctly scoped to cashiers who actually appear
in the visible sales history.

## 4. Sales list + detail

List columns: invoice #, customer, cashier, items count, date, gross,
discount, refund, net, payment status, actions (view invoice / process
return) — matches the plan's list.

**Detail**: built a new, non-printable `SaleDetailDialog` alongside
C4's `ShopInvoiceDialog`, deliberately not duplicating it. Checked
first whether `ShopInvoiceDialog` already served this purpose: it does
for viewing/printing the commercial document, but the plan asks for
fuller *operational* info — full item list with per-line returned
quantity (already on `get_shop_sale_detail`), full payment history
(already on `get_shop_sale_invoice_data`), and full return/refund
*history* (return-event-level, not just running totals) — which
neither existing RPC carries. Built one genuinely new RPC for that
last piece:

```
get_shop_sale_returns_history(p_sale_id uuid) returns table(
  return_id uuid, processed_by_name text, restock boolean, reason text, created_at timestamptz,
  refund_amount numeric, refund_method text, refund_status text, lines jsonb
)
```

(`supabase/migrations/20260828150200_shop_sale_returns_history_rpc.sql`)
— one row per `shop_sale_returns` entry, its return-item lines
aggregated into a jsonb array (a return can cover multiple sale items
in one submission), refund amount/method/status joined in only when a
refund actually happened (a restock-only return with no refund
correctly shows `null`, not `0`).

Clicking a sale's invoice number in the list now opens `SaleDetailDialog`
(previously it opened `ShopInvoiceDialog` directly); `SaleDetailDialog`
itself offers "View Invoice" (opens `ShopInvoiceDialog`) and "Process
Return" (opens the rebuilt `ReturnDialog`) actions, plus a dedicated
"Invoice" row action still opens `ShopInvoiceDialog` directly for a
one-click print path.

### 4a. A second bug caught during self-review: `invoice_status` vs. sale status

While wiring `SaleDetailDialog`'s status badge and return-eligibility
gate, found that `get_shop_sale_invoice_data`'s existing `invoice_status`
column is `invoices.status` (`'draft'/'issued'/'void'`) — **not**
`shop_sales.status` (`'draft'/'completed'/'cancelled'/'partially_returned'/
'returned'`, the actual state `return_shop_sale` itself checks before
allowing a return). These are two different state machines on two
different tables; using `invoice_status` for the Sales-page status
badge or the "can this be returned" decision would have been wrong —
confirmed via direct read of `get_shop_sale_invoice_data`'s own live
`select` list (`i.status`, joined from `invoices`, not `s.status` from
`shop_sales`).

**Fixed** with a new migration
(`supabase/migrations/20260828150300_shop_sale_invoice_data_sale_status.sql`)
appending a genuinely new, separate `sale_status` column (`s.status`)
to `get_shop_sale_invoice_data` — same input signature, in-place
`CREATE OR REPLACE`, matching C4's own precedent for appending `sku` to
`get_shop_sale_detail`. `invoice_status` is left completely unchanged.
`ShopInvoiceDocument.tsx` (C4, also a caller of this RPC) only reads
`data.invoice_status` explicitly and never spreads the row, so it is
unaffected by the new column — confirmed by grep before relying on
that.

## 5. Returns UX — rebuilt from a real lookup

Entry points: (1) "Find sale for return" button opens a real
invoice-number lookup dialog (`ReturnLookupDialog`, searches via the
extended `list_shop_sales`'s `p_invoice_number` filter) — matches the
plan's explicit "not a raw form" instruction; (2) a sales-list row
action; (3) from inside `SaleDetailDialog`. All three converge on the
same `ReturnDialog`.

`ReturnDialog` shows, per line: purchased qty, already-returned qty,
remaining refundable qty (`shop.sales.remainingReturnable`), a
quantity-to-return input clamped to the remaining amount. A real
**REFUND SUMMARY** renders before confirming: merchandise refund total
(computed client-side from each returned line's own net unit price —
`lineTotal / quantity`, so a discounted sale's refund reflects the
actual discounted price, not the list price), previous refund total
(sum of `get_shop_sale_returns_history`'s `refund_amount`s — real prior
partial-return history, not assumed), new refund amount, and remaining
refundable value (`paid - previousRefunds - newRefund`, floored at 0).
A banner also calls out any prior refund total explicitly above the
line items.

**Reason field**: kept `return_shop_sale.p_reason` as the existing
plain, non-enum `text not null` column (confirmed via direct schema
read of `20260826210846_shop_sales_schema.sql` — no constraint beyond
"not null/not empty") — it already cleanly satisfies this. Layered a
UI-only reason-code picker on top (defective / incorrect item /
customer return / other, with a free-text sub-field for "other") that
resolves to a translated string before being sent as `p_reason` — no
new enum or schema constraint was invented, per the task's own explicit
instruction not to add one unless the existing field couldn't satisfy
this cleanly.

**Payment selection**: when a refund is being issued and the sale has
more than one payment (`invoiceData.payments.length > 1`), a required
"Refund against which payment" selector appears, listing each payment's
method + amount; submission is blocked with a translated error
(`shop.sales.returnNoPaymentSelectedError`) until one is chosen. The
selected id is sent as the new `p_payment_id`. For a single-payment
sale, no extra step appears and `p_payment_id` is omitted, preserving
today's simpler flow exactly.

Refund can be disabled entirely via an explicit "Issue a refund for
this return" checkbox (restock-only returns, e.g. a defective item
being pulled from sale with no money changing hands, are a real,
distinct case `return_shop_sale`'s own `p_refund_amount` already
supports as optional).

## 6. i18n

~55 new keys added under `shop.sales.*` in both
`src/lib/i18n/resources/en/common.json` and `ar/common.json`
(KPI labels, filter labels, detail-panel strings, refund summary,
return reasons, payment-choice strings, new error messages). Verified
programmatically: both files parse as valid JSON, and the full `shop`
key set (383 keys) is set-identical between `en` and `ar` — not just
the `sales` subtree, the entire `shop` namespace, checked by a script
that walks both trees and diffs the flattened key lists (zero keys only
in `en`, zero only in `ar`).

## 7. Files changed / added

- `src/features/shop/ShopSalesPage.tsx` — substantially rebuilt: KPI
  row, filter row, extended sales table, new `SaleDetailDialog`, new
  `ReturnLookupDialog`, rebuilt `ReturnDialog` (refund summary, reason
  codes, payment selection).
- `src/components/ui/stat-card.tsx` — `value` prop widened from
  `string | number` to `ReactNode` (backward-compatible).
- `src/lib/i18n/resources/en/common.json`, `ar/common.json` — new
  `shop.sales.*` keys.
- `src/lib/supabase/types.ts` — hand-added/updated type entries for
  `list_shop_sales` (new filters + `branch_id`/`item_count`/
  `discount_amount`/`refund_amount`/`sold_by`), new
  `get_shop_sales_kpis`, new `get_shop_sale_returns_history`,
  `return_shop_sale` (new `p_payment_id`), `get_shop_sale_invoice_data`
  (new `sale_status`) — no live DB in this worktree to regenerate from,
  same constraint C1–C4 all documented.
- `supabase/migrations/20260828150000_shop_sales_filters_and_kpis.sql`
  — `list_shop_sales` filter extension (+ old-overload drop),
  new `get_shop_sales_kpis`.
- `supabase/migrations/20260828150100_return_shop_sale_payment_selection.sql`
  — `return_shop_sale` gains `p_payment_id` (+ old-overload drop).
- `supabase/migrations/20260828150200_shop_sale_returns_history_rpc.sql`
  — new `get_shop_sale_returns_history`.
- `supabase/migrations/20260828150300_shop_sale_invoice_data_sale_status.sql`
  — `get_shop_sale_invoice_data` gains `sale_status` (bug fix found
  during this phase's own self-review, see Section 4a).

### New/changed RPC signatures (exact)

```sql
list_shop_sales(
  p_club_id uuid, p_status text default null, p_limit int default 50, p_offset int default 0,
  p_start_date date default null, p_end_date date default null, p_branch_id uuid default null,
  p_cashier_id uuid default null, p_customer_id uuid default null, p_payment_method text default null,
  p_category_id uuid default null, p_product_id uuid default null, p_invoice_number text default null
) returns table(
  sale_id uuid, invoice_number text, customer_name text, sold_by_name text, status text, total numeric,
  created_at timestamptz, branch_id uuid, item_count numeric, discount_amount numeric, refund_amount numeric,
  sold_by uuid
)

get_shop_sales_kpis(
  p_club_id uuid, p_start_date date default null, p_end_date date default null, p_branch_id uuid default null,
  p_cashier_id uuid default null, p_customer_id uuid default null, p_payment_method text default null,
  p_category_id uuid default null, p_product_id uuid default null, p_invoice_number text default null,
  p_status text default null
) returns table(
  transaction_count bigint, gross_sales numeric, discount_total numeric, refund_total numeric,
  net_sales numeric, items_sold numeric, average_basket numeric
)

get_shop_sale_returns_history(p_sale_id uuid) returns table(
  return_id uuid, processed_by_name text, restock boolean, reason text, created_at timestamptz,
  refund_amount numeric, refund_method text, refund_status text, lines jsonb
)

return_shop_sale(
  p_sale_id uuid, p_lines jsonb, p_restock boolean, p_refund_amount numeric default null,
  p_reason text default null, p_idempotency_key uuid default null, p_payment_id uuid default null
) returns uuid
-- p_payment_id appended, optional, default null (byte-identical behavior when omitted)

get_shop_sale_invoice_data(p_sale_id uuid) returns table(
  sale_id uuid, club_id uuid, invoice_id uuid, invoice_number text, branch_id uuid, branch_name text,
  location_name text, customer_id uuid, customer_name text, customer_mobile text, sold_by_name text,
  created_at timestamptz, subtotal numeric, discount_amount numeric, discount_reason text, total numeric,
  invoice_status text, payments jsonb, sale_status text
)
-- sale_status appended; invoice_status unchanged, still invoices.status
```

## 8. Deliberate scope boundaries (not omissions)

- `shop.discount.override_limit` remains seeded but unwired (unchanged
  from C3/C4 — no discount-limit concept exists anywhere in this
  codebase; this phase doesn't touch discount logic beyond displaying
  it).
- Inventory movements from a return were **not touched** —
  `_apply_shop_inventory_movement_internal` is still the sole mechanism
  for `p_restock`-driven stock changes inside `return_shop_sale`; this
  phase's `p_payment_id` addition only changes which payment a refund
  is created against, nothing about the inventory-movement call.
- A reason-code *enum/schema constraint* was deliberately not added —
  see Section 5.

## 9. Verification performed (evidence tier per item)

- **`npx tsc -b`**: CODE VERIFIED — clean, 0 errors (verified twice:
  once after the initial build, again after the `sale_status` fix and
  the cashier-filter rewrite).
- **`npm run lint`**: CODE VERIFIED — 0 errors, 12 pre-existing
  warnings, identical set C1–C4 all documented (`AuthProvider.tsx`,
  `DirectionProvider.tsx`, `PortalClubProvider.tsx`, `badge.tsx`,
  `button.tsx`, `official-collection-receipt-fields.tsx`,
  `QuickBookingSheet.tsx`, `PlatformOwnersPage.tsx`, 3 Supabase Edge
  Functions). Zero new warnings from any file this phase touched.
- **`npm run test -- --run`**: CODE VERIFIED — 99 passed, 95 skipped, 2
  test files fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`)
  on `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — confirmed
  this worktree has no `.env.local`, the identical pre-existing
  environment gap C1–C4 all documented; not re-investigated as new.
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: CODE
  VERIFIED — 117 tests, 78 passed, 39 failed, every failure
  `[webkit-desktop]` on a browser-executable-missing error
  (`ms-playwright/webkit-2336/Playwright.exe` not installed), on
  marketing/login/route-guard/responsive-viewport pages entirely
  outside the Shop module — identical failure count and root cause to
  C1–C4's own documented results; not re-investigated as new.
- **RPC/permission contract fidelity**: CODE VERIFIED by direct
  migration read — `return_shop_sale`'s and `create_refund`'s full live
  definitions, `list_shop_sales`'s/`get_shop_sale_detail`'s/
  `get_shop_sale_invoice_data`'s live definitions, `shop_sales`/
  `shop_sale_returns`/`shop_sale_return_items`/`payments`/
  `payment_allocations`/`refunds`/`invoices`/`branches`/`profiles`
  schemas, and `_shop_module_active`/`has_permission`/
  `has_platform_support_access`/`write_audit_log_as_support` signatures
  were all read from their real, latest migration files before being
  relied on or extended.
- **Two real defects found and fixed during this phase's own
  self-review, before commit** (documented in Sections 3a and 4a
  above): a broken PostgREST embed for the cashier filter (no FK path
  from `shop_sales` to `profiles`), and a status-field mix-up
  (`invoices.status` used where `shop_sales.status` was needed) that
  would have shown the wrong status badge and the wrong return-
  eligibility gate. Both are schema/runtime-shape bugs `tsc`/`lint`
  cannot catch — found by re-reading the actual RPC definitions and
  schema against what the new UI code assumed, not by the type checker.
- **No live DB credentials in this worktree** — confirmed (same
  constraint as C1–C4); not worked around. Migration SQL was reviewed
  manually for syntax/logic correctness against the real, current live
  definitions of every function extended.
- **Live RLS/RPC calls, browser/UI interaction**: ENVIRONMENT-BLOCKED,
  not LIVE VERIFIED / BROWSER VERIFIED — same three blockers C1–C4 all
  documented (no `.env.local`, no Docker-backed local Supabase stack,
  and creating a Supabase branch for a disposable test is a material
  paid-service change requiring explicit user go-ahead, not taken
  unilaterally). Recommendation unchanged: approve a Supabase branch
  for a real impersonation/Returns-flow test (especially the new
  multi-payment refund-selection path), or run the equivalent from a
  session with real credentials/local stack.
- **Environment note**: the host machine's `C:` temp drive was at
  0 bytes free for part of this session (unrelated to this worktree,
  which lives entirely on `D:`), causing transient `ENOSPC` failures in
  `npm`/`vitest`/`playwright` and even plain shell output piping.
  Worked around by redirecting `TEMP`/`TMP` to a directory on `D:` for
  each verification command (via PowerShell `$env:TEMP`/`$env:TMP`,
  cleaned up afterward) — not a code change, not a workaround of any
  blocked tool call, purely an environment-variable redirect to get
  disk space for build tool temp files.

## 10. Commit

Committed locally to this worktree's own branch
(`worktree-agent-a8738cd56ab473c17`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`. Exact
commit SHA and clean-tree confirmation reported to the orchestrator
directly (outside this file) after the commit is made.
