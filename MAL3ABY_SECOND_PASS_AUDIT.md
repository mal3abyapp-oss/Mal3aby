# MAL3ABY SECOND-PASS AUDIT

**Date:** 2026-08-21  
**Baseline:** `20a01fc81ca2aeabcdad36c7228b0724d650be5d` (`main` = `origin/main`)  
**Production bundle:** `index-CB0BZOr3.js`  
**Evidence labels:** CODE-VERIFIED, DB-VERIFIED, TEST-VERIFIED, LIVE-VERIFIED, PRODUCTION-VERIFIED, NOT VERIFIED

## A. Executive Verdict

## PRODUCTION ACCEPTABLE WITH RISKS — NOT READY FOR CONTROLLED SCALE

The platform is materially stronger than the first audit: the previously demonstrated tenant leak, branch leak, payment idempotency defect, route-boundary defect, mobile page overflow, booking race, and academy branch leak all have later fixes plus persisted authenticated evidence. The current production application loads, the public and Reception workflows are usable, protected Reception routes redirect correctly, and the Customer Portal is live.

The scale verdict remains below “ready” for three concrete reasons:

1. **P1 financial trust regression:** a cancelled booking can retain an issued invoice; the Customer Portal shows the remaining balance and opens a real “Pay invoice” workflow for it. The server-side payment path checks invoice status but does not reject an invoice whose linked booking is cancelled/no-show.
2. **Release/migration control is not scalable:** migration history contains extensive local-only/remote-only drift, duplicate timestamps, and one invalid filename; there is no CI gate for the frontend, database, migrations, authenticated security suite, or deployment.
3. **Initial delivery remains a 2.05 MB single JavaScript bundle (535 KB gzip)** with no route-level lazy loading. Platform, club operations, reports, portal, scanner, and public pages ship together.

No P0 was found. No production mutation was performed during this pass.

## B. What changed since the first audit

| Previous major finding | Current status | Evidence |
|---|---|---|
| Cross-tenant data exposure | FIXED, current regression not reproduced | TEST-VERIFIED: seven authenticated sessions across nine tables in the evidence ledger; current source contains tenant triggers/RLS. Full second-pass re-run was NOT VERIFIED because only Reception and Customer sessions were available. |
| Branch isolation missing | FIXED for certified matrix | DB/TEST-VERIFIED: branch-scoped negative reads and report/academy scope tests are recorded; Reception direct-route behavior was rechecked live. Full role matrix was NOT VERIFIED this pass. |
| SECURITY DEFINER reports bypass scope | FIXED | DB/TEST-VERIFIED by migration 600 evidence and denied-branch report tests. Advisor still reports a large executable-definer surface requiring ongoing review. |
| Payment idempotency/concurrency defect | FIXED | DB/TEST-VERIFIED by concurrent payment test returning one payment row/id. |
| Booking double-slot race | FIXED | DB-VERIFIED by exclusion constraint and overlap tests. |
| Ordinary payment crashed without official receipt | FIXED | DB/TEST-VERIFIED by migration 800 and subsequent payment tests. |
| Academy branch leak | FIXED | DB/TEST-VERIFIED across four roles after migration 900. |
| UI-only route guards | FIXED for tested Reception routes | PRODUCTION-VERIFIED: `/app/staff`, `/app/reports`, `/app/fields`, `/app/audit-log`, `/app/settings`, and `/app/whatsapp` redirect Reception to `/app`. |
| Site-wide mobile overflow | FIXED at page level | PRODUCTION-VERIFIED on public routes at 375/390/430 and authenticated Reception screens. Contained tab scrollers remain a UX problem, not page overflow. |
| False-zero loading states | MOSTLY FIXED | CODE/LIVE-VERIFIED on Platform/finance patterns. Slow screens still briefly show loading/skeleton states but no confirmed false production KPI was found. |
| No deploy path/domain | NO LONGER RELEVANT | PRODUCTION-VERIFIED: `mal3aby.app`, Cloudflare frontend Worker, production bundle, and repeated deploy history exist. |
| No production backup | NOT VERIFIED in this pass | Previous report tied this to the Supabase plan. Recheck requires account/organization visibility not available to the current connector. |
| WhatsApp queue stall | FIXED at certified baseline | Prior REAL-WHATSAPP-VERIFIED evidence exists; connector build and real Baileys handshake pass now. No new authorized-device delivery was sent. |
| Minimal automated tests | PARTIALLY FIXED | 62 unit/component tests pass; 20 critical integration tests are skipped without credentials; no browser E2E/visual CI. |
| ~1.99 MB single bundle | STILL OPEN / slightly regressed | Current local build: 2,053,678 bytes JS, 535,420 bytes gzip; no `React.lazy`/dynamic route imports. |

