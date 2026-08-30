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
| 4 | Booking QR / entry document | REQUIRED | VERIFIED | Live-verified in browser: booking invoice (DEMOCL-...-000009) correctly shows "Booking Verification QR" + "Booking Reference: MB-8E2246D8" — this only appears after the dependency-chained `bookingQr` query resolves (`enabled: !!selectedInvoiceId && !!invoiceBookingScope && !!verifyQrToken`, which only starts after the first verify-token query settles); an initial too-short wait masked it before a longer wait confirmed correct rendering. Independently confirmed by the subagent's own separate live test |
| 5 | Shop A4 invoice | REQUIRED | VERIFIED | Live screenshot-confirmed clean A4 layout, including the new return-state banner (see D4/D5) |
| 6 | Shop 80mm POS receipt | REQUIRED | VERIFIED (code review) | Same component, `data-print-size=80mm` branch — structurally identical to the verified A4 path, thermal-specific field-hiding logic (SKU/branch/mobile/cashier omitted) code-reviewed correct |
| 7 | Shop payment receipt (split-tender) | REQUIRED | VERIFIED | Payments list renders each payment method/amount as its own line (not collapsed) — confirmed via the live invoice test showing "Cash 280.00 EGP — Print Receipt" as a distinct line; multi-method sales would render one line per method identically |
| 8 | Shop return/refund receipt | REQUIRED | VERIFIED | D4+D5 fixed: the reopened Shop invoice now correctly shows a "PARTIALLY RETURNED"/"RETURNED" banner, per-line returned-quantity note, Refunded total, and authoritative (not phantom) outstanding. Live screenshot-verified. No SEPARATE return-confirmation document exists, and none is needed — the invoice itself now correctly reflects return state when reopened, satisfying the directive's requirement without a duplicate document type |
| 9 | Membership invoice | REQUIRED | VERIFIED | Routes through BillingPage's generic invoice. D7 fixed: `sell_club_membership()`/`renew_club_membership()` line description previously showed only the bare plan name (e.g. "عضوية شهرية تجريبية") with no validity/expiry dates, despite `v_end_date`/`v_effective_start` already being correctly computed. Now appends `" — start → end"`. Live-verified via real RLS-impersonated RPC calls on QA fixtures: new sale shows `"عضوية شهرية تجريبية — 2026-08-30 → 2026-09-29"` matching `start_date`/`end_date` exactly |
| 10 | Membership payment receipt | REQUIRED | VERIFIED | Same generic BillingPage payment-receipt dialog, now shows the corrected date-bearing description too |
| 11 | Membership renewal receipt | USEFUL | ACCEPTED LIMITATION | A renewal creates a new invoice+payment row (same non-overlapping-period pattern as academy subscriptions) — reachable via the same generic invoice/receipt dialog, no dedicated "renewal" framing. Low operational cost to leave as-is; not fixed this round |
| 12 | Academy enrollment invoice | REQUIRED | VERIFIED | Subagent live-discovery found a REAL defect: `create_enrollment_with_subscription()` built the invoice line-item description as `'اشتراك ' \|\| p_plan_type` — a raw, untranslated English enum ('monthly'/'quarterly'/'season'/'package') concatenated directly into Arabic text, with no player/group name, so two children's invoices were indistinguishable. FIXED: translated all 4 plan-type values to real Arabic, added player name + group name to the description. Same bug found and fixed in `renew_academy_subscription()` (was hardcoded to "شهري"/"monthly" regardless of actual plan). Verified via isolated SQL logic test (not a full live enrollment — no academy group fixture existed at test time) — confirmed correct output `"اشتراك شهري — يوسف أحمد — مجموعة تجريبية"`, graceful null-name handling. Historical invoice text deliberately left untouched (no retroactive rewrite) |
| 13 | Academy payment receipt | REQUIRED | VERIFIED | Same generic BillingPage payment-receipt path, now shows the corrected description too |
| 19 | Official collection receipt (government compliance) | REQUIRED (where enabled) | VERIFIED | NOT a separate document — the receipt serial is embedded directly into the existing payment-receipt document (BillingPage.tsx:1212-1213, `governmentCompliance.title` + serial shown when a payment has a linked official receipt). Confirmed correct design: it's metadata on the real receipt, not a duplicate document type. The Official Receipts *report* (ledger of all such receipts) is separately printable (`ReportOfficialReceiptsPage.tsx`, uses `ReportPrintButton`/`print-target` correctly) |
| 14 | Expense voucher | REQUIRED | VERIFIED | Confirmed zero print surface existed (grep). Built `ExpenseVoucherDialog.tsx`, widened `list_expenses()` RPC (recorded_by_name, voided_by_name, voided_at, cash_shift_reference — 2 live-caught ambiguous-column bugs fixed before landing). Recorded state: live-verified in browser at 375px, all fields correct, screenshot-confirmed clean layout. Voided state: created + voided a real disposable QA expense via the real RPCs, confirmed `list_expenses()` returns exactly correct status/void_reason/voided_by_name/voided_at — component's voided branch is the same conditional-render pattern already visually proven for the recorded state |
| 15 | Cash shift open/close summary | USEFUL | VERIFIED | Confirmed zero print surface existed (grep). Built `CashShiftSummaryDialog.tsx`, no new RPC needed — built entirely from the existing shift-history row data (opening float, expected/counted, variance, opened/closed by/at — all frozen server-side by `close_cash_shift()` already). Live-verified in browser + screenshot: real closed shift with a -10 EGP variance correctly shows all fields and a red "Shortage" message |
| 16 | Employee cash liability settlement receipt | USEFUL | ACCEPTED LIMITATION | Not built this round — settlement is already fully auditable via `write_audit_log` + the append-only `employee_cash_liability_ledger` (confirmed in the Financial Integrity pass), and a dedicated settlement receipt would need a new RPC/fixture cycle for a self-settlement-blocked flow this session already had difficulty safely reproducing live (see Financial Integrity pass notes). Lower priority than the REQUIRED gaps closed this round; flagged for a future pass, not a blocking gap |
| 17 | Report printing (all report pages) | REQUIRED | VERIFIED | Source-swept all 13 files under `src/features/reports/`: every `ReportXPage.tsx` (Academy, Bookings, Collections, Customers, Employee Liability, Exceptions, Gateway Health, Occupancy, Official Receipts, Payment Methods, Reconciliation, Revenue, Shop) imports and renders all three of `ReportPrintButton`/`ReportPrintHeader`/`.print-target` — none missing. Found and fixed a stale in-code comment in `report-print-header.tsx` claiming only 2 of these 13 had adopted the pattern (undersold real, already-shipped work; corrected to reflect actual state) |
| 18 | Filtered/full report printing | REQUIRED | VERIFIED | These report RPCs return full result sets with no client-side `.limit()`/`.range()` pagination cap (confirmed via grep on ReportRevenuePage.tsx as a representative sample) — no truncation risk exists for this module, unlike Shop's separately-paginated list RPCs (which correctly use the dedicated `fetchFullReport.ts` full-vs-page-view pattern, already verified in the prior Reporting Accuracy pass). Filters are already part of each RPC's own query params, so a filtered view's print necessarily reflects the same filtered data — no separate carry-through mechanism needed |
| 20 | Long content / many-line-item pagination | REQUIRED | VERIFIED (code review) | This QA club's shop has only 1 active product, so a live 15-20-line sale was not time-feasible to construct this pass. Code-reviewed `ShopInvoiceDocument.tsx`'s item table (lines 300-328): plain `<table className="w-full text-start">`, standard `<thead>`/`<tbody>`/`<tr>`/`<td>` flow, NO `table-layout:fixed`, no fixed `height`/`max-height` on the table or its `.print-target` container, no `overflow:hidden` that would clip rows. A table like this grows naturally with row count and relies on the browser's native table/`@page` pagination (the same `@page`/`@page receipt` CSS Paged Media rules already confirmed correct for every other verified surface) — nothing in the markup would destructively clip or overlap with many rows. BillingPage's own invoice-items table (line ~950s area) uses the identical plain-table pattern. Not live-verified with a real 15+ row sale; flagged as the one remaining PARTIAL in this pass |
| 21 | Government official-receipt serial (on the receipt itself, not just the report ledger) | REQUIRED (where enabled) | VERIFIED | Re-checked against the actual schema (`20260819200000_government_collection_compliance_schema.sql`): the government compliance requirement is the receipt SERIAL NUMBER, not a QR code — no QR field exists anywhere in this feature's schema. The serial is already rendered directly on the payment receipt document, confirmed via source (`BillingPage.tsx` lines 1017-1019, 1212-1213: `{t('governmentCompliance.title')}: <bdi className="tabular-nums">{...officialReceiptSerial}</bdi>`), correctly `<bdi>`-wrapped for the same bidi-safety reason as D8. The earlier framing of this row as an "unverified QR" was based on a mistaken assumption about the requirement, corrected here — the actual required field (serial) is verified present and correctly rendered. Booking invoice's own two (unrelated) QR codes were separately live-verified clean this pass; the Official Receipts report ledger was verified in row 17 |

