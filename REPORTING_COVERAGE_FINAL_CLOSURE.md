# Mal3aby — Final Reporting Coverage Closure

Source of truth for the autonomous final reporting coverage closure
directive (2026-08-30). Status values: PENDING / IN PROGRESS / PASS /
FIXED + PASS / ACCEPTED LIMITATION.

## 0. Baseline

- Repo HEAD = origin/main = `1b0036f` (clean working tree, confirmed
  via `git status`).
- Production runtime confirmed live: console build tag `1695e59` (the
  last runtime-code commit; `1b0036f` on top is docs-only, correctly
  not yet redeployed).
- CI: green (run `33322558905`).
- Preserved without modification: all 37 report fixes from the prior
  session (timezone hook fix, Finance Overview expense KPI, Shop
  reporting fixes R1-R3, printing D1-D10, RTL/LTR fixes, security
  controls, financial semantics, tenant isolation). WhatsApp untouched.

## 1. Domain model inspection (Section 3 — before any code)

Source-of-truth fields/tables, confirmed via direct schema/function
reads before writing any code:

- **Membership created**: `club_membership_subscriptions.created_at`,
  written by `sell_club_membership()`. Confirmed via a real audit log
  row: action `club_membership.created`, `before = null`.
- **Membership renewed**: also a NEW row in
  `club_membership_subscriptions` (not a mutation of the old row),
  written by `renew_club_membership()`. **Real renewal linkage
  exists** and was found via direct inspection, not assumed: the
  `write_audit_log()` call inside `renew_club_membership()` records
  `before = jsonb_build_object('previous_membership_subscription_id',
  v_current.id)` on an audit-log row with action
  `club_membership.renewed`. Confirmed live against real data: a
  renewal performed earlier this session produced exactly this audit
  row, with `entity_id` = the new subscription and
  `before.previous_membership_subscription_id` = the original one.
- **Membership cancelled**: `club_membership_subscriptions.
  cancelled_at`/`cancelled_by`/`cancel_reason`, all real columns.
- **Membership expired**: not a stored status transition — computed on
  read via `get_club_membership_effective_status(status, start_date,
  effective_end_date, today)`, the exact same function already used by
  the real Members list (`MembersSection.tsx`). Statuses:
  `pending_payment`/`scheduled`/`active`/`frozen`/`expired`/
  `cancelled` (frozen/cancelled pass through as-is; otherwise expired
  if `effective_end_date < today`, scheduled if `start_date > today`,
  else active). `effective_end_date` already correctly extends by the
  sum of any `club_membership_freezes` rows.
- **Membership plan / price snapshot**: `plan_name_ar_snapshot`/
  `plan_name_en_snapshot`/`price_snapshot` on the subscription row
  itself (frozen at sale/renewal time, doesn't drift if the plan is
  later edited) — plus a live join to `club_membership_plans` for
  plan-level aggregates (top plans).
- **Invoice / payment / refund / outstanding**: every subscription has
  a real `invoice_id` FK. The single authoritative source for
  paid/refunded/outstanding/payment_status is
  `get_invoice_payment_summary(invoice_ids[])` — the SAME function
  already reused by Shop invoices, BillingPage, and every other
  financial-reconciliation surface fixed in the prior two sessions. No
  new accounting formula written for this report.