## C. New defects discovered

| ID | Severity | Area | Evidence | Root cause | Impact | Recommended action |
|---|---:|---|---|---|---|---|
| SP-001 | P1 | FINANCIAL / UX | PRODUCTION-VERIFIED: a cancelled booking with 350 EGP outstanding links to `/portal/payments?...`; the dialog “Pay invoice …” opens with the full amount. DB-VERIFIED discovery counted 43 cancelled bookings whose invoice remained draft/issued. | `cancel_booking()` changes only booking status. `record_payment()` validates `invoice.status='issued'` but not linked booking status. Portal invoice queries do not include booking lifecycle. | Customer may submit/receive a payment workflow for a service the club cancelled; staff approval can record money against the cancelled booking. | Add a DB invariant in the single payment path: reject payments/claims/proof approvals when the linked booking is cancelled/no-show; define refund/credit handling for already-paid cancellations; suppress Portal “outstanding/pay now” for cancelled/no-show invoices while retaining read-only receipt/history access. |
| SP-002 | P1 | DEPLOYMENT / DATA | CLI migration list shows hundreds of local-only/remote-only entries, duplicate timestamps, and `20260819200003a...` rejected as invalid. | Historical manual application and repeated timestamp reuse; deployment has no migration reconciliation gate. | A clean environment cannot be recreated deterministically; the next database change can be skipped, reordered, or applied twice. | Freeze new feature migrations briefly; build a non-destructive reconciliation ledger by schema object/checksum; establish a forward-only canonical baseline. Do not run bulk repair. |
| SP-003 | P1 | TESTING / DEPLOYMENT | Only GitHub workflow is a manually-triggered WhatsApp container build. Root build/lint/tests, migration validation, security suite, and deployment are not gated. | Release process is operator-driven. | Scale increases probability of deploying broken UI, stale migrations, or untested authorization changes. | Add required PR CI: typecheck, lint, unit, build, migration naming/duplicate timestamp validation, Supabase schema test, authenticated tenant/branch suite, and bundle budget. |
| SP-004 | P2 | PERFORMANCE | TEST-VERIFIED build: one 2,053,678-byte JS asset (535,420 gzip); no route lazy loading. | Eager imports in the central router package the entire product. | Slower first load and update on mobile; every role downloads code for every other role. | Split by public/app/portal/platform/scan first; then large finance/platform/academy screens. Set an initial-JS budget. |
| SP-005 | P2 | LOCALIZATION / PRODUCT | PRODUCTION-VERIFIED: English pricing displays Arabic plan names, descriptions and discount labels; English Academy shows Arabic group names. `public_plans` exposes only Arabic content columns. | Translatable configuration/business names have only Arabic storage fields; UI always reads `name_ar`/`description_ar`. | Mixed-language experience and lower commercial credibility for English operators. | Add optional English display fields with Arabic fallback; centralize localized-record selection. Do not translate customer-entered proper names automatically. |
| SP-006 | P2 | MOBILE UX | PRODUCTION-VERIFIED: Finance mobile shows two stacked horizontally scrolling tab rails; Academy tab label is clipped and native scrollbars dominate the first viewport. | Desktop information architecture compressed into independent horizontal scrollers. | High-frequency mobile navigation is visually noisy and hides destinations. | On mobile use a single section selector plus local segmented tabs; hide native scrollbars while keeping swipe/keyboard access; abbreviate labels only where meaning remains clear. |
| SP-007 | P2 | FINANCE UX | PRODUCTION-VERIFIED: Portal “My Payments” mixes active and cancelled-booking invoices without lifecycle context. | Invoice list has no source-status join or lifecycle filter. | “What do I actually owe?” is not trustworthy. | Add invoice source/lifecycle context and explicit `Not payable — booking cancelled` state. |
| SP-008 | P2 | MAINTAINABILITY | CODE-VERIFIED: `PlatformClubDetailPage` 1,123 lines, `BillingPage` 949, `PlayersSection` 767, Public Booking 709, Customer 360 621. | Fetching, permissions, transforms, form state, and rendering are coupled in page components. | Changes carry wide regression surface and discourage focused tests. | Extract query adapters and workflow-specific panels at behavior boundaries; do not cosmetic-split files. |
| SP-009 | P3 | ACCESSIBILITY | PRODUCTION-VERIFIED: several mobile header/footer links have visual heights around 20–28 px; mobile tabs rely on narrow targets/scrollbars. | Text-sized hit areas without a minimum interactive box. | Harder use for staff operating one-handed. | Apply a 44 px minimum touch target to navigation controls and visible focus treatment. |

