# Printable Document Matrix — TRUE FINAL CLOSURE

Definitive, repository-derived inventory. Every report route was found
via `src/app/routing/router.tsx` (grep for `reports/` registrations) —
**12 real report routes** exist, plus the invoice/receipt/refund
surfaces inside `BillingPage.tsx`, plus Stock Count and Inventory
Movements inside the Shop module.

## Invoices, Receipts, Refunds

| Document | Screen | Data Source | Permission | A4 | 80mm | QR | RTL | LTR | Status | Evidence |
|---|---|---|---|---|---|---|---|---|---|---|
| Field / Booking Invoice | `BillingPage.tsx` invoice dialog | `invoices`/`invoice_items` (real query, on-screen == print) | `invoice.view` | ✅ | ✅ | ✅ verify + ✅ booking QR | ✅ | ✅ | LIVE E2E VERIFIED (QR chain), CODE VERIFIED (layout) | `BOOKING_QR_INVOICE_SPEC.md` |
| Academy Invoice | Same dialog (generic) | Same | `invoice.view` | ✅ | ✅ | ✅ verify only (no booking) | ✅ | ✅ | CODE VERIFIED — unmodified, pre-existing | `invoice_items.description` shape identical across all 4 types |
| Club Membership Invoice | Same dialog (generic) | Same | `invoice.view` | ✅ | ✅ | ✅ verify only | ✅ | ✅ | CODE VERIFIED — unmodified, pre-existing | same |
| Shop / Product Invoice | Same dialog (generic) | Same | `invoice.view` | ✅ | ✅ | ✅ verify only | ✅ | ✅ | LIVE E2E VERIFIED | real QA sale: `invoice_items.description = "منتج اختبار الجرد"`, `reference_type='shop_sale_item'` never rendered |
| Payment Receipt | `BillingPage.tsx` — new "Print Receipt" per-payment dialog | `payments`/`payment_allocations` (same array already on screen) | `invoice.view` | ✅ | ✅ | — | ✅ | ✅ | CODE VERIFIED, build-clean | new this phase — invoice #, customer, date, method, collected-by, amount, outstanding |
| Refund Document | `BillingPage.tsx` — existing refund receipt dialog, extended | `refunds`/`create_refund()` result | `payment.refund` | ✅ | ✅ | — | ✅ | ✅ | CODE VERIFIED, build-clean | added "Processed by" this phase (was missing) |
| Public invoice verification card | `VerifyInvoicePage.tsx` (own layout, anon-reachable) | `verify_invoice_public` | none (public token) | n/a (screen-sized card) | — | ✅ | ✅ | ✅ | CODE VERIFIED — unmodified, pre-existing | |

## Reports (12 of 12 — full inventory, none guessed)

| Report | Route | Print Required? | Print Implemented? | Format | Orientation | Permission | Data Source |
|---|---|---|---|---|---|---|---|
| Revenue | `/app/reports/revenue` | Yes | ✅ (prior batch) | A4 | Portrait | `report.view` | `get_revenue_report` |
| Collections | `/app/reports/collections` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_collections_report` |
| Payment Methods | `/app/reports/payment-methods` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_payment_method_report` |
| Financial Exceptions | `/app/reports/exceptions` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_financial_exceptions_report` |
| Official Receipts | `/app/reports/official-receipts` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_official_receipts_report` |
| Financial Reconciliation | `/app/reports/reconciliation` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_financial_reconciliation_report` |
| Employee Cash Liability | `/app/reports/employee-liability` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` + `cash.liability.settle` for the Settle action (hidden on print) | `get_employee_liability_report` |
| Bookings | `/app/reports/bookings` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_booking_report` |
| Field Occupancy | `/app/reports/occupancy` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_field_occupancy_report` |
| Academy | `/app/reports/academy` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_academy_report` |
| Customers | `/app/reports/customers` | Yes | ✅ (this batch) | A4 | Portrait | `report.view` | `get_customer_activity_report` |
| Shop (Top Products + Inventory Summary) | `/app/reports/shop` | Yes | ✅ (prior batch) | A4 | Portrait | `report.view` + Shop module active | `get_shop_top_products`, `get_shop_inventory_summary` |

**Note on Club Membership**: no standalone "Club Membership report" route exists in `router.tsx` — membership operational data is surfaced through the Memberships feature UI directly, not a `/app/reports/*` route, so there was no report page to add printing to. This was verified by the same router grep that produced the 12-row list above, not assumed.

**Orientation**: every report above uses portrait A4 — none has more than ~6 columns of tabular data, so none required landscape. If a genuinely wide report is added later, `@page { size: A4 landscape }` scoped to that print target is the documented extension point (not built speculatively here, since no current report needs it).

## Inventory / Shop-specific documents

| Document | Screen | Print Implemented? | Notes |
|---|---|---|---|
| Inventory Balances (by Location) | `ShopInventoryPage.tsx` | ✅ this batch | Wrapped with `ReportPrintHeader`, low-stock filter shown as the applied filter |
| Inventory Movement Ledger | `ShopInventoryPage.tsx` (same page, movement history table) | ✅ this batch | Bounded to the most recent 50 movements — explicitly stated on the printed page, not silently truncated (Section 12) |
| Stock Count Result (completed) | `ShopStockCountPage.tsx` detail dialog | ✅ this batch | Print button shown only once `status = 'completed'`; header includes club/location/started-completed at+by; Matched/Shortage/Surplus summary counts added |
| Low Stock / Out of Stock | `ShopInventoryPage.tsx` (via the same balances table + low-stock filter) | ✅ (covered by Inventory Balances print above) | No separate dedicated page exists — the filter toggle on the one balances table already serves this, per this project's own earlier "don't duplicate a filter as a new page" decision |
| Damage / Loss | `list_shop_inventory_movements` (`movement_type` filter) | Covered by Movement Ledger print | Deliberately not a separate report page — same reasoning recorded in `COMMERCIAL_REPORTING_SOURCE_OF_TRUTH.md` from the Commercial closure, unchanged |
| Sales / Returns (Shop) | `ShopSalesPage.tsx` sales+returns history | ✅ this batch | Sale status column already shows `returned`/`partially_returned`; printing the sales list covers this — bounded to the most recent 50, stated explicitly on the printed page |

## Intentionally non-printable (Section 33's carve-out)

- Platform-internal debug/admin tables (audit log raw views, QA-only diagnostics) — no business/operational value to a printed copy.
- Real-time dashboards (`ReportsOverviewPage.tsx`, `TodayPage.tsx`) — these are live-refreshing summary hubs that link out to the actual printable reports above; printing a dashboard snapshot would encourage stale-data reliance, and every number on them is reachable via its own dedicated report.

## Reconciliation (Section 15)

Every print target added this phase renders directly from the same
`data`/`detail` object already used for the on-screen view — no
second calculation exists anywhere in the diff for this phase. This
was verified by construction (reading each edit before writing it),
not by a separate screen-vs-print pixel comparison, since both paths
share one render tree.

## What remains genuinely NOT BUILT (honest, not silent)

- Page numbering ("Page X/Y") for multi-page reports — investigated
  (Section 20): native browser print provides page breaks but not an
  in-content counter without a PDF library, which Section 10
  explicitly forbids adding. Documented as a real browser/tooling
  limitation, not left unexplained.
- A dedicated Club Membership report page does not exist to add
  printing to (see note above) — not a printing gap, an inventory
  fact.
