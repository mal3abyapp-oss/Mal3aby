# Mal3aby — 10-Minute Sales Demo Runbook

Written 2026-09-06, Final Sell-Readiness Mission. Uses the existing public
demo tenant "نادي النموذج" (`public_slug=demo-club`) — a real club row in
production with `is_test_fixture = true`, not a special demo-mode code
path. Everything shown below is real data behaving through the real
product; nothing here is mocked or simulated for the demo.

## Before you rely on this runbook

Confirm the demo tenant still has the sample depth this script assumes,
since demo data can drift over time:

- Booking/invoice depth (25 bookings, 34 invoices, 3 fields) was
  confirmed present as of this writing.
- **Academy and staff sample data specifically under `demo-club` is
  thin.** Richer academy sample data exists on other QA fixture clubs
  (not `demo-club`), so a live, un-rehearsed academy walkthrough on this
  specific tenant may look sparse. **Rehearse the academy section (step
  5 below) once before using this runbook in front of a real prospect**,
  and if it looks thin, either seed a couple of realistic academy groups/
  enrollments onto `demo-club` first, or soften the live claim to "here
  is how it looks" rather than implying a mature, long-running academy
  program.
- No demo-tenant-specific seeding code exists in
  `supabase/migrations/20260816070000_seed_qa_dataset.sql` (that
  migration seeds other QA fixtures, not `demo-club` by name) — the
  demo tenant's data was populated separately and is not automatically
  regenerated or kept in sync by any script. Treat it as live data that
  can be edited directly through the product, not as something to
  re-seed via a migration.

## Demo script

| # | Screen | Action | What to say | Business value | Expected result | Recovery if the step fails |
|---|---|---|---|---|---|---|
| 1 | Public booking page (`mal3aby.app/demo-club` or the tenant's public slug URL) | Open the page live, show available fields and time slots | "This is what your customers see — no app download, no account needed to browse availability" | Removes friction for the customer's own customers; works on any phone browser | Page loads, shows only `demo-club`'s own fields/pricing, real available/booked slots reflecting real bookings | If the page is slow/blank, switch immediately to the internal Bookings calendar (step 2) and note you'll follow up with the public link separately — don't debug live in front of a prospect |
| 2 | Internal Bookings calendar (staff view) | Show the field-by-day calendar with real bookings on it | "Your front desk sees the exact same real-time availability your customers see — there's one calendar, not two systems to keep in sync" | No double-booking risk, single source of truth | Calendar renders real bookings, no visibly broken slots | If a specific day looks empty, pick a different date known to have bookings rather than apologizing for empty data |
| 3 | Create a live booking (staff view, on a genuinely free slot) | Book a slot live, on camera | "Watch this — I'm booking a real slot right now, the same way your staff would" | Shows the actual, unscripted product, not a mockup | Booking is created, appears instantly on the calendar and (if you refresh the public page) reflects there too | If it errors, don't retry live more than once — move to invoicing (step 4) using an existing booking instead |
| 4 | Invoice / payment | Open the invoice for a recent real booking, show payment status and the printable receipt | "Every booking generates a proper, numbered receipt — useful for your own bookkeeping" | Financial traceability without a separate system | Invoice shows correct amount, correct status, receipt is legible and printable | If the invoice looks wrong, pick a different, previously-verified booking rather than narrating a live investigation |
| 5 | Academy (if relevant to this prospect) | Show a program/group and its enrolled players | "If you run training programs alongside your fields, they live in the same system — same customers, same billing" | One platform instead of a separate spreadsheet/app for academy | Program and enrollment list render correctly | **This is the thinnest data area on this tenant** — if it looks sparse, say so honestly ("this is a newer part of the demo data, let me show you a richer example account after this call") rather than implying deep existing usage |
| 6 | Booking check-in QR (use this, not academy-attendance QR) | Show a booking's QR code and, if possible, actually scan/confirm it | "Your front desk scans this on arrival — real confirmed check-ins, not a paper sign-in sheet" | Attendance tracking with zero extra staff effort | QR resolves via `verify_booking_qr_public()`/`qr_confirm_checkin()`, shows a valid confirmed booking | If scanning hardware isn't available live, show the QR code rendering and describe the scan step rather than skipping it silently — **do not** substitute the academy-attendance QR here; it has zero real production usage and should not be demoed as a proven, active feature |
| 7 | Reports | Open the revenue/bookings report for a recent period | "These numbers come straight from the same bookings and invoices you just saw — nothing is re-entered by hand" | Trustworthy reporting, no manual reconciliation | Report totals visibly correspond to the invoices shown in step 4 | If a number looks off, do not attempt to explain the discrepancy live — say you'll confirm the exact figure and follow up |
| 8 | Staff permission perspective | Log in as (or show the screen of) a limited role — e.g. a receptionist or coach account — and show what they can and cannot see | "Your staff only see what their role needs — a coach can't see your financials, a receptionist can't change pricing" | Real operational control, not "everyone sees everything" | The limited role's dashboard shows only its own permitted screens | If a specific limited-role account isn't handy, describe the permission model verbally rather than improvising a live account switch |
| 9 | Customer portal | Show a customer logging into their own portal — their bookings, their invoices, their membership status | "Your customers get their own self-service view — they don't need to call you to check a booking or download a receipt" | Reduces staff phone/WhatsApp load | Portal shows only that customer's own real data | If portal login isn't rehearsed, show a screenshot/description rather than attempting a live, unrehearsed login in front of the prospect |

## What NOT to claim during this demo

- Do not claim academy-attendance QR scanning is in active use by real
  clubs — it is built and wired correctly but has zero real production
  usage today (see `MAL3ABY_SALES_CLAIMS_MATRIX.md`).
- Do not claim WhatsApp notifications are live with real customers today
  — the architecture is real and hardened, but no real customer
  WhatsApp number is connected yet.
- Do not claim automated data-migration/import from another system
  exists — no such tooling exists in the product today.
- Do not claim the receipts shown are government/tax-authority
  e-invoices — they are honestly framed, internal official receipts
  (correct and safe framing), not an ETA/e-invoicing integration.

## Timing guidance

Steps 1-4 (booking, invoicing) are the core, most reliable ~6 minutes.
Steps 5-6 (academy, QR) are valuable differentiators but carry more
demo-data risk — rehearse them specifically before a real prospect call.
Steps 7-9 (reports, permissions, portal) close strong on trust and
control themes and take about 3 minutes combined. If running short on
time, cut step 5 (academy) before cutting steps 1-4 or step 9 (portal),
since booking/invoicing and the customer portal are the most rehearsed
and reliable parts of this script.
