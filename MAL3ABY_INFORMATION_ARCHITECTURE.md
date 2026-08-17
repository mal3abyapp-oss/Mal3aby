# Mal3aby — Target Information Architecture

Built directly from `MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md`'s confirmed findings. Every decision below traces to a specific, evidence-backed problem in that document — nothing here is invented preference.

**Core principle applied throughout:** a Tab becomes a full page when it has (a) its own primary action distinct from its siblings, (b) navigation state worth deep-linking to, or (c) enough data/complexity that it competes for attention with its siblings on the same screen. A crowded page becomes a Domain (its own nav-level concept, own route prefix) when its screens no longer share one clear purpose.

---

## 1. Target IA — Platform Owner

### Design decisions and why

**Group the sidebar, don't just reorder it.** Confirmed problem: 13 flat items, 4 dead-end placeholders interleaved with real screens, no live signal. Fix: 4 sections instead of a flat list — the placeholders are removed entirely (their promised content already exists on real screens; a nav item promising nothing is worse than no nav item).

**Remove the 4 placeholder routes**, redirecting each to where its real content already lives:
- `/platform/subscriptions` → redirect to `/platform/clubs` (subscription lifecycle lives in Club Detail; the directory is the correct list-level entry point)
- `/platform/payments` → redirect to `/platform/reports` (revenue tab)
- `/platform/renewals` → redirect to `/platform/alerts` (this is literally what Alerts already computes)
- `/platform/settings` → keep the route but build a real (small) screen: trial default days, default grace period days — the two platform-wide settings that today are hardcoded per-action (14-day grace) instead of configurable. This directly fixes the audit's finding that grace-period extension is hardcoded with no way to change the default.

**Add drill-down to `PlatformReportsPage`'s 5 tabs.** Confirmed problem: zero row-to-club links across the entire screen despite every row being club-keyed. Fix: every row gets a link to `PlatformClubDetailPage`, exactly matching the pattern Clubs/Owners/Alerts already use correctly.

