# Booking QR on the Printed Invoice — Spec & Verification

## Requirement

The printed Field Booking invoice must contain the canonical booking
QR — mandatory, not optional (directive Section 11).

## Mechanism (reused, not new)

```
BillingPage.tsx invoice dialog opens
  -> ensure_invoice_qr(invoice_id)              [existing RPC, unchanged]
       -> mints an invoice_verification_tokens row, returns raw token
  -> get_booking_qr_for_invoice_token(raw_token)  [existing RPC, unchanged]
       -> looks up the invoice via the token, finds its linked booking
       -> re-validates booking status server-side (cancelled / checked_in /
          not pending_payment|confirmed) on EVERY call
       -> if eligible: mints a fresh single-use qr_credentials row
          (type='booking'), returns its raw token + booking_ref/field_name/
          start_at/end_at/timezone/status
  -> QRCode.toDataURL(raw_token) -> <img>, rendered inline in the print target
```

Both RPCs already existed and were already used successfully by
`VerifyInvoicePage.tsx` (the public verification page) before this
phase. This phase's only change: the same second call
(`get_booking_qr_for_invoice_token`) is now also made from
`BillingPage.tsx`'s staff-facing invoice dialog, using the token that
dialog already mints for the "verify" QR — not a new credential path.

## Live verification (LIVE E2E VERIFIED, real production booking)

Using a real confirmed booking (`09575ad2-...`, club "Test") with a
linked invoice, impersonating that club's real owner:

1. `ensure_invoice_qr('4d21c55b-...')` → raw verify token (64-char hex).
2. `get_booking_qr_for_invoice_token(<that token>)` → `status='active'`,
   `raw_token` (a second, independent 64-char hex), `booking_ref='MB-09575AD2'`,
   correct `field_name`/`start_at`/`end_at`/`timezone`/`booking_status='confirmed'`.
3. Called the exact same RPC a second time (simulating a reprint) →
   `status='active'` again, a **different** fresh `raw_token`.
4. Queried `qr_credentials` directly: went from 2 → 3 active `type='booking'`
   rows for that booking between steps 2 and 3 — confirming the first
   credential was **not** revoked by the reprint (Section 45/69's "print
   is idempotent presentation, never invalidates a prior QR" — verified,
   not assumed).
5. Confirmed `bookings.status` unchanged (`confirmed`, before and after)
   — printing/reprinting never mutates booking state.
6. Token payload inspected: a 64-character hex string derived from
   `gen_random_bytes(32)` — opaque, contains no name/phone/email/price/
   any customer data (Section 12/76).

## Honest note on the existing design (not changed this phase)

Each `get_booking_qr_for_invoice_token` call mints a genuinely new
`single_use = true` credential and does **not** revoke previously
minted ones for the same booking. This means multiple valid QR
credentials can coexist for one booking (e.g. if the invoice is
printed three times, three independently-valid QR codes exist until
each is either scanned once or naturally expires at `end_at + 2
hours`). This is the pre-existing, already-shipped design (confirmed
via a migration named `stop_qr_credential_revocation_on_remint` in the
project's own migration history, predating this session) — not a new
decision made this phase, and not something this closure redesigned.
It correctly satisfies "reprinting does not invalidate the previous
QR," at the cost of allowing more than one physical copy to be
independently scannable. Documented here for transparency, not
silently relied upon.

## What the printed invoice shows next to the QR (Section 16)

`billing.detail.bookingQrLabel` ("Booking Verification QR" / "رمز
التحقق من الحجز") plus the human-readable `booking_ref` (e.g.
`MB-09575AD2`) is always rendered alongside the QR image — the QR is
never the sole way to identify the booking on the printed page.

## Non-eligible states handled

`get_booking_qr_for_invoice_token` returns a non-`'active'` status for:
`invalid_invoice_token`, `not_a_booking_invoice`, `booking_cancelled`,
`already_checked_in`, `booking_not_eligible`. `BillingPage.tsx` shows a
`print:hidden` warning line for any non-active status rather than
rendering a broken/empty QR box (Section 51's "no silently invalid
empty QR box").