### Discovery requiring follow-up, not promoted to a defect

- A read-only aggregate initially returned **2 potentially over-allocated invoices**. The query could not be re-run after database connector permissions changed, and the exact allocation/refund semantics were not proven. Status: **NOT VERIFIED**. Do not modify those records; rerun the reconciliation RPC versus raw allocations/refunds first.

## D. UX / Design findings by screen

| Screen | Current assessment | Evidence / opportunity |
|---|---|---|
| Public Home | Clear proposition and CTA, but commercially thin | LIVE-VERIFIED. It explains features, not outcomes, proof, onboarding effort, support, or how Mal3aby replaces WhatsApp + Excel. |
| Pricing | Functional, four plans | PRODUCTION-VERIFIED after data load. English is visibly mixed with Arabic plan data. Add comparison dimensions and buying guidance; avoid feature sprawl. |
| Login / Signup / Forgot Password | Simple and readable | PRODUCTION-VERIFIED at 375/390/430, no page overflow. Improve touch targets and add clear password requirements before submit. |
| Today | Fast operational overview | PRODUCTION-VERIFIED as Reception. “Getting started” remains visible on a populated QA club, implying checklist completion logic or fixture completeness needs review. |
| Bookings | Dense but task-oriented on desktop | PRODUCTION-VERIFIED. Calendar is inherently wide; on mobile provide field/day focus before rendering the full grid. |
| Customers | Strong table and direct outstanding visibility | PRODUCTION-VERIFIED. At scale, server-side filtering/pagination must be explicit; current first-page experience is dense. |
| Customer 360 | Closed architecture remains appropriate | CODE-VERIFIED, prior TEST-VERIFIED. Avoid redesign; address only query/pagination evidence if measured. |
| Academy | Simplified mental model is visible | PRODUCTION-VERIFIED: Overview, Players, Memberships & Subscriptions, Attendance. Mobile tab rail is clipped; dynamic Arabic group data appears in English. |
| Finance | Correct strategic consolidation | PRODUCTION-VERIFIED. Six top-level finance sections plus a second local tab rail are too much on mobile. The data is easier to find than before, but navigation needs responsive simplification. |
| Cash shifts | Operationally clear | PRODUCTION-VERIFIED read-only as Reception. It exposes branch, actor, expected/counted/variance and status. Staff 360-specific liability work was not modified. |
| Reports | Direct Reception access correctly blocked | PRODUCTION-VERIFIED authorization. Decision usefulness for owner/manager was CODE-VERIFIED only in this pass. |
| WhatsApp | Direct Reception access correctly blocked | PRODUCTION-VERIFIED. Platform-wide exception operations remain more important than adding settings. |
| Platform Owner | NOT VERIFIED live this pass | Current authenticated session redirected `/platform` to `/app`; source shows large, dense operational pages. Needs a dedicated platform-owner session for scale evidence. |
| Customer Portal | Useful cross-links, but financial lifecycle is misleading | PRODUCTION-VERIFIED. Cancelled bookings still surface outstanding and open a payment dialog (SP-001). |
| Scanner / QR | CODE-VERIFIED; prior live route evidence exists | Current Reception session had no scanner-specific visual pass after reset. |
| Invoice verification / PDF | Prior DB/device evidence only | NOT re-generated during this pass; no live WhatsApp send was authorized. |