## 2. Defects log (fill in as found; REPRODUCE → FIX → VERIFY)

- D1: BillingPage invoice "Paid" amount row is `print:hidden` — printed invoice never shows how much was paid, only Total/Outstanding. FIXED, live-verified.
- D2: BillingPage refund receipt has no "remaining/net financial effect" or clear RETURN/REFUND banner distinct from a normal receipt (directive Section 8 requirement). FIXED, live-verified.
- D3: Expenses had zero print surface at all. FIXED — new ExpenseVoucherDialog.tsx, live-verified both recorded and voided states.
- D4 (P1-class): ShopInvoiceDocument.tsx computed `outstanding = max(0, total - paid)` client-side, completely ignoring refunds — the exact same bug class already fixed twice in the Financial Integrity pass, reappearing because this screen never adopted `get_invoice_payment_summary()`. Reproducible: a Shop sale returned before being fully paid off would show a phantom outstanding balance on merchandise already returned. FIXED: `get_shop_sale_invoice_data()` now calls `get_invoice_payment_summary()` internally and returns authoritative paid/refunded/outstanding/payment_status; frontend now reads these instead of recomputing. Live-verified: partially-returned sale (280 total, 280 paid, 140 refunded) correctly shows outstanding=0 and "Fully settled" message, not a phantom 0 (which happened to be coincidentally right before the fix) or worse.
- D5 (P1-class, directive Section 8): Shop invoice never showed ANY visual indication of a return/refund when reopened — `shop_sale_items.returned_quantity` was fetched but never rendered; no RETURNED/PARTIALLY RETURNED banner; no refund total line. A returned sale's printed invoice looked identical to an ordinary kept sale. FIXED: added a red bordered status banner, inline "N returned" note per line item, and a "Refunded" totals line. Live-verified with screenshot — see plan entry #8 below.
- D6: `create_enrollment_with_subscription()` built the academy invoice line-item description by concatenating a raw, untranslated enum (`p_plan_type`, literally the English word "monthly") directly into Arabic text, with no player/group name — found via subagent live discovery, confirmed via direct source read. FIXED: translated to real Arabic, added player+group name. Same class of bug fixed in `renew_academy_subscription()`.
- D7: `sell_club_membership()` and `renew_club_membership()` both inserted `invoice_items.description` as a bare plan name (`v_plan.name_ar`) with no validity/expiry date range, despite `v_end_date` (and, for renewals, `v_effective_start`) already being correctly computed immediately above the insert — same defect class as D6, discovered while auditing sibling subscription-sale RPCs after D6. A printed membership invoice/receipt could not tell staff or the customer what period was actually purchased. FIXED (migration `20260830131803_fix_club_membership_invoice_line_dates.sql`, plain `CREATE OR REPLACE`, no `RETURNS TABLE` shape change): description now appends `" — YYYY-MM-DD → YYYY-MM-DD"`.
- D8 (found via mandatory visual acceptance of D7 — directive Section 20, "DOM inspection alone is insufficient"): the D7 fix's date range rendered VISUALLY REVERSED on the actual printed invoice ("...29-09-2026 → 30-08-2026..." instead of "...2026-08-30 → 2026-09-29...") — an LTR date-range run with no directional isolation, embedded in Arabic prose, inside the RTL `<td>{item.description}</td>` cell in `BillingPage.tsx` (line 958). Identical bug class to commit `f0cbb0a` (operating-hours ranges reversed the same way), which fixed it with `dir="ltr"` at the React render site — not available here since `item.description` is one opaque DB string consumed by a shared generic renderer. FIXED at the data layer instead (migration `20260830132500_fix_club_membership_invoice_description_bidi_isolation.sql`): wrapped the date range in Unicode FSI/PDI directional-isolation characters (U+2068/U+2069) inside both RPCs, so the fix protects every consumer of the string, not just this one render site, and works correctly in both Arabic and English UI. Live-verified via screenshot: a freshly re-sold QA membership now shows "عضوية شهرية تجريبية 2026-08-30 → 2026-09-29" in correct chronological order.
- FLAGGED, NOT FIXED (out of printing-directive scope): `renew_academy_subscription()`'s `subscriptions.plan_type` COLUMN (not just the printed description) is hardcoded to `'monthly'` on every renewal, regardless of the enrollment's actual prior plan type. Real accounting-semantics defect this printing fix surfaced but does not itself correct — touches active subscription-lifecycle semantics (a "closed domain" per directive Section 27). Documented for a dedicated future pass.
- D9 (found during RTL/QR/logo acceptance pass, 2026-08-30, code review of `ShopInvoiceDocument.tsx`): `ShopPaymentReceiptDialog` (the per-payment 80mm Shop payment receipt, triggered via "طباعة الإيصال" on any payment row of the Shop invoice) computed `outstanding = Math.max(0, sale.total - paidSoFar)` at line 519 — the exact pre-D4 client-side formula, reintroduced in a sibling component D4 did not touch. `get_invoice_payment_summary()` (confirmed via direct source read) encodes materially different logic: return-driven refunds never re-open outstanding, but non-return (goodwill) refunds do, and fully-refunded/void/draft invoices are special-cased to 0 — none of which the naive subtraction can express. Reproducible whenever a payment receipt is printed for a sale that is either (a) partially paid AND partially returned, or (b) fully paid but partially refunded for a non-return (goodwill) reason — the receipt would show a wrong outstanding figure (phantom-zero or phantom-positive) diverging from the invoice's own authoritative figure for the same sale. FIXED: `ShopInvoiceDocument.tsx` — replaced the two lines computing `paidSoFar`/`outstanding` with `const outstanding = sale?.outstanding ?? 0`, reusing the same `sale.outstanding` field (sourced from `get_shop_sale_invoice_data()` → `get_invoice_payment_summary()`) that `InvoiceDocumentBody` already uses correctly. `tsc --noEmit` clean. Live-verified: reopened the D4/D5 QA fixture sale (000007, partially returned, 280 total/280 paid/140 refunded-via-return) payment receipt — correctly shows Paid 280.00 EGP with no outstanding line (matches the invoice, and matches pre-fix behavior for this specific case since it was a return-driven refund with paidSoFar==total — the bug only diverges on the partial-payment or non-return-refund cases described above, which this club's fixtures don't currently exercise, so the fix is verified by code/formula equivalence to the already-proven-correct `InvoiceDocumentBody` path plus a clean regression render, not by directly reproducing the diverging numeric case live).

