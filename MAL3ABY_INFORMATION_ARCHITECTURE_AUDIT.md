# Mal3aby — Information Architecture Audit

**Purpose:** a complete, ground-truth inventory of the platform as it exists today — every route, screen, tab, dialog, role, permission, table, and RPC — gathered directly from the code, the live database, and existing documentation. No redesign decisions are made in this document; it is the factual foundation the target IA (`MAL3ABY_INFORMATION_ARCHITECTURE.md`) is built from.

**Method:** router.tsx read directly for route ground truth; three independent deep-read passes over Platform Owner / Club-Staff / Customer-Portal+WhatsApp source files; live database queries against the production Supabase project for roles, permissions, and every table's row count and purpose comment.

**Date:** 2026-08-17

---

## 1. Route Inventory (ground truth from `src/app/routing/router.tsx`)

### Public (no auth) — `PublicLayout`
`/`, `/pricing`, `/contact`, `/terms`, `/privacy`, `/login`, `/signup`, `/forgot-password`, `/reset-password`

### Standalone (no layout chrome)
`/onboarding`, `/verify/:token` (public invoice verification)

### `/app` (RequireAuth) — `AppLayout` — Club/Venue staff tier
`/app` (index=Today), `/app/bookings`, `/app/academy`, `/app/customers`, `/app/billing`, `/app/cash-shift`, `/app/subscription`, `/app/outstanding`, `/app/reports`, `/app/staff`, `/app/settings`, `/app/more`, `/app/club` (redirect → `/app/settings`)
Plus `/scan` (also RequireAuth, own top-level path outside AppLayout chrome, in mobile bottom nav)

### `/portal` (RequirePortalAuth) — `PortalLayout` — Customer tier
`/portal` (index — gate: `ClaimAccountPage` or `PortalBookingsPage`), `/portal/academy`, `/portal/payments`, `/portal/qr`, `/portal/profile`

**Known route gap:** `PortalBookingsPage` is a fully-built, real screen but has **no dedicated route** — it only renders as `/portal` index content once a customer has ≥1 linked record. Not bookmarkable, not a distinct URL.

### `/platform` (RequirePlatformOwner) — `PlatformLayout` — Platform Owner tier
`/platform` (index=Overview), `/platform/clubs`, `/platform/clubs/:clubId`, `/platform/owners`, `/platform/subscriptions` (placeholder), `/platform/plans`, `/platform/payments` (placeholder), `/platform/renewals` (placeholder), `/platform/trials`, `/platform/leads`, `/platform/reports`, `/platform/alerts`, `/platform/audit`, `/platform/settings` (placeholder)

**Total: 40 distinct routes/screens** (4 of which are inert placeholders).

---

## 2. Role & Permission Matrix (live database ground truth)

### Roles (`roles` table, 9 rows)
`platform_owner`, `club_owner`, `club_manager`, `branch_manager`, `receptionist`, `accountant`, `academy_manager`, `coach`, `scanner`

### Permission model
`permissions` (51 rows) is the sole authorization source of truth; `role_permissions` (202 rows) maps roles → permissions. **Role keys are never used for server-side authorization directly** — every RPC/RLS policy checks `has_permission(permission_key, club_id)`. Client-side role checks (`roleKey === 'club_owner'`) are UI-convenience only, not a security boundary.

### Permission summary per role (condensed; full matrix in the live DB)
| Role | Scope |
|---|---|
| `platform_owner` | Cross-tenant platform administration (separate RPC family, not the `permissions` table for most platform actions) |
| `club_owner` | Full operational + financial + staff + branch/field CRUD + `payment.refund` + `manage_whatsapp_connection` |
| `club_manager` | Same breadth as club_owner except `club.update`, `booking.discount.override`, `payment.refund` |
| `branch_manager` | Booking/customer/player/invoice/pricing ops scoped to assigned branch(es); `manage_whatsapp_connection`; no staff/branch/refund |
| `receptionist` | Booking/customer/payment/invoice creation, QR check-in confirm; **no** `payment.refund`, no pricing/staff/report beyond view |
| `accountant` | Invoice/payment/refund verification and management; `payment.refund`; **no** booking creation, no staff |
| `academy_manager` | Full academy CRUD (programs/groups/enrollments/subscriptions/players), no booking/field ops |
| `coach` | `attendance.mark`, `session.manage`, `qr.scan`, `player.view` only — narrowest staff role |
| `scanner` | `qr.scan` + `qr.checkin.confirm` only — single-purpose kiosk role |