## E. Simplification opportunities

### REMOVE

- “Pay now” and outstanding urgency for cancelled/no-show booking invoices.
- Native visible scrollbars as primary mobile tab affordance.
- Dashboard checklist once the underlying setup items are complete.

### MERGE

- Mobile Finance global section tabs and local page tabs into one section selector plus one local segmented control.
- Platform alerts, failed WhatsApp, subscription expiry, and financial exceptions into an evidence-backed **Platform Exception Inbox** rather than more dashboards.
- Reports that merely restate Finance KPIs into drill-downs from the KPI itself.

### HIDE

- Role-inaccessible destinations (already working for Reception).
- Advanced configuration behind progressive disclosure on mobile.

### DEPRECATE

- Compatibility route aliases after analytics/logs show no real traffic: `/app/billing`, `/app/cash-shift`, `/app/outstanding`, `/app/pending-payments`, `/platform/subscriptions`, `/platform/payments`, `/platform/renewals`.

### KEEP

- Customer 360 canonical identity and shared selector.
- Academy’s Player → Membership → Subscription → Attendance model.
- Finance as one module with contextual links from booking/customer/academy.
- DB-first payment/idempotency/receipt/cash-shift guarantees.
- Role-filtered navigation plus server-side RLS/RPC enforcement.

## F. Product opportunities

| Problem / evidence | Opportunity | ROI | Complexity | Priority |
|---|---|---:|---:|---|
| Owners need exception answers, not more pages | Daily owner digest: collected, outstanding, cancellations/refunds, cash variance, failed WhatsApp, expiring academy subscriptions | High retention/trust | Medium | DO NEXT |
| Portal shows money without service lifecycle | Trustworthy customer balance with payable/non-payable reason and cancellation/refund state | High trust/support reduction | Medium | DO NOW |
| Failed/exception surfaces are scattered | Platform Exception Inbox with owner, age, severity and deep link | High operations leverage at 100+ clubs | Medium | DO NEXT |
| Academy renewals/outstanding require manual follow-up | Renewal queue with one consolidated reminder and consent/quiet-hours rules | High revenue/retention | Medium | DO NEXT |
| Public site proves features, not business outcomes | Outcome-based demo story and guided trial checklist based on club type | Medium conversion | Medium | DO LATER |
| Reports are numerous | Question-led report entry points (“What was collected today?”, “Who owes money?”) | Medium productivity | Low/Medium | DO NEXT |
| WhatsApp per-account containers at 1,000 clubs | Per-tenant health/SLO dashboard, queue lag, reconnect rate, resource cost and support runbook | High scale reliability | High | DO NEXT before 100 clubs |

## G. Finance organization recommendations

| Current | Problem | Target |
|---|---|---|
| Finance overview + Payments + Invoices + Cash + Expenses + Reports | Correct grouping, but too many simultaneous mobile tabs | Keep desktop architecture; mobile section selector with remembered last section. |
| Booking/Academy/Customer contextual money links | Correct context, except cancelled lifecycle | Keep contextual links but let one financial state machine decide payable/refundable/closed. |
| Customer Portal invoices independent of booking state | Cancelled services look collectible | Expose `payability_state` from DB/RPC and consume it in every channel. |
| Government receipts contextual + report | Correct separation from payments | Keep; ensure reversal/correction state is visible on invoice/PDF/Portal. |

## H. Staff 360 readiness

**What exists:** one auth/profile identity, club membership as employment/role source, branch assignments, payment/cash-shift actor ids, custody/liability ledger, audit actor, and staff detail route.

**What should be reused:** `profiles`, `club_memberships`, branch assignments, permission model, cash shift actor, audit log, payment `received_by`, liability ledger.

**What is missing / needs proof:** a full multi-role Staff 360 live session matrix, lifecycle behavior for suspended/terminated staff, historical actor display after membership changes, and clear ownership of cross-branch staff.

**Concurrency constraint:** active Claude work modified `Employee360Page.tsx`, `StaffPage.tsx`, and both translation files during this audit. They were excluded from edits. No duplicate employee identity table is justified.

## I. Performance

