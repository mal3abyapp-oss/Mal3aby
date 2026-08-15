# Critical User Flows

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. Flow 2 (Check-in) and Flow 6 (QR Scan) are updated: scanning a booking QR now only validates — it never consumes the credential or mutates booking state by itself. A separate, explicit staff confirmation performs the atomic consume + check-in (see [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation)). Flow 5 (Refund) is unchanged in shape but now explicitly reflects that `payments` has no `invoice_id` — the reversing entry only ever touches `payment_allocations`.

Each flow is optimized for fewest steps — the receptionist/coach is the primary persona, not a power user browsing menus. See [ARCHITECTURE.md](ARCHITECTURE.md) for the RPCs backing the atomic steps.

## 1. Booking (Reception)

```
Search/Create Customer
  → Tap available slot on calendar grid
  → Price auto-calculated from pricing_rules
  → Optional discount (permission-gated: booking.discount)
  → Payment (method + amount)
  → Confirm  ──▶  create_booking RPC (atomic: booking + invoice + invoice_item)
  → Invoice generated (sequential number)
  → QR generated (separate, retryable step)
  → Print (A4 or 80mm)
```

Target: under 60 seconds for a repeat customer. Booking is created in `confirmed` status directly if payment is collected at creation; `pending_payment` only if payment is deferred.

## 2. Check-in (at the field, on arrival)

```
Staff opens /scan
  → Scan customer's booking QR
  → RPC (read-only, no mutation): hash lookup → validate (club match, type=booking, not expired, status=active)
  → Log scan event to qr_scan_events (result: success)
  → Result card: customer name, field, time, payment status
  → Staff reviews, taps "Confirm Check-in"
  → RPC (atomic): consume credential (status → consumed, used_at, used_by) + booking.status → checked_in, together
```

Scan and confirm are deliberately two steps: scanning alone never consumes the credential or changes booking state, so an accidental camera pass (testing, a customer showing the QR to a friend) cannot silently check someone in. The mutation happens only on the explicit "Confirm Check-in" tap. See [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation).

If offline: fails closed, no automated check-in. Staff can perform a manual override (mandatory reason), logged to `audit_logs`. See [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy).

## 3. Academy Enrollment

```
Search/Create Guardian (a customers row)
  → Search/Create Player
  → Link via guardian_links (relationship, is_primary)
  → Select Program → Select Group (capacity checked, concurrency-safe —
      RPC locks the groups row and re-validates capacity inside the same
      transaction as the enrollment insert, so two receptionists racing
      for the last spot cannot both succeed)
  → Create Enrollment
  → Create Subscription (status: pending; enrollment_id is unique — one
      subscription per enrollment, see DECISIONS.md ADR-013b)
  → Generate Invoice
  → Collect Payment (full or first installment via payment_allocations)
  → Subscription activates per clubs.subscription_activation_policy
      (manual / first_payment [default] / full_payment — see
      DECISIONS.md ADR-013)
  → QR generated for player (type: player_membership, single_use=false, reusable)
```

## 4. Attendance (Coach)

```
Coach logs in
  → "Today" view: sessions for their assigned groups only
  → Open a session
  → Roster pulled from active enrollments in that group
  → Mark attendance: tap-to-mark (present/absent/excused/late) or QR scan per player
      (player QR is reusable — single_use=false; scanning validates + logs to
       qr_scan_events + upserts attendance in one step, it does not consume the credential)
  → Complete session  ──▶  training_sessions.status → completed
```

## 5. Refund

```
Find payment (search — payments carry no invoice_id; the invoice(s) it funded
  are found via payment_allocations)
  → Permission check (accountant/club_owner only — payment.refund)
  → Enter refund amount + reason
  → RPC (single transaction):
      validate: amount <= payment's refundable balance (amount - prior completed refunds)
      insert refunds row (payment_id, amount, reason, refunded_by, refunded_at)
      insert reversing payment_allocations adjustment
      write audit_logs entry
  → Updated receipt available for print if required
```

Never mutates the original `payments.amount`, never deletes it. See [ARCHITECTURE.md](ARCHITECTURE.md#billing--financial-integrity-strategy) and [DECISIONS.md ADR-011c](DECISIONS.md#adr-011c--refund-model-refunds-table--reversing-allocation-atomic-rpc).

## 6. QR Scan (generalized — underlies flows 2 and 4)

```
Scan
  → Decode raw token from QR
  → RPC: SHA-256(token) → lookup qr_credentials by token_hash
  → Checks, in order: club match → type → expires_at → status=active → scanning user's permission for this action
  → Always: insert a row into qr_scan_events (result: success/already_used/expired/invalid/wrong_club/permission_denied)
  → Mutation, if any, depends on credential type:
      player_membership (single_use=false) → no mutation, validation + logging only
      booking (single_use=true) → still no mutation on scan; consume only happens in
        a separate, explicit "Confirm Check-in" RPC call (see Flow 2)
  → Show result screen — one of: VALID / ALREADY USED / EXPIRED / INVALID / WRONG CLUB
```

**`qr_credentials.used_at`/`used_by` are a convenience "last use" snapshot only.** The actual audit/replay/attendance history lives in `qr_scan_events`, which records every scan attempt regardless of outcome — see [DECISIONS.md ADR-011d](DECISIONS.md#adr-011d--player-qr-is-reusable-booking-qr-is-consumable-scans-are-a-separate-log).

## 7. Global Search

```
Type in search bar (customer name, mobile, player name, booking number, invoice number, subscription)
  → Debounced query, club-scoped by RLS automatically
  → Grouped results by entity type
  → Tap result → navigate to record
```

Starts as straightforward indexed `ILIKE`/trigram search on the columns above, scoped by `club_id` via RLS (never a separate unscoped search index) — expandable to Postgres full-text search later without a redesign. See [ARCHITECTURE.md](ARCHITECTURE.md#performance-principles).