**Real finding:** `payment.refund` is a dedicated permission (added this session, see `PROFESSIONAL_OWNER_REVIEW_STATE.md`) held only by `club_owner`/`accountant` — correctly excludes `receptionist`/`branch_manager`.

**Real finding:** the client-side desktop sidebar (`AppLayout.tsx`) has **zero role-filtering** despite an in-code comment documenting it as an intended, never-implemented Phase 2 task. Every role sees all 9 sidebar items (اليوم/الحجوزات/الأكاديمية/العملاء/الفواتير/وردية النقدية/التقارير/الموظفون/الإعدادات) regardless of actual permission — a `coach` or `scanner` account sees "الموظفون" (Staff) and "التقارير" (Reports) links they cannot meaningfully use. RLS prevents any actual data leak; this is a UX-clarity gap, not a security gap.

---

## 3. Major Entities (live database, `public` schema, with real row counts)

### Identity / Tenancy
- `clubs` (6 rows) — top-level tenant. `status` is administrative only (active/suspended/closed), never conflated with billing/subscription state.
- `branches` (7) — physical locations under a club.
- `profiles` (5) — 1:1 with `auth.users`.
- `club_memberships` (10) — the RLS anchor; links a user to a club with a role.
- `membership_branches` (0) — branch-scoping for a membership (empty = all branches).

### Platform billing (Platform Owner tier)
- `platform_plans` (4), `platform_subscriptions` (5, one row per billing period, trial = a `subscription_kind` value in this same table), `platform_invoices` (1), `platform_payments` (1), `automatic_trial_entitlements` (2), `contact_requests` (0), `commercial_entitlements` (1), `commercial_upgrade_requests` (0).

### People
- `customers` (31) — any person the club has a relationship with (booker or guardian or both).
- `players` (24) — academy participants, distinct from customers. `medical_notes` is permission-gated, protected via a `players_safe` view.
- `guardian_links` (22) — many-to-many, customers↔players.

### Bookings & Fields
- `fields` (9), `field_operating_hours` (33), `field_blocks` (2), `pricing_rules` (62).
- `bookings` (31) — the core operational record. A recurring booking is N real independent rows, never an expanded-pattern single row.
- `booking_series` (1) — bookkeeping-only link between recurring bookings, never financial or conflict-checking authority.

### Finance
- `invoice_number_sequences` (5), `invoices` (51, no `amount_paid` column — outstanding always derived at query time), `invoice_items` (50), `payments` (36, no `invoice_id` column — `payment_allocations` is the only bridge), `payment_allocations` (35), `refunds` (3, append-only), `payment_method_configs` (6), `manual_payment_claims` (0), `cash_shifts` (1), `payment_reconciliations` (1), `payment_gateway_configs` (1), `payment_gateway_transactions` (0), `invoice_verification_tokens` (6).

### Academy
- `programs` (5), `seasons` (3), `age_groups` (4), `groups` (6), `group_schedule_slots` (8), `enrollments` (22), `subscriptions` (21), `subscription_freezes` (1), `training_sessions` (5), `attendance` (27).

### QR / Check-in
- `qr_credentials` (6), `qr_scan_events` (5).

### WhatsApp / Notifications
- `whatsapp_accounts` (1, zero direct RLS row access — RPC-only), `whatsapp_connection_events` (10,697), `notification_events` (14), `notification_queue` (8), `notification_consent` (1), `notification_category_settings` (0), `notification_suppressions` (0), `messaging_safety_settings` (2).

### Audit
- `audit_logs` (150) — immutable, INSERT-only via SECURITY DEFINER, no UPDATE/DELETE policy for any role ever.

---

## 4. Platform Owner Tier — Screen Inventory

*(14 routes, 10 real screens, 4 inert placeholders)*

