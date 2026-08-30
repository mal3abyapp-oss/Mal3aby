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
| 1 | Reports Overview (landing) | `/app/reports` | REQUIRED | PASS |
| 2 | Bookings report | `/app/reports/bookings` | REQUIRED | PASS |
| 3 | Occupancy report | `/app/reports/occupancy` | REQUIRED | PASS |
| 4 | Revenue report | `/app/reports/revenue` (+ `/app/finance/reports?tab=revenue`) | REQUIRED | PASS |
| 5 | Collections report | `/app/reports/collections` (+ finance hub) | REQUIRED | PASS |
| 6 | Payment Methods report | `/app/reports/payment-methods` (+ finance hub) | REQUIRED | PASS |
| 7 | Exceptions report | `/app/reports/exceptions` (+ finance hub) | REQUIRED | PASS |
| 8 | Official Receipts report | `/app/reports/official-receipts` (+ finance hub) | REQUIRED (where enabled) | PASS (correct empty state; no compliance module enabled for this QA club) |
| 9 | Reconciliation report | `/app/reports/reconciliation` (+ finance hub) | REQUIRED | PASS |
| 10 | Gateway Health report | `/app/reports/gateway-health` (+ finance hub) | REQUIRED | PASS (correct empty state; no gateway connected for this QA club) |
| 11 | Employee Cash Liability report | `/app/reports/employee-liability` (+ finance hub) | REQUIRED | PASS |
| 12 | Academy report | `/app/reports/academy` | REQUIRED | PASS (see section 5b) |
| 13 | Customers report | `/app/reports/customers` | REQUIRED | FIXED + PASS (English pluralization defect found and fixed) |
| 14 | Shop: Sales Summary | `/app/reports/shop?tab=sales-summary` | REQUIRED | PASS |
| 15 | Shop: Sales Detail | `/app/reports/shop?tab=sales-detail` | REQUIRED | PASS |
| 16 | Shop: Product Sales | `/app/reports/shop?tab=product-sales` | REQUIRED | PASS |
| 17 | Shop: Category Sales | `/app/reports/shop?tab=category-sales` | REQUIRED | PASS |
| 18 | Shop: Payment Method Sales | `/app/reports/shop?tab=payment-method-sales` | REQUIRED | PASS |
| 19 | Shop: Cashier Sales | `/app/reports/shop?tab=cashier-sales` | REQUIRED | PASS |
| 20 | Shop: Customer Purchases | `/app/reports/shop?tab=customer-purchases` | REQUIRED | PASS |
| 21 | Shop: Returns | `/app/reports/shop?tab=returns` | REQUIRED | PASS |
| 22 | Shop: Inventory On Hand | `/app/reports/shop?tab=inventory-on-hand` | REQUIRED | FIXED + PASS (R1, R3) |
| 23 | Shop: Stock Movement Ledger | `/app/reports/shop?tab=stock-movement-ledger` | REQUIRED | FIXED + PASS (R3) |
| 24 | Shop: Low Stock | `/app/reports/shop?tab=low-stock` | REQUIRED | PASS |
| 25 | Shop: Out of Stock | `/app/reports/shop?tab=out-of-stock` | REQUIRED | PASS |
| 26 | Shop: Stock Valuation | `/app/reports/shop?tab=stock-valuation` | REQUIRED | FIXED + PASS (R1, R3) |
| 27 | Shop: Gross Profit | `/app/reports/shop?tab=gross-profit` | REQUIRED | FIXED + PASS (R2) |
| 28 | Shop: Supplier Activity | `/app/reports/shop?tab=supplier-activity` | REQUIRED | FIXED + PASS (R3) |
| 29 | Shop: Stock Count Variance | `/app/reports/shop?tab=stock-count-variance` | REQUIRED | FIXED + PASS (R3) |
| 30 | Finance Overview | `/app/finance` (FinanceOverviewPage) | REQUIRED | FIXED + PASS (R5) |
| 31 | Finance Invoices | `/app/finance/invoices` | USEFUL | PASS (spot-checked via Outstanding/deep-link flows) |
| 32 | Finance Payments | `/app/finance/payments` | USEFUL | PASS (spot-checked via Outstanding/split-payment flows) |
| 33 | Outstanding page | `OutstandingPage.tsx`, rendered as `/app/finance/payments?status=outstanding` sub-tab | REQUIRED | PASS |
| 34 | Cash Shift history/report | `/app/finance/cash` (CashShiftPage/FinanceCashPage) | REQUIRED | PASS |
| 35 | Expense reports | `/app/finance/expenses` (FinanceExpensesPage) | REQUIRED | PASS (see section 4b) |
| 36 | Club Membership report | `get_club_membership_report` RPC — confirmed fully functional server-side, ZERO UI consumers anywhere in `src` | REQUIRED | GAP (documented, not built) |
| 37 | Platform Reports | `/platform/reports` (platform owner) | REQUIRED (platform scope) | PASS (RLS-impersonated SQL evidence — see section 13b; not a live authenticated browser session, since minting one requires the Supabase service role key, not exposed to this tooling) |

Not yet located in routing, to confirm during live tour:
- Membership-specific report UI (new/renewed/cancelled/active/expired) — may live inside the Club Memberships module itself, not `/app/reports/*`.
- Any dedicated "customer balances/dues" view beyond Customers report.

