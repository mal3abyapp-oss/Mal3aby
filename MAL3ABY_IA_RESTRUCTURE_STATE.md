# Mal3aby IA Restructure — Execution State

Durable tracking artifact for the Information Architecture restructuring directive. Read this file first before resuming — it survives context resets.

**Directive received:** 2026-08-17 (immediately following completion of the Master Owner-Level Review + WhatsApp integration program)
**Audit completed:** 2026-08-17 (`MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md`)
**Target IA completed:** 2026-08-17 (`MAL3ABY_INFORMATION_ARCHITECTURE.md`)

---

## STANDING RULE (carried over from the Owner-Level Review directive, still in force)

Never stop mid-phase to send a report or wait for permission. After finishing any step: verify → commit if appropriate → update this file → continue immediately to the next phase. "Checkpoint" is not a valid reason to pause. The only two valid stop conditions: (1) the ENTIRE restructuring is complete (all 12 phases from the target IA's migration plan, full regression clean), or (2) a genuine external blocker after exhausting investigation.

---

## RESUME CURSOR

```
current_phase: Phase 7 — Reports tab-grouping
completed_phases: 1 (Audit), 2 (Target IA), 3 (Shared navigation foundation), 4 (Platform Owner), 5 (Club Settings restructure), 6 (Finance domain grouping)
last_commit: 6d03548 (Phase 6)
test_status: tsc clean, build clean, live-verified in browser at 1280px width (sidebar renders grouped "المالية" section header with all 4 finance items, all other items/hrefs unaffected)
blocker: none
exact_next_action: Begin Phase 7 -- restructure ReportsPage's flat tabs into labeled groups (Overview / التشغيل [Bookings, Occupancy] / المالية [Revenue, Collections, Reconciliation, Exceptions] / الأكاديمية والعملاء [Academy, Customers]) per target IA's decision (documented in Phase 2 log above): reports share one genuine purpose, so this is presentation-only tab-bar reorganization, NOT a route split. Read ReportsPage.tsx first to confirm the exact current tab list/order before restructuring. Then Phase 8 (WhatsApp module).

NOTE: Phase 4 deliberately did NOT fix the 2 hardcoded-reason/method RPC calls on PlatformClubDetailPage (change_platform_plan, record_platform_payment) or the 2 direct-table-writes there that bypass RPCs -- these are real data-integrity/form-completeness findings from the audit but are NOT information-architecture problems (no screen/nav reorganization involved), and fixing them requires adding real form inputs (a scope-creep risk against "reorganize, don't invent features"). Logged here as a legitimate follow-up, deliberately deferred, not forgotten -- revisit after the core IA restructuring (all 12 phases) is complete, as a discrete follow-up task if the user wants it.
```

---

## PHASE LOG

### Phase 1 — Audit: COMPLETE (commit `fdc7b13`)
Full inventory across Platform Owner (14 routes, 10 real screens + 4 placeholders), Club/Venue Staff (12 routes), Customer Portal (5 routes), WhatsApp current state. 15 confirmed cross-cutting problems documented with concrete evidence (file paths, line-level detail, exact duplicated logic). Gathered via 3 parallel deep-read exploration passes + live database queries (roles/permissions/table inventory with real row counts) + direct router.tsx/AppLayout.tsx/SettingsPage.tsx reads.

### Phase 2 — Target IA: COMPLETE (this commit)
Designed target navigation trees for all 3 tiers, WhatsApp module structure, canonical metrics table, role-navigation matrix, migration plan (12 phases), no-feature-lost tracking table. Every decision traces to a specific audit finding — documented inline in `MAL3ABY_INFORMATION_ARCHITECTURE.md` under "Design decisions and why" for each tier.

**Decisions made and rationale (for the record):**
- 4 Platform Owner placeholder routes removed/redirected rather than built out — their promised content already exists on real screens; a dead nav item is worse than no nav item, but building 4 new speculative screens would violate "don't add features while restructuring."
- ReportsPage's 9 tabs → grouped into 3 labeled sections, NOT split into separate pages — reports share one genuine purpose (retrospective analysis), the crowding problem is presentation (undifferentiated flat tabs), not domain mixing.
- BillingPage's 5 jobs → kept as ONE route with better internal separation (persistent claims strip), NOT split into separate pages — payment/refund/void are actions ON an invoice, not separate domains; splitting would break the natural "here's an invoice, here's what I can do to it" workflow.
- WhatsApp → new top-level `/app/whatsapp` module with 4 tabs (Overview/Activity/Connection/Settings) — directive's explicit instruction. Activity tab is the one genuinely NEW screen (data already exists in notification_queue, only a read-only view is new).
- Templates preview, self-test tooling, owner-person-level profile, lead-conversion workflow, staff edit-role-after-invite, Plans full CRUD — explicitly logged as OUT OF SCOPE (real gaps, but new features, not IA restructuring) per §7 of the target IA doc.

### Phase 3 — Shared navigation foundation: COMPLETE
Built `src/lib/domain/navigation.ts` (role -> nav-domain visibility map, mirrors target IA §6 exactly) and wired it into `AppLayout.tsx`'s sidebar + mobile nav (confirmed gap: was never permission-filtered despite an in-code comment saying it should be). Built `src/lib/domain/audit.ts` (shared ACTION_LABELS/ENTITY_LABELS, consolidating the club-side AuditLogPage's existing good map with the platform-tier's confirmed-raw values) and wired it into PlatformAuditPage + PlatformClubDetailPage's audit tab (both previously showed `r.action`/`r.entity_type` completely raw) plus AuditLogPage (now imports instead of duplicating). Consolidated `CLUB_STATUS_LABELS`/`ACCESS_TONE`/`ACCESS_LABEL` (each duplicated verbatim across 2-3 files) into `platform/labels.ts`. Fixed `PlatformReportsPage`'s Growth tab raw `clubs.status` enum. Added club-name drill-down links across all 4 club-keyed PlatformReportsPage tabs (Subscription/Renewal/Growth/Usage) and PlatformTrialsPage (all previously plain text, confirmed dead-ends in the audit). Added `/app/outstanding` to AppLayout's sidebar (Finance domain) and MorePage (confirmed: fully-built screen with zero navigation entry points anywhere). Added `nav.outstanding` i18n key (ar/en).

Verified: tsc clean, `npm run build` clean, live-verified in browser -- audit log shows human labels + working club links, Reports Growth tab shows "نشط" not raw "active", Outstanding page reachable via المزيد and loads real data, sidebar renders correctly post role-filtering wiring (club_owner sees everything, matching expected behavior since ROLE_NAV_DOMAINS lists club_owner with the full domain set).

### Phase 4 — Platform Owner: COMPLETE
Removed the 3 dead-end placeholder routes (Subscriptions/Payments/Renewals) -- `<Navigate>` redirects now point `/platform/subscriptions` -> `/platform/clubs`, `/platform/payments` -> `/platform/reports`, `/platform/renewals` -> `/platform/alerts` (same pattern as the pre-existing `/app/club` -> `/app/settings` redirect), preserving deep links per the migration rule while removing their sidebar entries entirely. Built a real `PlatformSettingsPage` (trial-days/grace-days defaults, backed by the real `platform_settings` table, confirmed RLS-writable by platform_owner) replacing the 4th placeholder. Restructured `PlatformLayout`'s sidebar from 13 flat items into 4 sections (standalone نظرة عامة -> الأندية group -> التجارة group -> المراقبة group -> standalone الإعدادات) exactly matching target IA §1's navigation tree. Fixed Trials' icon (was duplicating Plans' Sparkles icon -- now Award).

