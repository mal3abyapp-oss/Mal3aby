# Autonomous Execution State

Continuously updated. Governing directive: "MASTER AUTONOMOUS DIRECTIVE
V3" (Doc 3) — user explicitly selected "Full autonomous execution (per
docs 2/3)" via AskUserQuestion on 2026-08-16. Do not re-audit the whole
project from scratch on every task — trust this file, the decision log
(`AUTONOMOUS_DECISION_LOG.md`), and git history; only re-audit fully on
a genuine contradiction.

## Priority order (Doc 3, governs until superseded by a new user message)

0. ~~Initial audit~~ — superseded by direct-investigation approach per
   this run's evidence (see Gate 1 below); a separate standalone audit
   report was not produced as its own artifact, but Gate 1/2 findings
   ARE the audit for booking/academy, documented in the decision log.
1. **Gate 1 — Booking Time Integrity (P0)** — ✅ FIXED & VERIFIED (see
   D-001 in the decision log). Root cause: naive datetime strings sent
   to timestamptz RPC params + timezone-agnostic local-time derivation
   server-side, both fixed.
2. **Gate 2 — Academy Enrollment Integrity (P0)** — ✅ INVESTIGATED &
   FIXED (see D-002 in the decision log). Real bug found: `manual`
   subscription-activation policy was bypassed by ANY payment (should
   require explicit staff action). Fixed via a `p_explicit` flag.
   Duplicate-enrollment protection, full-group filtering, and
   no-approved-price guard were all already correctly handled — no fix
   needed for those (verified, not assumed).
