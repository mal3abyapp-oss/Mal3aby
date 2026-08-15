# Design System

> **Added 2026-08-15 (final pre-implementation)** as part of the Final Pre-Implementation Directive. This is the mandatory visual foundation — built before any real screen implementation begins, per [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) Phase 1. Read together with [SCREEN_MAP.md](SCREEN_MAP.md) (which screens exist) and [USER_FLOWS.md](USER_FLOWS.md) (how they connect).

## Brand Direction

Mala3by must read as a **Modern Sports Operations SaaS** — not an old-style ERP, not a gaming/consumer sports app.

**Personality:** Modern · Strong · Operational · Fast · Premium · Clean · Confident · Sports-oriented · Professional · Arabic-first.

**Explicitly not:** Childish, gaming UI, football-only (the product serves multiple sports and business types), over-animated.

## Color Tokens

Design-direction starting values — treated as a direction to validate during Design QA (Phase 1), not immutable hex codes. A shade may be nudged for contrast/legibility while keeping the same brand identity.

```
--color-dark-base:       #0B1220   /* primary dark surface — sidebar, platform console dark areas */
--color-dark-secondary:  #111827   /* secondary dark surface */
--color-accent:          #B7F34A   /* electric lime / sports green — primary actions, CTAs */
--color-page-bg:         #F7F8FA   /* light content page background */
--color-surface:         #FFFFFF   /* cards, panels */
--color-text-primary:    #111827
--color-text-secondary:  #667085
```

**Semantic status tokens** — used for booking/subscription/payment/alert status, never a bespoke color per screen:

```
--status-success   (confirmed, paid, active, checked-in)
--status-warning    (pending, expiring soon, grace period)
--status-danger     (cancelled, overdue, expired, void)
--status-info        (informational, upcoming)
--status-neutral     (draft, inactive, no-show)
```

**Status is never color-only.** Every status indicator pairs its color with an icon and a text label (see [DECISIONS.md](DECISIONS.md) Accessibility principles) — a colorblind user or a low-contrast screen in bright daylight must still be able to read a booking's state from the label alone.

## Typography

- **Arabic:** IBM Plex Sans Arabic (open, professional, free) — primary typeface, since the product is Arabic-first.
- **English/Latin:** Inter (open, free) — used for English UI text and numerals where appropriate.
- No paid font dependency, ever, consistent with [PROJECT_RULES.md](PROJECT_RULES.md) rule 4.

**Scale** (fixed set — not 15 ad hoc sizes across the app):

```
Display   — hero headlines, marketing only
H1        — page titles
H2        — section headers
H3        — card/panel headers
Body      — default UI text
Small      — secondary/meta text
Caption    — labels, timestamps, fine print
Numeric KPI — dashboard stat figures, a distinct weight/size for scannable numbers
```

## Spacing, Radius, Shadow

- **Spacing:** one consistent scale (e.g. 4/8/12/16/24/32/48px) used everywhere — no per-screen ad hoc margins/padding.
- **Radius:** medium/modern, not maximal — direction: `8px` (inputs, small elements), `12px` (cards), `16px` (larger panels/dialogs). Not everything is a pill.
- **Shadows:** subtle only — no heavy glassmorphism, no exaggerated glow. Shadows exist to establish elevation (card above page, dialog above app), not as a decorative effect.

## Icon System

One icon system throughout — no mixing. An open-source, monoline icon library (e.g. Lucide or an equivalent open set already common with shadcn/ui) at a consistent `24×24` size, consistent stroke weight, consistent optical weight. **No emoji as UI icons, no mixed styles, no ad hoc SVGs** pulled from different sources with inconsistent visual weight.

## RTL & Internationalization

