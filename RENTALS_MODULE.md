# Rentals Module (الإيجارات)

Clubs lease out spaces they own — a gym, a wedding / events hall, a shop
unit, an office, a warehouse, an apartment, a sports facility, or **any
custom-named type** — to a tenant (an ordinary club customer).

Migration: `supabase/migrations/20261007100000_rentals_module.sql`
UI: `/app/rentals` (`src/features/rentals/`), report `/app/reports/rentals`,
revenue-by-source report in Finance → Reports.

## Concepts

| Concept | Table | Notes |
|---|---|---|
| Space | `rental_spaces` | name, type (`gym`, `wedding_hall`, `event_hall`, `shop`, `office`, `warehouse`, `apartment`, `sports_facility`, `other`, or `custom` + free-text name), branch, area, capacity, default rent, overlap policy, status active/inactive/archived |
| Lease contract | `rental_contracts` | tenant, space, rent cycle, number of periods, amount per period, security deposit, start/end, status active/terminated/cancelled, number `RC-00001` per club |
| Installment | `rental_installments` | one row per period (+ one deposit row). `scheduled` → `invoiced` → (paid state derived) or `cancelled` |

Rent cycles: `daily`, `monthly`, `quarterly`, `semi_annual`, `annual`,
`custom` (every N days / weeks / months). Periods are always computed from
the contract start date (month-end safe), same math client
(`src/lib/domain/rental.ts`) and server (`_rental_period_start`).

## Money flow (no parallel ledger)

1. Installments are a **schedule only** — future rent never shows as
   outstanding.
2. Issuing installments (`issue_rental_invoice`, `issue_due_rental_invoices`,
   or the first invoice at contract creation) creates a normal `invoices`
   row (`due_date` = installment due date) with `invoice_items.reference_type = 'rental'`.
   Several installments can share one invoice ("pay 3 months now").
3. Collection goes through the shared `record_payment` /
   `record_payment_with_official_receipt` (Finance → Payments), so cash
   shifts, official receipts, printing, refunds, notifications, outstanding
   balances, revenue / collections / payment-method / reconciliation /
   executive / today reports, Customer 360 and the customer portal all
   include rentals automatically. `record_payment` resolves the rental's
   branch for the cash-shift and government-receipt policy.
4. Paid / partial / overdue per installment is **derived** from
   `get_invoice_payment_summary` (discount taken off the last installments of
   an invoice, cash attributed in schedule order), so refunds and voids are
   always reflected.

## Where rentals appear

- Sidebar + mobile "More" → **Rentals** (tabs: overview, spaces, contracts, dues)
- Customer 360 → **Rentals** tab (tenant's leases) + `rental` source in the financial ledger
- Finance → invoices list source label "Rent"; Finance → Reports → **Revenue by source**
- Reports → **Rentals** report (occupancy, collected, due, overdue, deposits, by space, by cycle, expiring)
- Today dashboard → "Needs attention": overdue rent, leases ending within 30 days
- Platform owner → module toggle `rentals` (club Modules tab, plan default modules)

## Permissions

| Key | Default roles |
|---|---|
| `rental.view` | owner, manager, branch manager, receptionist, accountant |
| `rental.space.manage` | owner, manager, branch manager |
| `rental.contract.create` (create + issue invoices) | owner, manager, branch manager, receptionist |
| `rental.contract.manage` (terminate / cancel) | owner, manager, branch manager |

Collecting money still requires the existing `payment.create`.

## Module activation

Module key `rentals`. Existing clubs and new clubs are **entitled but not
active** (opt-in, like Shop): the club owner presses "Activate" on the
Rentals page, or the platform owner toggles it from the club's Modules tab.

## Lifecycle rules

- Overlapping leases on one space are rejected unless the space allows it.
- **Terminate** (early end): un-invoiced installments after the termination
  date are cancelled; issued invoices stay (void/refund them in Finance if needed).
- **Cancel** (entered by mistake): only when nothing was collected; its
  invoices are voided and all installments cancelled.
- A voided installment invoice can be re-issued.

## v2 (2026-10-08) — `20261008100000_rentals_v2.sql`

- **Security deposit is a liability**: always invoiced on its own invoice
  (`invoice_items.reference_type = 'rental_deposit'`), excluded from rental
  "collected"/net figures. **Settle deposit** (contract detail) refunds all or
  part through the shared refunds ledger (`create_refund`); the deducted part is
  kept as income and the deposit invoice is reduced so nothing stays outstanding.
  Revenue by source shows deposits as their own source; the revenue report
  exposes `deposits_collected` (shown as a note).
- **Hourly bookings** (`rent_cycle = 'hourly'`): start time + hours on one day;
  same-day bookings on a space only conflict when their times overlap.
- **Annual increase %**: compounds per full contract year on each installment.
- **Renew** (one click, follow-on lease from the day after the old one ends, no
  new deposit), **Edit** (notes, reprice upcoming un-invoiced periods from a
  date, extend by N periods), **Print contract** (A4).
- **Rental settings** (per club): auto-issue invoices N days before due, late
  fee (none / fixed / percent, grace days, once per installment on its own
  invoice), WhatsApp reminders. Runs daily via pg_cron job `rental-daily-jobs`
  (`run_rental_daily_jobs()`, 04:07 UTC).
- **WhatsApp reminders** use connector templates `rental-payment-reminder` /
  `rental-payment-overdue` (in `whatsapp-connector/src/templates.ts`). They are
  only queued once `_rental_whatsapp_templates_live()` returns true — flip it in
  a follow-up migration **after** the connector image with those templates is
  deployed, otherwise queued messages would fail on an unknown template.
- **Space calendar** (month grid per space), **space expenses**
  (`record_rental_space_expense` → normal `record_expense` + `expenses.rental_space_id`)
  feeding per-space expenses/net in the rentals report.
- **Customer portal** `/portal/rentals` (`get_my_portal_rentals()`), shown in the
  bottom bar only for customers with a lease.
- Global search finds contracts by number (`/app/rentals?contract=<id>`); Help
  guide has a Rentals section.