| Screen | Route | Purpose | Tabs | Primary tables/RPCs | Problems found |
|---|---|---|---|---|---|
| PlatformOverviewPage | `/platform` | Command-center KPI dashboard | none | `clubs`, `platform_subscriptions`, `platform_payments`, `commercial_upgrade_requests`, `contact_requests`, `get_club_platform_access` (N+1 loop) | Stat cards duplicate Clubs/Trials/Alerts/Reports with **different day-window thresholds** for the same concept; N+1 RPC-per-club; "pending upgrade requests" card links to unfiltered clubs list |
| PlatformClubsPage | `/platform/clubs` | Club directory | none | `clubs`, `get_club_platform_access` (N+1 loop) | Hard `limit(100)`, no pagination indicator; no search/filter; same N+1 pattern |
| PlatformClubDetailPage | `/platform/clubs/:clubId` | Club 360 — subscription lifecycle, billing, entitlements, upgrade requests, audit | 4 tabs: سجل الاشتراكات / الفواتير والمدفوعات / طلبات الترقية / سجل التدقيق | `platform_subscriptions`, `platform_invoices`+`platform_payments`, `commercial_entitlements(_usage)`, `commercial_upgrade_requests`, `audit_logs`; 8 RPCs + 2 direct-table writes | Does 4+ unrelated jobs in one screen; 2 RPCs (`change_platform_plan`, `record_platform_payment`) hardcode reason/method instead of collecting user input; grace-period extension hardcoded to 14 days; inconsistent RPC-vs-direct-write access pattern |
| PlatformOwnersPage | `/platform/owners` | Club-owner directory (all clubs) | none | `get_platform_club_owners` RPC | An owner with 3 clubs appears as 3 unrelated rows — no person-level grouping/profile |
| **PlatformSubscriptionsPage** | `/platform/subscriptions` | **Placeholder — dead end** | — | none | Real nav item, zero functionality; real subscription mgmt lives in Club Detail |
| PlatformPlansPage | `/platform/plans` | Plan catalog CRUD (partial) | none | `platform_plans` | No drill-down to subscribed clubs; no create/delete; inconsistent RPC-vs-direct-write |
| **PlatformPaymentsPage** | `/platform/payments` | **Placeholder — dead end** | — | none | Real payment recording lives buried in Club Detail's invoices tab |
| **PlatformRenewalsPage** | `/platform/renewals` | **Placeholder — dead end** | — | none | Real renewal data scattered across Alerts + Reports + Club Detail |
| PlatformTrialsPage | `/platform/trials` | Platform-wide trial list | none | `platform_subscriptions` filtered `trial` | Club name **not** a link (inconsistent with every sibling screen) |
| PlatformLeadsPage | `/platform/leads` | Contact-request inbox | none | `contact_requests` | Fetches `email`/`message` but never renders them — dead data; "converted" status has no actual conversion workflow |
| PlatformReportsPage | `/platform/reports` | 5 platform-wide reports | 5 tabs: الاشتراكات/الإيرادات/التجديدات/النمو/الاستخدام | `platform_subscriptions`, `platform_payments`, `clubs`, `branches`, `club_memberships` | **Raw enum shown to user** (`clubs.status` unmapped in النمو tab); Revenue tab is a flat payment list, not actually grouped by month despite the column header; **zero row links to Club Detail across all 5 tabs**; no export |
| PlatformAlertsPage | `/platform/alerts` | Rule-based subscription alert feed | none (flat cards) | `platform_subscriptions`, `clubs` | Duplicates Reports' renewal tab and Overview's expiry stat with 3 different day-thresholds; no acknowledge/snooze |
| PlatformAuditPage | `/platform/audit` | Platform-wide audit trail (200 rows) | none | `audit_logs` | Club name not linked (same gap as Trials); raw `action`/`entity_type` values unmapped; hard 200-row cap, no filter/pagination |
| **PlatformSettingsPage** | `/platform/settings` | **Placeholder — dead end** | — | none | No platform-level config screen exists at all |

**Navigation:** `PlatformLayout` sidebar — 13 flat items, no sectioning, icon reuse (`Sparkles` for both Plans and Trials), 4 of 13 are dead-end placeholders interleaved with real screens, no live badge/count signal despite Overview already computing exactly those numbers.

**Shared modules:** only `src/features/platform/labels.ts` (2 label maps) is actually centralized; `CLUB_STATUS_LABELS` and `ACCESS_TONE`/`ACCESS_LABEL` are each duplicated verbatim across 2 files instead of being in this shared module. No shared data-fetching hooks exist anywhere in this tier — every screen defines its own local fetch function.

