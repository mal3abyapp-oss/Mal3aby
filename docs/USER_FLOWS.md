# Critical User Flows

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
  → Scan customer's QR
  → RPC: hash lookup → validate (club match, type=booking, not expired, status=active)
  → Atomic consume (status → consumed, used_at, used_by)
  → Result card: customer name, field, time, payment status
  → Tap "Check In"  ──▶  booking.status → checked_in
```

If offline: fails closed, no automated check-in. Staff can perform a manual override (mandatory reason), logged to `audit_logs`. See [ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy).

## 3. Academy Enrollment

```
Search/Create Guardian (a customers row)
  → Search/Create Player
  → Link via guardian_links (relationship, is_primary)
  → Select Program → Select Group (capacity checked)
  → Create Enrollment
  → Create Subscription (status: pending)
  → Generate Invoice
  → Collect Payment (full or first installment via payment_allocations)
  → Subscription flips to `active` on first qualifying payment
  → QR generated for player (type: player_membership)
```

## 4. Attendance (Coach)

```
Coach logs in
  → "Today" view: sessions for their assigned groups only
  → Open a session
  → Roster pulled from active enrollments in that group
  → Mark attendance: tap-to-mark (present/absent/excused/late) or QR scan per player
  → Complete session  ──▶  training_sessions.status → completed
```

## 5. Refund

```
Find invoice/payment (search)
  → Permission check (accountant/club_owner only — payment.refund)
  → Enter refund amount + reason
  → RPC (single transaction):
      insert refunds row
      insert reversing payment_allocation
      write audit_logs entry
  → Updated receipt available for print if required
```

Never mutates the original `payments.amount` — see [ARCHITECTURE.md](ARCHITECTURE.md#billing--financial-integrity-strategy).

## 6. QR Scan (generalized — underlies flows 2 and 4)

```
Scan
  → Decode raw token from QR
  → RPC: SHA-256(token) → lookup qr_credentials by token_hash
  → Checks, in order: club match → type → expires_at → status=active → scanning user's permission for this action
  → If single_use: atomic UPDATE...WHERE status='active' (consume)
  → Zero rows returned → "Already Checked In" / "Expired" / "Invalid" (one of exactly four unambiguous outcomes)
  → Log scan event (audit_logs)
  → Show result screen
```

## 7. Global Search

```
Type in search bar (customer name, mobile, player name, booking number, invoice number, subscription)
  → Debounced query, club-scoped by RLS automatically
  → Grouped results by entity type
  → Tap result → navigate to record
```

Starts as straightforward indexed `ILIKE`/trigram search on the columns above, scoped by `club_id` via RLS (never a separate unscoped search index) — expandable to Postgres full-text search later without a redesign. See [ARCHITECTURE.md](ARCHITECTURE.md#performance-principles).
