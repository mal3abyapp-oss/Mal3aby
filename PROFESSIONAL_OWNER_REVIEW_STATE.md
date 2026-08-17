# Mala3by — Owner-Level Professional Product Review: State & Resume Cursor

This file is the durable tracking artifact for the Master Autonomous Owner-Level Full Product Review directive. It survives context resets — always read this file first before resuming.

**Directive received:** 2026-08-17
**Review started:** 2026-08-17

---

## RESUME CURSOR

```
current_role: (none yet — Phase 0 just completed)
module: —
screen: —
test_scenario: —
last_issue: —
last_fix: —
last_commit: 045cf082b15284c76f4570cfd73bfbdea018d26d
test_status: baseline gate PASS (see Phase 0 below)
blocker: none
exact_next_action: Begin Phase 1 — complete product inventory (map every route to role/permission/data-source), then start Phase 2 (Platform Owner review)
```

---

## PHASE 0 — TRUE CURRENT STATE (completed 2026-08-17)

- **Branch:** `master`
- **HEAD:** `045cf082b15284c76f4570cfd73bfbdea018d26d` ("docs: full financial regression + acceptance matrix (task #90)")
- **git status:** clean except `.claude/launch.json` (dev-tooling config, unrelated to product code, not touched)
- **Worktrees:** one stale secondary worktree (`.claude/worktrees/goofy-ptolemy-0d3fbc`, branch `claude/goofy-ptolemy-0d3fbc`) — behind master, clean, zero unique commits. Inspected, confirmed inert. Left alone (not deleted) per directive.
- **Migrations applied (live Supabase):** 109
- **Tables (public schema):** 61, **100% RLS-enabled** (0 without RLS)
- **SECURITY DEFINER functions:** 98
- **npm scripts (real, from package.json):** `dev` (vite), `build` (`tsc -b && vite build`), `lint` (`eslint . --ext ts,tsx`), `preview`, `test` (`vitest run`) — no separate `typecheck` script exists; `tsc -b`/`tsc --noEmit` used directly.
- **Baseline gate result:** `tsc --noEmit` ✅ 0 errors · `npm run build` ✅ · `npm run lint` ✅ 0 errors / 4 pre-existing warnings (fast-refresh only-exports-components, in `AuthProvider.tsx`, `DirectionProvider.tsx`, `badge.tsx`, `button.tsx` — cosmetic, not functional) · `npm test` ✅ 4/4 passing.
- **WhatsApp connector:** separate Node service at `whatsapp-connector/`, running live during this review (PID seen: 28056, started 2026-08-17 08:15), one real connected account (club `6ca5315e-e199-4531-9fb1-1df358cda087`, phone `201116505553`, status `connected`). Baileys session persisted encrypted in Postgres (`whatsapp_accounts.session_credentials_encrypted`, AES-256-GCM) — confirmed NOT relying on localStorage, confirmed `.baileys-auth-tmp/` correctly gitignored and untracked.

## PHASE 1 — ROUTE INVENTORY (from `src/app/routing/router.tsx`, ground truth)

### Public (no auth) — `PublicLayout`
`/`, `/pricing`, `/contact`, `/terms`, `/privacy`, `/login`, `/signup`, `/forgot-password`, `/reset-password`

### Standalone (no layout chrome)
`/onboarding`, `/verify/:token` (public invoice verification, task #86)

### `/app` (RequireAuth — any club membership) — `AppLayout`
`/app` (Today/dashboard), `/app/bookings`, `/app/academy`, `/app/customers`, `/app/billing`, `/app/cash-shift`, `/app/subscription`, `/app/outstanding`, `/app/reports`, `/app/staff`, `/app/settings`, `/app/more`, `/app/club` (redirect → `/app/settings`, kept for stale links)
Plus `/scan` (also under RequireAuth, own top-level path, not under AppLayout chrome)

### `/portal` (RequirePortalAuth — customer/guardian) — `PortalLayout`
`/portal`, `/portal/academy`, `/portal/payments`, `/portal/qr`, `/portal/profile`

### `/platform` (RequirePlatformOwner) — `PlatformLayout`
`/platform`, `/platform/clubs`, `/platform/clubs/:clubId`, `/platform/owners`, `/platform/subscriptions`, `/platform/plans`, `/platform/payments`, `/platform/renewals`, `/platform/trials`, `/platform/leads`, `/platform/reports`, `/platform/alerts`, `/platform/audit`, `/platform/settings`

**Total: 39 distinct routes/screens.**

### Feature module directories (`src/features/`)
`academy`, `auth`, `billing`, `bookings`, `clubs`, `customers`, `dashboard`, `onboarding`, `platform`, `portal`, `public-site`, `reports`, `scanner`, `search`, `settings`, `staff`, `verify`

---

## MODULE REVIEW TRACKER

Status values: `not started` / `in progress` / `reviewed — no issues` / `reviewed — issues found` / `reviewed — fixed & reverified`

| # | Module/Screen | Role(s) | Status | Notes |
|---|---|---|---|---|
| 1 | Platform Overview (`/platform`) | Platform Owner | not started | |
| 2 | Platform Clubs list + detail | Platform Owner | not started | |
| 3 | Platform Owners directory | Platform Owner | not started | |
| 4 | Platform Subscriptions/Plans/Payments/Renewals | Platform Owner | not started | |
| 5 | Platform Trials/Leads | Platform Owner | not started | |
| 6 | Platform Reports/Alerts/Audit | Platform Owner | not started | |
| 7 | Platform Settings | Platform Owner | not started | |
| 8 | Today/Dashboard (`/app`) | Owner/Manager/Reception | not started | |
| 9 | Bookings (`/app/bookings`) | Owner/Manager/Reception | not started | |
| 10 | Academy (`/app/academy`) | Owner/Manager/Academy/Coach | not started | |
| 11 | Customers (`/app/customers`) | Owner/Manager/Reception | not started | |
| 12 | Billing (`/app/billing`) | Owner/Manager/Cashier | not started | |
| 13 | Cash Shift (`/app/cash-shift`) | Cashier/Manager | not started | |
| 14 | Platform Subscription (`/app/subscription`) | Club Owner | not started | |
| 15 | Outstanding (`/app/outstanding`) | Owner/Manager | not started | |
| 16 | Reports (`/app/reports`) | Owner/Manager/Accountant | not started | |
| 17 | Staff (`/app/staff`) | Owner/Manager | not started | |
| 18 | Settings (`/app/settings`) | Owner/Manager | not started | |
| 19 | More (`/app/more`) | all | not started | |
| 20 | Scan (`/scan`) | Reception/Coach/Scanner | not started | |
| 21 | Portal Root/Academy/Payments/QR/Profile | Customer/Guardian | not started | |
| 22 | Public site (Home/Pricing/Contact/Terms/Privacy) | Anonymous | not started | |
| 23 | Auth (Login/Signup/Forgot/Reset) | Anonymous | not started | |
| 24 | Onboarding | New owner | not started | |
| 25 | Invoice verification (`/verify/:token`) | Anonymous | not started | (built + live-tested at creation, task #86 — re-verify, not rebuild) |
| 26 | WhatsApp Connection + Messaging Safety (Settings tab) | Owner/Manager | not started | (built + tested across tasks #91-105 — re-verify current live behavior, not rebuild) |

---

## DEFECT LOG

_(Empty — review not yet started. Populate as: ID | Priority | Module | Description | Root cause | Fix commit | Verified)_

---

## DECISIONS LOG (owner-level, no-approval-needed calls)

_(Empty — populate as decisions are made)_
