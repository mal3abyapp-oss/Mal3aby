# Printable Document Matrix

| Document | Print mechanism | Status |
|---|---|---|
| Booking invoice | `.print-target` (BillingPage.tsx, pre-existing) | LIVE E2E VERIFIED — line items, totals, verify QR, **booking QR (new this phase)** |
| Academy invoice | Same `.print-target`, same dialog (generic `invoice_items` rendering) | CODE VERIFIED — unmodified, already worked (no booking, so no booking-QR section renders) |
| Club Membership invoice | Same `.print-target`, same dialog | CODE VERIFIED — unmodified, already worked |
| Shop invoice | Same `.print-target`, same dialog | LIVE E2E VERIFIED — a real QA shop sale's `invoice_items` row confirmed: `description = "منتج اختبار الجرد"` (real product name), `reference_type = 'shop_sale_item'` present only as an internal column never rendered (the dialog's markup reads `item.description` only) |
| Payment receipt | Same `.print-target` (BillingPage.tsx refund/payment section) | CODE VERIFIED — pre-existing |
| Refund document | Same `.print-target` (BillingPage.tsx refund receipt dialog) | CODE VERIFIED — pre-existing |
| Public invoice verification card | `VerifyInvoicePage.tsx`, its own centered-card layout (not `.print-target` — this page IS the printable surface, reached via QR/link, not a "print" affordance inside a bigger screen) | CODE VERIFIED — pre-existing |
| Shop Sales / Top Products report | `ReportPrintButton` + `ReportPrintHeader` (new this phase) | CODE VERIFIED, SERVER VERIFIED (underlying RPC data) |
| Revenue (Finance) report | `ReportPrintButton` + `ReportPrintHeader` (new this phase) | CODE VERIFIED, SERVER VERIFIED |
| Booking / Collections / Payment Methods / Academy / Occupancy / Exceptions / Reconciliation / Employee Liability / Official Receipts / Customers reports | Not wired this phase | **NOT BUILT** — deliberate scope decision, identical 2-component pattern available, documented in PRINTING_ARCHITECTURE.md |
| Stock Count report/printout | Not built | NOT BUILT — Stock Count itself was built this closure; a dedicated print view for a completed count session was not, though its data (`get_shop_stock_count_detail`) is already print-capable via the same pattern |
| Movement / Damage / Loss dedicated report tabs | Not built | Deliberately not built — already fully visible as `movement_type` filters on `list_shop_inventory_movements`, per COMMERCIAL_REPORTING_SOURCE_OF_TRUTH.md's earlier scope decision (unchanged this phase) |

## Legend

- **LIVE E2E VERIFIED**: exercised against real/QA data through the
  actual RPC chain, not just read from source.
- **CODE VERIFIED**: read the actual rendering logic and confirmed it
  is generic/correct by construction; not independently re-run this
  phase because it was unmodified (already covered by the pre-existing
  BillingPage.tsx invoice dialog, which predates this session).
- **NOT BUILT**: honestly absent, stated as a scope decision.
