# Product Experience Baseline

> Established 2026-08-25 as the closing artifact of the **PERSONA COUNCIL + EXPERIENCE SCORE + AUTONOMOUS PRODUCT REFINEMENT** audit (3 independent persona rounds — Platform Owner, Club Owner, Customer — followed by 4 fix-and-deploy rounds). Read together with [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (visual tokens/typography, pre-implementation) and [SCREEN_MAP.md](SCREEN_MAP.md) (which screens exist). This file records *conventions actually established or reinforced by real fixes in this audit* — not aspirational rules invented for this document. Each principle below traces to a specific commit; update this file the next time a persona audit finds and fixes a real violation of it, rather than letting it drift out of sync with the code.

## Navigation principles

- **Order tabs by how the persona actually thinks, not by implementation order.** Confirmed correct across all three shells during this audit (AppLayout's Today→Bookings→Academy→Customers→Finance→Reports ordering, PlatformLayout's Overview→Clubs→Owners→Commerce→Monitoring grouping, PortalLayout's Bookings→Academy→Payments→QR→Profile) — no reordering was needed this round, but this is the standard a future IA change must be checked against.
- **A shell's claim-vs-dashboard gate must wrap every route in that shell's subtree, never live inline on just the index route.** The Customer persona's P0 finding (`RequirePortalCustomer`, commit `791a8f8`) was exactly this violation: the gate existed only on `/portal`'s index, so every sibling route bypassed it. Any future shell-level gate (new persona, new top-level area) must be a route-wrapping guard component, not a component-local conditional.
- **A cross-page search entry point is expected in every top-level shell.** The club-side app (`GlobalSearch.tsx`) had one; the Platform Owner console did not (`PlatformGlobalSearch.tsx`, commit `7dff2e0`) — treat "no way to jump straight to an entity from anywhere" as a real gap, not a nice-to-have, the next time a new top-level shell is built.

## Layout principles

- **Every stat card in a group must be independently clickable to a genuinely filtered view of what it counts**, not a generic list. Already the working convention on `PlatformOverviewPage`/`ReportsOverviewPage` before this audit — verified still true, no dead-end cards found in either screen this round.
- **A number whose sibling number tells an operational story (cancellations vs. confirmed, blocked vs. active) should carry a conditional tone, not a static one.** Established this round on `ReportsOverviewPage`'s cancelled-bookings card (`49f07a6`) — `tone="danger"` fires only when cancellations exceed confirmed bookings for the same club/date-range, a real comparison, not decoration. Apply the same test before adding tone anywhere else: is this a real comparison between two numbers that share the same scope, or just styling for its own sake?

## Persona priorities

- **Platform Owner** wants the smallest number of numbers that answer "does anything need me today," each one clickable straight to the fix. Verified strong on `PlatformOverviewPage`'s exception-first "needs attention" section (only renders when non-zero) — extend new platform-level signals the same way, not as permanent dashboard fixtures.
- **Club Owner** wants today's operational state (who booked, who owes, what needs collecting) before anything administrative. `TodayPage` already leads the club-side nav for this reason — do not let a future feature push it out of the first tab position without a specific, evidenced reason.
- **Customer** wants the fewest taps to "book / see my booking / see if I paid / see my QR," in plain non-technical language, mobile-first. The portal's bottom nav (5 items, no more) and its claim-gate fix are the concrete expression of this — resist adding a 6th top-level portal tab without strong justification; nest it under an existing one instead.

## Shared component rules

- **Any `sr-only` or visible label inside a shared primitive (`dialog.tsx`, `sheet.tsx`, `data-table.tsx`, etc.) must go through `useTranslation()`, never a hardcoded string.** Found and fixed in this audit (`791a8f8`): both `DialogContent` and `SheetContent`'s close-button label were raw English, invisible to sighted users but read aloud in English to an Arabic screen-reader user on every dialog/sheet in the app. A hardcoded string in a *shared* component is worse than one in a page — it repeats itself silently everywhere that component is used.
- **A raw machine value (an `action`/`entity_type`/status code, an RPC-returned enum) must never reach the UI unmapped.** `src/lib/domain/audit.ts`'s `actionLabel()`/`entityLabel()` fall back to the raw string when a value is missing from their maps by design (never throws) — but that fallback is a safety net, not a target state. This audit found and closed a 41-of-69 action / 12-of-30 entity_type coverage gap (`791a8f8`) that had been silently widening as new `write_audit_log()` call sites were added without a matching label. When adding a new audited action, add its label in the same commit.
- **A free-text input must default to empty, never a hardcoded example value in the input's own language mismatched to the UI's.** `FieldsManagement.tsx`'s sport field defaulting to the literal English word "football" (`791a8f8`) is the concrete case — a placeholder/hint text is the correct way to show an example; the input's actual value should not silently carry one.

## Table / filter conventions

- **A query with a hard `.limit(N)` and no pagination must say so when the cap is actually hit.** `BillingPage.tsx`'s invoice list (`bd1d731`) is the reference pattern: `rows.length === N` is the honest, cheap signal (no new query needed) — pair it with a pointer to whatever filters already exist to narrow the result, don't just show a bare warning.
- **If an RPC already returns a `total_count` alongside a page of rows, the frontend must render it.** `get_customer_financial_account()` had been returning `total_count` for both its invoice ledger and payment history since before this audit — the frontend parsed it into its own TypeScript types and never displayed it (`bd1d731`). Check for an already-fetched-but-unrendered count before adding a new one.
- **A filter that's read from and applied against a URL param must have a corresponding UI control, not just deep-link support.** `PlatformClubsPage`'s `reason` filter (`791a8f8`) existed in the query logic and was reachable via `PlatformOverviewPage`'s exception-card links, but had no `<Select>` — undiscoverable to anyone who landed on the page directly. Every filter param a screen reads should be exposed as a real control on that same screen.

## Mobile conventions

- Confirmed no new mobile-specific defects this round (Platform console's hamburger nav and Portal's bottom nav were already fixed in prior audit passes, per their own header comments) — this baseline records the *pattern* to check against for future screens: a desktop-only sidebar/nav needs an explicit mobile fallback (hamburger + slide-in `Sheet`) in the same PR that adds the sidebar, not as a follow-up.

## Arabic RTL conventions

- `sheet.tsx`'s `side="right"` prop means "the reading-start edge" via CSS logical properties (`inset-inline-start`/`border-e`), not a hardcoded physical side — confirmed still correct and unmodified by this audit's changes. Any new directional prop on a shared component must follow this same logical-property pattern, verified live in both `dir="rtl"` and `dir="ltr"`, not just read from the CSS.
- A raw English string surfacing in an all-Arabic UI (this audit's dialog/sheet close-button finding, the audit-log raw-code finding, the "football" default-value finding) is treated as the same class of bug as a broken layout, not a lower-priority polish item — it was fixed in the same P1 batch as functional gaps, not deferred to a later "i18n cleanup" pass.

## Drill-down conventions

(Carried forward from the earlier REPORTS + INVOICES + UNIVERSAL ENTITY DRILL-DOWN AUDIT, commit `d134921` and follow-ups — this persona-council round found no new drill-down gaps beyond what that audit already closed, only extended two of its RPCs for display-data completeness: `get_official_receipts_report()` gained `invoice_id`, `get_my_portal_academy()` gained `branch_name`/`field_name`.)

- One invoice ID → one canonical detail experience (`BillingPage`'s `?invoice=` dialog), reached the same way from every list/report/card that shows an invoice.
- A number on a report that has a real underlying entity must be clickable to it — never a static table cell for data that traces back to a real row.

## Page score targets

- Any screen scoring below **8/10** average (across visual quality, information hierarchy, navigation, discoverability, data completeness, filter quality, actionability, consistency, mobile, Arabic RTL, empty states, error states, loading states, drill-down) enters the fix queue.
- Any single dimension below **7/10** is treated as a real, named problem requiring a root-cause fix, not just a score note.
- Any single dimension below **5/10** is a high-priority item, sequenced before general polish (see the P0/P1/P2 priority order below).
- Score every *new* screen against this same bar during review, using the same 12-16 dimensions this audit used — a screen that scores below 8 at ship time should not ship without an explicit, documented reason (matches the "cosmetics never come before broken workflow" priority order established during this audit).

## Priority order (how this audit sequenced its own fix rounds)

1. **P0** — broken, confusing, wrong data, dead links, blocked workflow. (This round's example: the Portal claim-gate bypass.)
2. **P1** — daily-task friction, missing filters, bad navigation, poor drill-down, mobile problems. (Most of this round's fixes.)
3. **P2** — visual polish, spacing, icons, microcopy, secondary enhancements. (Not reached as a distinct pass this round — P0/P1 volume was real and evidenced enough to fill four fix-and-deploy cycles.)

Never start P2 work while a P0 or well-evidenced P1 remains open.

## What this audit deliberately did NOT do

Recorded here so a future pass doesn't waste time re-investigating these:

- **Customer 360's financial-reconciliation "mismatch"** (Club Owner audit finding) was traced to `get_invoice_payment_summary()`'s deliberate, documented formula (`total - paid + refunded`, established by Master Payment Directive task #81) and found to be internally consistent, not a bug — no accounting-rule change was made, and none should be made on this finding alone without new evidence.
- **Academy training schedule/timetable** (Customer persona finding — "where/when do I go") was confirmed genuinely absent from the data model (`groups` has no day/time columns) — expiry date and location were added where real data existed; the schedule question stays open as a real product gap, not a display bug, and needs a data-model decision before any UI can show it.
- **A club-approval workflow** for new clubs (Platform Owner finding) does not exist anywhere in the platform — confirmed absent, not hidden. This is a product/business decision, not a UX defect, and was left for the product owner to decide whether to build.
- **No new architecture, no new top-level pages, no redesign** — every fix in this round's four commits (`791a8f8`, `7dff2e0`, `49f07a6`, `bd1d731`) was additive to an existing screen or a narrow, grant-reverified RPC widening, matching the audit's own explicit "don't change architecture if a natural improvement solves it" constraint.