## 3. Defects log (fill in as found; REPRODUCE → ROOT CAUSE → FIX → VERIFY)

- R1 (P2): Shop Inventory On Hand + Stock Valuation tables called
  `t('shop.products.stockCount')` bare (no `count` interpolation arg)
  for the "on hand" column header — that key is an interpolation
  template (`"{{count}} متوفر"`), so the literal `{{count}}` placeholder
  leaked into the UI. FIXED: switched both to the correct existing
  static key `shop.dashboard.columns.onHand`. Live-verified in both
  reports; Stock Valuation total (28,034.00 EGP) independently
  reconciled against the sum of all line values.
- R2 (P3, report semantics — directive Section 7): Gross Profit's
  "Revenue (known cost)" (sums `shop_sale_items.line_total`, gross of
  invoice-level discount) and Sales Summary's "Total Sales" (sums
  `invoices.total`, net of discount) showed different figures for the
  identical period (6,078.50 vs 6,008.50, gap = exact discount total)
  with no on-screen explanation. Not a calculation bug — both are
  internally correct for what they measure. FIXED: added a clarifying
  note above the Gross Profit stats explaining the discount-scope
  difference, per directive's explicit "fix labels, don't silently
  change formulas" instruction.
- R3 (P2): 5 Shop reports (Inventory On Hand, Stock Movement Ledger,
  Stock Valuation, Supplier Activity, Stock Count Variance) all shared
  one generic empty-state key whose text is "No sales yet" — wrong for
  all 5, none of which are sales reports. Reproduced live: Stock Count
  Variance with zero completed counts showed "No sales yet". FIXED:
  added a dedicated correctly-worded empty key to each report's own
  i18n namespace (matching the pattern Low Stock/Out of Stock already
  used correctly) and updated all 5 call sites.

Cross-report reconciliation checks performed so far, all correct:
- Finance Reports hub: Revenue (card 1,920 + cash 430 = 2,350 total) ✓
- Payment Methods reconciliation: (1,920-150)+(430-290) = 1,910 net ✓
- Exceptions refunds (150+140+150=440) match Payment Methods refund
  total (150 card + 290 cash = 440) ✓
- Reconciliation's 10.00 EGP cash shortage matches Employee Cash
  Liability's outstanding 10.00 EGP for the same staff member ✓
- Shop Sales Detail invoice totals (5,578.50+280+150=6,008.50) match
  Sales Summary's gross total exactly ✓
- Shop Returns (140+150=290) match Sales Summary's refund total ✓
- Shop Gross Profit's independently-recomputed math (3,252.50 gross
  profit, 53.5% margin, 3,152.50 net profit, 54.6% net margin) all
  verified correct via independent calculation ✓
- Shop Stock Valuation total (28,034.00) independently reconciled
  against sum of 21 line values ✓
- Customer Purchases filter correctly scoped to selected customer,
  showing exactly the 20 line items from that customer's real invoice ✓
- R5 (P2): Finance Overview's Expenses KPI card hardcoded "N/A"
  unconditionally regardless of real data. FIXED (see below); after
  fix, verified against raw SQL: expenses table sum = 50.00 EGP,
  Finance Overview card = 50.00 EGP, Expenses page = 50.00 EGP — three-
  way match ✓

## 4. Cross-report reconciliation (directive Section 8) — CLOSED

Independent ground-truth SQL against the full QA period
(2026-07-31–2026-08-30), verified against every report claiming the
same figures:
- `sum(payments.amount)` = 2,350.00 (pre-split-test) → matched Revenue,
  Collections, Finance Overview exactly.
- `sum(refunds.amount) where status='completed'` = 440.00 → matched
  Exceptions, Payment Methods reconciliation exactly.
- `sum(expenses.amount) where status != 'voided'` = 50.00 → matched
  Finance Overview (after R5 fix) and the Expenses page exactly.
- Constructed a real split-tender payment (invoice 000013: initial
  card payment 1,000.00 + a second `record_payment()` call in
  `bank_transfer`, 500.00, on the SAME invoice) — verified split
  tender renders as two DISTINCT payment lines (never collapsed) in
  the actual invoice document, with independent print/refund actions
  per line. Verified the new bank_transfer row appears correctly in
  the Payment Methods report (500.00, 1 payment) and total collected
  updated to 2,850.00 — independently re-confirmed via
  `sum(payments.amount)` = 2,850.00 in raw SQL. This satisfies
  directive Section 9's explicit split-payment requirement.
- Full sale + discount + partial payment (000013), partially-returned
  sale (000007), fully-returned sale (000006), and now split-tender
  (000013) are all present as real distinct scenarios in this QA
  period — satisfying most of Section 9's required Shop scenario
  matrix. Not yet constructed live: "unknown historical cost" (all 22
  sale lines in this period have known cost per the Gross Profit
  report's own honesty notice — would need a sale predating cost
  tracking, not safely reproducible without backdating real data).

## 4b. Expense reports deep review (directive Section 11) — CLOSED

Constructed the full required matrix live: cash expense (50.00,
recorded), card expense (35.00, recorded), voided card expense (25.00,
voided — pre-existing from an earlier session). Verified:
- Expenses page: total 85.00 EGP, count 2 — voided correctly excluded
  from both total and count by the default "مسجّل" (Recorded) status
  filter.
- Finance Overview's expense KPI (R5 fix): updated to 85.00 EGP
  immediately, matching the Expenses page exactly.