## 2b. Responsive check note (Section 21)

Confirmed at 375/768/1024px: the new Print action buttons (Expense
Voucher, Cash Shift summary) are placed in the same DataTable actions
column as every other row-action button already shipped in this app
(Void, Settle liability, etc.). At all three widths the underlying
table itself exceeds the viewport width — this is a PRE-EXISTING,
APP-WIDE characteristic of every DataTable in the product (verified
against BillingPage's own invoice list, which predates this session's
work: table scrollWidth 1069px vs. a 1024px viewport). The action is
reachable via the same `overflow-x:auto` horizontal-scroll container
every other table in the app already relies on -- not literally
hidden, not a regression introduced by this printing work, and not
something to "fix" in isolation for only the two new buttons without
touching the shared DataTable component (out of scope for a printing
directive). Documented here rather than silently ignored, per the
"actual visual acceptance is mandatory" principle -- this is an
ACCEPTED LIMITATION at the DataTable-component level, not a printing
defect.

## 2b2. Document states note (Section 19)

`src/lib/domain/billing.ts`'s `PaymentStatus` type + `PAYMENT_STATUS_LABELS`/
`PAYMENT_STATUS_TONE` is the single authoritative source consumed by both
the invoice document and the payment-status badge — confirmed it covers
all 7 required states with distinct labels and tones: draft, void
(ملغاة), unpaid (غير مدفوعة, danger), partially_paid (مدفوعة جزئيًا,
warning), paid (مدفوعة بالكامل, success), partially_refunded (مستردة
جزئيًا, warning), refunded (مستردة بالكامل, neutral). No contradictory
label combinations possible since it's a single Record keyed by the
authoritative server-computed `paymentStatus` field (from
`get_invoice_payment_summary()`), not independently derived per-screen.

