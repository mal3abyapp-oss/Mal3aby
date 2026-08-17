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
current_phase: Phase 3 — Shared navigation foundation
completed_phases: 1 (Audit), 2 (Target IA)
last_commit: fdc7b13 (Phase 1 audit) -- Phase 2 target IA not yet committed
test_status: N/A (no code changes yet, documentation only)
blocker: none
exact_next_action: Commit Phase 2 (target IA doc), then begin Phase 3 -- build the shared nav-permission-filtering helper (used by both AppLayout and PlatformLayout), extend src/features/platform/labels.ts with the confirmed missing enum->label maps (clubs.status for Growth tab, audit_logs.action/entity_type), consolidate CLUB_STATUS_LABELS/ACCESS_TONE/ACCESS_LABEL duplicated across PlatformClubsPage.tsx/PlatformClubDetailPage.tsx into labels.ts.
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

### Phase 3 — Shared navigation foundation: NOT STARTED
Next up. Scope: permission-filtering helper for AppLayout sidebar, section-grouping for PlatformLayout sidebar, labels.ts extensions.

### Phase 4 — Platform Owner: NOT STARTED
### Phase 5 — Club Settings restructure: NOT STARTED
### Phase 6 — Finance domain grouping: NOT STARTED
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
| WhatsApp connection (QR/disconnect) | Settings → الإشعارات | `/app/whatsapp` → الاتصال | No | No |
| WhatsApp safety settings | Settings → الإشعارات | `/app/whatsapp` → الإعدادات | No | No |
| Fields/hours/pricing management | Settings → إعدادات الحجوزات | New domain (TBD route) | No | No |
| Audit log (club-side) | Settings → الأمان وسجل التدقيق | `/app/audit-log` | No | No |
| Platform Subscriptions nav item | Placeholder | Redirect → `/platform/clubs` | No | No |
| Platform Payments nav item | Placeholder | Redirect → `/platform/reports` | No | No |
| Platform Renewals nav item | Placeholder | Redirect → `/platform/alerts` | No | No |
| Platform Settings nav item | Placeholder | Real screen | No | No |
| Outstanding page | Built, unlinked | Finance domain nav | No | No |
| Activation policy setting | Academy tab AND Settings (dup) | Settings only | No | No |

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