- Initial JS: **2,053,678 bytes raw / 535,420 gzip**.
- CSS: **36,418 bytes raw / 7,434 gzip**.
- Route splitting: **none found**.
- Largest risk-bearing pages: Platform Club Detail 1,123 lines; Billing 949; Players 767; Public Booking 709; Customer 360 621.
- Public/mobile layouts had no confirmed page-level horizontal overflow at 375/390/430.
- Query-level production timings and Core Web Vitals: **NOT VERIFIED**.

## J. Security / Tenant / Branch

- **Tenant isolation:** TEST-VERIFIED at certified baseline; second-pass full matrix NOT VERIFIED.
- **Branch isolation:** DB/TEST-VERIFIED at certified baseline; Reception route scope PRODUCTION-VERIFIED.
- **UI permission boundary:** PRODUCTION-VERIFIED for Reception blocked routes.
- **Server-side authorization:** CODE/previous TEST-VERIFIED; no service-role evidence was counted as tenant proof.
- **Security Advisor:** previous run reported executable SECURITY DEFINER warnings and leaked-password protection disabled. The current connector denied a fresh advisor query, so current exact count is NOT VERIFIED.
- **New financial authorization/lifecycle defect:** SP-001 is not cross-tenant access; it is missing server-side lifecycle authorization for collectible invoices.

## K. Testing maturity

| Layer | Current state |
|---|---|
| Unit/component | 62 PASS |
| Integration | 20 SKIPPED (13 Staff 360, 7 Customer 360) because credentials were unavailable |
| DB/RPC | Strong manually-authenticated evidence exists for certified invariants; not automatically run in CI |
| Authenticated security | Persisted evidence across seven sessions; current pass live-tested Reception routes and Customer Portal only |
| Browser E2E | Manual, no automated framework/gate |
| Visual | Manual production review at 375/390/430 plus desktop for public and Reception/Portal surfaces |
| Connector | TypeScript build PASS; self-test reached a real WhatsApp `qr_required` handshake; real device scan/send NOT performed |

## L. Deployment / migration maturity

- Local `main`, `origin/main`, and audited HEAD were synchronized at `20a01fc`.
- Production served `index-CB0BZOr3.js`; local rebuild produced `index-Dvu7Aan3.js` from the same source plus active uncommitted Staff 360 files, so hash equality is not expected and the local artifact must not be deployed.
- Cloudflare frontend latest observed deployment: `3ef72f6a-5463-4c1c-a5c8-d614fe730fab` at 2026-08-20 23:36:52Z.
- WhatsApp Worker observed deployment history exists; configured container image is `fa49505` / v12.
- PWA uses `autoUpdate`, network-only Supabase runtime caching, and an explicit update prompt.
- Migration state: **ACTIVELY DANGEROUS for unattended changes**, but **SAFE TO LEAVE untouched during this audit**. No repair or migration mutation was run.
- Current working tree is not clean because another session owns Staff 360/i18n changes. No commit, merge, push, migration, or deployment was attempted.

## M. Scores (0–10)

| Dimension | Score |
|---|---:|
| Architecture | 7.5 |
| Security | 8.0 |
| Data Integrity | 7.0 |
| Tenant Isolation | 8.5 |
| Branch Isolation | 8.0 |
| Financial Integrity | 6.5 |
| UX | 7.0 |
| Visual Design | 7.0 |
| Mobile | 6.5 |
| RTL/LTR | 6.5 |
| Performance | 5.0 |
| Maintainability | 6.0 |
| Testing | 5.5 |
| Operational Readiness | 6.5 |
| Commercial Scalability | 5.5 |

## N. Master Improvement Backlog