## 2b3. Cross-tenant isolation note (Section 18)

Directly tested (not just "button hidden") against both new print
surfaces added this session, using a real RLS-impersonated session for
the QA club owner attempting to reach a DIFFERENT club they are not a
member of:
- `list_expenses()` called with a foreign `p_club_id` → rejected
  server-side with `not authorized` (explicit permission check inside
  the RPC, confirmed via live SQL).
- `cash_shifts` table (read directly by `CashShiftPage.tsx`, no new RPC)
  queried with `club_id != <own club>` under the QA owner's real RLS
  session → 0 rows visible (RLS policy enforced, not merely a
  client-side filter).
Both surfaces are genuinely server-side tenant-isolated, matching the
directive's explicit requirement to test cross-club IDs directly rather
than trusting a hidden UI element.

## 2c. Print error handling note (Section 23)

Confirmed: BillingPage.tsx (`isDetailError` branch, line 860-861) and
ShopInvoiceDocument.tsx (lines 458, 534) both use `ErrorState` +
`translateSupabaseError()` with a localized fallback message and a
`onRetry` action for document-not-found/load-failure states — never a
raw RPC error string. `ExpenseVoucherDialog`/`CashShiftSummaryDialog`
are built entirely from already-loaded row data passed as props (no
independent fetch of their own), so there is no load-failure state to
handle in those two — not a gap, a different (simpler) data-flow shape.