---

## 5. Club/Venue Staff Tier — Screen Inventory

*(12 routes + 1 outside `/app`)*

| Screen | Route | Role gating | Tabs | Primary tables/RPCs | Problems found |
|---|---|---|---|---|---|
| TodayPage | `/app` | Renders differently per role via booleans (isManager/isReception/isCoach/isOwner) | n/a (conditional panels) | `get_today_dashboard` RPC, `subscriptions`, `training_sessions`, `customers` | Does 4 distinct jobs in one component (ops board, KPI dashboard, academy-risk panel, owner finance panel) gated by boolean flags, not separate screens |
| BookingsPage / BookingsMobileView | `/app/bookings` | Not gated (RLS-only) | none (sheets: Quick Booking / Booking Detail) | `fields`, `branches`, `bookings`, `field_blocks`, `field_operating_hours`, `resolve_field_price` RPC | Booking Detail has no "collect payment" action — must navigate to Billing and find the invoice manually |
| AcademyPage | `/app/academy` | `coach` bypasses entirely to `CoachTodayView` | 4 tabs: نظرة عامة / اللاعبون / البرامج والمجموعات / التسجيلات والاشتراكات | `players_safe`, `guardian_links`, `enrollments`, `groups`, `training_sessions`, 5+ RPCs | 4 fully independent CRUD subsystems in one page; `ActivationPolicySetting` mounted here **and** in Settings (same component, two places) |
| CustomersPage | `/app/customers` | Not gated | none (dialogs: create/edit, detail) | `customers`, `outstanding_invoices`, `get_invoice_payment_summary` | No "customer 360" — financial/booking history scattered across Customers, Billing, Outstanding, Academy |
| BillingPage | `/app/billing` | Not gated | none (functionally 5 unrelated jobs in dialogs) | `invoices`, `manual_payment_claims`, `payment_allocations`, `payments`; RPCs: verify/record/refund/void/QR | Single largest file (~760 lines); claims review + invoice browsing + payment collection + refunds + voiding all in one screen with no internal separation |
| CashShiftPage | `/app/cash-shift` | Not gated (server enforces one-open-per-branch) | none | `cash_shifts`, RPCs: get/open/close | Separate top-level nav item splitting money-reconciliation across 4+ screens |
| SubscriptionPage | `/app/subscription` | Not gated | none | `club_platform_subscription_summary`, `public_plans` | **Not linked from any nav** (only reachable via a banner); duplicates `PlatformSubscriptionCard` inside Settings almost entirely |
| **OutstandingPage** | `/app/outstanding` | Not gated | none | `outstanding_invoices` view | **Completely unreachable from any navigation** — not in sidebar, mobile nav, or MorePage. Fully built, zero discoverability. |
| ReportsPage | `/app/reports` | Not gated | **9 tabs**: نظرة عامة/الإيرادات/الحجوزات/التحصيلات/تسوية طرق الدفع/الاستثناءات المالية/إشغال الملاعب/الأكاديمية/العملاء | 9 distinct report RPCs | **The single most crowded screen in the tier.** 3 of the 9 tabs are financial-reconciliation variants that conceptually overlap; duplicates TodayPage's manager KPIs and OwnerFinanceTransparency |
| StaffPage | `/app/staff` | Not gated | none | `club_memberships`, `roles`, `membership_branches`, invite/deactivate RPCs | No edit-role/edit-branch-scope after invite — only deactivate |
| SettingsPage | `/app/settings` | 2 of 8 sections gated to owner/manager | **8 unrelated sections** in one linear scroll: النادي / إعدادات الحجوزات / إعدادات الأكاديمية / الموظفون (stub link only) / المدفوعات / الإشعارات (**WhatsApp lives here**) / اشتراك المنصة / الأمان وسجل التدقيق | 9+ sub-tables across all sections | **The clearest confirmed instance of the directive's core hypothesis** — a club owner scrolls past WhatsApp rate-limit config to reach the audit log. "الموظفون" section is a stub card, not real settings. |
| ScanPage | `/scan` | Not gated (server outcome-based) | none | `training_sessions`, RPCs: qr_validate/confirm_checkin/mark_attendance | Well-scoped, no major issues |
| MorePage | `/app/more` | Not gated | none (nav only) | none | Mirrors sidebar minus Bookings/Today/Academy/Scan; **omits Outstanding** |