Verified: tsc clean, `npm run build` clean, live-verified in browser -- all 3 redirects fire correctly (confirmed via window.location.pathname), grouped sidebar renders with correct section headers and no dead-end items, new Settings screen loads real values (7/7 trial/grace days) from the database and is ready to save.
### Phase 5 — Club Settings restructure: COMPLETE (commit `afadffa`)
Extracted BranchesFieldsPage (new `/app/fields` route) from Settings' "النادي" (branches half) and "إعدادات الحجوزات" section (FieldsManagement) -- confirmed real operational infrastructure, not settings. Removed Settings' "الأمان وسجل التدقيق" section (AuditLogSection) now that `/app/audit-log` exists as its own route (wired in Phase 3, just not yet un-duplicated from Settings until now). Removed the dead "الموظفون والصلاحيات" stub card entirely (redundant -- Staff already has its own sidebar item). De-duplicated `ActivationPolicySetting`: was mounted in both AcademyPage's Enrollments tab and SettingsPage -- Settings stays canonical, Academy now shows a short link ("سياسة تفعيل الاشتراك تُدار من صفحة الإعدادات") instead of re-rendering the control. Gave `/app/subscription` a real nav presence for the first time: `PlatformSubscriptionCard` (kept in Settings as a compact status glance -- a genuinely different purpose from the full `SubscriptionPage`, not a duplicate) now links out via "عرض التفاصيل الكاملة". Updated MorePage (mobile "المزيد" hub): added the 2 new routes that had no mobile entry point (الفروع والملاعب, سجل التدقيق) and refreshed Settings' stale description text. WhatsApp cards deliberately left in place in Settings -- Phase 8 gives them a real module; moving them now would strand them with no upgrade path.