**Fix the raw-enum leaks.** `clubs.status` in the Growth tab and `action`/`entity_type` in Audit — extend `src/features/platform/labels.ts` (already exists, already the right home) with the missing maps, and use it consistently (it's currently only used by 2 of the screens that need it).

**Give Overview real drill-down.** Confirmed problem: cards that don't lead anywhere specific, three independently-computed versions of "subscriptions expiring soon" with different day-thresholds. Fix: Overview's KPI cards link to Clubs/Reports/Alerts filtered to the matching set, and the alert-window computation is centralized into one function all three screens call (see §5 Canonical Metrics).

**Consolidate `CLUB_STATUS_LABELS` and `ACCESS_TONE`/`ACCESS_LABEL`** into `labels.ts` — currently duplicated verbatim in 2 files each.

### Target navigation tree

```
PLATFORM OWNER
├── نظرة عامة (Overview)                      /platform
│     KPI cards, all drilling down to the matching filtered list below
│
├── الأندية (Clubs)                            group
│   ├── كل الأندية (Directory)                 /platform/clubs
│   ├── نادٍ [Club 360]                        /platform/clubs/:clubId
│   │     tabs: سجل الاشتراكات / الفواتير والمدفوعات / طلبات الترقية / سجل التدقيق
│   └── أصحاب الأندية (Owners)                  /platform/owners
│
├── التجارة (Commercial)                       group
│   ├── الخطط (Plans)                          /platform/plans
│   └── طلبات التواصل (Leads)                   /platform/leads
│
├── المراقبة (Monitoring)                       group
│   ├── التقارير (Reports)                      /platform/reports  (5 tabs, now with drill-down)
│   ├── التنبيهات (Alerts)                      /platform/alerts   (badge count in nav)
│   ├── التجارب المجانية (Trials)                /platform/trials  (club name now linked)
│   └── سجل التدقيق (Audit)                     /platform/audit    (club name now linked)
│
└── الإعدادات (Settings)                        /platform/settings (now real: trial days, grace days)
```

Sidebar shows 4 section headers (الأندية / التجارة / المراقبة is implicit as the middle two groups, الإعدادات standalone) instead of 13 flat items. Alerts gets a live badge count (Overview already computes this number — surface it in the nav itself, per the audit's finding that the sidebar carries zero live signal today).

### What is NOT changed
`PlatformClubDetailPage`'s 4 tabs stay as tabs, not separate pages — subscription/billing/upgrade-requests/audit for ONE club is exactly the kind of tightly-scoped, single-entity-context content tabs are right for (per the core principle: they share one clear purpose — "everything about this club"). The screen's *content* gets two real fixes (stop hardcoding reason/method on 2 RPCs; make the 2 direct-table-writes use RPCs like their siblings, for consistency and audit-trail completeness) but its tab structure is correct as-is.

---

## 2. Target IA — Club/Venue Staff

### Design decisions and why

**Split `SettingsPage`'s 8 sections into Settings (true settings) + 2 relocated domains.** This is the directive's core hypothesis, now confirmed with concrete evidence. Reallocation:

| Current Settings section | Verdict | New home |
|---|---|---|
| النادي (club identity, branches) | **Stays in Settings** — genuine settings | Settings |
| إعدادات الحجوزات (fields/hours/pricing) | **Moves out** — this is operational infrastructure management, not settings, and it's already large enough (`FieldsManagement` has its own sub-dialogs) to be a first-class screen | New: الفروع والملاعب (Branches & Fields) domain |
| إعدادات الأكاديمية (activation policy) | **Stays in Settings**, but the duplicate mount inside AcademyPage is removed — Settings is now the single home for this one control | Settings only |
| الموظفون والصلاحيات (stub link) | **Removed from Settings entirely** — it was never real settings content, just a redirect card | (Staff already has its own sidebar item — this stub is deleted) |
| المدفوعات (payment methods/gateways config) | **Stays in Settings** — genuine settings (how the club accepts money is configuration, not an operational screen) | Settings |
| الإشعارات (WhatsApp connection + safety) | **Moves out entirely** — directive's explicit instruction: WhatsApp becomes a top-level module | New: واتساب (WhatsApp) domain |
| اشتراك المنصة (platform subscription) | **Stays in Settings**, but de-duplicated — `SubscriptionPage` (`/app/subscription`) becomes the canonical full view; the Settings card becomes a slim summary linking to it, not a second full implementation | Settings (slim) + `/app/subscription` (full) |
| الأمان وسجل التدقيق (audit log) | **Moves out** — audit is a monitoring/security concern, arguably closer to Reports than Settings, and deserves a real route, not a Settings section | New: `/app/audit-log` (linked from Settings' security section as a "view full log" pointer, not embedded) |

Resulting Settings page: **club identity, branches, academy activation policy, payment method configuration, a subscription summary card** — 4 genuine "how the club is configured" sections, not 8 unrelated administrative domains.

**Split `ReportsPage`'s 9 tabs into 3 groups, not 9 flat tabs.** Confirmed problem: 3 of the 9 tabs are financial-reconciliation variants that conceptually overlap (Collections, Payment-Method Reconciliation, Financial Exceptions). Fix: keep it as ONE page (reports genuinely are one domain — "read-only analysis of what already happened") but restructure the tab bar into 3 labeled groups so a manager isn't scanning 9 undifferentiated options:

```
التقارير (Reports)
├── نظرة عامة (Overview)          — executive dashboard
├── التشغيل (Operations)           — group
│   ├── الحجوزات (Bookings)
│   └── إشغال الملاعب (Occupancy)
├── المالية (Financial)            — group
│   ├── الإيرادات (Revenue)
│   ├── التحصيلات (Collections)
│   ├── تسوية طرق الدفع (Reconciliation)
│   └── الاستثناءات المالية (Exceptions)
└── الأكاديمية والعملاء (Academy & Customers) — group
    ├── الأكاديمية (Academy)
    └── العملاء (Customers)
```
This does not create new pages (reports stay tabs — they're genuinely one "look back at what happened" purpose) but groups them so the 4 financial variants read as one family with 4 lenses, not 4 unrelated tabs.

**Fix `OutstandingPage`'s total orphan status.** Confirmed: fully built, zero navigation entry points. Fix: add to sidebar (as part of the new Finance domain, see below) and to MorePage.

**Consolidate financial reconciliation.** Confirmed problem: fragmented across 5+ places. Fix: introduce a **Finance domain** at the nav level (not a rename of Billing — a grouping) that contains Billing, Cash Shift, Outstanding, and links to the Financial report group:

```
المالية (Finance)                   — new nav group
├── الفواتير والمدفوعات (Billing)    /app/billing
├── المستحقات (Outstanding)          /app/outstanding   [was orphaned, now placed]
├── وردية النقدية (Cash Shift)        /app/cash-shift
└── → التقارير المالية (link into Reports' Financial tab group)
```
`OwnerFinanceTransparency` (TodayPage's owner-only panel) stays where it is — "today's numbers at a glance on the dashboard" is a legitimate, distinct use case from "full reconciliation," per the core principle (it has its own purpose: fast daily glance, not deep analysis). It already correctly links out to Reports for depth.

**Split `BillingPage`'s 5 jobs.** Confirmed problem: claims review + invoice browsing + payment collection + refunds + voiding all in one ~760-line file with no internal separation. Fix: keep ONE route (`/app/billing` — invoice management is genuinely one workflow, payment/refund/void are all *actions on an invoice*, not separate domains) but add a persistent top strip for "طلبات الدفع المعلقة" (pending claims) as its own always-visible section (not buried until scrolled to) rather than mixed into the general list — this was already identified in the audit as visually present but not separated. The invoice detail dialog's payment/refund/void actions stay as dialog actions on that invoice (correct — they are actions on one entity, not separate pages).

**Add a "collect payment" action directly to `BookingDetailSheet`.** Confirmed gap: staff must navigate away to Billing and manually find the invoice. Fix: the sheet's outstanding-amount display gets a "تحصيل الدفعة" button that opens the same payment-recording flow BillingPage uses (shared component, not duplicated logic), operating on that booking's linked invoice directly. This is exactly what Booking 360 needs per the directive.

**WhatsApp becomes a top-level nav item**, per the directive's explicit instruction. See §4.

**Role-filter the sidebar.** Confirmed gap: zero role-filtering despite a code comment saying it was planned. Fix: each `NavItem` gets a `requiredPermission` field checked against the current membership's actual permission set (already computed server-side and available client-side via `currentMembership`) — an item renders only if the role has at least one permission relevant to that domain. This is additive (no route/permission changes), purely a nav-visibility fix.

### Target navigation tree

```
CLUB / VENUE STAFF
├── اليوم (Today)                              /app                [all roles, content varies]
├── الحجوزات (Bookings)                          /app/bookings       [booking.view+]
├── العملاء (Customers)                          /app/customers      [customer.view+]
├── الأكاديمية (Academy)                          /app/academy        [enrollment.view+ or coach → CoachTodayView]
├── المالية (Finance)                            group               [payment.view+ / invoice.view+]
│   ├── الفواتير والمدفوعات                       /app/billing
│   ├── المستحقات                                /app/outstanding
│   └── وردية النقدية                             /app/cash-shift
├── التقارير (Reports)                           /app/reports        [report.view]   (3 tab-groups, see above)
├── واتساب (WhatsApp)                            /app/whatsapp       [manage_whatsapp_connection or notification.view]
├── الموظفون (Staff)                              /app/staff          [staff.create/update]
├── الإعدادات (Settings)                          /app/settings       [club_owner/club_manager primarily, scoped sections]
└── المزيد (More, mobile only)                    /app/more           [mirrors sidebar minus primary 4]
```

Mobile bottom nav unchanged in principle (اليوم/الحجوزات/مسح/الأكاديمية/المزيد — already correctly minimal per the directive's own guidance to pick the most-used items), but **المزيد now includes المستحقات and واتساب**, which it previously omitted (Outstanding was missing entirely; WhatsApp didn't exist as a standalone destination).

`/app/subscription` gets a real nav presence for the first time — as a `Settings` sub-link, not a hidden banner-only page.

---

## 3. Target IA — Customer Portal

### Design decisions and why

**Give `PortalBookingsPage` its own route.** Confirmed problem: no dedicated URL, coupled to claim-gate logic. Fix: `/portal/bookings` becomes real; `/portal` index still does the claim-gate check but redirects to `/portal/bookings` once linked, rather than rendering the bookings page inline. This makes the home screen bookmarkable and consistent with its 4 siblings.

**Cross-link booking ↔ invoice ↔ QR.** Confirmed core problem: zero cross-links, customer manually correlates by date/amount. Fix, minimal and additive (no new screens needed — the data already exists in each screen's query):
- Each booking card on `/portal/bookings` gets: payment-status badge (reusing `PAYMENT_STATUS_LABELS`, already shared with staff side) + a "عرض رمز QR" link that pre-selects that booking on `/portal/qr` (via a query param) + a "عرض الفاتورة" link that scrolls/filters `/portal/payments` to that invoice (via a query param).
- This avoids inventing a "Booking 360" full-detail page for the customer (unnecessary complexity for what's fundamentally a short list) while still solving the actual cross-linking gap.

**Fix the two silent-data-drop bugs** (confirmed, not a design choice): `PortalAcademyPage` shows only the first active enrollment/subscription per player → show all of them, most-recent-first, each with its own status badge. `PortalProfilePage` shows only the first linked customer record → add a club selector when a guardian has links across multiple clubs (mirroring the staff-side club switcher pattern already established in `AppLayout`).

**Do not add navigation complexity.** Per the directive: "Customer navigation must be much simpler" — the 5-item bottom nav stays exactly as-is structurally. The fixes above are entirely inside existing screens, not new destinations.

### Target navigation tree

```
CUSTOMER
├── حجوزاتي (Bookings — now /portal/bookings, real route)
│     each card: status + payment badge + [QR] + [Invoice] cross-links
├── أكاديميتي (Academy — now shows ALL enrollments/subscriptions per player)
├── مدفوعاتي (Payments)
├── رمزي (QR — deep-linkable from a specific booking)
└── حسابي (Profile — now with a club selector if multi-club)
```

---

## 4. WhatsApp — Target Module Design

Per the directive: a top-level module, not a Settings feature, but still connected to the rest of the system.

### Target structure (staff side, `/app/whatsapp`)

```
واتساب (WhatsApp)
├── نظرة عامة (Overview)     — connection state, connected number, last connection, sent/queued/failed counts
├── النشاط (Activity)        — NEW: per-message log — recipient, type, linked booking/payment, sent/failed, attempts, WITH links back to the source booking/payment
├── الاتصال (Connection)     — what WhatsAppConnectionCard already does (QR pairing, disconnect) — moved here verbatim
└── الإعدادات (Settings)     — what MessagingSafetyCard already does (categories, quiet hours, rate limits, circuit breaker) — moved here verbatim
```

**Why 4 sub-tabs, not more:** the directive explicitly warns against creating empty pages "just to organize." Templates preview and self-test tooling (confirmed absent from the UI, confirmed to exist server-side) are deliberately **not** added as new tabs in this pass — they're real gaps but adding UI for them is new feature work, not IA restructuring; flagged in §7 as a recommendation, not built here, to stay within the actual scope of this task (reorganizing what exists, preserving all current functionality, not inventing new features).

**The "النشاط" (Activity) tab is the one genuinely new screen this module needs** — it's what makes WhatsApp "connected to the rest of the system" per the directive's explicit requirement, and the data it needs (`notification_queue` rows with `event_id`/`recipient_customer_id`) already exists; only a read-only list view is new, not new backend capability.

### Contextual integration (the connected part)

- `BookingDetailSheet` gets a small "الإشعارات" summary line: "تأكيد الحجز: أُرسل ✓" / "لم يُرسل بعد" — sourced from `notification_queue` filtered by that booking's `event_id`s, with a "عرض النشاط" link into `/app/whatsapp` → Activity tab pre-filtered to this booking. This is exactly the directive's specified pattern ("Confirmation sent ✓ ... View WhatsApp activity").
- `CustomerDetailDialog` gets the same summary pattern, scoped to that customer.
- Full management (retry, diagnostics, safety settings) stays exclusively in the WhatsApp module — the booking/customer surfaces are summary-only, per the directive.

---

## 5. Financial Relationship & Canonical Metrics

### Entity chain (confirmed real, from the audit's entity inventory)
```
CUSTOMER
   ↓
BOOKING  (or ENROLLMENT → SUBSCRIPTION, for academy)
   ↓
INVOICE           (invoice_items — no amount_paid column, always derived)
   ↓
PAYMENT_ALLOCATION (the only bridge — payments has no invoice_id)
   ↓
PAYMENT
   ↓
REFUND            (append-only, never mutates payments.amount)
```
This chain is already correctly modeled in the schema and already has one canonical read path: `get_invoice_payment_summary()` / `fetchInvoicePaymentSummaries()`. **No schema or RPC changes are needed here** — the fix is entirely about which screens call this canonical function versus reimplementing it, and the audit found this is already mostly consistent (the one exception: `PlatformClubDetailPage`'s billing math is a separate platform-tier concept — platform invoices are Mala3by's own SaaS billing, correctly a different entity chain, not a violation).

### Canonical metric definitions (to prevent the audit's confirmed multi-threshold duplication)

| Metric | Canonical source | Currently duplicated in (to be pointed at the canonical source) |
|---|---|---|
| "Subscription expiring soon" window | One shared constant/function (e.g. `get_platform_subscription_urgency()` or a shared TS constant consumed by all 3 call sites) — **7 days for paid, 3 days for trial**, matching the majority existing convention (Alerts' definition, the most carefully-considered of the three) | Overview (flat 7d for all), Alerts (3d trial/7d paid), Reports renewal tab (no fixed threshold, just color-coded) |
| Outstanding balance | `get_invoice_payment_summary()` | Already canonical — no change needed |
| Today's collections | `get_collections_report()` | OwnerFinanceTransparency (today-filtered) and Reports' التحصيلات tab (date-range) — same RPC, different date param, not a duplication, just two legitimate views |
| Club administrative status vs subscription access status | Two genuinely distinct concepts (`clubs.status` vs `get_club_platform_access()`) — **not to be merged**, but every screen that shows either must use the SAME two labels/badges (extend `labels.ts`) so "موقوف إداريًا" and "بوصول موقوف" never get abbreviated or reworded differently screen-to-screen | Overview (2 separate stat cards, previously ambiguous — already partially fixed this session, extend the same fix everywhere) |

### Timezone
Already correctly centralized via `src/lib/domain/time.ts` + `clubs.timezone`. No changes needed — confirmed working, used consistently in Bookings/QuickBookingSheet/BookingDetailSheet. **Extend the same pattern to the Portal and WhatsApp Activity tab** (both currently new/touched screens) rather than introducing a second time-handling approach.

---

## 6. Role Navigation Summary

| Role | Sees in sidebar (after permission-filtering) |
|---|---|
| `club_owner` | Everything |
| `club_manager` | Everything except platform-subscription mutation actions (view-only there) |
| `branch_manager` | Today, Bookings, Customers, Academy, Finance (Billing/Cash Shift, no refund action), Reports (view), Staff (view own branch only) — no Settings beyond their own profile |
| `receptionist` | Today, Bookings, Customers, Finance→Billing (create/verify, no refund), no Reports, no Staff, no Settings, no WhatsApp management (view-only if `notification.view` granted) |
| `accountant` | Today (limited), Finance (full, including refund), Reports, no Bookings creation, no Staff, no Settings, no WhatsApp |
| `academy_manager` | Today, Academy (full), Customers, Reports (view), no Bookings (field-booking), no Finance beyond invoice creation, no Staff |
| `coach` | Today (→ CoachTodayView directly, unchanged), Academy (session/attendance only), Scan — narrowest nav of any staff role |
| `scanner` | Scan only — no sidebar at all beyond the kiosk scan screen (matches its single-permission scope exactly) |

This directly fixes the audit's confirmed gap: today every one of these roles sees all 9 items regardless of relevance.

---

## 7. Explicitly Out of Scope for This Pass

Per the directive's own instruction not to invent new features while restructuring, and to preserve all current functionality:

- WhatsApp template preview/editing UI — real gap, not built here (flagged for a future task)
- WhatsApp "send test message" tooling — same
- Per-owner (person-level, not per-club-row) profile page on `PlatformOwnersPage` — real gap, not built here
- Lead-to-club conversion workflow on `PlatformLeadsPage` — real gap, not built here
- Staff edit-role-after-invite capability — real gap, not built here
- Platform Plans full CRUD (currently only publish-toggle + name/price edit) — not expanded here

These are genuine product gaps the audit surfaced, distinct from IA/navigation problems — recorded here so they aren't lost, but not implemented as part of restructuring existing screens.

---

## 8. Migration Plan (phase order)

Matches the directive's suggested order, adjusted only where this codebase's actual dependency graph requires a different sequence (e.g., shared nav-permission-filtering logic must land before per-role nav trees can be verified):

1. ~~Audit~~ — done (`MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md`)
2. ~~Target IA~~ — done (this document)
3. Shared navigation foundation — permission-filtering helper for `AppLayout`, section-grouping for `PlatformLayout`'s sidebar, `labels.ts` extensions (enum→label maps for the confirmed raw-enum leaks)
4. Platform Owner — remove/redirect 4 placeholders, add Reports drill-down, real Platform Settings screen, RPC consistency fixes on Club Detail/Plans
5. Club Settings restructure — extract WhatsApp and Fields/Booking-rules out, remove the staff stub card, de-duplicate `ActivationPolicySetting` and the subscription card
6. Finance domain grouping — nav-level grouping of Billing/Outstanding/Cash Shift, Outstanding added to nav
7. Reports tab-grouping — 9 tabs → 3 labeled groups, no route changes
8. WhatsApp module — new `/app/whatsapp` route with 4 tabs, contextual summary lines added to Booking Detail + Customer Detail
9. Booking 360 — "collect payment" action added to `BookingDetailSheet`
10. Customer Portal — `/portal/bookings` real route, cross-links between booking/QR/payments, the two silent-data-drop fixes
11. Role-based nav visibility — apply the permission-filtering foundation from step 3 across every role
12. Full regression — tsc/build/lint/tests + live verification of every moved feature, matching this session's established discipline

Each phase: verify → commit → update `MAL3ABY_IA_RESTRUCTURE_STATE.md` → continue immediately, no pause between phases.

---

## 9. No-Feature-Lost Checklist

Every feature currently reachable remains reachable after restructuring — this table is the audit trail for that guarantee, filled in as each phase completes in `MAL3ABY_IA_RESTRUCTURE_STATE.md`:

| Feature | Old location | New location |
|---|---|---|
| WhatsApp connection (QR/disconnect) | Settings → الإشعارات | `/app/whatsapp` → الاتصال |
| WhatsApp safety settings | Settings → الإشعارات | `/app/whatsapp` → الإعدادات |
| Fields/hours/pricing management | Settings → إعدادات الحجوزات | New `/app/fields` (Branches & Fields domain) |
| Audit log (club-side) | Settings → الأمان وسجل التدقيق | `/app/audit-log` (linked from Settings) |
| Platform Subscriptions nav item | Placeholder | Redirect → `/platform/clubs` |
| Platform Payments nav item | Placeholder | Redirect → `/platform/reports` |
| Platform Renewals nav item | Placeholder | Redirect → `/platform/alerts` |
| Platform Settings nav item | Placeholder | Real screen (trial/grace defaults) |
| Outstanding page | Built, unlinked | Finance domain, sidebar + MorePage |
| Activation policy setting | Academy tab AND Settings (duplicate) | Settings only |
