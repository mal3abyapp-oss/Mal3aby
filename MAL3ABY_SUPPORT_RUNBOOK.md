# Mal3aby — Day-2 Support Runbook

Written 2026-09-06, Final Sell-Readiness Mission. For whoever handles
day-to-day customer support once real tenants exist — a first-line
responder, not necessarily an engineer. Each section below gives: first
checks, a safe admin action if one exists, what NOT to do, and when to
escalate to engineering. For deeper technical incident response (secret
rotation, database migration failures, Cloudflare/Supabase outages), see
`INCIDENT_RUNBOOKS.md` — this document is the first-line triage layer in
front of that one.

## Customer cannot log in

**First checks**
- Confirm which kind of account: staff (club member) or customer (portal
  user) — the failure modes differ.
- Ask what error message they actually see, verbatim, rather than "it's
  broken."
- Confirm they are using the correct URL (`mal3aby.app` for staff, the
  customer portal link for customers) and the correct email.

**Safe admin action**
- Staff account: check the staff member's status in the club's staff
  list. If it shows `invited` (not `active`), they have not completed
  their first login yet — resend the invitation rather than
  troubleshooting a password issue.
- If their status is genuinely `active` and they still cannot log in,
  this is most likely a Supabase Auth password/session issue, not a
  Mal3aby-specific bug — direct them to the normal password-reset flow.

**What NOT to do**
- Do not create a new duplicate account for the same person "to get them
  in quickly" — this creates a second identity for one real person and
  complicates their history going forward.
- Do not ask for or accept their password over chat/phone/email under
  any circumstance.
- Do not attempt to manually flip an account's status via direct
  database access unless you are the engineer on call and have confirmed
  the safe path (staff deactivation/reactivation RPCs) does not apply.