**Real defect found during this inspection** (Section 20: reproduce →
root cause → fix): the EXISTING `get_club_membership_report()` RPC
(already present before this directive, apparently built in an earlier
pass but never wired to any UI) computes New vs. Renewal via
`exists (select 1 from ... prior where prior.customer_id =
s.customer_id and prior.created_at < s.created_at)` — "this customer
has ANY earlier subscription row, ever, regardless of gap or
cancellation" — not the real renewal linkage. This exact class of bug
is what directive Section 3 explicitly warns against ("do not infer
renewal from date proximity unless the product already does so") —
this RPC does something arguably worse: it infers renewal from mere
customer history, with no date/linkage check at all. A customer who
cancels a membership, has zero relationship with the club for a year,
then buys a completely fresh new membership would be miscounted as a
"renewal", never a "new membership". Root cause: this RPC predates the
`previous_membership_subscription_id` audit-log linkage (or was never
updated to use it). Fixed as part of this closure — see Section 2.

## 2. Report inventory for this closure

| # | Item | Status |
|---|---|---|
| 1 | Club Membership Lifecycle & Revenue report | FIXED + PASS |
| 2 | Secondary coverage gap check | COMPLETE — 0 P1, 0 built |

### Secondary coverage gap review (Section 16)

Bounded review across Bookings/Academy/Club Memberships/Shop/
Inventory/Expenses/Cash/Customers/Finance (product-explorer subagent,
read-only, no nested delegation):

| Domain | Existing reporting | Gap | Priority |
|---|---|---|---|
| Bookings | ReportBookingsPage + ReportOccupancyPage | none | — |
| Academy | ReportAcademyPage | none | — |
| Club Memberships | MembershipReportSection (this session) | — | out of scope, already reviewed |
| Shop | Sales/Summary/Profit/Returns/Inventory reports | none | — |
| Inventory | Covered by Shop inventory reports (no separate facility-asset domain exists) | none | — |
| Expenses | FinanceExpensesPage (ledger + 2 KPIs, filterable) | no category/branch breakdown view | P3 |
| Cash | Shift history + Reconciliation + Employee Liability | none | — |
| Customers | ReportCustomersPage (new-customer count + top spenders) | no lapsed/inactive-customer win-back list | P2 |
| Finance | Full hub (Revenue/Collections/Payment Methods/Exceptions/Receipts/Reconciliation/Gateway Health/Liability) | none | — |

**Result: 0 P1 gaps.** Reporting coverage across all 9 domains is
materially complete. The one P2 (lapsed-customer report) requires a
net-new RPC/aggregation — not "obvious low-risk" wiring — so per
Section 16 it is explicitly NOT built this phase; it is a standalone
future feature candidate if the business prioritizes it. The one P3
(expense breakdown) is a convenience, not a missing capability — not
built. No P0/P1/core-P2 reporting gaps remain.

## 3. Defects log

- D1 (P2, found during Section 1 domain inspection, before any code
  was written): `get_club_membership_report()` (pre-existing, zero UI
  consumers) computed New vs. Renewal via "does this customer have any
  earlier subscription row, ever" — not the real renewal linkage.
  Proven wrong live: constructed a fresh, unrelated
  `sell_club_membership()` sale for a customer who already had 2 prior
  subscriptions (one original, one real renewal) — the old formula
  misclassified this brand-new sale as a "renewal" (`old_buggy_is_
  renewal: true`), while the real audit-log linkage correctly says
  `false`. FIXED: migration `20260830173747_fix_membership_report_
  renewal_linkage_and_financials.sql` — both `get_club_membership_
  report()` (extended with `p_branch_id`/`p_plan_id` filters + a
  `financials` block, requiring `DROP FUNCTION` first since the
  parameter list widened) and a new `list_club_membership_report_
  rows()` (paginated lifecycle table) now use
  `renew_club_membership()`'s own real audit-log linkage
  (`action='club_membership.renewed'` +
  `before->>'previous_membership_subscription_id'`) instead of the
  customer-history heuristic. Live-verified: `new_memberships_in_range`
  and `renewals_in_range` now correctly separate the 4 genuinely new
  sales from the 1 genuine renewal in the QA period, cross-checked
  against a raw per-row comparison of old-vs-new logic.

## 4. Membership report — build details

**Frontend**: new "Report" tab on the existing `MembershipsPage.tsx`
(not a new top-level route — matches this page's own established IA:
Overview/Plans/Members/Expiring already live as tabs of one page).
`MembershipReportSection.tsx` reuses every established Reports pattern
exactly: `useDateRange()`/`useDateRangeReport`-equivalent hooks,
`DateRangeFilter`, `ReportPrintButton`/`ReportPrintHeader`/
`.print-target`, `StatCard` grid, `DataTable`, `StatusBadge` +
`CLUB_MEMBERSHIP_STATUS_TONE` (the same map `MembersSection.tsx`
already uses), `MoneyDisplay` (bidi-safe by construction — no
hand-formatted currency strings).

**Server**: `get_club_membership_report()` (fixed, extended with
branch/plan filters + financials) for KPIs/by-plan/expiring/
financials; new `list_club_membership_report_rows()` for the paginated
lifecycle table, mirroring `list_club_membership_subscriptions()`'s
exact branch-scoping/pagination pattern. Both reuse
`get_invoice_payment_summary()` — the SAME authoritative financial
source already used by every other reconciled surface in this
codebase — for paid/refunded/outstanding/payment_status. No new
accounting formula written.

**Live QA scenarios constructed** (all via real product RPCs, per
directive Section 19): new membership (unpaid), renewal (unpaid),
cancelled membership, partial payment, full payment, partial refund
after full payment — full spectrum, not just the happy path.

**Live-verified financial reconciliation**: gross revenue
1,500.00 EGP (5×300), collected 750.00 (300+150+300), refunded 100.00,
outstanding 850.00 — every figure independently cross-checked against
raw `get_invoice_payment_summary()` output before trusting the report
UI, sum of outstanding-per-row (100+300+150+300+0=850) matches exactly.

**Filters tested live**: date range (zero-result range correctly shows
empty state with all KPIs at 0, not stale/cached data); lifecycle
status filter (narrowed 5 rows → 1 exactly, the cancelled membership).

**Timezone**: reuses `club_local_day_bounds()` throughout (same
mechanism as `get_booking_report()`, already verified correct in the
prior reporting-coverage session) — no `timestamp::date` truncation,
no `new Date().toISOString()` anywhere in the new RPCs.

**RTL/LTR**: verified live in both languages. Arabic renders correct
Arabic-Indic numerals via `MoneyDisplay`'s `<bdi>` wrapping (confirmed
in the actual DOM, not assumed), Arabic plan/status labels, mixed
Arabic customer names alongside English QA fixture names with no bidi
corruption. Single-token dates (`YYYY-MM-DD`, no dash-joined range)
confirmed to carry no D8-class reversal risk since there's no
neutral-character-joined LTR pair for the bidi algorithm to reorder.