**Navigation:** `AppLayout` — 9-item desktop sidebar (not role-filtered), 5-item mobile bottom nav (اليوم/الحجوزات/مسح/الأكاديمية/المزيد). `/app/outstanding` and `/app/subscription` have no nav entry anywhere.

**Shared modules (`src/lib/domain/`):** `billing.ts` (centralizes `fetchInvoicePaymentSummaries` — the single documented fix for a previously-5x-duplicated outstanding-balance bug), `booking.ts`, `academy.ts`, `fields.ts`, `membership.ts`, `people.ts`, `staff.ts`, `time.ts` (venue-timezone-aware, prevents the documented naive-UTC bug class). These are genuinely well-centralized — the problem in this tier is screen/nav organization, not duplicated business logic.

---

## 6. Customer Portal Tier — Screen Inventory

*(5 routes, 1 without a dedicated path)*

| Screen | Route | Purpose | Tabs | Primary tables/RPCs | Problems found |
|---|---|---|---|---|---|
| PortalRoot → ClaimAccountPage / PortalBookingsPage | `/portal` | Gate + de-facto home | none | `customers`, `find_claimable_customer`/`claim_customer_self_service` RPCs, `bookings` | `PortalBookingsPage` has no dedicated route; booking cards show no payment/outstanding status and no link to invoice or QR |
| PortalAcademyPage | `/portal/academy` | Guardian's linked players + enrollment/subscription status | none | `guardian_links`, `players`, nested `enrollments`/`subscriptions` | Silently shows only the *first* active enrollment/subscription if a player has more than one; no link to that player's invoices |
| PortalQrPage | `/portal/qr` | Generate check-in QR for a selected upcoming booking | none | `bookings`, `ensure_booking_qr` RPC | Includes `pending_payment` bookings in the selector with no payment-status indicator; duplicate mini-list of the same bookings already on Home instead of a "View QR" action on the booking card itself |
| PortalPaymentsPage | `/portal/payments` | Invoice list + manual payment claim submission | none (dialog: claim payment) | `invoices`, `payment_method_configs`, `claim_manual_payment` RPC | No invoice line-item detail; **no link from a booking to its invoice or vice versa** — two disconnected lists requiring manual date/amount matching; no visibility into a submitted claim's review status |
| PortalProfilePage | `/portal/profile` | Edit contact info | none | `customers` (direct update, RLS-protected) | Silently shows/edits only the *first* linked customer record if a guardian has links across multiple clubs, with no club selector |

**Navigation:** `PortalLayout` — single fixed 5-item bottom nav (حجوزاتي/أكاديميتي/مدفوعاتي/رمزي/حسابي) at all breakpoints, no desktop-specific variant.

**Core cross-cutting portal problem confirmed:** zero cross-links between bookings ↔ payments ↔ QR ↔ academy — every screen is an isolated read-only list requiring the customer to manually correlate by date/amount across tabs.

---

## 7. WhatsApp — Current State (confirmed, not hypothetical)

**Where it lives today:** entirely inside `SettingsPage` → "الإشعارات" section (2 of 8 sections on that page) — `WhatsAppConnectionCard` (connection lifecycle: QR pairing, status, disconnect) + `MessagingSafetyCard` (category toggles, quiet hours, rate limits, circuit breaker, **aggregate-only** queue diagnostics).

**Confirmed NOT exposed anywhere in staff UI, despite existing server-side:**
- Per-message send log/history (only aggregate pending/retrying/failed/sent **counts** are shown — no "what was sent to whom, when, with what content")
- Template preview (6 fully-composed AR/EN templates exist in `whatsapp-connector/src/templates.ts`, invisible to staff)
- Self-test / "send test message" tooling
- Any contextual delivery status inside a booking, customer, or invoice screen — grepped `src/features/bookings`, `src/features/customers`, `src/features/billing`: **zero WhatsApp activity references** anywhere outside Settings. `CustomersPage` only shows the customer's stored WhatsApp *phone number* as static contact data, never delivery status.