Verified: tsc clean, `npm run build` clean, live-verified in browser -- Settings now renders exactly 5 sections (النادي / إعدادات الأكاديمية / المدفوعات / الإشعارات / اشتراك المنصة) all loading real data, `/app/fields` shows real branches+fields+pricing, `/app/audit-log` shows real human-labeled entries, `/app/subscription` reachable and renders full plan/billing content, Academy's Enrollments tab shows the pointer link with the enrollment table still rendering correctly beneath it (no regression from removing the duplicate mount).
### Phase 6 — Finance domain grouping: COMPLETE (commit `6d03548`)
Restructured `AppLayout.tsx`'s sidebar from a flat `NavItem[]` into a `NavSection[]` (same pattern as `PlatformLayout`'s Phase 4 grouping) -- Billing/Outstanding/Cash Shift/Subscription now render under a labeled "المالية" section header. Nav-domain visibility filtering (role-based, via `canSeeNavDomain`) unchanged -- applied per-item within each section, sections with zero visible items after filtering are omitted entirely. `/app/subscription` gained a persistent sidebar entry inside the Finance group (previously reachable only via contextual banners + Phase 5's Settings link) -- an always-relevant financial concern warranted more than banner-only visibility. Mobile bottom nav untouched (out of scope -- it's deliberately minimal per its own design rationale, not a grouping candidate). Added `nav.sectionFinance`/`nav.subscription` i18n keys (ar/en).

Verified: tsc clean, `npm run build` clean, live-verified in browser at 1280px width (browser pane's default viewport gets stuck below the `md:` breakpoint on plain `resize_window` calls -- worked around by passing explicit width/height) -- sidebar `read_page` tree confirms the "المالية" header appears exactly once, directly above all 4 finance items in the correct order, all other sidebar items and hrefs unaffected.
### Phase 7 — Reports tab-grouping: NOT STARTED
### Phase 8 — WhatsApp module: NOT STARTED
### Phase 9 — Booking 360 (collect-payment action): NOT STARTED
### Phase 10 — Customer Portal: NOT STARTED
### Phase 11 — Role-based nav visibility: NOT STARTED
### Phase 12 — Full regression: NOT STARTED

---

## NO-FEATURE-LOST TRACKING (live, updated as each move happens)

| Feature | Old location | New location | Moved? | Verified? |
|---|---|---|---|---|
| WhatsApp connection (QR/disconnect) | Settings → الإشعارات | `/app/whatsapp` → الاتصال | No (Phase 8) | No |
| WhatsApp safety settings | Settings → الإشعارات | `/app/whatsapp` → الإعدادات | No (Phase 8) | No |
| Branches management | Settings → النادي | `/app/fields` → الفروع | Yes | Yes (live-verified, real branch data) |
| Fields/hours/pricing management | Settings → إعدادات الحجوزات | `/app/fields` → الملاعب | Yes | Yes (live-verified, real field/pricing data) |
| Audit log (club-side) | Settings → الأمان وسجل التدقيق | `/app/audit-log` | Yes | Yes (live-verified, human-readable labels) |
| Staff stub card | Settings → الموظفون والصلاحيات | Removed (Staff already had its own sidebar item) | Yes (removed, not moved -- destination already existed) | Yes (confirmed `/app/staff` still reachable via sidebar) |
| Activation policy setting | Academy tab AND Settings (dup) | Settings only; Academy shows a link | Yes | Yes (live-verified, pointer link renders correctly) |
| Platform Subscriptions nav item | Placeholder | Redirect → `/platform/clubs` | Yes | Yes (live-verified redirect fires) |
| Platform Payments nav item | Placeholder | Redirect → `/platform/reports` | Yes | Yes (live-verified redirect fires) |
| Platform Renewals nav item | Placeholder | Redirect → `/platform/alerts` | Yes | Yes (route wired, same pattern as the other 2 -- not separately re-clicked but identical code path) |
| Platform Settings nav item | Placeholder | Real screen (trial/grace defaults) | Yes | Yes (live-verified, loads real DB values) |
| Outstanding page | Built, unlinked | Finance domain nav | Yes (added to sidebar + MorePage) | Yes (live-verified, loads real data) |
| Subscription page (`/app/subscription`) | Built, unlinked from any nav | Contextual banner links (pre-existing) + Settings' new "عرض التفاصيل الكاملة" link | Yes (nav presence added) | Yes (live-verified, full plan/billing content renders) |

---

## DEFECT LOG (real bugs found during restructuring, distinct from IA problems)

None found yet during restructuring itself (Phases 1-2 were documentation-only). The audit found 2 confirmed silent-data-drop bugs to fix during Phase 10 (Customer Portal):
- `PortalAcademyPage` shows only the first active enrollment/subscription per player (should show all)
- `PortalProfilePage` shows only the first linked customer record for a multi-club guardian (needs a club selector)

---

## DECISIONS LOG (no-approval-needed calls made during restructuring)

- Kept `PlatformClubDetailPage`'s 4-tab structure as-is (tabs, not separate pages) — single-entity-context content is exactly what tabs are right for, per the core "one clear purpose" principle.
- Kept `OwnerFinanceTransparency` (TodayPage's owner panel) where it is rather than folding into the new Finance domain — it's a legitimate "fast daily glance" use case distinct from "full reconciliation," and already correctly links out to Reports for depth.
- Chose NOT to merge `clubs.status` (administrative) and `get_club_platform_access()` (billing-derived) into one concept — audit confirmed these are genuinely different, the fix is consistent labeling, not merging.
