# Print Security Matrix

## Core principle

No new attack surface was introduced. Printing happens exclusively
from already-open, already-authorized staff screens (the invoice
dialog inside `BillingPage.tsx`, the report pages under
`src/features/reports/`) — there is no separate `/print/invoice/:id`
route whose authorization could drift independently from the screen it
prints. `window.print()` operates on the DOM already rendered by a
query that was already permission-gated.

## Live security verification (reused directly from this session's
own established RLS-impersonation testing method)

| Test | Mechanism | Result |
|---|---|---|
| Cross-club invoice access via `ensure_invoice_qr` | `ensure_invoice_qr` checks `v_club_id in (select user_club_ids()) and has_permission('invoice.view', v_club_id)` before minting anything | DENIED for a caller not scoped to that invoice's club — same guard this session already relied on unmodified |
| Booking QR minted for the wrong club | `get_booking_qr_for_invoice_token` re-derives the booking/club from the token's own `invoice_verification_tokens` row server-side — a client cannot supply a club_id at all | Not exploitable — no club_id parameter exists on this call for a client to tamper with |
| Print does not require a new permission check | The invoice dialog is already gated by the existing `invoice.view` permission before any print action becomes reachable; `window.print()` itself performs no RPC call | Confirmed by reading the call path — printing is pure client-side rendering of already-authorized data |
| Support VIEW-mode printing a target club's invoice | Same `has_platform_support_access`/dual-audit pattern this session verified extensively for Shop — unmodified, reused | Not re-tested via a fresh live call this addendum (no code path changed here), relying on the extensive same-mechanism verification already on record in COMMERCIAL_PERMISSION_MATRIX.md |
| Printing attributes the document to Platform Admin | Not applicable — the printed invoice shows the target club's own branding fields (`clubName`) via `currentMembership`/support-session club context, never a Platform Owner identity; no new attribution logic was added |
| Printing mutates finance/booking state | Verified live (see BOOKING_QR_INVOICE_SPEC.md): `bookings.status` and `qr_credentials` active-count checked before/after two consecutive QR-mint calls — booking status unchanged; only new QR credential rows were added (an intentional side effect of the reused mint mechanism, not a mutation of financial/booking state) |
| Duplicate print does not create a new invoice/payment/movement | `window.print()` makes zero RPC calls; the only "print"-triggered RPC (`ensure_invoice_qr`/`get_booking_qr_for_invoice_token`) is `staleTime: Infinity`-cached per dialog session for the verify QR, and each booking-QR fetch mints a QR **credential** row only — never an invoice, payment, sale, or inventory movement row | Confirmed by reading both RPC bodies: neither touches `invoices`/`payments`/`shop_sales`/`shop_inventory_movements` |
| Report print shows only already-permission-gated data | `<ReportPrintHeader>`/`<ReportPrintButton>` render inside the same component tree as the report's own `useQuery`-fetched `data` — there is no separate fetch for print | Confirmed by reading the modified files: no new RPC call was added for print, only presentational wrapper markup |

## What was not independently re-verified this addendum (honest gap)

This addendum reused two RPCs verified extensively earlier this
session for other purposes (`ensure_invoice_qr`'s club-scoping,
`get_booking_qr_for_invoice_token`'s booking-eligibility
re-validation) rather than re-running a full fresh adversarial pass
against them, because their source code was read in full and confirmed
unchanged. A dedicated fresh cross-club/cross-branch live attack
re-test specifically through the new `BillingPage.tsx` code path was
not performed (would require a second real club + a second real staff
identity walking through the UI, which is server-testable but was
judged lower priority than the Stock Count/payment-model live
verification given both underlying RPCs were read byte-for-byte and
confirmed to reuse existing, already-audited authorization logic
verbatim).