**Responsive**: 375/768/1024/1440 all confirmed zero page-level
horizontal overflow via live `document.body.scrollWidth` checks (not
just eyeballing); the lifecycle table correctly scrolls within its own
bounded `overflow-x-auto` container at 375px (1167px content in a
342px box) while the page itself never scrolls sideways — same
pattern already established for every other report this session.

**Print**: `.print-target` confirmed present with the correct
`visible-for-print` class and exactly matching the 5 on-screen rows;
print header correctly shows the report name, club name, applied
filter summary, and generation timestamp in both languages.

**Security**: 4 adversarial RLS-impersonated probes, all correctly
rejected server-side:
- `get_club_membership_report()` with a foreign `p_club_id` →
  `not authorized`.
- `list_club_membership_report_rows()` with a foreign `p_club_id` →
  `not authorized`.
- Unauthenticated (`anon` role) call → `authentication required`
  (distinct message, correctly gated before the club-membership check
  even runs).
- Real club_id + a `p_branch_id` belonging to a DIFFERENT club
  (cross-tenant filter-parameter injection) → `not authorized`.

**Console-error investigation (Section 20 bug process, closed)**: two
`Failed to load resource: 400` console errors were observed on one
early reload of `/app/memberships` during active dev-server editing.
Investigated per Section 20 (reproduce → root cause → fix/dismiss →
verify): confirmed via `performance.getEntriesByType('resource')` that
every real RPC call on that same load — including both new RPCs,
`get_club_membership_report` and `list_club_membership_report_rows` —
completed and returned data the UI rendered correctly (not possible if
either had actually failed). The 400s did not recur across 5+
subsequent reload cycles in the same tab, and a genuinely fresh tab
(closed old tab, new `preview_start`, full cold load, then a fresh
Report-tab click) produced **zero** console errors end to end.
Conclusion: a one-time Vite HMR/dev-server reconnect artifact, not a
product defect — no fix required, re-verified clean.

