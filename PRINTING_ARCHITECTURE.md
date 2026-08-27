# Printing & Document Output — Architecture

## What already existed (discovered, not rebuilt)

Before this phase, `BillingPage.tsx` already had a working, shipped
print mechanism for invoices and refund receipts:

- **CSS** (`src/index.css`): a class-based print-isolation trick —
  `.print-target.visible-for-print` is the only element made visible
  under `@media print` (`body * { visibility: hidden }`, then the
  target and its children are un-hidden and repositioned to the page
  origin). `@page { size: A4; margin: 12mm }` by default;
  `[data-print-size='80mm']` switches to a named `@page receipt { size:
  80mm auto }` for POS-style receipt printing.
- **Trigger**: a plain `window.print()` button, no PDF library
  involved — the browser's native print/save-as-PDF dialog handles
  output. No `jspdf`/`pdfmake`/`html2canvas`/etc is installed, and none
  was added this phase (Section 10's own instruction: reuse browser
  print-to-PDF, don't add a paid/new backend).
- **QR**: the `qrcode` npm package (`QRCode.toDataURL()`) generates a
  QR image client-side from a raw token already minted server-side;
  the shared `<QrCodeViewer>` component displays it (click-to-fullscreen)
  on the public verification pages. The printable invoice embeds the
  QR image directly inline (no fullscreen dialog needed in print
  context).
- **Invoice QR**: `ensure_invoice_qr(invoice_id)` mints a public
  verification token (`/verify/:token`, anon-reachable, no login) shown
  on every printed invoice regardless of type.

This phase did **not** rebuild any of this. It extended it.

## What this phase added

1. **Booking QR on the printed invoice** (the one genuine gap against
   the mandate — see BOOKING_QR_INVOICE_SPEC.md). `BillingPage.tsx`'s
   print target now also renders the booking-specific attendance QR
   for Field Booking invoices, reusing `get_booking_qr_for_invoice_token`
   — the exact RPC `VerifyInvoicePage.tsx` already used successfully —
   fed the same invoice verification token already minted for the
   "verify" QR (one round-trip chain, not a second minting path).
2. **Shared report-print primitives**: `src/components/ui/report-print-header.tsx`
   exports `<ReportPrintButton>` (a `window.print()` button, hidden on
   print itself) and `<ReportPrintHeader>` (report name, club, filter
   summary, generated-at timestamp — shown ONLY under `@media print`,
   via `hidden print:block`, so it never clutters the screen view).
   Both reuse the exact same `.print-target`/`visible-for-print`
   convention — no new print CSS was written.
3. **Wired into two representative reports** (Revenue/Finance and
   Shop/Commercial) as proof the pattern generalizes cleanly to any
   report page with zero additional CSS.

## Why "print is presentation only" holds structurally

- Invoice printing renders `invoice_items`/`invoices` rows already
  fetched for on-screen display (`fetchInvoiceDetail` in
  `BillingPage.tsx`) — the same query populates both the screen dialog
  and the print target inside it. There is no second fetch, no
  recomputation.
- Report printing renders the exact same `data` object already used
  for the on-screen cards/lists/tables — `<ReportPrintHeader>` adds
  metadata only (name/club/filters/timestamp), never a number.
- The booking QR shown on a printed invoice is minted by the same
  server RPC (`get_booking_qr_for_invoice_token`) that already backs
  the public Secure Booking Page's QR — one credential-issuance path,
  multiple surfaces that trigger it.

## Deliberate scope decisions (stated, not silently dropped)

- **Report print coverage**: wired into 2 of ~12 report pages
  (Revenue, Shop) as the representative implementation. The remaining
  report pages (Bookings, Collections, Payment Methods, Academy,
  Occupancy, Exceptions, Reconciliation, Employee Liability, Official
  Receipts, Customers) were not individually wired this session — each
  can adopt the identical two-component pattern with zero new CSS,
  documented here as follow-up work, not a defect.
- **Academy/Membership/Shop invoice unification**: already true by
  construction, not built this phase — `BillingPage.tsx`'s invoice
  detail dialog renders any `invoices`/`invoice_items` row generically
  regardless of source (`reference_type` = booking, subscription,
  club_membership, or shop_sale_item all render through the identical
  markup, since `invoice_items.description`/`quantity`/`unit_price`/
  `line_total` is the same shape for all four). No per-type visual
  system was ever built, so there was nothing to unify.
- **Standalone `/print/invoice/:id` routes**: not built. Printing
  happens from within the authenticated invoice/report screens
  themselves (an already-open, already-authorized dialog/page), which
  is simpler and avoids the exact cross-tenant "print URL as a bypass"
  risk Section 36 warns against — there is no separate route whose
  authorization could drift from the screen it's printed from.
- **PDF generation library**: deliberately not added (Section 10's own
  instruction). Browser print-to-PDF via the existing mechanism is
  judged sufficient.
- **Page numbering for multi-page reports**: not implemented — browser
  print natively provides page breaks but not an in-content "Page X/Y"
  counter without a PDF library. Investigated and consciously deferred
  (Section 30 permits this: "do not block release if browser
  limitations make total-page count impractical").

See PRINTABLE_DOCUMENT_MATRIX.md for the full per-document-type status
table, BOOKING_QR_INVOICE_SPEC.md for the QR flow in detail, and
PRINT_SECURITY_MATRIX.md for the security verification.