3. Gate 3 — Unified Accounts / Participants / Guardians — not started.
4. Gate 4 — Memberships / Subscriptions / Operational Entitlements —
   not started. NOTE: do not confuse with the already-built Commercial
   Entitlements (platform-level club limits, tasks #51-67) — separate
   concept, same name collision Doc 3 warns about.
5. Gate 5 — Bookings / Activities / Seats — booking CORE already exists
   (V1 rebuild, tasks #23-27); this gate is about recurring bookings,
   seat/activity booking, waitlist — not yet built.
6. Gate 6 — Secure QR / Identity / Attendance — a QR mechanism already
   exists for bookings (`ensure_booking_qr`) but has NOT been audited
   against Doc 3's security requirements (opaque token vs guessable ID,
   expiry, replay, identity-match verification screen). Not started.
7. Gate 7 — Notification Core — not started.
8. Gate 8 — WhatsApp QR Module — not started (large net-new module).
9. Gate 9 — RTL full sweep — not started (partial RTL exists via
   `DirectionProvider` but no full audit done).
10. Gate 10 — Arabic/English i18n — not started (Arabic-only currently).
11. Gate 11 — Reporting Rebuild — not started (current reports are
    basic; task #12/Phase 13 in the original plan, not the full
    Doc 3 KPI-drill-down spec).
12. Gate 12 — Full Regression/Security/Tenant QA — not started as a
    dedicated pass for the Doc 3 scope (earlier V1/P1 passes exist but
    predate the unified-account/QR/WhatsApp scope).
13. Gate 13 — Resume Commercial Entitlements phase (tasks #51-67) —
    FROZEN per Doc 3 until Gates 1-12 substantially resolved. The
    underlying migration/enforcement work for commercial entitlements
    (branch/field/academy limits) is DONE and verified; only the UI
    wiring (task #51 types regen onward) remains, deliberately paused.

## Current gate: Gate 3 (Unified Accounts / Participants / Guardians) — starting next

## Completed this run (chronological)
- Resolved 3-way directive conflict via AskUserQuestion → user chose
  full autonomous execution per Docs 2/3.
- Gate 1 (Booking Time Integrity): root-caused, fixed, verified
  end-to-end via live UI test + direct SQL. See D-001.
- Gate 2 (Academy Enrollment Integrity): investigated, found and fixed
  the manual-activation-policy bypass; confirmed duplicate-enrollment/
  full-group/no-price cases already correctly handled. See D-002.

## Migrations applied this run
- `20260816110000_fix_booking_venue_timezone.sql` — rewrote
  `_create_booking_internal` to use `clubs.timezone` + `AT TIME ZONE`
  for local date/time derivation instead of UTC-implicit casts.
- `20260816120000_fix_enrollment_integrity.sql` — added `p_explicit`
  flag to `_activate_subscription_if_due_internal`/
  `activate_subscription_if_due`; added then removed a redundant
  duplicate-enrollment index (pre-existing one already covered it).
- Follow-up cleanup (ad hoc, via apply_migration): dropped the
  redundant index and the orphaned 1-arg
  `_activate_subscription_if_due_internal` overload left behind by
  `create or replace`'s signature-change behavior.

## Files changed this run
- `src/lib/domain/time.ts` (new) — Time Model utility.
- `src/features/bookings/useFieldPricing.ts` — added `useClubTimezone`.
- `src/features/bookings/QuickBookingSheet.tsx` — booking write path
  now uses `toInstant`.
- `src/features/bookings/BookingsPage.tsx` — day-range fetch filters,
  `slotMinutesOf`, `FieldColumnHeader` now timezone-aware.
- `src/features/bookings/BookingsMobileView.tsx` — same class of fix.
- `src/features/bookings/BookingDetailSheet.tsx` — display now
  timezone-aware via `formatInstant`.
- `src/lib/errors.ts` — added Arabic translation for the
  already-actively-enrolled error.

## Known-good, do NOT re-investigate without new evidence
- React Query staleness / Radix Dialog-Select-Tabs: repeatedly tested
  and confirmed working correctly in this codebase (prior session).
- Commercial entitlement enforcement triggers (branch/field/academy
  limits): verified via direct SQL tamper tests (prior session).
- Booking conflict detection (`field_blocks` overlap via `tstzrange`):
  confirmed timezone-agnostic and correct, untouched by Gate 1 fix.

## Outstanding from before Doc 3 arrived (still pending, now frozen — Gate 13)
- Task #51: regenerate Supabase TS types to include
  `commercial_entitlements`/`commercial_upgrade_requests`/
  `commercial_entitlements_usage`. The `generate_typescript_types` MCP
  call hit its output-size limit; raw output was saved to a session
  tool-results file but never extracted into `src/lib/supabase/types.ts`.
  Needs the JSON-unwrap-via-python technique documented in prior
  session notes. LOW PRIORITY per Doc 3 freeze — do not resume until
  Gates 1-12 are substantially done.
- Tasks #52-67: all commercial-phase UI/reporting work, frozen.

## Last commit
(check `git log` — commits should follow small logically-scoped
fix:/feat: convention per Doc 3 Part XXVII; local-first, do not push
without separate authorization)

## Next exact task
Start Gate 3 — Unified Accounts / Participants / Guardians. This is a
large net-new domain-modeling gate per Doc 3's design-only source
document. Before writing any migration, read the current schema for
`customers`/`players`/`guardian_links`/`club_memberships`/`profiles`
(or equivalent) to establish what already exists vs. what's genuinely
missing, since this codebase already has real customers/players/
guardian_links tables from the V1 build — the gate is likely narrower
than a full rebuild (e.g. may already satisfy "one account per person"
if auth is already unified; needs verification, not assumption).
Specifically check: (a) is there already a 1:1 mapping of
auth.users → a single profile, with no separate per-role accounts;
(b) does self-service signup exist without manual DB activation
(SignupPage.tsx / OnboardingPage.tsx already exist per the router — 
check their actual flow); (c) is there a profile-photo field, and is
it distinguished from any "verified" academy-member photo concept
(likely NOT yet built — this is probably the real gap); (d) does
guardian_links already correctly support one guardian managing
multiple children (schema suggests yes — verify). Do not rebuild what
already works; scope the actual gap precisely before writing code.
