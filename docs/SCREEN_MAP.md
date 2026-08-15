# Screen Map

> **Corrected 2026-08-15 (final)** per Final Platform SaaS Corrections. Added the full `/platform` navigation (Overview/Clubs/Subscriptions/Payments/Renewals/Reports/Alerts/Audit/Settings) replacing the single "Platform Billing Console" row — see [DECISIONS.md ADR-034](DECISIONS.md#adr-034--platform-owner-control-center-full-navigation-not-a-single-billing-screen).
>
> **Added 2026-08-15 (public site)** per Public Website + Signup + Free Trial addition. New Public navigation/screens, Onboarding flow, `/app/subscription` club-side screen, `/platform/plans`/`/platform/trials`/`/platform/leads`. See [DECISIONS.md ADR-036](DECISIONS.md#adr-036--free-trial-requires-no-payment-method-zero-financial-exposure-by-construction) through ADR-046.
>
> **Added 2026-08-15 (final pre-implementation)** per the Final Pre-Implementation Directive. New `/app/outstanding` screen, Recurring Booking UI (within New Booking), Quick Field Block action (within Booking Calendar), Global Search + Quick Actions (Ctrl/Cmd+K, desktop). Full visual/interaction rules for every screen here live in the new [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) — this file remains the screen *inventory*, DESIGN_SYSTEM.md is the visual/responsive *rulebook*.

## Public Navigation (unauthenticated, `PublicLayout`)

Logo · الرئيسية (Home) · المزايا (Features) · الأسعار (Pricing) · تواصل معنا (Contact) — right side: تسجيل الدخول (Login) · ابدأ مجانًا (Start Free)

## Desktop Navigation (Club-side, `AppLayout`)

Today · Bookings · Academy · Customers · Payments · Invoices · Reports · Club · Staff · Settings

## Platform Owner Navigation (`/platform`, `PlatformLayout` — separate area, not part of club-side navigation)

Overview · Clubs · Subscriptions · Payments · Renewals · Reports · Alerts · Audit · Settings

A Platform Owner who also happens to hold a club membership switches between the two navigation contexts explicitly (e.g. via the club-switcher becoming a "Platform / Club X / Club Y..." selector) — the two are never merged into one shared nav. See [ARCHITECTURE.md](ARCHITECTURE.md#public-website--layout-strategy) for the three-layout separation.

## Mobile Navigation (bottom bar, club-side)

Today · Bookings · **Scan** · Academy · More

`Scan` is given a prominent, thumb-reachable center position — it's a high-frequency action for reception/gate staff. The `/platform` area is desktop-only in V1 — Platform Owner's workflow (reviewing multi-club reports, managing renewals) is not a mobile-first task, unlike reception/coach work. The public site is fully responsive (a visitor evaluating the product on mobile is a real, expected case) but has no dedicated mobile-app-style bottom nav — it's a standard responsive marketing site.

## Recommended Route Structure

```
/                          Public homepage
/pricing                   Public plans
/contact                   Public contact form
/terms                     Public terms
/privacy                   Public privacy policy

/login
/signup
/forgot-password
/reset-password

/onboarding                New-club setup wizard (authenticated, no club membership yet)

/app                       Authenticated club-side (AppLayout)
/app/bookings
/app/academy
/app/customers
/app/invoices
/app/subscription           Club Owner's own-subscription view (new)
...

/platform                  Platform Owner console (PlatformLayout)
/platform/clubs
/platform/subscriptions
/platform/payments
/platform/renewals
/platform/plans              Plan management (new)
/platform/trials              Trials-specific view (new)
/platform/leads               Contact request leads (new)
/platform/reports
/platform/alerts
/platform/audit
/platform/settings
```

## Route Guards

| Route group | Auth required | Additional requirement |
|---|---|---|
| `/`, `/pricing`, `/contact`, `/login`, `/signup`, `/forgot-password`, `/reset-password`, `/terms`, `/privacy` | No | None — fully public |
| `/onboarding` | Yes | User has **no** active `club_memberships` row (a user who already has a club is redirected to `/app`, not shown onboarding again) |
| `/app/*` | Yes | Active `club_memberships` row + `get_club_platform_access()` is `full` or `grace` for that club (`blocked` redirects to a "subscription required" screen, not silently hidden) |
| `/platform/*` | Yes | `platform_owner` permission — independent of any club membership |

## Screen Inventory

| Screen | Domain | Devices | Primary roles |
|---|---|---|---|
| Global Search (results grouped: Customers/Players/Bookings/Invoices) | search | All | Everyone (club-side, scoped by permission) |
| Quick Actions palette (Ctrl/Cmd+K: New Booking, New Customer, Collect Payment, Scan QR, Find Invoice) | search | Desktop only | Receptionist, Manager, Accountant |
| Today / Ops Center | dashboard | All | Manager, Owner |
| Reception Operational View (Now/Next/Quick Actions) | dashboard | All | Receptionist |
| Booking Calendar (day grid) | bookings | Desktop, Tablet | Receptionist, Manager |
| Booking List/Search | bookings | Mobile | Receptionist |
| New Booking (drawer/modal, incl. Recurring Booking option) | bookings | All | Receptionist |
| Quick Field Block (from Booking Calendar) | bookings | Desktop, Tablet | Club/Branch Manager |
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
| Outstanding Payments (`/app/outstanding`) | billing | All | Receptionist, Accountant, Manager |
| Refund | billing | Desktop, Tablet | Accountant, Club Owner |
| /scan | scanner | Mobile, Tablet | Receptionist, Scanner, Coach |
| Reports Hub (revenue, occupancy, academy, customers) | reports | Desktop | Manager, Owner, Accountant, Academy Manager |
| Staff & Roles | staff | Desktop | Club Owner, Club Manager |
| Club/Branch Settings | clubs | Desktop | Club Owner |
| **Subscription (`/app/subscription`)** | billing | Desktop, Tablet | Club Owner — current subscription, available plans (from `public_plans`), pricing, expiry, own payment history, "Contact to activate/renew" CTA. **Cannot record a payment themselves** — that remains exclusively a Platform Owner action, see [DECISIONS.md ADR-035](DECISIONS.md#adr-035--club-owner-subscription-visibility-is-scoped-own-clubs-commercial-summary-only) |
| Trial Banner (persistent, shown during `trial` effective status) | dashboard | All | Club Owner, Manager — "التجربة المجانية: متبقي N أيام" + CTA to `/app/subscription` |
| Audit Log Viewer | settings | Desktop | Owner, Manager |
| Login | auth | All | Everyone (unauthenticated) |
| Club Switcher | auth | All | Users with >1 club membership |

## Public Screen Inventory (unauthenticated, `PublicLayout`)

| Screen | Route | Contents |
|---|---|---|
| Home | `/` | Hero (headline + "ابدأ تجربتك المجانية" primary CTA + "تسجيل الدخول" secondary), Suitable For (clubs/academies/fields), Core Features, How It Works (4 steps), Why Mala3by, Pricing preview, 7-Day Trial CTA banner, FAQ, Contact CTA — see [USER_FLOWS.md](USER_FLOWS.md) for the homepage section order |
| Pricing | `/pricing` | Plan cards sourced from `public_plans` (never hardcoded) — name, duration, price, discount label, features summary, "ابدأ 7 أيام مجانًا" CTA on every card. No "Buy"/"Checkout"/"Pay" language anywhere (see [ARCHITECTURE.md](ARCHITECTURE.md#public-website--layout-strategy)) |
| Contact | `/contact` | Phone, WhatsApp link (plain `wa.me` link, not the WhatsApp Business API), email, contact form (writes to `contact_requests`) |
| Login | `/login` | Email, Password, Login button, "نسيت كلمة المرور؟" link, "ليس لديك حساب؟ ابدأ تجربتك المجانية" link to `/signup` |
| Signup | `/signup` | Name, Mobile, Email, Password, Confirm Password, Accept Terms checkbox, "ابدأ تجربتك المجانية لمدة 7 أيام" CTA |
| Forgot Password | `/forgot-password` | Email input, Supabase Auth reset-email trigger |
| Reset Password | `/reset-password` | New password + confirm, via Supabase Auth's reset token flow |
| Terms | `/terms` | Static content — placeholder legal text acceptable for V1, route must exist (see [DECISIONS.md](DECISIONS.md) brief Section 37) |
| Privacy | `/privacy` | Static content — same as Terms |

## Onboarding Screen Inventory (authenticated, no club yet)

| Screen | Route | Contents |
|---|---|---|
| New Club Setup (4-step wizard) | `/onboarding` | Step 1: Business Type (نادي/أكاديمية/ملاعب/مركز رياضي — classification label only). Step 2: Basic Details (club name, phone, city, address optional). Step 3: First Branch (branch name, city — can default from club details). Step 4: Trial Activation confirmation, then `complete_new_club_onboarding()` fires |
| Onboarding Success | `/onboarding/success` (or a final wizard step) | "تم إنشاء ناديك بنجاح" + "تم تفعيل التجربة المجانية لمدة 7 أيام" + "ابدأ الإعداد" CTA into `/app` |
| First-Run Checklist | shown in `/app` dashboard, not a separate route | Dismissible checklist: ✓ club created, ✓ branch created, □ add a field, □ add a staff member, □ add a first customer, □ create a first booking — see [DECISIONS.md ADR-043](DECISIONS.md#adr-043--first-run-setup-is-a-checklist-not-a-multi-step-wizard) |

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
| Plans | `/platform/plans` | Desktop | `platform_plans` CRUD: Create Plan, Edit Price, Publish/Unpublish (`is_public`), reorder (`display_order`). **Editing price never rewrites any existing subscription's snapshot** — see [DECISIONS.md ADR-030](DECISIONS.md#adr-030--platform-plan-pricing-is-snapshotted-onto-each-subscription-period) |
| Trials | `/platform/trials` | Desktop | Active trials list with days remaining, Trials Started/Active/Expired/Converted counts, Trial Conversion Rate — see [DECISIONS.md ADR-044](DECISIONS.md#adr-044--platform-owner-reports-gain-trial-specific-metrics-public-leads-get-their-own-report) |
| Leads (Contact Requests) | `/platform/leads` | Desktop | `contact_requests` inbox with status pipeline (New/Contacted/Converted/Closed) |
| Reports | `/platform/reports` | Desktop | Subscription Report, Revenue Report, Renewal Report, Growth Report, Usage Report — see [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 3c for exact columns/breakdowns |
| Alerts | `/platform/alerts` | Desktop | In-app rule-based alerts: subscriptions expiring soon, overdue renewals, trial ending soon (3 days / 1 day / expired) |
| Audit | `/platform/audit` | Desktop | Platform-level audit log (subscription lifecycle actions, payment records/reversals, club suspensions, new-club-onboarding events) — separate from a club's own `audit_logs` view |
| Settings | `/platform/settings` | Desktop | `platform_settings` (`default_trial_days`, `default_grace_period_days`) |

## Deferred Screens (V1.1+)

Cash Shift open/close, Expenses entry, Utilization Heatmap, Organizations admin, Customer self-service portal, Platform Billing feature-tiered plan management (all V1 plans share one feature set). See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md#v1--deferred-matrix).