**Escalate to engineering if**
- The account shows `active` but repeatedly fails login with no clear
  Auth-side explanation, or multiple staff at the same tenant are
  affected simultaneously (possible platform-wide Auth issue — see
  `INCIDENT_RUNBOOKS.md`'s SUPABASE OUTAGE runbook).

## Booking issue

**First checks**
- Get the exact booking (date, field, time) or ask them to point to it
  in their own Bookings screen.
- Confirm what they expected vs. what they see (a slot showing booked
  that shouldn't be, a booking missing, a double-booking).

**Safe admin action**
- Verify the booking's actual state directly in the product (Bookings
  calendar, or the booking's own detail view) before taking the
  customer's description at face value.
- If it is a genuine double-booking: this class of bug was closed this
  session for the academy/field overlap case specifically (see
  `MAL3ABY_FINAL_SELL_READINESS.md`). A double-booking reported today on
  a build that includes that fix is not expected — treat it as a new
  finding, not a recurrence of the known-fixed issue, and escalate.

**What NOT to do**
- Do not cancel or modify a booking on the customer's behalf without
  their explicit request for that specific action — a booking often has
  a payment/invoice attached, and changing it has downstream effects.
- Do not manually edit booking rows via direct database access — use the
  product's own reschedule/cancel actions so the audit trail and any
  attached invoice stay consistent.

**Escalate to engineering if**
- You find a genuine double-booking, a booking with no invoice that
  should have one, or any state that doesn't match what the product's
  own screens should be able to produce through normal use.

## Subscription issue

**First checks**
- Confirm the tenant's current plan and status (trial, active, past-due,
  suspended) via the Platform Owner subscription screen.
- Ask specifically what the customer expected (a feature they think
  should be unlocked, a limit they think is wrong, a renewal that didn't
  happen).

**Safe admin action**
- Compare their actual plan tier's limits against what they're
  reporting — the plan model (Starter/Growth/Pro) and its limits were
  verified to match the intended truth table exactly this session.
- If the complaint is about a "soft" limit (staff count or active-player
  count) sitting in a grace period that never seems to resolve: this is
  a known, open gap — `refresh_commercial_grace_state()` is not
  currently scheduled to run by anything, so the grace state cannot
  advance on its own. Do not tell the customer this is expected
  behavior; escalate it.
- If the complaint is about the founding-offer discount not being
  available to select: this is a known, open gap —
  `claim_founding_customer_slot()` has no product UI entry point today.
  Do not attempt to grant it via the UI (there is no button); escalate
  to whoever has direct database/RPC access if this customer is
  genuinely eligible and the business wants to honor it.

**What NOT to do**
- Do not change a tenant's plan/limits via direct database access when
  the subscription management screen can do it — the screen keeps the
  audit trail correct.
- Do not promise the founding-offer discount is "one click away" — it
  isn't, today.

**Escalate to engineering if**
- The plan/limits shown genuinely disagree with the truth table, or a
  hard-limited resource (branches/fields/academy programs) was allowed
  to exceed its limit (this class is trigger-enforced and should not be
  possible — a real instance is a genuine bug, not user error).

## QR issue

**First checks**
- Identify which QR: booking check-in, invoice/payment verification,
  club-membership, or academy attendance. They behave differently and
  have very different real-world usage today.
- Ask what happens when they scan it (nothing, an error message, a wrong
  result).

**Safe admin action**
- Booking check-in QR, invoice/payment QR, and club-membership QR are
  all real, working, in active use — treat a reported failure on any of
  these as a genuine issue and investigate the specific token/booking
  involved.
- **Academy attendance QR has zero real production usage today** (every
  existing attendance record was entered manually). If a customer
  reports trouble with academy QR scanning specifically, this may be the
  very first real usage of that path — treat it carefully, do not
  assume it works exactly as advertised without checking, and consider
  it a new integration point rather than a mature, previously-proven
  feature.

**What NOT to do**
- Do not regenerate or invalidate a QR credential without understanding
  what it's tied to (a booking, an invoice, a membership) — doing so can
  break a legitimate, already-shared credential the customer's own
  customer may still need.

**Escalate to engineering if**
- A QR resolves to the wrong booking/customer/tenant (a potential
  tenant-isolation issue — treat as high priority) or academy-attendance
  QR shows a systemic failure on its first real use.

## WhatsApp issue

**First checks**
- Confirm whether this tenant has ever actually connected a real
  WhatsApp number. As of this writing, no real customer WhatsApp
  connection exists anywhere in production — only 2 test-fixture
  accounts exist, both logged out / awaiting QR pairing. If this
  customer is attempting to connect for the first time, this is new
  territory operationally, even though the underlying architecture
  (circuit breaker, rate limiting, quiet hours, consent handling) is
  real and hardened.

**Safe admin action**
- Walk the customer through the QR-pairing flow carefully and confirm
  the connection status actually transitions away from `qr_required`/
  `logged_out` before considering it connected.
- Send one real test notification after pairing and confirm delivery
  before telling the customer it's working.

**What NOT to do**
- Do not touch WhatsApp connector configuration or secrets directly —
  per `INCIDENT_RUNBOOKS.md`, WhatsApp transport-layer changes require
  separate, explicit authorization; this runbook is about the
  customer-facing pairing/usage flow, not the connector internals.

**Escalate to engineering if**
- The pairing flow itself fails repeatedly, or a connected account's
  status silently reverts to logged-out with no user action.

## Invoice issue

**First checks**
- Get the specific invoice number and what's wrong with it (amount,
  status, missing payment allocation, printable formatting).

**Safe admin action**
- Cross-check the invoice against its linked booking/payment records
  directly in the product — reports and invoices were confirmed to
  reconcile exactly to raw data this session, so a genuine mismatch is
  a real finding, not expected noise.
