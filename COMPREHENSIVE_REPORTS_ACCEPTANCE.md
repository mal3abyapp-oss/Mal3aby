# Mal3aby — Comprehensive Reports Tool Review & Acceptance

Source of truth for the autonomous reports acceptance directive (2026-08-30).
Status values: PENDING / IN PROGRESS / PASS / FIXED + PASS / ACCEPTED LIMITATION / FAIL.

Baseline preserved, not reopened without concrete evidence: Finance
calculations, Printing architecture (incl. D1-D10 fixes this same day),
Commerce core. WhatsApp untouched.

## 0. Starting ground truth

- Repo HEAD = origin/main = `99efc28` (clean working tree, confirmed via `git status`).
- Production runtime confirmed live: console build tag `c6167dc` (the
  last runtime-code commit; `99efc28` on top is docs-only and correctly
  not redeployed, consistent with the printing directive's own
  "do not deploy docs-only changes" rule).
- QA identities reused from prior sessions: QA club id
  `a6bf6b6d-9a58-4636-bc6b-8ab0e7ed0b50`, club owner user_id
  `ecf9b9f3-0c18-47bf-9896-5263bdddd9a6`, QA branch id
  `e6187c20-17b9-4a75-84e1-53d87a10676d`.

## 1. Architecture note (confirmed via source, not assumed)

- `/app/reports/*` (ReportsOverviewPage + 12 individual routes) and
  `/app/finance/reports` (FinanceReportsPage, 8-tab hub) both render
  the SAME underlying `*Content` components (e.g. `ReportRevenueContent`
  imported by both `ReportRevenuePage.tsx` and `FinanceReportsPage.tsx`)
  — one implementation, two entry points. No duplicate-calculation risk
  between these two surfaces by construction.
- `/app/reports/shop` renders `ShopReportsPage.tsx`, a 16-report tabbed
  hub (Commerce Pro C7) — Sales Summary, Sales Detail, Product Sales,
  Category Sales, Payment Method Sales, Cashier Sales, Customer
  Purchases, Returns, Inventory On Hand, Stock Movement Ledger, Low
  Stock, Out of Stock, Stock Valuation, Gross Profit, Supplier
  Activity, Stock Count Variance. This already covers essentially all
  of directive Sections 9/10's requested Shop+Inventory reports.
- All print surfaces reuse the shared `ReportPrintButton`/
  `ReportPrintHeader`/`.print-target` mechanism, already verified
  correct architecture in the prior Printing Production Acceptance
  pass (including the D10 fix for Dialog-clipping on long documents,
  which applies here too since these report pages are NOT inside a
  Dialog — they are full routed pages, so D10 does not apply to them
  directly, but the same `@media print`/`.print-target` mechanism is
  shared).

## 2. Report inventory (discovered via routing + source, to be verified live)