| Priority | Action | Impact | Effort | Dependencies | Evidence |
|---|---|---:|---:|---|---|
| DO NOW | Block payment/claim/proof approval for cancelled/no-show booking invoices at DB level; fix Portal payability | High | Medium | Cancellation/refund policy; isolated migration after reconciliation check | SP-001 |
| DO NOW | Build non-destructive migration reconciliation ledger and forward baseline | High | Medium/High | Production schema dump, migration checksums | SP-002 |
| DO NOW | Add frontend/DB/security CI gates | High | Medium | QA secrets, protected branch | SP-003 |
| DO NEXT | Route-level code splitting and bundle budget | High | Medium | Router refactor | SP-004 |
| DO NEXT | Mobile Finance/Academy navigation simplification | Medium/High | Medium | Existing design system | SP-006 |
| DO NEXT | Localizable plan/config fields with fallback | Medium | Medium | Schema/API/i18n | SP-005 |
| DO NEXT | Platform Exception Inbox | High at scale | Medium | Unified exception contracts | Operations data |
| DO NEXT | Automated renewal/outstanding reminders with one-message policy | High | Medium | Consent, quiet hours, payability state | Existing WhatsApp queue |
| DO LATER | Outcome-led public site proof/demo | Medium | Medium | Real customer evidence | Public audit |
| DO LATER | Split large pages at workflow boundaries | Medium | Medium | Tests first | File-size audit |
| DO NOT BUILD | Duplicate employee identity model | Negative | High | — | Existing profile/membership architecture |
| DO NOT BUILD | New generic dashboards without decisions/actions | Negative | Medium | — | Existing report density |

## O. Recommended execution order

### PHASE 0 — Financial trust and release safety

1. Fix SP-001 server-side and in Portal; add DB and authenticated browser regression tests.
2. Reconcile migration history without bulk repair; establish a canonical forward baseline.
3. Add required CI gates and prevent deploys from dirty/non-deploy branches.

### PHASE 1 — Controlled-scale performance

1. Split public/app/portal/platform/scan bundles.
2. Add bundle and authenticated security budgets to CI.
3. Measure Core Web Vitals and top RPC timings on realistic datasets.

### PHASE 2 — Mobile operational UX

1. Simplify Finance and Academy mobile navigation.
2. Add explicit payable/non-payable financial states.
3. Standardize 44 px touch targets, empty/error/recovery states.

### PHASE 3 — Retention and operations automation

1. Platform Exception Inbox.
2. Owner daily digest.
3. Academy renewal/outstanding automation.
4. Per-tenant WhatsApp health and queue SLOs.

### PHASE 4 — Commercial conversion

1. Localized plan content.
2. Outcome-based public proof.
3. Guided onboarding based on club type and first-value milestones.

## P. Top 10

### Top 10 fixes

1. Block payment on cancelled/no-show linked bookings.
2. Suppress Portal payment CTAs for non-payable invoices.
3. Reconcile migration history forward-only.
4. Add required CI for root build/lint/test.
5. Add migration naming/duplicate timestamp gate.
6. Automate authenticated tenant/branch tests.
7. Split the initial bundle by role surface.
8. Add English plan/config values with fallback.
9. Simplify stacked mobile tab rails.
10. Add release provenance tying commit → bundle → Cloudflare version → migration set.

### Top 10 product opportunities

1. Trustworthy customer payable balance.
2. Owner daily exception digest.
3. Platform Exception Inbox.
4. Academy renewal queue.
5. Outstanding collection workflow.
6. Cash-variance exception workflow.
7. Failed WhatsApp support workflow.
8. Per-branch performance comparison.
9. Expiring subscription automation.
10. First-value onboarding checklist driven by real setup state.

### Top 10 design/UX improvements

1. One mobile Finance section selector.
2. Cleaner Academy mobile tab navigation.
3. Cancellation/payment lifecycle labels.
4. Question-led reports.
5. 44 px navigation targets.
6. Mobile-first booking field/day focus.
7. Localized dynamic configuration text.
8. Remove completed setup checklist.
9. Actionable empty/error states with recovery.
10. Progressive disclosure for advanced settings.

## Q. Final Recommendation

**Build next:** the shared DB `payability_state`/guard for invoices linked to bookings, consumed by staff finance, Customer Portal, payment proofs/claims, and WhatsApp/PDF messaging.

**Fix next:** migration/release determinism and required authenticated CI, then route splitting.

**Do not touch:** Customer 360 identity architecture, Academy’s simplified mental model, the financial allocation/refund engine without new evidence, or Staff 360 files currently owned by Claude.

**Defer:** broad visual redesign, new generic reports, duplicate staff/customer models, and speculative AI features. First make financial lifecycle, release provenance, and performance budgets deterministic.

**Final recommendation:** keep production running for controlled existing use, but do not onboard at scale until SP-001, SP-002, and SP-003 are closed and production-verified.