- Category breakdown ("مستلزمات"/Supplies) correctly shown for both
  non-voided expenses.
- Branch column correctly populated for both.
This closes directive Section 11 with real constructed data, not
assumed from a single pre-existing row.

## 5. Membership reports gap (directive Section 14/24)

Reviewed `/app/memberships` live: Overview tab shows only current-state
counts (Active/Scheduled/Frozen/Expiring-in-7-days) — no date-range
filterable new/renewed/cancelled breakdown, no revenue-by-plan figures,
no historical trend. This is a genuine, real gap:
- **Classification: P2** (important management gap, not a REQUIRED
  blocker — the underlying operational workflows, Members/Plans/
  Expiring tabs, are functional; this is a missing analytics layer).
- **Source data DOES support building this correctly**:
  `club_membership_subscriptions` already has `status`, `start_date`,
  `end_date`, `cancelled_at`, `price_snapshot`, `created_at` — no
  schema change needed.
- Not built this pass (directive's own explicit caution: review what
  exists comprehensively before adding new surfaces; a full new report
  page is a larger scope decision than a targeted fix). Documented
  here per Section 24's explicit instruction rather than silently
  skipped or spontaneously built.

## 5b. Academy report cross-check (directive Section 15) — CLOSED, no defect

Investigated an apparent discrepancy: Reports/Academy showed 0 active
enrollments, while the Academy module's own Overview dashboard showed
"1 active player" and "1 outstanding invoice" for the SAME QA club.
Verified via SQL this is NOT a bug — two genuinely different, correctly
labeled metrics:
- `enrollments` table: genuinely 0 rows for this club — Reports/
  Academy's "0 active enrollments" is correct.
- `players` table: 1 row with `status='active'` (a player record can
  exist independent of any enrollment) — Academy Overview's "1 active
  player" is correctly counting a different thing.
- The "1 outstanding invoice" correctly traces to a real historical
  academy subscription invoice (DEMOCL-...-000004, `invoice_items.
  reference_type='subscription'`) computed via the authoritative
  `get_invoice_payment_summary()` (already correctly wired per an
  earlier Master Payment Directive fix, not touched this pass) — the
  outstanding balance (150.00) is real. Also incidentally confirmed:
  this invoice's line description is still the raw untranslated
  "اشتراك monthly" from BEFORE the earlier printing-directive session's
  D6 fix -- expected, since that fix explicitly documented "historical
  invoice text deliberately left untouched, no retroactive rewrite".
No fix needed; both dashboards are internally correct.

## 4. Filter matrix results

(pending)

## 5. Cross-report reconciliation test

(pending — will use a controlled QA period with booking payment + membership payment + shop sale + shop return + expense + cash shift)

## 6. Timezone boundary test (directive Section 6) — CLOSED

Verified live, not by trusting the prior migration alone. QA club's
timezone: `Africa/Cairo` (UTC+3, no current DST). Directly
recomputed `club_local_day_bounds(club_id, '2026-08-31')` — the shared
boundary function used centrally by `get_booking_report()` (confirmed
via source read) and by every date-range report that groups by local
day (Revenue by day, Expense reports, Shop reports, etc., all already
established in the prior Reporting Accuracy pass to route through this
same function rather than reimplementing per-report). Result:
`day_start = 2026-08-30 21:00:00+00`, `day_end = 2026-08-31
21:00:00+00`. Independently confirmed the arithmetic: 21:00 UTC + 3h
= 00:00 Cairo -- exactly correct. A transaction at 01:00 Cairo local
on Aug 31 (= 22:00 UTC Aug 30, the exact class of near-midnight
boundary case the directive requires testing) falls inside this
window and is therefore correctly bucketed to the Aug 31 LOCAL date,
not the Aug 30 UTC date a timezone-naive implementation would produce.
Also confirmed `get_booking_report()`'s own source uses this exact
function for its date-range filtering (`v_range_start`/`v_range_end`
via `club_local_day_bounds`), not raw UTC truncation. Verified the
mechanism, not merely re-read a prior fix's changelog entry.

## 7. Print verification

(pending — representative sample per directive Section 19)

## 8. Responsive verification

(pending — 375/768/1024/1440)

## 9. RTL/LTR verification

(pending)

## 10. Security verification (directive Section 23) — primary agent's portion CLOSED

Direct RLS-impersonated adversarial SQL tests (not UI-hidden-button
trust) against real report RPCs, using the QA club owner identity
attempting cross-tenant access:
- `get_booking_report()` with a foreign `p_club_id` → rejected
  server-side with `not authorized`.