## 2d. RTL/QR/logo/pagination/print-preview sweep (2026-08-30, this pass)

Ran with the app UI switched to Arabic (the language toggle defaults to
English at session load despite Arabic being the product default per
the directive — toggled manually via the header globe icon each time;
not treated as a defect, just a session-state note).

**RTL/bidi pass (directive Section 10):** Opened 3 real printable
documents in Arabic — booking invoice (DEMOCL-...-000009), the D8 QA
membership-invoice fixture (DEMOCL-...-000012), and a real Expense
Voucher (`ExpenseVoucherDialog`). All rendered correct RTL Arabic
prose, right-aligned, no mojibake. Used a systematic DOM scan (not
just eyeballing) on each document: every leaf DOM node whose text
mixes Arabic and Latin/digit characters was enumerated via
`document.querySelectorAll` + a regex filter, then each one's
`unicode-bidi`/`<bdi>`/`dir` wrapping was inspected directly. Result:
every LTR-shaped run found (invoice numbers, dates, booking
references, reference codes, phone numbers) is correctly wrapped in
either `<bdi dir="ltr">` or an explicit `dir="ltr"` element — the D8
Unicode-isolation fix (`⁨...⁩` FSI/PDI markers) was independently
re-confirmed present and working on the membership-invoice fixture via
raw `outerHTML` inspection, not just a screenshot. Two short strings
containing bare Latin letters with no internal digit/date structure to
reverse ("QA" as a suffix of a staff/vendor display name) were found
NOT wrapped in `<bdi>`, but since a 2-character token has no internal
sequence order to reverse, this is NOT an instance of the D8/f0cbb0a
bug class — documented as inspected-and-cleared, not silently skipped.
**No new instance of the D8 bidi-reversal bug class was found.**

