# Platform Owner Experience Review

**Date:** 2026-08-28
**Scope:** Complete review of the `/platform` console (Platform Owner / Master Admin tier) — dashboard, club management, subscriptions, module entitlements, staff/roles, support sessions, security/audit, reporting, payment oversight, health signals, search, and visual/responsive quality.
**Method:** Local `main`-branch review (commit `249c9fd`, verified fresh via HMR build-SHA log). Full route tree read, full read of every `/platform/*` page component, the support-session RPCs/migrations, and the shared audit label map. Cross-referenced against two existing project documents: `MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md` (dated 2026-08-17) and `docs/SCREEN_MAP.md`, so this report does not re-flag findings those already closed.
**Nature:** Report only. No code was changed as part of this review (no defect blocked the review itself).

---

## 0. A note on timing — this console is not what the original audit saw

The 2026-08-17 IA audit found a console with 4 dead-end placeholder routes, N+1 RPC storms, dead-end dashboard cards, raw enum leaks, and a Club Detail page that fetched owner/facility data but never rendered it. **Almost none of that is still true.** In-code comments show at least nine dated remediation passes since then (Phase A through I, "PERSONA COUNCIL AUDIT 2026-08-25," "FINAL PRODUCT COMPLETENESS ROUND 2026-08-25," "COMMERCIAL MODULE ARCHITECTURE 2026-08-26," "SHOP MODULE UX HARDENING 2026-08-28" — the last one dated *today*), plus an entirely new subsystem (Platform Staff + Platform Roles — a second full authorization domain) that didn't exist at audit time.

This report's findings are deliberately narrower and more current than the 2026-08-17 audit's. Where a finding below overlaps one already recorded there, it is because the fix does not yet exist, not because the earlier work was overlooked.

---

## 1. Executive assessment

Judged as an actual paying business owner would judge it: **this control panel is close to operationally usable for day-to-day subscription/entitlement administration, and still missing real capability for running the business as a portfolio.** The subscription lifecycle, club-level operations, staff/role administration, and audit trail are genuinely strong — better than "functional," closer to "professional SaaS admin console." But a platform owner cannot yet answer, from this console, three questions any SaaS operator needs answered daily: *"Is my payment infrastructure healthy across my tenants?" "Which clubs are quietly going dormant?"* and *"What is my platform's overall usage/adoption trend, not just its billing state?"* Those are not polish gaps — they are missing operational instruments.

The console does not feel like an internal developer tool anywhere reviewed — every mutating action goes through an RPC with a typed reason field where destructive, every list uses the shared `DataTable`, and badges/cards are visually consistent. The gaps are about **coverage**, not **quality** of what already exists.

---

## 2. Current strengths (credit where already earned — do not re-litigate)