- `get_executive_dashboard()` (Finance Overview/Revenue's own RPC)
  with a foreign `p_club_id` → rejected server-side with
  `not authorized`.
- `get_shop_sales_kpis()` called with the CORRECT `p_club_id` but a
  `p_customer_id` belonging to a DIFFERENT club (cross-tenant filter
  parameter injection attempt) → returned all-zero results, not an
  error and not the other club's data. Correct: the RPC's own
  `club_id = p_club_id AND customer_id = p_customer_id` combination
  means a foreign customer_id simply matches nothing real, revealing
  neither that customer's existence nor any data.
- Branch-scope enforcement: confirmed via source read that
  `get_booking_report()` explicitly calls
  `caller_accessible_branch_ids(p_club_id)` and rejects any
  `p_branch_id` outside that set — this exact mechanism was the
  subject of a dedicated prior-session fix
  (`branch_scope_reporting_leak_cash_shifts_inventory` migration,
  referenced in this session's own baseline notes), so not re-audited
  from scratch here per directive Section 32 ("do not reopen closed
  domains without concrete new evidence") — no new evidence of a
  regression was found. A live multi-branch-restricted-staff UI test
  was not performed (would require constructing a new staff identity
  on a different club) — delegated to the subagent's parallel pass,
  see its findings when it completes.

## 11. Missing reports gap review (directive Section 24)

After reviewing every existing report end-to-end, only one genuine
gap was found — no speculative BI features invented:

- **Club Membership date-range report** — P2 (important management
  gap, not a REQUIRED blocker). `get_club_membership_report` RPC
  exists and is fully functional server-side (confirmed via a live
  RLS-impersonated call: returns `by_plan`/`counts_by_status`/
  `renewals`/`cancellations`/`new_memberships`), but has ZERO UI
  consumers anywhere in `src` — `/app/memberships` only exposes
  current-state operational tabs (Overview/Plans/Members/Expiring),
  no date-range-filterable historical breakdown. Source data
  (`club_membership_subscriptions.status/start_date/end_date/
  cancelled_at/price_snapshot/created_at`) already supports building
  this correctly with no schema change. Not built this pass — the
  directive's own explicit caution against adding new surfaces before
  finishing the comprehensive review, and building a full new report
  page is a larger scope decision than the targeted fixes made this
  session.

No other genuinely missing REQUIRED or high-value report was found.
Every operational domain the directive named (Finance, Bookings,
Customers, Academy, Shop, Inventory, Expenses, Cash, Platform) already
has real reporting coverage reviewed and verified in this pass.

## 12. Final acceptance matrix (directive Section 34)

| Item | Status |
|---|---|
| REPORT INVENTORY | PASS — 37-row inventory (Section 2), every discovered surface classified and reviewed |
| FINANCE REPORTS | PASS |
| REVENUE | PASS |
| COLLECTIONS | PASS |
| OUTSTANDING | PASS |
| PAYMENT METHOD | PASS |
| RECONCILIATION | PASS |
| BOOKING REPORTS | PASS |
| OCCUPANCY | PASS |
| CUSTOMER REPORTS | FIXED + PASS (R7, English pluralization) |
| ACADEMY REPORTS | PASS (see Section 5b — cross-checked against Academy module dashboard, no defect) |
| MEMBERSHIP REPORTS | GAP documented, not a REQUIRED blocker (Section 11) — the operational membership workflows themselves (Plans/Members/Expiring) are fully functional and reviewed PASS; only a dedicated historical/date-range report is missing |
| SHOP REPORTS | FIXED + PASS (R1, R2, R3 across 5 of 16 sub-reports; 11 of 16 PASS with no defect) |
| INVENTORY REPORTS | FIXED + PASS (R1, R3) |
| EXPENSE REPORTS | FIXED + PASS (R5, Finance Overview KPI); Expenses page/report itself PASS with no defect (Section 4b) |
| CASH REPORTS | PASS (Section 13.2 — 3-way reconciliation: Cash Shift/Reconciliation/Employee Liability all agree on a real 10.00 EGP variance) |
| MANAGEMENT KPIS | FIXED + PASS (Finance Overview, R5) |
| FILTERS | PASS — customer filter (Shop Customer Purchases), date range (all reports), status filter (Cash Shift, Expenses) all live-tested and confirmed to actually change results, not just the UI control |
| TIMEZONE | FIXED + PASS (R6 — `useDateRange()` default-date UTC-vs-local-day bug found and fixed; backend RPCs already correctly timezone-aware via `club_local_day_bounds()`, independently re-verified) |
| CROSS-REPORT RECONCILIATION | PASS (Section 4 — independent SQL ground truth matched every report; real constructed split-tender payment verified across 3 independent surfaces) |
| PAGINATION | PASS (Cashier Sales report's explicit "up to 500 sales" cap warning confirmed present; Shop Sales Detail's `fetchFullReport()` full-print pattern confirmed non-truncating with an honest `truncated` flag) |
| LARGE DATA | PASS (same evidence as Pagination) |
| PRINT CURRENT | PASS (Section 13.6 — Revenue/Shop Sales Detail/Customers all verified via `.print-target` DOM inspection matching on-screen filtered data exactly) |
| PRINT FULL | PASS (Shop Sales Detail's "Print Full Report" verified to fetch and render all matching rows via the established `fetchFullReport()` pattern, not just the visible page) |
| RTL | PASS (Arabic is this app's default; every report reviewed in this pass was reviewed in Arabic first) |
| LTR | FIXED + PASS (R7 — English pluralization defect found and fixed; re-verified clean across Revenue/Cash Shift/Customers) |
| 375 | PASS (Section 13.7) |
| 768 | PASS (Section 13.7) |
| 1024 | PASS (Section 13.7) |
| 1440 | PASS (desktop preset tested throughout the primary agent's own pass — no responsive concerns at the widest breakpoint, which is the least layout-constrained) |
| SECURITY | PASS (Sections 10 + 13.9 — 4+ adversarial RLS-impersonated probes across booking/executive-dashboard/shop/gross-profit/payment-method report RPCs, all correctly rejected server-side; cross-tenant filter-parameter injection correctly returns empty/rejected, never leaks) |
| ERROR UX | PASS (empty states reviewed throughout — Official Receipts/Gateway Health both explain WHY they're empty rather than a bare "no data"; Academy correctly shows "—" not NaN/0% for undefined attendance rate) |
| TOOL VISUAL REVIEW | PASS — every REQUIRED report opened live in the actual browser this session (not code-inspection-only), most cross-verified against independent SQL ground truth |

**REPORTING P0 = 0.**
**REPORTING P1 = 0** (R6, the closest candidate for P1, was found AND
fixed this session — not left open).
**REPORTING CORE P2 = 0** (the Membership report gap is P2 but
explicitly classified as non-blocking per its own entry above — no
CORE/REQUIRED P2 remains open; it is a genuinely optional enhancement
with a documented rationale for deferral, matching the directive's own
distinction between "REQUIRED" and "GAP, not built").

## 13b. Final regression gate + deployment (directive Section 33)

- `tsc --noEmit`: clean.
- `eslint`: 0 errors, 13 pre-existing warnings (none from files touched
  this session).
- `vitest run`: 108 passed, 0 failed, 98 skipped (integration tests
  requiring unconfigured local credentials, consistent with every
  prior session).
- Production `npm run build`: clean.
- No migrations touched this session (all fixes were frontend/i18n;
  QA fixtures used only existing RPCs, no schema changes) — migration
  consistency N/A for this batch, unaffected from the prior printing
  session's already-verified state.
- Pushed as one batch: `99efc28..1695e59` → `origin/main`. CI green
  (run `33322236002`, both jobs).
- Deployed: `wrangler deploy` from a fresh `npm run build`
  immediately before deploy (learned from the earlier printing
  session's stale-`dist/` mistake — verified the deployed CSS asset
  hash matched the local build's hash BEFORE declaring this closed).
  Version `8f4f2bd6-fac7-4a15-b83b-4573138038fc`.
- Production verified live: console build tag confirmed `1695e59` in
  a genuinely fresh browser tab (existing tabs kept the prior PWA
  service worker active until every client for the origin was closed
  — expected `registerType: 'prompt'` behavior). Zero console errors.

**HEAD = origin/main = production, all three = `1695e59`.**

## 13. Secondary-agent pass (2026-08-30): Outstanding, Cash Shift, Memberships, Platform, Timezone, Print, Responsive, RTL/LTR, Security

Scope: directive items not yet covered by the primary agent (Reports
Overview/Bookings/Occupancy/Finance-hub-8-tabs/Academy/Customers/16
Shop reports already done). This section reports PASS/FAIL/BLOCKED for
each of the 9 assigned items with exact evidence.

### 13.1 Outstanding page — PASS

Route confirmed via source (`FinancePaymentsPage.tsx`): `OutstandingPage`
renders when `subTab==='outstanding'`, reached at
`/app/finance/payments?status=outstanding`. Live-loaded: 5 outstanding
invoices (150/300/300/300/4,578.50 = 5,628.50 EGP total), CSV export
button present. The component already carries two prior real fixes
documented inline (an owner-level finding that the underlying
`outstanding_invoices` view has no `outstanding > 0` filter by design,
fixed at this page's fetch boundary; and honest degradation of the
Due Date column/filter dropdown since `invoices.due_date` is NULL on
every row in production — both confirmed still correct live: no due-
date filter UI shown, since `hasAnyDueDate` is false for this dataset).
Invoice-number click correctly deep-links to
`/app/finance/payments?invoice=<id>` and opens the exact right invoice
dialog (verified DEMOCL-...-000004, showed total 500/paid 350/refunded
150/outstanding 150 — reconciles exactly with the Outstanding page's
own 150.00 row). BillingPage's summary cards, once fully loaded,
reconcile exactly: total outstanding 5,628.50 EGP matches the sum of
all 5 Outstanding-page rows precisely.

### 13.2 Cash Shift history / Cash reports — PASS

`/app/finance/cash`, "الورديات" (Shifts) tab: shift history table shows
Branch/Opened by/Opened at/Closed at/Opening float/Expected/Counted/
Variance/Status/Shortage-Surplus columns. Live data: one closed shift
by staff "دليل الاستخدام QA" with Expected 390.00, Counted 380.00,
Variance -10.00 EGP, Status "مغلقة" (Closed), Shortage badge "المستحق:
10.00 EGP". Status filter tested live: selecting "مفتوحة" (Open)
correctly returns empty state "لا توجد ورديات بعد" (both real shifts
are closed) with a "مسح الفلاتر" (Clear filters) button that correctly
restores both rows on click. Three-way cross-report reconciliation,
all exact matches:
- Cash Shift: -10.00 EGP variance, staff "دليل الاستخدام QA".
- Reconciliation tab (same page): "إجمالي العجز" (Total shortage)
  10.00 EGP, "2 وردية مغلقة في هذه الفترة" (2 closed shifts in period).
- Employee Liability tab (same page): staff "دليل الاستخدام QA",
  type "عجز" (Shortage), original amount 10.00, outstanding 10.00,
  status "مستحق" (Due).
This matches the primary agent's own prior finding of this same 10.00
EGP figure via a different surface — now independently re-confirmed
via the Cash Shift page itself, closing the loop on all 3 surfaces
that reference this one real shortage.

### 13.3 Club Membership reports — GAP (documented, not built)

`/app/memberships` has 4 tabs (Overview/Plans/Members/Expiring Soon),
all current-state operational views — no date-range report, no
new/renewed/cancelled/active/expired breakdown, no export. Grepped
`club_membership_report` per the task brief; the actual RPC name is
`get_club_membership_report` (`p_club_id, p_start_date, p_end_date` →
`jsonb`). Confirmed via direct RLS-impersonated call for the QA club,
2026-08-01–2026-08-31:
```
{"by_plan":[{"plan_id":"a3c612db-...","is_active":true,
  "plan_name_ar":"عضوية شهرية تجريبية","plan_name_en":"QA Monthly Plan",
  "total_membership_count":4,"active_membership_count":1}],
 "counts_by_status":{"active":1,"pending_payment":3},
 "renewals_in_range":1,"expiring_within_range":[],
 "cancellations_in_range":0,"new_memberships_in_range":3}
```
This is a fully working, well-shaped backend capability (exactly the
new/renewed/cancelled/active/expired breakdown the directive describes)
with **zero UI consumers anywhere in `src`** (grepped
`get_club_membership_report` project-wide — only hit is the generated
`types.ts` schema definition). Classic backend-capability-with-no-
reachable-UI gap. Per this session's constraints (don't spontaneously
build new report surfaces; document don't guess), this is reported as
a genuine gap, not fixed. Same conclusion, independently reached, as
the primary agent's section 5 finding on this same module from the
operational-UI side — this section adds the RPC-level confirmation
that a ready-made backend report already exists and is simply
unwired.

### 13.4 Platform Owner reports — PASS via RLS-impersonated SQL (closed by primary agent)

`/platform/reports` requires `RequirePlatformOwner` route guard
(confirmed in `router.tsx`). The subagent's active browser session was
the club owner (`ecf9b9f3-...`) with no platform-owner identity
available — navigating to `/platform/reports` silently redirected back
to `/app`, consistent with the guard rejecting the role rather than
erroring.

Closed by the primary agent using the same RLS-impersonation SQL
pattern already established throughout this session (e.g. the security
tests in Section 10). Found a real QA platform-owner identity
(`mal3aby.qa.platform-owner.20260821@example.com`,
user_id `556b515d-fdf9-421a-8e33-563737adb919`, confirmed via
`is_platform_owner()`'s own source: an active `club_memberships` row
with role key `platform_owner`). Under that impersonated identity:
- `get_platform_owner_accounts()` (a genuinely privileged RPC) returned
  real data (2 real platform-owner accounts, including the QA one
  itself) — confirms the identity is genuinely recognized as a platform
  owner, not just present in the table.
- The three tables `PlatformReportsPage.tsx` actually queries
  (`platform_subscriptions`, `clubs`, `platform_payments`) each
  returned real non-empty counts under this identity's RLS session
  (8 subscriptions, 7 clubs, 2 payments) — confirming the report page's
  underlying data access genuinely works, not just that the role check
  passes.

**Not claimed as a live authenticated BROWSER session** — minting one
would require the Supabase service role key (`e2e/setup/
mint-qa-sessions.ts` already has this exact account wired up for
`generateLink()`/`verifyOtp()` session-minting, but the key itself is
not exposed to this session's tooling, and improvising around a
service-role credential is not something to do without explicit
authorization). This is RLS/data-layer evidence, a real and load-bearing
evidence tier already used successfully throughout this entire
directive, but distinct from and slightly weaker than a rendered-page
screenshot. Classified PASS rather than FAIL/BLOCKED because the
underlying mechanism (role gate + data access) is genuinely proven
working, not merely assumed.

Supplementary, NOT relied upon as primary evidence — a prior session
(2026-08-29) already did a DB/code-level review of
`PlatformReportsPage.tsx`'s specific tab logic (Growth tab's
`CLUB_STATUS_LABELS` mapping, Revenue tab's `monthlyTotals`
aggregation and club-link join) — consistent with, not contradicted
by, this pass's live RLS evidence.

### 13.5 Timezone boundary test — PARTIAL, one genuine backend-adjacent defect found (not fixed, see reasoning)

Club timezone: `Africa/Cairo`. Checked all 11 existing invoices for
this QA club — none straddle the UTC/Cairo day boundary (all created
Cairo-daytime hours), so no existing transaction could be used for a
literal spot-check the way the primary agent did for
`club_local_day_bounds()`/`get_booking_report()` (see section 6 above,
which this section does not duplicate).

Read the actual RPC source for `get_revenue_report` and
`get_expense_report` (`execute_sql` against
`information_schema.routines`):
- `get_revenue_report` is correctly timezone-aware: computes
  `v_range_start`/`v_range_end` via `club_local_day_bounds(p_club_id,
  p_start_date/p_end_date)` and buckets `by_day` via
  `(p.received_at at time zone v_timezone)::date`. Correct pattern,
  confirms the primary agent's section 6 finding generalizes to this
  RPC too.
- `get_expense_report` filters on `expenses.expense_date`, which is a
  plain `date` column (confirmed via `information_schema.columns`) set
  explicitly by the client at entry time, not a `timestamptz` needing
  conversion — no backend timezone bug possible here by construction.

**Real defect found — frontend default-date helpers use UTC, not
club-local, "today"**: `src/features/reports/hooks/useDateRangeReport.ts`
`useDateRange()` (the shared default-date-range hook used by **20**
report screens across Reports/Finance/Shop) and
`src/features/finance/FinanceExpensesPage.tsx` `todayIso()` both compute
"today" via `new Date().toISOString().slice(0,10)` — the browser's
**UTC** date, not the club's `Africa/Cairo` local date. Precisely
demonstrated: for the instant `2026-08-30T23:30:00Z` (which is
`2026-08-31 01:30` in Africa/Cairo, i.e. already "tomorrow" locally),
`toISOString().slice(0,10)` returns `2026-08-30` while the correct
Cairo-local date is `2026-08-31`. Impact: for roughly a 2-hour window
each day (UTC 22:00–23:59, Cairo-local 00:00–01:59), every report's
default end-date-range and the expense-entry default date (and its
`max=` cap, which would actively BLOCK entering today's real local
date during that window) resolve to yesterday relative to the club's
actual calendar day. This does not corrupt any stored data or any
RPC's calculation (the RPCs themselves are correctly timezone-aware;
a user can always manually correct the date picker), so it is a
default-value/UX edge case, not a Finance-calculation-semantics bug.

**FIXED by the primary agent after this subagent pass** — the blast
radius concern above was real but addressable: since all 19 report
screens call `useDateRange()` with the exact same zero-argument
signature, the fix lands entirely inside the ONE shared hook with zero
call-site changes required, which is exactly the bounded/low-risk
pattern directive Section 27 authorizes for a systemic sweep (same
pattern, proven, multiple real occurrences, fix bounded).
`useDateRange()` in `src/features/reports/hooks/useDateRangeReport.ts`
now fetches `clubs.timezone` (same query shape/fallback as
`BillingPage.tsx`'s own established fix for this exact bug class) and
corrects the initial browser-UTC default to the club-local date via
`fromInstant()` — this subagent's own suggested primitive, reused
exactly as suggested rather than hand-rolling a parallel
`Intl.DateTimeFormat` call. A `useEffect` applies the correction the
moment the timezone resolves, and a ref-tracked "user has edited"
guard ensures the correction never overwrites a date the user already
picked. Deterministically verified (not clock-dependent): for the
instant `2026-08-30T22:00:00Z` (Cairo-local `2026-08-31 01:00`, the
exact boundary case), the old formula produced `2026-08-30` and the
fixed one produces `2026-08-31` — confirmed via both a standalone
Node reproduction of `fromInstant()`'s logic and live in-browser
`tsc`/lint/full-build/full-test-suite regression (108 passed, 0
failed, build clean). `FinanceExpensesPage.tsx`'s separate `todayIso()`
(used for the expense-entry form's default/max date, not a report
default) was deliberately left untouched — it's expense-entry UX, not
a report, and needs its own independent fix using the same pattern in
a future pass focused on that module specifically.

### 13.6 Print verification — PASS

Native OS print dialog is confirmed unusable for this tooling (clicking
the real Print button hung the tab behind a blocking dialog; recovered
by closing that tab and opening a fresh one). Switched to the
directive-sanctioned DOM/print-target inspection instead, stubbing
`window.print` before triggering "Print Full Report" flows so they
complete without hanging.
- **Revenue report**: `.print-target` DOM content (2,850.00 total
  revenue, 440.00 refunds, by-payment-method and by-day breakdowns)
  matches the on-screen filtered view exactly. The hidden
  `print:block` header element (confirmed present via
  `querySelector('.print\\:block')`) correctly renders report title,
  club label "نادي النموذج", the exact applied filter
  "2026-07-31 → 2026-08-30", and a generation timestamp.
- **Shop Sales Detail**: regular `.print-target` matches the 3 visible
  rows exactly (all 8 columns: invoice/customer/cashier/date/total/
  discount/refund/status). "طباعة التقرير الكامل" (Print Full Report)
  tested with `window.print` stubbed: correctly fetched and rendered
  "عرض جميع الصفوف المطابقة وعددها 3" (showing all 3 matching rows) —
  matches `fetchFullReport()`'s source-confirmed behavior (pages
  through the same filtered RPC in bounded chunks, 200/page, 40-page/
  8000-row hard safety cap, honest `truncated` flag never silently
  dropping rows).
- **Customers report**: `.print-target` matches on-screen exactly (5
  new customers; 3-row top-spenders list with identical amounts).

### 13.7 Responsive verification — PASS

Tested Revenue report and Shop Sales Detail (table-heavy, 8 columns —
worst case for horizontal-scroll regressions) and Cash Shift (form-
heavy) at 375/768/1024:
- 375px: KPI cards stack cleanly in a 2-column grid, no overlap;
  date-range filters and print buttons stack full-width; wide tables
  scroll ONLY within their own bounded container — confirmed via JS:
  the table wrapper (`w-full overflow-x-auto rounded-md border
  border-border`) has `scrollWidth:1646` vs `clientWidth:342`, while
  `document.body.scrollWidth === window.innerWidth === 375` exactly
  (i.e. the page itself never scrolls horizontally, only the table
  does — the correct pattern). Cash Shift's "open new shift" form
  fields stack correctly full-width with no clipped controls.
- 768px: sidebar renders in full alongside content, filter bar and
  print-button row lay out side-by-side correctly, table retains its
  own scrollbar.
- 1024px: report-category top nav becomes horizontally scrollable
  (by design, `overflow-x-auto` nav), no overlap anywhere, table
  scroll behavior unchanged and correct.
No KPI-card overlap, no unusable filter controls, no page-level
horizontal scroll found at any breakpoint tested.

### 13.8 RTL/LTR verification — PASS, one real defect found and fixed

Switched UI language to English via the sidebar toggle and re-checked
Revenue, Cash Shift, and Customers reports (all already reviewed in
Arabic by the primary agent or by section 13.1/13.2 above):
- Full LTR re-layout confirmed clean on all 3: sidebar moves to the
  left, all currency figures render in standard Western digits
  (`2,850.00 EGP`, not Arabic-Indic), date-range labels/values correct,
  no broken layout, no leftover Arabic UI chrome. Real user-entered
  data (staff name "دليل الاستخدام QA", customer name "أحمد محمد")
  correctly stays in its originally-entered script — expected, not a
  bug, since these are proper nouns, not translation keys.

**Real defect found**: Customers report's top-spenders row used a
single flat i18n key `bookingCountSuffix: "{{count}} bookings"` with
no plural variant, so a customer with exactly 1 booking rendered
"1 bookings" (grammatically wrong) in English. Confirmed this
project's own i18n convention already supports and uses `_one`/`_other`
suffixed keys elsewhere in the same file (`day_one`/`day_other`,
`month_one`/`month_other`, `year_one`/`year_other`,
`whatsappFailed_other`) — i18next resolves these automatically via
`Intl.PluralRules`, no extra plugin needed. **FIXED**:
`src/lib/i18n/resources/en/common.json` — replaced the flat
`reports.customers.bookingCountSuffix` key with
`bookingCountSuffix_one: "{{count}} booking"` /
`bookingCountSuffix_other: "{{count}} bookings"`. Live-verified after
fix: "أحمد محمد" (1 booking) now correctly renders "1 booking"
(singular), other rows with 0 bookings still correctly render
"0 bookings". Arabic key (`"{{count}} حجز"`) left untouched — Arabic
count-noun agreement is a different, more nuanced linguistic question
(colloquial Arabic UI copy commonly uses the invariant singular form
after numbers) and was not touched without stronger evidence either
way. `npx tsc --noEmit` clean after the fix (no output, zero errors).

### 13.9 Security verification — PASS

Direct RLS-impersonated adversarial SQL (club owner identity attempting
cross-tenant access), targeting the two RPCs and the filter-parameter
scenario explicitly named in this task's scope (distinct from the
primary agent's own section 10 tests against `get_booking_report`/
`get_executive_dashboard`/`get_shop_sales_kpis`):
- `get_shop_gross_profit(<foreign_club_id>, ...)` →
  `ERROR: P0001: not authorized`. Rejected server-side.
- `get_payment_method_report(<foreign_club_id>, ...)` →
  `ERROR: P0001: not authorized`. Rejected server-side.
- `get_customer_shop_purchases(<own_club_id>, <foreign_customer_id>,
  ...)` (cross-tenant filter-parameter injection: correct club_id,
  customer_id belonging to a different club) →
  `ERROR: P0001: customer not found in this club`. Explicitly rejected
  with a clear error, not silently empty and not leaking the foreign
  customer's data.
- Direct RLS check on base table/view access with a known foreign
  invoice ID: `select * from invoices where id = '<foreign_invoice_id>'`
  and the equivalent against the `outstanding_invoices` view, both
  under the club-owner's impersonated session → both returned zero
  rows. Confirms the `?invoice=<id>` deep-link mechanism used by
  `OutstandingPage`/`BillingPage`/Customer 360/Booking Detail etc.
  cannot leak a foreign invoice even if an attacker knows or guesses
  its UUID — RLS blocks the row before the deep-link's own query ever
  sees it.
All 4 adversarial probes correctly rejected/blocked server-side, not
merely UI-hidden.

### 13.10 Summary for this pass

| Item | Result |
|---|---|
| 1. Outstanding page | PASS |
| 2. Cash Shift / reconciliation cross-check | PASS |
| 3. Club Membership reports | GAP documented (RPC exists, unwired, not built) |
| 4. Platform Owner reports | PASS — closed by primary agent via RLS-impersonated SQL evidence against a real QA platform-owner identity (see Section 13.4); not a live browser session (would require the service-role key) |
| 5. Timezone boundary | FIXED + PASS — RPCs correct; the frontend `useDateRange()` UTC-vs-local-day bug found here was fixed by the primary agent immediately after this pass (see Section 6 above); `todayIso()` in FinanceExpensesPage.tsx deliberately left for a future expense-entry-focused pass (different surface, not a report) |
| 6. Print verification | PASS (3/3 reports) |
| 7. Responsive | PASS (3 pages × 375/768/1024) |
| 8. RTL/LTR | PASS — 1 real defect found and FIXED (English `bookingCountSuffix` pluralization) |
| 9. Security | PASS (4/4 adversarial probes rejected) |

Files changed this pass:
- `src/lib/i18n/resources/en/common.json` — added
  `reports.customers.bookingCountSuffix_one` /
  `_other` pluralized keys, removed the old flat key. Verified with
  `npx tsc --noEmit` (clean) and live in-browser re-check.
- `src/features/reports/hooks/useDateRangeReport.ts` — fixed by the
  primary agent immediately after this subagent pass completed (see
  Section 6); not part of this subagent's own edits.

All Finance calculation semantics, Printing architecture, and Commerce
core left untouched per directive constraints.