| # | Report | Route/Location | Classification | Status |
|---|---|---|---|---|
| 1 | Reports Overview (landing) | `/app/reports` | REQUIRED | PENDING |
| 2 | Bookings report | `/app/reports/bookings` | REQUIRED | PENDING |
| 3 | Occupancy report | `/app/reports/occupancy` | REQUIRED | PENDING |
| 4 | Revenue report | `/app/reports/revenue` (+ `/app/finance/reports?tab=revenue`) | REQUIRED | PENDING |
| 5 | Collections report | `/app/reports/collections` (+ finance hub) | REQUIRED | PENDING |
| 6 | Payment Methods report | `/app/reports/payment-methods` (+ finance hub) | REQUIRED | PENDING |
| 7 | Exceptions report | `/app/reports/exceptions` (+ finance hub) | REQUIRED | PENDING |
| 8 | Official Receipts report | `/app/reports/official-receipts` (+ finance hub) | REQUIRED (where enabled) | PENDING |
| 9 | Reconciliation report | `/app/reports/reconciliation` (+ finance hub) | REQUIRED | PENDING |
| 10 | Gateway Health report | `/app/reports/gateway-health` (+ finance hub) | REQUIRED | PENDING |
| 11 | Employee Cash Liability report | `/app/reports/employee-liability` (+ finance hub) | REQUIRED | PENDING |
| 12 | Academy report | `/app/reports/academy` | REQUIRED | PENDING |
| 13 | Customers report | `/app/reports/customers` | REQUIRED | PENDING |
| 14 | Shop: Sales Summary | `/app/reports/shop?tab=sales-summary` | REQUIRED | PENDING |
| 15 | Shop: Sales Detail | `/app/reports/shop?tab=sales-detail` | REQUIRED | PENDING |
| 16 | Shop: Product Sales | `/app/reports/shop?tab=product-sales` | REQUIRED | PENDING |
| 17 | Shop: Category Sales | `/app/reports/shop?tab=category-sales` | REQUIRED | PENDING |
| 18 | Shop: Payment Method Sales | `/app/reports/shop?tab=payment-method-sales` | REQUIRED | PENDING |
| 19 | Shop: Cashier Sales | `/app/reports/shop?tab=cashier-sales` | REQUIRED | PENDING |
| 20 | Shop: Customer Purchases | `/app/reports/shop?tab=customer-purchases` | REQUIRED | PENDING |
| 21 | Shop: Returns | `/app/reports/shop?tab=returns` | REQUIRED | PENDING |
| 22 | Shop: Inventory On Hand | `/app/reports/shop?tab=inventory-on-hand` | REQUIRED | PENDING |
| 23 | Shop: Stock Movement Ledger | `/app/reports/shop?tab=stock-movement-ledger` | REQUIRED | PENDING |
| 24 | Shop: Low Stock | `/app/reports/shop?tab=low-stock` | REQUIRED | PENDING |
| 25 | Shop: Out of Stock | `/app/reports/shop?tab=out-of-stock` | REQUIRED | PENDING |
| 26 | Shop: Stock Valuation | `/app/reports/shop?tab=stock-valuation` | REQUIRED | PENDING |
| 27 | Shop: Gross Profit | `/app/reports/shop?tab=gross-profit` | REQUIRED | PENDING |
| 28 | Shop: Supplier Activity | `/app/reports/shop?tab=supplier-activity` | REQUIRED | PENDING |
| 29 | Shop: Stock Count Variance | `/app/reports/shop?tab=stock-count-variance` | REQUIRED | PENDING |
| 30 | Finance Overview | `/app/finance` (FinanceOverviewPage) | REQUIRED | PENDING |
| 31 | Finance Invoices | `/app/finance/invoices` | USEFUL | PENDING |
| 32 | Finance Payments | `/app/finance/payments` | USEFUL | PENDING |
| 33 | Outstanding page | `OutstandingPage.tsx` (billing) | REQUIRED | PENDING — need to locate route |
| 34 | Cash Shift history/report | `/app/finance/cash` (CashShiftPage/FinanceCashPage) | REQUIRED | PENDING |
| 35 | Expense reports | `/app/finance/expenses` (FinanceExpensesPage) | REQUIRED | PENDING |
| 36 | Club Membership report | `club_membership_report` RPC — need to locate UI surface | REQUIRED | PENDING |
| 37 | Platform Reports | `/platform/reports` (platform owner) | REQUIRED (platform scope) | PENDING |

Not yet located in routing, to confirm during live tour:
- Membership-specific report UI (new/renewed/cancelled/active/expired) — may live inside the Club Memberships module itself, not `/app/reports/*`.
- Any dedicated "customer balances/dues" view beyond Customers report.

## 3. Defects log (fill in as found; REPRODUCE → ROOT CAUSE → FIX → VERIFY)

(none yet — starting live tour)

## 4. Filter matrix results

(pending)

## 5. Cross-report reconciliation test

(pending — will use a controlled QA period with booking payment + membership payment + shop sale + shop return + expense + cash shift)

## 6. Timezone boundary test

(pending)

## 7. Print verification

(pending — representative sample per directive Section 19)

## 8. Responsive verification

(pending — 375/768/1024/1440)

## 9. RTL/LTR verification

(pending)

## 10. Security verification

(pending — cross-tenant, branch-scope, direct RPC calls)

## 11. Missing reports gap review

(pending — only after full existing-report review)

## 12. Final acceptance matrix

Not yet evaluated — populated at closure.