## 5. Final acceptance matrix

| Area | Result |
|---|---|
| Membership report — build & wiring | PASS |
| Renewal-linkage defect (D1) | FIXED + PASS |
| Financial reconciliation vs. `get_invoice_payment_summary` | PASS |
| Timezone (`club_local_day_bounds`, no raw truncation) | PASS |
| Filters (date range, plan, status) update KPIs+table+print together | PASS |
| Lifecycle table (Paid/Refunded/Outstanding all shown) | PASS |
| Charts | N/A — not added; KPI cards + status/plan breakdowns judged
sufficient, no chart would add information the numbers don't already
show at this data volume |
| Churn/retention metric | Deliberately omitted — not defensible from
current data model without inventing a formula (Section 10) |
| Print (current filter / full report) | PASS |
| Responsive 375/768/1024/1440 | PASS |
| RTL/LTR | PASS |
| Security (tenant isolation, unauth, branch cross-tenant) | PASS |
| Empty/edge states | PASS |
| Live tool-based acceptance (Section 18) | PASS |
| Console errors on fresh load | PASS (investigated one transient,
confirmed non-reproducing) |

## 6. Final regression gate & deployment record

- `npx tsc --noEmit`: PASS (0 errors).
- `npm run lint`: PASS (0 errors, 13 pre-existing warnings unrelated
  to this session's files).
- `npm run test` (vitest): PASS — 108/108 tests, 98 skipped (pre-
  existing integration suites requiring QA credentials, unchanged).
- `npm run build` (`tsc -b && vite build`): PASS, clean production
  build.
- Local commits: `6f2d93e` (report feature) + `975a174` (secondary
  coverage doc) on top of baseline `1b0036f`.
- Pushed to `origin/main`: `1b0036f..975a174`.
- CI run [33327412670](https://github.com/mal3abyapp-oss/Mal3aby/actions/runs/33327412670):
  GREEN — build-and-test + e2e-public (39 Playwright tests) both
  passed.
- Deployed to production: `cd cloudflare/frontend-worker && wrangler
  deploy` (Worker `mala3by-frontend`, version
  `73d421cb-6998-40c9-a2da-b4147958445b`). First deploy attempt used a
  `dist/` built before the final commit (stale build SHA baked in via
  `vite.config.ts`'s `define`); caught via console build-tag
  mismatch, fixed by rebuilding at the correct HEAD and redeploying.
- Production verified live: `https://mal3aby.app`, fresh-tab console
  confirms `build 975a174`, zero console errors, Membership Report
  tab loads with the same correct, reconciled data as local
  verification (same Supabase backend/club).
- Docs corrected: `docs/PROJECT_STATE.md` and `README.md` both
  contained a stale "Phase 18 not authorized" claim, superseded by
  `MAL3ABY_DEPLOYMENT_RUNBOOK.md`'s "DONE, live" status since
  2026-08-18 but never updated at the source. Corrected both to point
  to the runbook as the authoritative deployment record.

## 7. Final status

- MEMBERSHIP LIFECYCLE REPORT = PASS
- SECONDARY COVERAGE REVIEW = PASS (0 P1 gaps)
- REPORTING COVERAGE P0/P1/CORE P2 = 0
- TSC/LINT/UNIT/BUILD = PASS
- CI = GREEN (run 33327412670)
- PRODUCTION = VERIFIED (mal3aby.app, build 975a174)
- REPOSITORY HEAD = origin/main = 975a174
- WORKING TREE = clean (pending this doc's own commit)

REPORTING SYSTEM = COMPLETE PRODUCTION BASELINE.
