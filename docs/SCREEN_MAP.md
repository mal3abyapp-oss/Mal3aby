# Screen Map

> **Corrected 2026-08-15 (final)** per Final Platform SaaS Corrections. Added the full `/platform` navigation (Overview/Clubs/Subscriptions/Payments/Renewals/Reports/Alerts/Audit/Settings) replacing the single "Platform Billing Console" row — see [DECISIONS.md ADR-034](DECISIONS.md#adr-034--platform-owner-control-center-full-navigation-not-a-single-billing-screen).

## Desktop Navigation (Club-side)

Today · Bookings · Academy · Customers · Payments · Invoices · Reports · Club · Staff · Settings

## Platform Owner Navigation (`/platform`, separate area — not part of club-side navigation)

Overview · Clubs · Subscriptions · Payments · Renewals · Reports · Alerts · Audit · Settings

A Platform Owner who also happens to hold a club membership switches between the two navigation contexts explicitly (e.g. via the club-switcher becoming a "Platform / Club X / Club Y..." selector) — the two are never merged into one shared nav.

## Mobile Navigation (bottom bar, club-side)

Today · Bookings · **Scan** · Academy · More

`Scan` is given a prominent, thumb-reachable center position — it's a high-frequency action for reception/gate staff. The `/platform` area is desktop-only in V1 — Platform Owner's workflow (reviewing multi-club reports, managing renewals) is not a mobile-first task, unlike reception/coach work.

## Screen Inventory

| Screen | Domain | Devices | Primary roles |
|---|---|---|---|
| Today / Ops Center | dashboard | All | Manager, Owner |
| Reception Operational View (Now/Next/Quick Actions) | dashboard | All | Receptionist |
| Booking Calendar (day grid) | bookings | Desktop, Tablet | Receptionist, Manager |
| Booking List/Search | bookings | Mobile | Receptionist |
| New Booking (drawer/modal) | bookings | All | Receptionist |
| Customer Search/Profile | customers | All | Receptionist, Manager, Accountant |
| Player Profile | players | All | Academy Manager, Coach (assigned) |
| Field Management | fields | Desktop | Club/Branch Manager |
| Operating Hours & Blocks | fields | Desktop | Club/Branch Manager |
| Pricing Rules | fields | Desktop | Club/Branch Manager |
| Academy Programs/Seasons | academy | Desktop, Tablet | Academy Manager |
| Groups & Schedule | academy | Desktop, Tablet | Academy Manager |
| Coach Today (sessions list) | academy | Mobile, Tablet | Coach |
| Attendance Marking | academy | Mobile, Tablet | Coach |
| Enrollment Wizard | academy | Desktop, Tablet | Academy Manager, Receptionist |
| Subscription Detail (incl. freeze, installments) | billing | All | Academy Manager, Accountant |
| Invoice View/Print (A4 + 80mm) | billing | All | Receptionist, Accountant |
| Payment Collection | billing | All | Receptionist, Accountant |
| Refund | billing | Desktop, Tablet | Accountant, Club Owner |
| /scan | scanner | Mobile, Tablet | Receptionist, Scanner, Coach |
| Reports Hub (revenue, occupancy, academy, customers) | reports | Desktop | Manager, Owner, Accountant, Academy Manager |
| Staff & Roles | staff | Desktop | Club Owner, Club Manager |
| Club/Branch Settings | clubs | Desktop | Club Owner |
| Platform Subscription Summary (read-only card: plan, start, expiry, grace status, days remaining, renewal status, payment summary — own club only) | platform-billing | Desktop | Club Owner (own club only) |
| Audit Log Viewer | settings | Desktop | Owner, Manager |
| Login / Club Switcher | auth | All | Everyone |

## Platform Owner Screen Inventory (`/platform`, Phase 3c)

| Screen | Route | Devices | Contents |
|---|---|---|---|
| Platform Overview | `/platform` | Desktop | Total/active/trial/grace-period/expired/suspended club counts, subscriptions expiring soon, revenue collected today/this month/this year, renewals due, new clubs this month |
| Clubs List | `/platform/clubs` | Desktop | All clubs with current access status (`full`/`grace`/`blocked`), search/filter |
| Club Detail | `/platform/clubs/:clubId` | Desktop | Overview, Current Subscription, Subscription History (full `previous_subscription_id` chain), Platform Payment History, Usage (branches/fields/staff/customers/players/bookings/enrollments), Access Status, Audit, Actions panel |
| Club Detail — Actions | (within Club Detail) | Desktop | Activate, Start Trial, Renew, Change Plan, Extend Grace Period, Suspend Club, Reactivate Club, Cancel Subscription, Record Payment, Reverse Payment — every action writes an audit entry |
| Subscriptions List | `/platform/subscriptions` | Desktop | All subscription periods across all clubs, filterable by status/plan |
| Payments List | `/platform/payments` | Desktop | All recorded platform payments, filterable by club/method/date |
| Renewals | `/platform/renewals` | Desktop | Due in 7/15/30 days, in grace period, expired, recently renewed |
| Reports | `/platform/reports` | Desktop | Subscription Report, Revenue Report, Renewal Report, Growth Report, Usage Report — see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 3c for exact columns/breakdowns |
| Alerts | `/platform/alerts` | Desktop | In-app rule-based alerts: subscriptions expiring soon, overdue renewals |
| Audit | `/platform/audit` | Desktop | Platform-level audit log (subscription lifecycle actions, payment records/reversals, club suspensions) — separate from a club's own `audit_logs` view |
| Settings | `/platform/settings` | Desktop | Plan management (`platform_plans` CRUD), default grace period days |

## Deferred Screens (V1.1+)

Cash Shift open/close, Expenses entry, Utilization Heatmap, Organizations admin, Customer self-service portal, Platform Billing feature-tiered plan management (all V1 plans share one feature set). See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#v1--deferred-matrix).