- **Subscription lifecycle is fully UI-manageable**, not RPC/database-only: start trial (with a real eligibility-guard override flow requiring a typed reason), activate, renew, change plan, extend grace (with a computed resulting-date preview), cancel, suspend, reactivate — every action requires a typed reason where destructive and writes an audit entry. [PlatformClubDetailPage.tsx](src/features/platform/PlatformClubDetailPage.tsx)
- **Module entitlement is a real, well-modeled two-level system** — "Entitled" (platform-controlled) vs. "Active" (club owner's own operational switch) are deliberately kept as two separate, clearly labeled states, with Active correctly read-only from the platform side. This is a genuine architectural strength, not an accident. [PlatformClubDetailPage.tsx:1215-1298](src/features/platform/PlatformClubDetailPage.tsx)
- **Dashboard is exception-first and honest about failure** — cards render "—" not "0" on a query error (so a failed query can never be misread as "a healthy empty platform"), and every card is a genuine filtered deep-link, not a dead end. [PlatformOverviewPage.tsx](src/features/platform/PlatformOverviewPage.tsx)
- **Club Directory search/filter/pagination is strong** — server-side search across name/code/owner name/email/phone, real pagination with total count, URL-param-backed filters (status/access/reason/flagged), pinned/recent-clubs shortcuts. Exceeds the original plan's ask. [PlatformClubsPage.tsx](src/features/platform/PlatformClubsPage.tsx)
- **Club Detail ("Club 360")** answers "if this club's owner calls right now, can I understand their state in under a minute?" with identity, owner contact (with copy-to-clipboard), operational summary, staff-by-role breakdown, WhatsApp health, and conditional government-compliance data — all from one batched RPC.
- **Platform Staff + Platform Roles is a genuinely new, well-built second authorization domain** — dynamic custom-role builder with a 7-group permission catalog, a "cannot grant what you don't hold yourself" escalation guard, and staff creation routed through a server-authorized Edge Function (not a client-trusted call). [PlatformRolesPage.tsx](src/features/platform/PlatformRolesPage.tsx), [PlatformStaffPage.tsx](src/features/platform/PlatformStaffPage.tsx)
- **Support-session live UX is strong** — explicit View/Manage mode choice at session start, a persistent full-width banner naming the club and mode on every page of the session (explicitly engineered so "a Platform Owner must never be able to forget which club they're currently modifying"), and an explicit exit action. [master-admin-banner.tsx](src/components/ui/master-admin-banner.tsx)
- **Audit Log mechanics are strong** — server-side actor/action/entity/date filters, a plain-language before/after diff view (not raw JSON), real incremental pagination (not a hard cap), and club-name deep-linking. [PlatformAuditPage.tsx](src/features/platform/PlatformAuditPage.tsx)
- **Visual/component consistency is genuinely good** — every list in the tier uses the shared `DataTable`; no raw HTML tables found anywhere; badges consistently use the shared `StatusBadge` tone system; all dialogs use the same labeled-input pattern; dates are consistently locale-formatted with correct RTL bidi isolation (`<bdi>`).
- **WhatsApp cross-club visibility was identified as "the single largest operational gap" and fixed** — connection status, failure counts, and disconnection exceptions are now visible both platform-wide (Overview) and per-club (Club Detail). This is the template the same gap in payment-gateway oversight (§9 below) should follow.
- **Platform Settings is a real screen**, not the placeholder the 2026-08-17 audit found — trial-days default and platform contact info, both audited RPC writes.

---

## 3. Critical missing capabilities

1. **Zero platform-wide payment-gateway oversight.** Confirmed by direct grep — no file under `src/features/platform/` references `payment_gateway_configs`, `payment_gateway_transactions`, or gateway health in any form. The equivalent club-owner-facing screens exist (`PaymentGatewayConnectionsCard.tsx`, `ReportGatewayHealthPage.tsx`) but nothing surfaces which clubs have gateways connected, which provider, enabled state, or recent failures at the platform level. See §12.
2. **No platform-wide activity/volume metrics.** Total active users, total bookings, academy activity, membership counts, and Shop adoption are not computed anywhere in `PlatformOverviewPage.tsx` — the dashboard's coverage is subscription/access/WhatsApp-focused only.
3. **No dormancy or engagement signal.** No "no activity for N days," no "owner hasn't logged in," anywhere in the console, for either clubs or platform staff.
4. **Support-session audit events render as unreadable raw machine strings** (`platform_support.session_started`, `platform_support_session`) in the Audit Log — confirmed absent from `src/lib/domain/audit.ts`'s label maps. A Platform Owner trying to review "who accessed which club, when" via the Audit Log sees literal code, not a sentence.
5. **Club Detail's Staff/Customers/Bookings/Academy/Memberships sections are all single summary numbers with no drill-down** — a platform owner can see "31 customers" but cannot see who, or open a filtered list, without leaving the console.

---

## 4. UX problems

- **Reverse-payment and deactivate-staff actions are visually under-weighted relative to their consequence.** Both use `variant="ghost"` while Suspend Club and Cancel Subscription (comparable-consequence actions) use `variant="destructive"` with an explicit warning line. Both still require a typed reason (real friction exists), but the visual signal doesn't match Suspend/Cancel's treatment. [PlatformClubDetailPage.tsx:556](src/features/platform/PlatformClubDetailPage.tsx:556), [PlatformStaffPage.tsx:186-194](src/features/platform/PlatformStaffPage.tsx)
- **No reactivate action for deactivated platform staff** — `deactivate_platform_staff` is wired, but no corresponding "reactivate" button exists anywhere in `PlatformStaffPage.tsx`, an asymmetry with the club-suspend/reactivate pair that does exist.
- **No acknowledge/snooze on Alerts** — every subscription in an alert state reappears on every page load with no way to mark "already followed up." Originally flagged in the 2026-08-17 audit, still open.
- **No export on Reports** — none of the 5 report tabs has a CSV/PDF/print action. Originally flagged, still open.
- **Global search covers only clubs and owners**, not staff/customers/invoices/bookings/memberships/payments — every result routes to Club Detail regardless of what matched. This may be an intentional scope choice given Club Detail's own summary depth, but as implemented it is a "club finder," not the broader entity search the console's own design intent (`docs/SCREEN_MAP.md`) describes.
- **Module-entitlement audit trail shows "when" but not "who" inline** — the Modules tab shows a last-changed timestamp but the actor requires switching to the separate Audit tab and searching.

---

## 5. Visual/design problems

- **No breadcrumbs anywhere in the tier**, confirmed by reading `PlatformLayout.tsx` and every child page. Club Detail — the deepest, most information-dense screen (1,298 lines, 5 tabs, multiple always-visible cards) — has no "All Clubs > [Club Name]" trail; the only way back is the sidebar link or browser back.
- **Two coexisting empty-state patterns** — most list screens use `DataTable`'s built-in `emptyTitle`, but the card-based Alerts page uses a separate standalone `EmptyState` component. Not a bug, but an inconsistency a design-system pass should fold into one pattern.
- Otherwise, the tier is visually disciplined: no raw HTML tables, no ad-hoc badge styling, no unlabeled forms found in any file read.

---

## 6. Platform Owner dashboard gaps

Per §4 of the review directive — EXISTS / MISSING / WEAK against each requested metric:

| Metric | Status |
|---|---|
| Club counts (total/active/inactive/trial/expired) | EXISTS (total, active, admin-suspended, trial). No dedicated "closed" count card, though `clubs.status` supports it — WEAK. |
| Clubs added this month | EXISTS |
| Total active users | MISSING |
| Total bookings | MISSING |
| Academy activity | MISSING |
| Memberships | MISSING |
| Shop adoption | MISSING |
| Payment gateway adoption | MISSING |
| Failed payment/gateway events | MISSING |
| Clubs needing attention | EXISTS, and well-built (exception-first, deep-linked) — but weighted toward subscription/access/WhatsApp only; see §11 of findings above |
| Recent platform activity / support sessions / security actions feed | MISSING — no activity feed on Overview; only the full, separate Audit Log page |

**Judgment:** reads as strategic and actionable for the subscription/access dimension specifically — the exception-card design and error-honesty (showing "—" not "0" on failure) are real strengths. It does not yet answer the operational-volume questions ("how much is actually happening on my platform") a business owner would ask first.

---

## 7. Club-management gaps

- **Directory list columns are thin relative to the plan's list**: EXISTS — status, subscription/access status, owner, created date. MISSING from the table itself — country/city (fetched but never rendered, a dead-data pattern), last activity, enabled modules, staff count, customer count, booking volume, outstanding issues. All exist only after opening Club Detail.
- **Club Detail structure vs. the proposed OVERVIEW/SUBSCRIPTION/MODULES/OWNERS/STAFF/CUSTOMERS/BOOKINGS/ACADEMIES/MEMBERSHIPS/SHOP/PAYMENTS/SUPPORT/AUDIT/ACTIVITY tab model:

| Section | Status |
|---|---|
| OVERVIEW | EXISTS (as always-visible cards, not a tab) |
| SUBSCRIPTION | EXISTS, strong |
| MODULES | EXISTS, as a tab |
| OWNERS | WEAK — single owner shown, no multi-owner handling |
| STAFF | WEAK — role-count summary only, no roster/drill-down |
| CUSTOMERS | WEAK — count only |
| BOOKINGS | WEAK — counts only (today/month/pending) |
| ACADEMIES | MISSING |
| MEMBERSHIPS | MISSING |
| SHOP | EXISTS but minimal (entitlement toggle only, no Shop metrics) |
| PAYMENTS | EXISTS, but this is platform billing (club→platform), not the club's own customer-facing gateway — see §9 |
| SUPPORT | MISSING as a section on this page (sessions start from the Clubs list, not from here; no per-club session history) |
| AUDIT | EXISTS, as a tab |
| ACTIVITY | WEAK/MISSING beyond the Audit tab |

This screen does correctly cover the Shop module (Modules tab includes `shop` alongside `fields`/`academy`, built after and specifically for that architecture) — it does not predate Commerce Pro.

---

## 8. Subscription/commercial gaps

Fully UI-manageable — this is one of the console's strongest areas (see §2). The one remaining gap: **PlatformPlansPage** allows editing plan name and price via a real RPC, but **billing period, per-plan client/branch/field limits, and per-plan module defaults are not editable from the UI** — those specific edits still require direct database/RPC access. No plan create/delete UI exists either.

---

## 9. Module-entitlement gaps

The entitlement model itself (Entitled vs. Active, platform-controlled vs. club-controlled) is a genuine strength, not a gap — see §2. Two real gaps remain:
- **No bulk assignment** — confirmed one-club-one-module-at-a-time only; no "apply to all clubs on plan X" capability anywhere.
- **"Who changed it" requires leaving the panel** — only "when" is shown inline; the actor is only visible via the separate Audit tab.

---

## 10. Platform staff/support gaps

- **Staff/Roles subsystem itself is strong** (see §2) — genuinely well-built, not a superficial addition.
- **No reactivate action** for deactivated platform staff (asymmetric with deactivate).
- **No last-login/last-activity visibility** for platform staff (or for club owners, platform-wide).
- **No per-employee audit deep-link** from the Staff page — reachable only by manually filtering the separate Audit Log.
- **Support-session mechanics are strong live** (mode choice, persistent banner, explicit exit — see §2), but:
  - **No dedicated session-history screen** — "who supported which club, when, for how long" is only reconstructable from the Audit Log by someone who knows to filter for it.
  - **Session start/end events render as raw, unmapped machine strings** in that same Audit Log (`platform_support.session_started`, `platform_support_session`) — confirmed by direct read of `src/lib/domain/audit.ts`, zero matches for `platform_support` anywhere in its label maps. This is the same defect class the file's own header comment describes fixing for every other action/entity type — just not yet extended to this newer subsystem.
  - Module-entitlement changes (`set_club_module_entitlement`) and platform-staff actions (invite/deactivate/role-change) have the same unmapped-label gap.

This is the standing accepted architectural risk (Platform Owner's legacy broad access, independent of session-scoped auditing) noted in the review directive — **not redesigned here, per instruction** — but the finding above is narrower and additive: even the *newer, properly session-scoped* support mechanism's own audit trail is currently unreadable, which undercuts the auditability the newer feature was specifically built to provide.

---

## 11. Reporting gaps

- Reports/Alerts/Trials have had every finding from the 2026-08-17 audit closed: club-name deep-links added to all 5 report tabs, monthly revenue aggregation added, raw `clubs.status` enum now labeled, alert day-thresholds unified to one shared definition, trial club-names linked.
- **Still open, confirmed present in both the original audit and now:**
  - **No export** on any of the 5 Reports tabs (CSV/PDF/print).
  - **No acknowledge/snooze** on Alerts.
  - **No "Trial Conversion Rate" metric**, despite `docs/SCREEN_MAP.md` (the product's own design commitment, ADR-044) explicitly naming it as planned.
  - **Usage tab is thin** — branch + staff count per club only; no module-adoption %, booking volume, or revenue-per-club comparison, despite the tab's name implying broader usage analytics.

---

## 12. Payment oversight gaps

**This is the report's single largest confirmed gap.** Exhaustive grep across `src/features/platform/` for `gateway` (case-insensitive) and for `payment_gateway_configs`/`payment_gateway_transactions` across all of `src/` returns matches only in club-owner-facing files (`PaymentGatewayConnectionsCard.tsx`, `ReportGatewayHealthPage.tsx`, `GatewayReturnPage.tsx`, all under `/app`) — never under `/platform`.

There is no Platform-Owner-facing view of: which clubs have gateways connected, which provider, enabled/disabled state, recent transaction/webhook failures, or reconciliation exceptions, anywhere in the console. `PlatformClubDetailPage.tsx`'s Payments/Invoices tab is exclusively the club's own SaaS billing to the platform — a structurally distinct, correctly-separated concern from the club's customer-facing gateway. That separation in the data model is correct; the missing platform-side aggregate view into the latter is not.

This is the exact same shape of gap that WhatsApp visibility was (correctly) identified and fixed for in an earlier phase — the fix pattern (a single batched cross-club RPC, an Overview exception card, a per-club health card in Club Detail) already exists in the codebase as a template and has not yet been applied to gateways.

---

## 13. Security/audit UX gaps

Per the directive: the standing architectural risk (Platform Owner's broad always-on access) is explicitly not being redesigned here. What was reviewed is whether the UI makes privileged actions sufficiently visible/auditable:

- **Entitlement changes, subscription lifecycle actions, staff changes, and club suspend/reactivate are all real, audited, reason-collecting actions** — strong.
- **Support-session start/end are audited server-side but unreadable in the UI** (§10) — the one concrete, fixable gap in an otherwise sound audit-visibility design.
- **No session-history screen** specifically for support sessions (§10) — a platform owner cannot currently answer "show me every support session on Club X in the last month" without manually filtering the general Audit Log.

---

## 14. Responsive/RTL findings

**No authenticated Platform Owner session was available this session** (confirmed: 3 live, authenticated `mal3aby.app` browser tabs exist, all Club Owner/staff-tier accounts; each redirected to `/app` on a `/platform` navigation attempt, consistent with `RequirePlatformOwner`'s documented behavior). Per the review directive's own instruction, this classifies the **authenticated visual/responsive portion as ENVIRONMENT-BLOCKED** — it was not skipped, and no part of it is reported as visually verified.

What can be honestly reported from code alone:
- `docs/SCREEN_MAP.md` documents `/platform` as an explicit **desktop-only-by-design** area in V1 ("Platform Owner's workflow... is not a mobile-first task, unlike reception/coach work").
- Despite that documented decision, `PlatformLayout.tsx`'s own comments describe a prior audit finding **zero mobile navigation fallback below 768px** (no hamburger, nothing) — since fixed with a hamburger + slide-in `Sheet`, RTL-aware (`side="right"`). This suggests the "desktop-only" decision was later revised toward "responsive, mobile-accessible" without the SCREEN_MAP.md documentation being updated to match — worth reconciling, not a defect in the code itself.
- RTL discipline (`<bdi>` wrapping for codes/phone numbers/dates, locale-aware date formatting) was consistently observed across every file read.
- No genuine 375/768/1024/1440 live rendering check was possible or performed. Any claim of visual responsive verification here would be false.

---

## 15. Proposed information architecture

No structural redesign is recommended — the existing 4-section grouping (Clubs, Commerce, Monitoring, Staff & Access) from the prior "Master IA/UX audit" is sound and should be preserved. The concrete additions this review's findings imply:

- A **Payments/Gateways** entry, likely under the existing Monitoring section (sibling to Reports/Alerts), rather than a new top-level section — it's the same "cross-club exception visibility" job WhatsApp health already does.
- A **Support Sessions** view, either as a new tab within Club Detail (sibling to Audit) or a small standalone list under Monitoring — the underlying data already exists in `audit_logs`; this is a presentation gap, not a new data-layer need.
- Club Detail's Staff/Customers/Bookings tabs could remain summary-only by design (this is a "control tower," not an operations console) — but if drill-down is added, it should link out to filtered views rather than duplicate the club-side screens' functionality.

---

## 16. Recommended new screens/components

1. **Platform-wide gateway health** (Overview exception card + a per-club card in Club Detail, mirroring the existing WhatsApp health pattern exactly).
2. **Support session history list** (filterable by club/staff member/date), reusing the audit-log data already captured.
3. **Audit label-map extension** for `platform_support.*`, `platform_staff.*`, and `set_club_module_entitlement`-family action/entity strings in `src/lib/domain/audit.ts` — a small, mechanical fix with outsized clarity impact.
4. **Breadcrumb component** for the Platform Owner shell, at minimum on Club Detail.
5. **Report export** (CSV at minimum) on the 5 Reports tabs.
6. **Alert acknowledge/snooze** state.
7. **Reactivate-staff action** on Platform Staff, symmetric with deactivate.

---

## 17. What should NOT be changed

- The Platform Owner's standing broad-access architecture — explicitly out of scope per the review directive; not revisited here.
- The Entitled/Active two-level module model — correct as designed, do not collapse into a single toggle.
- The separation between platform billing (club→platform) and the club's own customer-facing gateway — correct data-model separation; the fix needed is a new *view*, not a data-model merge.
- The existing 4-section nav grouping, mobile hamburger/Sheet pattern, and global search's clubs+owners scope — all deliberate, already-audited decisions with documented rationale; do not re-litigate without new evidence.
- `DataTable`/`StatusBadge`/dialog-with-reason patterns — consistently and correctly used throughout; extend, don't replace.

---

## 18. Priority implementation roadmap

Derived from what was actually found in this console, not the directive's illustrative example.

**P0 (prevents correct/secure operation):** None found. No security defect, no data-integrity defect, and nothing actively preventing correct platform operation was identified in this review.

**P1 (essential for professional operation):**
- Platform-wide payment-gateway oversight (§12) — a platform owner currently has zero visibility into a core piece of tenant infrastructure health.
- Audit label-map extension for support-session/staff/entitlement action strings (§10, §13) — undermines the auditability the newer subsystems were specifically built to provide.
- Support-session history view (§10, §13).

**P2 (important UX/product improvement):**
- Platform-wide activity/volume metrics on Overview (users, bookings, academy, Shop adoption) (§6).
- Dormancy/engagement signals — no-activity and no-login exceptions (§3, §11).
- Club Detail drill-down for Staff/Customers/Bookings (§7).
- Report export and Alert acknowledge/snooze (§11).
- Reactivate-staff action; last-login visibility for staff and club owners (§10).
- Directory list columns (modules, staff/customer/booking counts) (§7).

**P3 (polish/nice-to-have):**
- Breadcrumbs across the tier (§5).
- Visual weight parity for reverse-payment/deactivate-staff vs. other destructive actions (§4).
- Unify the two empty-state patterns (§5).
- Trial Conversion Rate metric (§11).
- Per-plan billing-period/limit/module-default editing in Plans UI (§8).

---

## Final response

```
PLATFORM OWNER REVIEW = COMPLETE
AUTHENTICATED LOCAL REVIEW = ENVIRONMENT-BLOCKED (no authenticated Platform Owner session available; code-level/structural review completed in full)
CRITICAL P0 = 0
P1 = 3
P2 = 6
P3 = 5
TOP 5 GAPS =
1. Zero platform-wide payment-gateway oversight — no view of which clubs have gateways connected, provider, health, or failures across the tenant base.
2. Support-session, platform-staff, and module-entitlement audit events render as raw unmapped machine strings in the Audit Log.
3. No support-session history screen — session start/end is only reconstructable by manually filtering the general Audit Log.
4. No platform-wide activity/volume metrics (users, bookings, academy, Shop adoption) on the Overview dashboard — coverage is subscription/access/WhatsApp only.
5. No dormancy/engagement signals (no-activity clubs, no-login owners/staff) anywhere in the console.
REPORT = PLATFORM_OWNER_EXPERIENCE_REVIEW.md
RECOMMENDED NEXT PHASE = Platform Owner Payment & Support Visibility (gateway oversight + audit label completeness + support session history — the three P1 items, which reuse the existing WhatsApp-health and audit-log patterns rather than requiring new architecture)
```

**STOP — no implementation begins until this report is reviewed and approved.**
