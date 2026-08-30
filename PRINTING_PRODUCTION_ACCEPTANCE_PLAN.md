# Mal3aby — Printing / Invoices / Receipts Production Acceptance Plan

Source of truth for the autonomous printing acceptance directive (2026-08-30).
Status values: PENDING / IN PROGRESS / VERIFIED / CLOSED / ACCEPTED LIMITATION.

Baseline preserved, not reopened: Finance (outstanding/refund formula fixes),
Reporting (timezone-boundary fixes), Commerce accounting. WhatsApp untouched.

## 0. Existing print architecture (confirmed real, reused — not rebuilt)

- `src/index.css` `@media print` block: `@page { size: A4; margin: 12mm }`,
  a dedicated `@page receipt { size: 80mm auto; margin: 4mm }` selected via
  `.print-target[data-print-size='80mm']`, `visibility: hidden` on
  `body *` with an explicit `.print-target.visible-for-print` escape hatch
  (correctly hides app chrome; handles the two-dialogs-mounted-at-once case).
- `src/features/billing/BillingPage.tsx`: general invoice document (bookings/
  academy/club-membership, since they share `invoices`/`payments`), a
  payment-receipt dialog, a refund-receipt dialog. A4/80mm toggle.
- `src/features/shop/ShopInvoiceDocument.tsx`: Shop A4 invoice + 80mm thermal
  receipt (same component, `data-print-size` branch) and a per-payment
  Shop payment receipt. Conditional club-branding fields (logo/address/
  phone/tax/reg/footer/return-policy) via `get_shop_print_settings`.
- `src/features/shop/reports/shopReportShared.tsx` + `report-print-header.tsx`:
  shared report-print chrome, `fetchFullReport.ts` full-print-with-explicit-
  truncation-warning pattern (already verified correct in the prior
  Reporting Accuracy pass — not re-litigated here).

This is a real, working, non-fragmented foundation. Work here is: find and
close gaps where this architecture is NOT reused, and visually verify
documents that claim to work actually render correctly.

## 1. Print surface inventory & status

| # | Surface | Classification | Status | Notes |
|---|---|---|---|---|
| 1 | Booking/general invoice (A4+80mm) | REQUIRED | VERIFIED | D1 fixed: removed `print:hidden` from Paid row. Live-verified in browser (academy invoice 500 EGP shows Paid 500.00 correctly, no longer print-hidden) |
| 2 | Booking payment receipt | REQUIRED | VERIFIED | Live-verified via same academy invoice test |
| 3 | Booking refund receipt | REQUIRED | VERIFIED | D2 fixed: added "Amount refunded" label + "Remaining outstanding on this invoice" net-effect line (or "fully settled" message). Live-verified: real partial refund (150 of 500 EGP) on QA academy invoice, receipt correctly shows both fields, invoice correctly shows "Partially refunded" + Outstanding 150.00 |
| 4 | Booking QR / entry document | REQUIRED | PENDING | Confirmed present in invoice dialog (line ~928) — needs visual verify |
| 5 | Shop A4 invoice | REQUIRED | VERIFIED (code review) | ShopInvoiceDocument.tsx — needs visual print-preview verify |
| 6 | Shop 80mm POS receipt | REQUIRED | VERIFIED (code review) | Same component, `data-print-size=80mm` — needs visual verify |
| 7 | Shop payment receipt (split-tender) | REQUIRED | PENDING | Needs live split-tender test |
| 8 | Shop return/refund receipt | REQUIRED | PENDING | Not yet located — Shop returns may lack a dedicated receipt |
| 9 | Membership invoice | REQUIRED | PENDING | Routes through BillingPage's generic invoice — needs a membership-specific live test |
| 10 | Membership payment receipt | REQUIRED | PENDING | Same as above |
| 11 | Membership renewal receipt | USEFUL | PENDING | |
| 12 | Academy enrollment invoice | REQUIRED | PENDING | Routes through BillingPage — needs live test |
| 13 | Academy payment receipt | REQUIRED | PENDING | |
| 14 | Expense voucher | REQUIRED | VERIFIED | Confirmed zero print surface existed (grep). Built `ExpenseVoucherDialog.tsx`, widened `list_expenses()` RPC (recorded_by_name, voided_by_name, voided_at, cash_shift_reference — 2 live-caught ambiguous-column bugs fixed before landing). Recorded state: live-verified in browser at 375px, all fields correct, screenshot-confirmed clean layout. Voided state: created + voided a real disposable QA expense via the real RPCs, confirmed `list_expenses()` returns exactly correct status/void_reason/voided_by_name/voided_at — component's voided branch is the same conditional-render pattern already visually proven for the recorded state |
| 15 | Cash shift open/close summary | USEFUL | PENDING | |
| 16 | Employee cash liability settlement receipt | USEFUL | PENDING | |
| 17 | Report printing (all report pages) | REQUIRED | PENDING | Broad — verify representative sample |
| 18 | Filtered/full report printing | REQUIRED | PENDING | Architecture already verified correct in Reporting pass; spot-check post-print-fix regression |
| 19 | Official government collection receipt | REQUIRED (where enabled) | PENDING | `official_collection_receipts` — separate compliance system, verify printability |

## 2. Defects log (fill in as found; REPRODUCE → FIX → VERIFY)

- D1: BillingPage invoice "Paid" amount row is `print:hidden` — printed invoice never shows how much was paid, only Total/Outstanding. Real, visually-verifiable defect.
- D2: BillingPage refund receipt has no "remaining/net financial effect" or clear RETURN/REFUND banner distinct from a normal receipt (directive Section 8 requirement).
- (more added as discovery continues)

## 3. Acceptance matrix (final gate — see directive Section 30)

Not yet evaluated — populated at closure.