This is the clearest, most literal confirmation of the directive's WhatsApp hypothesis: it is a Settings feature today, with no contextual integration anywhere else in the product.

---

## 8. Confirmed Cross-Cutting Problems (evidence-backed, not speculative)

1. **No role-based nav filtering** — `AppLayout`'s own code comment admits this was planned and never built.
2. **`OutstandingPage` is fully built and completely orphaned from navigation.**
3. **Financial reconciliation is fragmented across 5+ screens** with overlapping concepts: BillingPage (invoice-level), CashShiftPage (cash-drawer level), OutstandingPage (dues list), ReportsPage's التحصيلات/تسوية طرق الدفع/الاستثناءات المالية (3 tabs), TodayPage's OwnerFinanceTransparency (today-only duplicate of a Reports tab).
4. **Club's own SaaS subscription status is duplicated in two full implementations** — `SubscriptionPage` (unlinked from nav) and `PlatformSubscriptionCard` inside Settings.
5. **`ActivationPolicySetting` is mounted in two unrelated screens** (Academy tab + Settings) — the exact same control.
6. **`SettingsPage` — the screen explicitly rebuilt in an earlier phase to fix "dumping ground" — has re-accumulated the same problem**: 8 unrelated administrative domains (club identity, physical infrastructure, academy policy, staff stub, payments, WhatsApp/messaging, SaaS subscription, security audit) in one linear scroll.
7. **`ReportsPage`'s 9 tabs** is the single most crowded screen in the entire product.
8. **`BillingPage`** does 5 distinct jobs (claims review, invoice browsing, payment collection, refunds, voiding) in one ~760-line file with no internal separation.
9. **Platform Owner sidebar: 4 of 13 items are dead-end placeholders**, interleaved with real screens rather than grouped or removed.
10. **`PlatformReportsPage`'s 5 tabs have zero drill-down to `PlatformClubDetailPage`**, despite every row in every tab being keyed by club — the single largest dead-end in the Platform Owner tier.
11. **Raw enum values leak to users** in two confirmed places: `PlatformReportsPage`'s Growth tab (`clubs.status` unmapped) and `PlatformAuditPage`/Club Detail's audit tab (`action`/`entity_type` unmapped). `FieldsManagement`'s sport field is free-text with no label dictionary, inconsistent with every other status/type value in the app.
12. **Portal has zero cross-linking** between bookings, payments, QR, and academy — four isolated lists.
13. **Two data-loss-shaped bugs found**: `PortalAcademyPage` silently drops all but the first active enrollment/subscription per player; `PortalProfilePage` silently shows/edits only the first linked customer record for a multi-club guardian.
14. **Inconsistent RPC-vs-direct-table-write access pattern** in `PlatformClubDetailPage` and `PlatformPlansPage` — some mutations go through RPCs, siblings on the same screen bypass to direct table writes, for no apparent architectural reason.
15. **Dead/duplicated code**: `PlatformLeadsPage` fetches `email`/`message` fields it never renders; `AuditLogPage` wrapper component has no registered route (only its extracted `AuditLogSection` is reachable).

---

## 9. What Is Already Working Well (do not disturb)

- The financial-summary bug class (5 independently-reimplemented outstanding-balance formulas) was already found and fixed earlier this session via `fetchInvoicePaymentSummaries()` / `get_invoice_payment_summary()` — every consumer screen now reads the same single source. This is the correct pattern; extend it, don't replace it.
- `src/lib/domain/*` shared modules for booking/billing/academy/fields/people/staff/time are genuinely well-centralized with real label-dictionary discipline in most places.
- `has_permission()`-based RLS/RPC authorization is consistently applied server-side across almost the entire schema — the IA problems found are navigation/screen-organization problems, not security or business-logic duplication problems.
- Venue-timezone-aware date/time handling (`src/lib/domain/time.ts`) is correctly centralized and used everywhere that matters.
- The Owner-Level Review completed immediately before this task (see `PROFESSIONAL_OWNER_REVIEW_STATE.md`) already fixed 13 real defects including the `payment.refund` permission split, RTL bidi issues, and several confirmation-dialog gaps — this IA work builds on top of that clean baseline, not instead of it.

---

*Next: `MAL3ABY_INFORMATION_ARCHITECTURE.md` — target IA design based on the findings above.*