- Remind the customer, if they ask, that these are internal official
  receipts (serial-numbered, correctly and honestly labeled "الإيصال
  الرسمي") — not a government e-invoicing/tax-authority submission. Do
  not tell a customer this satisfies a tax-authority (ETA) integration
  requirement, because it does not exist.

**What NOT to do**
- Do not manually edit invoice amounts or statuses via direct database
  access — use the product's own refund/adjustment flows so the audit
  trail and reconciliation stay correct.

**Escalate to engineering if**
- Reported totals genuinely do not reconcile against the underlying
  payments/refunds, or an invoice references a payment/customer outside
  its own tenant (a tenant-isolation concern — high priority).

## Staff permission issue

**First checks**
- Confirm the staff member's assigned role and what specifically they
  can't do that they believe they should be able to.
- Confirm whether this is a built-in role or a custom role — custom
  coach-like roles had a real dashboard-routing bug fixed this session
  (`TodayPage.tsx`); if this customer is on an affected build without
  the fix, a coach-scoped custom role could show a blank dashboard.

**Safe admin action**
- Compare the role's actual granted permissions (via the permission
  matrix screen) against what the staff member is trying to do — most
  reports of "permission issue" are the role correctly restricting
  something, not a bug.
- One narrow, known, open exception: `players.medical_notes` is not
  currently protected by column-level RLS on read. This is not
  exploitable through the shipped UI (no screen selects that column
  today), so it should not surface as a customer-visible support issue
  — but if a customer or staff member ever reports seeing medical notes
  they shouldn't have access to, treat it as urgent and escalate
  immediately rather than assuming it's a permission-matrix
  misconfiguration.

**What NOT to do**
- Do not grant a broader role "to unblock" a staff member without
  confirming with the tenant's owner — permission scope is a real
  security boundary, not a convenience setting.

**Escalate to engineering if**
- A role change through the normal screen doesn't take effect, or a
  staff member can see/do something their assigned role's permission
  matrix says they should not be able to.

## Trial expired

**First checks**
- Confirm the tenant's actual trial end date and current
  `get_club_platform_access()` state via the Platform Owner subscription
  screen.
- Ask the customer whether they intend to convert to paid.

**Safe admin action**
- If converting: follow `MAL3ABY_FIRST_CUSTOMER_ONBOARDING.md`'s
  CONVERSION TO PAID section.
- If they need a short grace extension before deciding, use whatever
  extension mechanism exists on the subscription screen rather than
  improvising via direct database access.
- Remember: there is currently no automated "trial ending soon" or
  "trial expired" reminder notification sent to the customer — this is
  a known, open gap. Do not assume the customer was already warned by
  the product; they likely were not.

**What NOT to do**
- Do not manually extend `platform_subscriptions` dates via direct
  database access when a supported extension action exists on the
  subscription screen.

**Escalate to engineering if**
- The access-blocking behavior at trial expiry doesn't match what the
  subscription screen says it should (e.g. a customer past their trial
  end date who can still do everything, or a customer within their
  trial who is already blocked).

## Tenant suspended

**First checks**
- Confirm who suspended the tenant and why (a Platform Owner action,
  billing lapse, or a support/compliance decision) before doing
  anything.

**Safe admin action**
- `platform_reactivate_club(p_club_id)` is the real, already-proven
  action to restore normal operation immediately — use it once the
  reason for suspension is resolved (per `INCIDENT_RUNBOOKS.md`'s
  Tenant Suspension runbook).
- Confirm reactivation actually restores access before telling the
  customer they're unblocked.

**What NOT to do**
- Do not reactivate a suspended tenant without understanding why it was
  suspended first — a billing-related suspension reactivated blindly
  can just repeat the same problem days later.

**Escalate to engineering if**
- Reactivation doesn't take effect, or a tenant's historical data looks
  different after a suspend/reactivate cycle (it should not — suspension
  is a status flag, not a data operation).

## General escalation principle

If you are ever unsure whether an action is safe to perform directly
(especially anything involving direct database access rather than a
product screen), do not perform it and escalate instead. Every "safe
admin action" above uses an existing product screen or a previously
proven RPC — none of them require raw SQL, and none of them should ever
be improvised under time pressure from a frustrated customer.