Every component is built RTL-correct from the start — **not** built LTR-first and mirrored later. Use CSS logical properties (`margin-inline-start`, not `margin-left`) throughout, exactly as already established in [ARCHITECTURE.md](ARCHITECTURE.md#ui--ux-architecture). Architecture stays i18n-ready, but V1 content is Arabic-first per [DECISIONS.md ADR-010](DECISIONS.md#adr-010--arabic-first-content-english-best-effort-toggle) — English content is not duplicated everywhere right now if it isn't load-bearing.

## Accessibility Baseline

Contrast (WCAG AA as a practical target, not a formal certification requirement), visible keyboard focus states, proper form labels, semantic HTML (real `<button>`/`<table>`/`<nav>`, not div soup), touch target sizing (see Responsive Rules below), and — restated from the color tokens section — status is never conveyed by color alone.

## Performance UX

No heavy animation libraries, no background video, no heavy visual effects in the core operational app. This is a tool people use dozens of times a day under time pressure — visual weight that doesn't aid comprehension is a cost, not a feature. (The public marketing site has slightly more room for a polished hero visual — see [Public Website Visual System](#public-website-visual-system) — but even there, nothing that meaningfully slows load or distracts from the CTA.)

**Design-level UX targets** (design targets, not hard technical guarantees — see [ARCHITECTURE.md](ARCHITECTURE.md#performance-principles) for the technical performance principles):

```
Repeat-customer booking:  30–45 seconds
QR check-in:              ≤ 5 seconds
Collect payment:          ≤ 20 seconds
Attendance marking:       one tap per player
```

## App Shell — Desktop

```
Sidebar + Top Bar + Main Workspace
```

Sidebar items (rendered per the caller's permissions — an item the user cannot act on is not shown, matching [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#permission-state) "if no permission, don't show the action"):

```
Today · Bookings · Academy · Customers · Payments · Invoices · Reports · Club · Staff · Settings
```

**Density:** comfortable, not sparse — this is a tool for operators who need real information density, not a marketing page. Avoid oversized "hero cards" for routine data; avoid true ERP-style cramming either. See [SCREEN_MAP.md](SCREEN_MAP.md) for the full desktop navigation.

## Tablet Rules

Tablet is not a shrunk desktop. Specifically:

- Collapsible sidebar (icon-only or fully hidden behind a toggle)
- Larger touch targets than desktop's mouse-oriented sizing
- Drawers/sheets instead of dense inline panels where space is tight
- The Booking Calendar grid is specifically optimized for tablet touch interaction (see [Booking Calendar Design](#booking-calendar-design))
- All interactive controls are touch-safe (no controls that assume hover-to-reveal as the only path to an action)

## Mobile Rules

Bottom navigation:

```
Today · Bookings · Scan · Academy · More
```

`Scan` is visually prominent (center position or otherwise emphasized) — it's a high-frequency reception/gate action, matching [SCREEN_MAP.md](SCREEN_MAP.md)'s existing mobile navigation.

**Priority:** Reception and Coach workflows are mobile-first — these roles work standing up, moving around a facility, phone in hand. Admin/configuration screens (staff management, pricing rules, club settings) can be desktop-first in *design priority* but remain fully responsive — never desktop-only or broken on mobile.

## Touch Targets

Primary action buttons and any control a Receptionist/Coach/Scanner-role user taps repeatedly through a shift are sized for a thumb, not a mouse cursor — no small icon-only tap targets for frequent operational actions.

## Responsive Matrix

Documented explicitly per screen where behavior meaningfully differs — most importantly for:

| Screen | Desktop | Tablet | Mobile |
|---|---|---|---|
| Booking Calendar | Full grid, columns=fields, rows=time, sticky time axis | Same grid, touch-optimized cell size, collapsible sidebar | List/agenda view of today's bookings + quick-create, not a cramped grid |
| Reports | Full table + filters + charts side-by-side | Stacked filters above table, charts scroll horizontally if needed | Summary cards + drill-down list, no dense tables |
| Platform Console | Full `/platform` layout, desktop-only priority | Usable but not the primary target | Not optimized in V1 (Platform Owner's workload is not mobile-first — see [SCREEN_MAP.md](SCREEN_MAP.md)) |
| Attendance | Table with inline tap-to-mark | Larger touch rows | One player per row, big tap target, one-tap status cycle |
| Scanner | N/A (not a desktop-primary flow) | Full-screen camera view | Full-screen camera view, minimal chrome |
| Billing | Full invoice/payment tables | Stacked cards for outstanding/paid | Compact list, tap into detail for full numbers |

## Component Foundation

Built on `shadcn/ui` as the base wherever it fits, before any real screen is implemented (Phase 1):

```
Button · Input · Select · Search · Card · StatCard · DataTable · StatusBadge
Drawer · Dialog · Sheet · Tabs · EmptyState · ErrorState · PageHeader
ActionMenu · BookingCard · MoneyDisplay · QRCodeResult
```

Each of these is a single shared implementation reused everywhere it applies — a second, slightly different `StatusBadge` built inline in some other feature module is a design-system violation, not a shortcut.

## Booking Calendar Design

This is the product's hero screen — it must be premium and immediately legible, not merely functional.

**Desktop:** Columns = fields, rows = time, with a sticky time axis, clear field-column headers, and booking cards showing: customer name, time, payment status, booking status. Full detail lives in a Quick Booking Drawer opened on tap/click, not a separate full page navigation (keeps the calendar itself as the persistent context).

**Visual weight:** empty/available slots are visually quiet (not filled with a strong color) — booked, blocked, and current-time indicators are what should draw the eye. An all-green or all-red grid defeats the purpose of a scannable calendar.

## Dashboard Hierarchy

Not 15–20 equal-weight KPI cards. Three tiers:

```
Level 1 — Immediate:  Today's Revenue · Current Bookings · Upcoming · Outstanding
Level 2 — Operations:  Fields · Academy Sessions · Alerts
Level 3 — Insights:     Reports/Trends (secondary, not front-and-center)
```

**Reception Dashboard** specifically is the fastest screen in the product: `NOW` / `NEXT` / `AVAILABLE` / `QUICK ACTIONS`, matching [SCREEN_MAP.md](SCREEN_MAP.md)'s existing Reception Operational View — this design system doesn't change that screen's content, only formalizes its visual priority.

## Academy & Attendance UX

Coach's Home view is deliberately narrower than Manager's — `Today's Sessions · Upcoming · Attendance`, no administrative reports the coach doesn't need. Attendance marking is mobile-first: one row per player (photo optional, name, status), a single tap cycles or sets status — never a multi-step form per player.

## Scanner UX

Minimal by design: camera view, scan frame, one line of instruction text. After a scan, a large, unambiguous Result Card takes over the screen — see the QR result states below.

**QR result visual states** (matching [DECISIONS.md ADR-011d](DECISIONS.md#adr-011d--player-qr-is-reusable-booking-qr-is-consumable-scans-are-a-separate-log)/[ARCHITECTURE.md](ARCHITECTURE.md#qr-strategy)'s defined outcomes): `Valid` / `Already Used` / `Expired` / `Wrong Club` / `No Permission` / `Invalid` — each a distinct, immediately recognizable visual treatment (color + icon + label, never color alone).

## Billing & Outstanding UX

Financial figures (Total, Paid, Outstanding, Refunded) are always shown at a size and weight that's immediately readable — never buried in small secondary text. Overdue amounts are visually distinct but not alarm-styled (no flashing/pulsing/oversized warning treatment) — clarity over urgency-theater.

## Forms

Inline validation, clear labels, logical field grouping, sensible defaults. No 30-field monolithic forms. **Quick customer creation** during a booking flow is deliberately minimal — Name + Mobile only; every other field is filled in later, not required up front (matches the booking-speed target above).

## Search UX

Global search: a single input, optionally showing recent searches, results grouped by entity type (Customers / Players / Bookings / Invoices) — starts simple, matching the indexed-`ILIKE` approach already specified in [ARCHITECTURE.md](ARCHITECTURE.md#performance-principles).

## Empty & Error States

Every module has a purposeful empty state, not a blank screen — e.g. "لا توجد حجوزات اليوم" with a direct "إنشاء حجز" action, not just absence of content.

**Error states never expose raw internals** — no Postgres error text, no RLS policy violation message, no raw HTTP status code shown to the end user. A human-readable message is shown ("حدث خطأ، حاول مرة أخرى" or a more specific safe message); the actual error detail is captured in development/server-side logging only, never surfaced to the client UI.

## Permission-Aware UI

If the caller lacks a permission, the corresponding action is not rendered at all — not shown-then-disabled, not shown-then-erroring. This is a UX quality choice, not the security boundary: if a user reaches the action anyway (a stale cached UI, a direct route, a raw API call), the database is what actually blocks it, per [SECURITY_ANTI_FRAUD.md](SECURITY_ANTI_FRAUD.md#core-security-principle).

## Subscription-Blocked & Trial States

**Club access blocked** (expired subscription, no active grace): never renders a broken/half-working app. A clear, calm screen: "انتهى اشتراك النادي" / "بياناتك محفوظة." / a renewal or contact CTA — matching the tone and mechanism already specified in [USER_FLOWS.md](USER_FLOWS.md) Flow 9 and [ARCHITECTURE.md](ARCHITECTURE.md#platform-access-strategy).

**Trial banner** (during an active trial): "تجربة مجانية" + days remaining + a CTA to view plans — persistent but not intrusive, matching [SCREEN_MAP.md](SCREEN_MAP.md)'s existing Trial Banner entry; this design system doesn't add a new screen here, only formalizes its visual treatment.

## Club Branding (V1 Scope)

V1 allows a club to set: logo, club name, and an optional limited accent color — **not** a full theme builder. Mala3by's own core visual identity (the design tokens above) remains constant across every club's instance; a club's branding is a light overlay (logo + name + maybe one accent), never a full re-skin. This keeps the product visually and operationally consistent for support/training purposes and avoids building theming infrastructure with no current business justification.

## Public Website Visual System

Same brand tokens as the app — the public site is not a visually distinct product, it's the same brand with marketing-weighted hierarchy (larger type, more generous spacing, a stronger hero moment).

**Header:** `Logo · الرئيسية · المزايا · الأسعار · تواصل معنا` — right-aligned (in RTL, meaning visually on the left) `تسجيل الدخول` and a prominent `ابدأ مجانًا` button.

**Hero direction:** dark premium background (using the dark base tokens above) + the lime accent for the primary CTA + a product interface mockup/screenshot as the visual anchor — not a generic stock photo. Headline explains the *outcome*, not the technology — direction example: "إدارة ناديك وأكاديميتك وملاعبك من مكان واحد."

**Hero CTAs:** Primary "ابدأ تجربتك المجانية", secondary "تسجيل الدخول", with supporting microcopy "7 أيام مجانًا / بدون بطاقة بنكية" directly beneath — this is the single most important conversion moment on the site, matching [DECISIONS.md ADR-036](DECISIONS.md#adr-036--free-trial-requires-no-payment-method-zero-financial-exposure-by-construction).

**Homepage section order** (confirmed, matches [SCREEN_MAP.md](SCREEN_MAP.md) and [USER_FLOWS.md](USER_FLOWS.md) Flow 8): `Header → Hero → Suitable For → Core Benefits → Product Screens/Workflow → How It Works → Pricing → Free Trial CTA → FAQ → Contact → Footer`.

**Suitable For:** الأندية / الأكاديميات / ملاعب الحجز / المراكز الرياضية — four segments, not an exhaustive list.

**Feature presentation:** focused on the seven things that matter — الحجوزات / الأكاديمية / الاشتراكات / الفواتير والمدفوعات / QR / التقارير / إدارة الموظفين — not a sprawling 20–30 feature-card wall.

**Product visuals:** once real screens exist, use actual Mala3by screenshots/mockups as the primary marketing visual — not generic stock photography as the product's identity. Stock imagery, if used at all, is limited to the Landing Page only (e.g. a modern field, academy training, a reception/QR moment) — never used to represent the actual product UI, and never used inside the authenticated app, where imagery comes from real data (club logo, field images, player photos).

## Platform Owner Visual System

Same design system — not a visually different product. The Platform Owner console is more analytical in content (tables, summary cards, simple charts) but uses the identical color tokens, typography, spacing, and component set as the club-side app. Charts start minimal — line, bar, donut only where genuinely justified — no heavy charting library added without a clear need (consistent with [PROJECT_RULES.md](PROJECT_RULES.md) rule 4's zero-cost-first principle extended to bundle weight).

## Design QA Checklist (Phase 1 gate)

Before the design system is considered locked for use in subsequent phases:

- [ ] Desktop, Tablet, Mobile breakpoints reviewed for the App Shell and at least one representative content screen
- [ ] Arabic RTL verified as the default, correct direction throughout (not a mirrored LTR build)
- [ ] Dark sidebar / light content contrast verified legible
- [ ] Lime accent verified legible against both dark and light surfaces, adjusted if it reads as visually weak
- [ ] All semantic status colors pass contrast checks and are paired with icon + label, never color alone
- [ ] Touch target sizing verified on a real mobile viewport, not just a resized desktop browser
