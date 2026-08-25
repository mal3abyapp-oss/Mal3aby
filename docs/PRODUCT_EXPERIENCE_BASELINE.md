# Product Experience Baseline

> Established 2026-08-25 as the closing artifact of the **PERSONA COUNCIL + EXPERIENCE SCORE + AUTONOMOUS PRODUCT REFINEMENT** audit (3 independent persona rounds — Platform Owner, Club Owner, Customer — followed by 4 UX fix-and-deploy rounds, `791a8f8`/`7dff2e0`/`49f07a6`/`bd1d731`) and extended 2026-08-25 by the **FINAL PRODUCT COMPLETENESS ROUND** (`5f544ab`) that closed the three remaining real gaps the council's own closure report identified. Read together with [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) (visual tokens/typography, pre-implementation) and [SCREEN_MAP.md](SCREEN_MAP.md) (which screens exist). This file is the **Product Experience Contract**: the standing expectations every future screen/feature must meet, not just a changelog. It records *conventions actually established or reinforced by real fixes* — not aspirational rules invented for this document. Each principle traces to a specific commit; update this file the next time a persona audit finds and fixes a real violation, rather than letting it drift out of sync with the code.

## Persona expectations (the contract each persona is owed)

- **Platform Owner** is owed: the smallest number of dashboard signals that answer "does anything need me today," each clickable straight to the fix (`PlatformOverviewPage`'s exception-first section); visibility into every real signal the system already computes about a new signup, even without a formal approval workflow (`flagged_duplicate`, surfaced `5f544ab` after being silently computed and discarded since before this audit); a cross-page search entry point (`PlatformGlobalSearch.tsx`); and honest error states on every read that feeds a real decision (Club Detail's suspend/reactivate/pricing actions) — never a silent "0" standing in for "the query failed."
- **Club Owner** is owed: today's operational state before anything administrative (`TodayPage` leads the nav); every Finance list telling the truth about whether it's showing everything (`bd1d731`'s pagination-cap indicators); a real, evidence-backed answer to "who's working, what did they do, is anything in their custody" for every staff member (`Employee360Page`'s activity-counts section, `5f544ab`) — built only from real FK-backed counts, never a fabricated metric; and a conditional visual signal (not just a raw number) when two related numbers tell an operational story (cancelled vs. confirmed bookings).
- **Customer** is owed: a discoverable path to the portal from every real entry point — the public homepage, the login page, and the post-booking confirmation screen (`5f544ab`) — without the marketing site turning into a dashboard; the fewest taps to book/see bookings/check payment/see QR, in plain non-technical language, mobile-first; and a shell-wide guarantee that an unlinked account never sees a misleading empty state instead of the claim-gate (`RequirePortalCustomer`, `791a8f8`).

## Navigation principles

- **Order tabs by how the persona actually thinks, not by implementation order.** Confirmed correct across all three shells (AppLayout's Today→Bookings→Academy→Customers→Finance→Reports, PlatformLayout's Overview→Clubs→Owners→Commerce→Monitoring, PortalLayout's Bookings→Academy→Payments→QR→Profile) — this is the standard a future IA change must be checked against.
- **A shell's claim-vs-dashboard gate must wrap every route in that shell's subtree, never live inline on just the index route.** The Customer persona's P0 finding (`RequirePortalCustomer`, `791a8f8`) was exactly this violation. Any future shell-level gate must be a route-wrapping guard component, not a component-local conditional.
- **A cross-page search entry point is expected in every top-level shell.** The club-side app had one; the Platform Owner console did not until `PlatformGlobalSearch.tsx` (`7dff2e0`).
- **Discoverability of a persona's own entry point is a navigation requirement, not a marketing decision.** The Customer persona could not find `/portal` from the public site or the login page — this was treated as a real Product Navigation defect (per the directive that reopened this audit), not "out of scope." Every persona-facing surface (public site, login, post-transaction confirmation screens) must carry a low-friction, honest link to the portal that actually serves that visitor, without displacing the site's primary sales/functional purpose (`HomePage.tsx`, `LoginPage.tsx`, `PublicClubBookingPage.tsx`, all `5f544ab`).

## Platform control expectations

- **A Platform Owner must never lose visibility into a new club's signal state, even when the underlying self-serve model creates the club fully active immediately.** `complete_new_club_onboarding()` computes `flagged_duplicate`/`flagged_duplicate_reason` at every signup by design — any such already-computed signal must be surfaced (exception card + filter + detail-page banner, `5f544ab`), never left to sit unused in a column no screen selects.
- **Do not invent a new lifecycle/status enum value to solve a visibility gap that existing columns already answer.** `clubs.status` stayed a hard 3-value enum (`active`/`suspended`/`closed`) through this entire audit — the fix was surfacing real, already-computed data, not adding a `pending` state and rebuilding every RLS policy/UI branch that reads `status`.
- **The existing suspend/reactivate action set is the accept/reject mechanism until a real approval-workflow business decision is made.** Do not build a parallel approval system alongside it.

## Customer portal discoverability

- Every real customer entry point into the portal must be reachable without knowing the URL in advance: the public homepage (a quiet secondary link, not a competing CTA), the shared `/login` page (a hint + link, routing logic itself untouched — `LoginPage`'s post-auth logic already correctly resolves a linked customer to `/portal`), and the post-booking confirmation screen (a real clickable link, not inert informational text).
- **Never touch `/login`'s post-auth routing heuristic to fix a discoverability problem.** It is fragile, multi-branch (`platform_owner` → `/app` fallback via `from` → club membership → linked customer → `/onboarding` fallback for a genuinely fresh account) and already correct for every real case this audit traced — the fix for "customers can't find the portal" is always a *link*, never a routing-logic change.

## Staff accountability expectations

- **Any "who did what" view must be built exclusively from real, existing FK-backed columns** (`bookings.created_by`, `payments.received_by`, `attendance.marked_by`, `official_collection_receipts.entered_by`, `audit_logs.actor_id`) — never a new HR/tracking table, never an estimate. A staff member with zero real activity in a category shows `0`, not a placeholder or omitted card.
- **Verify a new activity/performance metric against an independent raw count before shipping it.** `get_staff_360_summary()`'s `payments_collected_total` was checked against a direct `COUNT(*)` on `payments` before the frontend was wired — this is the standard for any future roll-up metric.
- Employee 360 (`Employee360Page.tsx`) is the one canonical per-staff-member destination for identity, access, cash custody, financial liability, activity feed, and now activity counts — do not create a second staff-detail surface.

## Finance display rules

- **A query with a hard `.limit(N)` and no pagination must say so when the cap is actually hit.** `BillingPage.tsx`'s invoice list (`bd1d731`): `rows.length === N` is the honest, cheap signal — pair it with a pointer to existing filters, never leave it silent.
- **If an RPC already returns a `total_count` alongside a page of rows, the frontend must render it.** `get_customer_financial_account()` had returned it unused since before this audit (`bd1d731`).
- **Never invent a financial/accounting rule to fill a display gap.** Invoice `due_date` is NULL on every real invoice across every invoice type (booking/academy/other) — confirmed twice, in two separate rounds of this audit, with no club-level payment-terms configuration anywhere in the schema. The correct response was leaving the feature honestly degraded (no due-date column/filter shown when the data doesn't exist) and recording it as `REQUIRES OWNER BUSINESS DECISION` — never guessing 3 days, 7 days, or "today." This is the standing precedent for any future missing-financial-data gap: investigate whether a rule already exists in the system; if not, degrade honestly and defer, do not invent.
- **A number whose sibling number tells an operational story should carry a conditional tone, not a static one.** `ReportsOverviewPage`'s cancelled-bookings card (`49f07a6`): `tone="danger"` fires only when cancellations exceed confirmed bookings for the same club/date-range — a real comparison, never decoration.

## Error-state rules

- **Every `useQuery` whose data feeds a real decision must destructure and surface `isError`/`error`, not just `isLoading`.** Found and fixed across `PlatformOverviewPage`/`PlatformClubsPage`/`PlatformOwnersPage`/`PlatformClubDetailPage` (`7dff2e0`): a real query failure previously fell through to a `?? 0`/`?? []` default and rendered identically to a genuinely healthy, empty state — indistinguishable to the Platform Owner making a suspend/reactivate/pricing decision from it.
- Use the shared `ErrorState` component with a real `onRetry` wired to `refetch()` wherever a single query is the failure source; when multiple independent queries feed one screen and no single retry would fix it (Club Detail's ~14 reads), a plain aggregated warning banner (no `onRetry`) is more honest than a retry button that might not resolve anything.
- A number that should show `—` during loading must also show `—` on error, never fall back to a numeral that could be mistaken for a real `0`.

## Empty-state honesty

- **An empty state must never be structurally indistinguishable from "something is broken."** The Customer persona's P0 (`791a8f8`) was exactly this: an unlinked account saw the same "no bookings yet" / "no players linked" phrasing a genuinely-linked-but-inactive customer would see, with no way to tell the difference or find the fix.
- A degraded feature (invoice due-dates, currently disabled — see Finance display rules) must communicate *why* the data isn't there when relevant (filters/columns hidden rather than shown empty), not just silently omit itself with no explanation available anywhere.

## Shared component rules

- **Any `sr-only` or visible label inside a shared primitive must go through `useTranslation()`, never a hardcoded string.** `dialog.tsx`/`sheet.tsx`'s close-button label (`791a8f8`) — a hardcoded string in a *shared* component repeats itself silently everywhere that component is used.
- **A raw machine value must never reach the UI unmapped.** `src/lib/domain/audit.ts`'s `actionLabel()`/`entityLabel()` fall back to the raw string by design (never throws) — that's a safety net, not a target state. Closed a 41-of-69 action / 12-of-30 entity_type coverage gap (`791a8f8`); add a new action's label in the same commit that adds the `write_audit_log()` call.
- **A free-text input must default to empty, never a hardcoded example value.** `FieldsManagement.tsx`'s sport field (`791a8f8`) — use placeholder/hint text for examples, never a pre-filled real value.

## Table / filter conventions

- **A filter read from and applied against a URL param must have a corresponding UI control on the same screen**, not just deep-link support. `PlatformClubsPage`'s `reason` filter (`791a8f8`) and its new `flagged` filter (`5f544ab`) both follow this — every filter param a screen reads must be exposed as a real control on that same screen.

## Mobile conventions

- A desktop-only sidebar/nav needs an explicit mobile fallback (hamburger + slide-in `Sheet`) in the same change that adds the sidebar, not as a follow-up.
- A new discoverability link/CTA added to a public-facing screen must be verified at a real mobile viewport (375px), not assumed responsive — confirmed live for the homepage's new customer-link (`5f544ab`).

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

## Verification taxonomy

Use exactly these levels when reporting any fix's verification status — never claim a stronger level than what was actually done:

- **LIVE VERIFIED** — clicked/observed on the real deployed production app, in a real browser, using a real authenticated session (never a newly-created QA account created just to test, never a service-role key standing in for a user session).
- **AUTHENTICATED AUTOMATED VERIFIED** — proven via a real authenticated automated call (e.g. a direct REST/RPC call carrying a real session's JWT) against production, without a human clicking through the UI.
- **SERVER VERIFIED** — proven via a real SQL-level impersonation of a real production identity (`set_config('request.jwt.claims', ...)`), confirming the data-layer contract is correct, without exercising the actual frontend UI.
- **CODE VERIFIED** — confirmed correct by reading the source (types, RLS, RPC bodies) and passing typecheck/lint/build/tests, without any live or server-level execution proof.

A finding may honestly carry different levels for different parts of the same fix (e.g. a frontend change LIVE VERIFIED on a customer-facing page, but its Platform-Owner-only counterpart only SERVER VERIFIED because no real Platform Owner browser session was available and none was created to avoid the standing "no new QA accounts unless necessary" rule).

## What this audit deliberately did NOT do

Recorded here so a future pass doesn't waste time re-investigating these:

- **Customer 360's financial-reconciliation "mismatch"** (Club Owner audit finding) was traced to `get_invoice_payment_summary()`'s deliberate, documented formula (`total - paid + refunded`, established by Master Payment Directive task #81) and found to be internally consistent, not a bug — no accounting-rule change was made, and none should be made on this finding alone without new evidence.
- **Academy training schedule/timetable** (Customer persona finding — "where/when do I go") was confirmed genuinely absent from the data model (`groups` has no day/time columns) — expiry date and location were added where real data existed (`5f544ab` widened `get_my_portal_academy()`); the schedule question stays open as a real product gap, not a display bug, and needs a data-model decision before any UI can show it.
- **Invoice due-date** — confirmed twice, across two separate rounds of this audit, that `due_date` is NULL on every real invoice in production (booking, academy_subscription, and other invoice types alike) and no club-level payment-terms configuration exists anywhere in the schema. Left honestly degraded rather than guessed. **REQUIRES OWNER BUSINESS DECISION** before any UI change here — do not infer 3/7 days or "same day" from convention.
- **A formal club-approval workflow** for new clubs does not exist and was not built — `clubs.status` stayed a 3-value enum and new clubs are still created `active` immediately (the platform's self-serve trial model). What WAS fixed: the real, already-computed `flagged_duplicate` signal that the platform owner had zero visibility into is now surfaced (`5f544ab`) — this closes the "loses control silently" complaint using existing infrastructure, without building new approval architecture. If a formal gated-approval workflow is wanted in the future, that remains **REQUIRES OWNER BUSINESS DECISION**, not something a future audit round should infer and build unilaterally.
- **No new architecture, no new top-level pages, no redesign, no new enum values, no tenant-isolation changes, no accounting-rule changes** — every fix across all five commits in this audit (`791a8f8`, `7dff2e0`, `49f07a6`, `bd1d731`, `5f544ab`) was additive to an existing screen, a narrow grant-reverified RPC widening, or a plain informational link — matching the audit's own explicit "don't change architecture if a natural improvement solves it" constraint throughout.
