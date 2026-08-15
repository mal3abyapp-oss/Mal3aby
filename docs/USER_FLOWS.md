# Critical User Flows

> **Corrected 2026-08-15** per Mandatory Architecture Corrections. Flow 2 (Check-in) and Flow 6 (QR Scan) are updated: scanning a booking QR now only validates — it never consumes the credential or mutates booking state by itself. A separate, explicit staff confirmation performs the atomic consume + check-in (see [DECISIONS.md ADR-011e](DECISIONS.md#adr-011e--qr-scan-validates-explicit-staff-confirmation-performs-the-check-in-mutation)). Flow 5 (Refund) is unchanged in shape but now explicitly reflects that `payments` has no `invoice_id` — the reversing entry only ever touches `payment_allocations`.
>
> **Added 2026-08-15 (public site)** per Public Website + Signup + Free Trial addition. New Flow 8 (Signup & Onboarding) and Flow 9 (Trial Expiry) — see [DECISIONS.md ADR-036](DECISIONS.md#adr-036--free-trial-requires-no-payment-method-zero-financial-exposure-by-construction) through ADR-046. This is the end-to-end flow the Phase 3d exit gate (see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)) is verified against.

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

## 8. Signup & Onboarding (anonymous visitor → operating club)

```
Anonymous visitor
  → Opens homepage (/)
  → Sees current public plans (from public_plans, never hardcoded)
  → Clicks "ابدأ تجربتك المجانية"
  → /signup: Full Name, Mobile, Email, Password, Confirm Password, Accept Terms
  → Create Account  ──▶  Supabase Auth signup (auth.users + profiles row via trigger)
  → No club membership yet → redirected to /onboarding
  → Step 1: Business Type (نادي / أكاديمية / ملاعب / مركز رياضي — classification only)
  → Step 2: Basic Details (club name, phone, city, address optional)
  → Step 3: First Branch (branch name, city — can reuse club details)
  → Step 4: Confirm  ──▶  complete_new_club_onboarding() RPC (atomic, single transaction):
      create clubs row
      create first branches row
      create club_memberships row (role = club_owner, hardcoded — never client-supplied)
      create platform_subscriptions row (subscription_kind = 'trial', hardcoded;
        duration = platform_settings.default_trial_days; grace_period_days_snapshot = 0)
  → Onboarding Success screen: "تم إنشاء ناديك بنجاح" + "تم تفعيل التجربة المجانية لمدة 7 أيام"
  → "ابدأ الإعداد" CTA  ──▶  enters /app
  → Trial banner visible: "التجربة المجانية: متبقي 7 أيام"
  → First-Run Checklist visible on dashboard (add field / add staff / add customer / first booking —
      each independently completable, not a forced sequence, see DECISIONS.md ADR-043)
  → Club can operate fully (get_club_platform_access() returns 'full') during the trial
```

Target: from "Start Free Trial" click to "operating club" in well under a minute of actual data entry — this is the single most important conversion path in the product. See [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values) for why the finalization step is one atomic RPC rather than several client-driven inserts.

**Existing club staff cannot reach this flow to create a second club** — `complete_new_club_onboarding()` rejects any caller who already holds an active `club_memberships` row. Creating an additional club for an existing operator is a separate, Platform-Owner-mediated action, not self-service (see [DECISIONS.md ADR-042](DECISIONS.md#adr-042--onboarding-finalization-is-one-atomic-rpc-client-never-sets-privileged-values)).

## 9. Trial Expiry & Reminder

```
During trial (get_club_platform_access() = 'full', subscription_kind = 'trial'):
  → In-app alerts appear at fixed thresholds (dashboard banner, notification center,
      subscription page — no external notification service):
      "باقي 3 أيام على انتهاء التجربة"
      "باقي يوم واحد"
      "انتهت التجربة المجانية" (at/after expiry)

At end_at (start_at + platform_settings.default_trial_days):
  → get_club_platform_access() returns 'blocked' immediately — no grace window for trials
      (grace_period_days_snapshot = 0 by convention, see DECISIONS.md ADR-038)
  → Staff seeking a new operational commitment (new booking, new enrollment, new subscription)
      see a clear "trial expired, contact us to activate" state
  → All existing data remains fully readable and intact — nothing is deleted or hidden
  → Club Owner sees this on /app/subscription: "تجربة منتهية" + "تواصل لتفعيل الاشتراك" CTA
  → Platform Owner sees the club in /platform/trials as "expired," can activate a paid
      plan at any time via the Club Detail Actions panel (see SCREEN_MAP.md)
  → Activation creates a new platform_subscriptions row (subscription_kind = 'paid',
      previous_subscription_id pointing at the trial) — the trial's own row is never
      deleted or overwritten, preserving full history (same renewal-chain mechanism
      as any paid-to-paid renewal, see DECISIONS.md ADR-031)
  → get_club_platform_access() returns 'full' again on the very next request
```

Trial does **not** auto-convert to a paid subscription — there is no payment gateway in V1 for it to convert through. See [DECISIONS.md ADR-038](DECISIONS.md#adr-038--trial-is-a-subscription_kind-not-a-new-concept-trial-expiry-defaults-to-blocked-not-automatic-conversion).