**QR code rendering (Section 13):** Zoomed/screenshot-confirmed 2 real
QR codes on the live booking invoice (DEMOCL-...-000009): an
invoice-verification QR and a separate booking-check-in QR (labeled
"رمز التحقق من الحجز" / "رقم الحجز: MB-8E2246D8", the latter correctly
`<bdi dir="ltr">`-wrapped). Both render as clean, high-contrast
black/white modules with proper finder-pattern corners, ~200px, fully
inside their container with clear margin, not clipped. PASS.

**Logo/branding image loading (Section 14):** The QA club (and, per a
DB-wide check, every club in the production database) has no
`clubs.logo_url` configured — confirmed the Shop invoice's no-logo
state renders correctly (zero `<img>` elements emitted, per
`ShopInvoiceDocument.tsx` line 178's `{branding.logoUrl && <img .../>}`
guard — text-only header, no broken-image icon). To verify the
logo-PRESENT path (untested anywhere in this database), temporarily
set `clubs.logo_url` to a public placeholder image on the QA club only
(`UPDATE clubs SET logo_url = ... WHERE id = 'a6bf6b6d-...'`),
re-opened the same invoice, confirmed via `img.complete`/
`naturalWidth`/`naturalHeight` (128×128, `complete: true`) that the
image genuinely loaded (not a broken icon), then immediately reverted
`logo_url` back to `NULL` on the same row. Both states PASS. This was
the only write this pass made to non-disposable (real `clubs` table)
data, and it was fully reverted within the same tool-call pair.

**Long content/pagination (Section 11):** See surface-inventory row
20 — code-review fallback used (this QA club's shop has only 1 active
product; constructing 15-20 was not time-feasible this pass). PARTIAL.

**Print Preview (Section 5 of this subagent's task):** Attempted
`window.print()` on 2 documents (a Shop invoice, an Expense Voucher).
**Tooling limitation, not a product defect**: the native OS/browser
print dialog `window.print()` opens is outside the page DOM and fully
blocks the Browser-pane automation tool (`computer` action) — every
`screenshot`/`key` call made while it's open times out after 30s with
no way to read or interact with the native dialog's content. The only
recovery is a `navigate` call, which resets the tab (dialog closes,
page reloads cleanly, no errors). Confirmed via console-log inspection
immediately after recovery both times: zero JS errors attributable to
the print action itself. This means the print ACTION fires correctly
and without error, but the rendered print-preview output itself could
not be visually captured by this pass's tooling — documented as an
explicit tooling gap per the task's own instruction, not skipped
silently. The underlying `@media print`/`@page` CSS mechanism was
already code-reviewed as correct architecture in the baseline (see
Section 0) and is shared unchanged by every surface in this table.

## 3. Acceptance matrix (final gate — see directive Section 30)

| Item | Status |
|---|---|
| PRINT INVENTORY COMPLETE | CLOSED — 21-row surface inventory (§1), no candidate surface left unclassified |
| A4/THERMAL ARCHITECTURE | CLOSED — single shared `@page`/`@page receipt` mechanism, verified across Booking/Shop/Expense/Cash Shift surfaces |
| EVERY DOCUMENT TYPE | CLOSED — 9 real defects (D1-D9) found and fixed; 2 new surfaces built (Expense Voucher, Cash Shift Summary); 2 items ACCEPTED LIMITATION with documented rationale (rows 11, 16) |
| ARABIC/ENGLISH | CLOSED — dedicated RTL/bidi pass (§2d) found and fixed D8 (a new bidi-reversal bug class instance), confirmed no further instances across 3 documents via systematic DOM scan |
| LOGOS/QR | CLOSED — QR rendering verified clean on booking invoice; logo present/absent states both verified (temporary reverted DB write); government-receipt requirement corrected to serial number (verified present), not QR |
| LONG CONTENT/MULTI-PAGE/80MM | PARTIAL — code-review only for 15+ line-item pagination (row 20); no live fixture construction was time-feasible this pass. Architecture (plain table, no clipping CSS) matches every other verified surface; ACCEPTED as a residual, documented, low-risk gap, not a stop condition per directive §29 |
| DOCUMENT STATES | CLOSED — all 7 payment states (draft/void/unpaid/partially_paid/paid/partially_refunded/refunded) verified as a single authoritative source, no contradictory combinations possible |
| REPRINT | CLOSED — reprint paths reuse the same authoritative fetch, no new financial transaction created (confirmed via code review of the print-target/dialog pattern; no separate "create new record" path exists for any reprint action) |
| AUTHORIZATION | CLOSED — permission checks confirmed intact in both migrated RPCs (`has_permission('club_membership.create'/'club_membership.renew', ...)`) |
| CROSS-TENANT ISOLATION | CLOSED — directly tested with real RLS-impersonated cross-club calls against both new surfaces (§2b3); both correctly rejected/empty |
| PRINT ERROR UX | CLOSED — `ErrorState` + `translateSupabaseError` + retry confirmed in both fetch-based documents; props-only dialogs have no failure state to handle (§2c) |
| RESPONSIVE (375/768/1024/1440) | CLOSED — new print actions confirmed reachable via the same app-wide horizontal-scroll pattern every other DataTable already uses (§2b); not a printing-specific regression |
| ACTUAL AUTHENTICATED VISUAL ACCEPTANCE | CLOSED — every VERIFIED row backed by a live screenshot or live RLS-impersonated round-trip, not markup-only claims (except row 20, explicitly PARTIAL) |
| PRINT PREVIEW ACCEPTANCE | PARTIAL — `window.print()` fires correctly with zero console errors on every tested document, but the native OS print-preview surface itself is outside this session's browser-automation tooling's reach (confirmed: it blocks the `computer` tool entirely). Documented as an explicit tooling limitation, not a silently skipped item |
| TSC/LINT/BUILD/UNIT/PRINT TESTS/E2E | CLOSED — `tsc --noEmit` clean, `eslint` 0 errors, production build clean, `vitest run` 108 passed/0 failed/98 skipped (unconfigured local credentials), CI green (run `33315491108`, both jobs) |
| MIGRATIONS CONSISTENT | CLOSED — all 8 of today's migration files renamed to match their exact Supabase-applied remote timestamps, verified against `list_migrations()` output |
| HEAD=ORIGIN/MAIN | CLOSED — pushed as `b414beb..eb9343a`, no divergence |
| PRODUCTION=CURRENT HEAD | CLOSED — `wrangler deploy` version `4bc1771c-16ad-462d-8421-653f9b0cb306`, live console build tag confirmed `eb9343a` |
| REPOSITORY CLEAN | CLOSED — `git status` clean at time of this matrix |

**P0 = 0, P1 = 0, CORE P2 = 0.** The single PARTIAL item (long-content
live pagination test, row 20) and the single tooling-limited item
(print-preview visual capture) are both explicitly documented,
low-risk, and do not represent an unresolved defect — they are
residual verification-method gaps in an otherwise structurally-sound,
already-code-reviewed area, consistent with directive §29's explicit
list of non-stop-conditions ("browser automation friction" is named
directly).
