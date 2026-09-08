# Platform Owner Control Plane V1

Written 2026-09-08, branch `feature/platform-owner-control-plane-v1` (14 commits ahead of
`main`, HEAD `e87f284` at the time of writing). This is the main reference document for the
mission that took the read-only findings in
[`PLATFORM_OWNER_DEEP_DIVE_REPORT.md`](PLATFORM_OWNER_DEEP_DIVE_REPORT.md) (baseline, preserved
unchanged, branch `main` @ `88b3559`) and implemented the Phase-A/Phase-B fixes it recommended.

**Deployment status, stated up front because it matters everywhere below**: this branch has
**not been applied to production**. 6 new/modified migrations exist only in this branch's
`supabase/migrations/`. Supabase MCP access was blocked for the entire mission (confirmed
repeatedly, see the Deep Dive Evidence Log), so nothing here was ever run against the live
database. Every RPC/column described in this document is CODE VERIFIED (read directly from the
migration SQL and the frontend call sites) but **not yet LIVE VERIFIED against production data**
beyond one authenticated browser session that correctly showed graceful 404/error states for the
new RPCs (see Phase 18 evidence in `FINAL_OWNER_DECISIONS_REQUIRED.md` #19). See
[`PLATFORM_OWNER_OPERATIONS_GUIDE.md`](PLATFORM_OWNER_OPERATIONS_GUIDE.md) for what that means
day to day.

---

## 1. What this is, and isn't

**What this is**: a practical SaaS Control Plane sized for Mal3aby's first ~25 real paying
customers. The Deep Dive found a console that was commercially mature but operationally
fragmented — no single screen answered "which of my clubs needs my attention today?", no
last-activity signal existed anywhere, and a real hired platform staff member was locked out of
the console built for them. This mission closed those specific gaps.

**What this deliberately did NOT build** (from the mission's own "DO NOT BUILD" list, matching
the Deep Dive's Section 23/27 phasing — these were judged premature at 25-customer scale, not
forgotten):

- **Enterprise BI / charts / trend lines** — every number in this console (Overview, Commercial
  Snapshot, Tenant Health) is a plain point-in-time figure, matching the pre-existing StatCard
  convention. No time-series, no charting library, no trend arrows.
- **A generic CRM** — Sales Intelligence (a separate bounded context, ADR-054) already exists and
  was not extended or duplicated. This mission did not add a dollar-value pipeline field, deal
  scoring, or CRM-style lead assignment.
- **Full impersonation** — the existing `platform_support_sessions` model (auditable, time-boxed,
  `auth.uid()` never changes) was kept as-is. No true identity assumption was added; the Deep
  Dive explicitly recommended against ever building this.
- **AI-driven scoring or a weighted health score** — Tenant Health is HEALTHY/WATCH/AT_RISK with
  explicit `reasons`, not a 0–100 number. The Attention Center is a fixed danger/warning
  classification, not a ranked/weighted queue. Both were deliberately kept simple per the
  mission's own "not a complicated scoring engine yet" instruction.
- **MRR/ARR-driven forecasting, expansion/contraction/churn metrics** — MRR/ARR themselves were
  added (Phase 6, see below), but no forecast, no cohort analysis, no churn rate.
- **Bulk operations / CSV export** — still absent, per the Deep Dive's own "low value at 13
  clubs" classification, unchanged this mission.
- **New event-tracking infrastructure** — "last activity" was built as a pure aggregation over
  existing `bookings`/`payments`/`attendance` rows, not a new heartbeat/ping table.

A future reader should treat all of the above as **deliberately out of scope**, not as things
this mission ran out of time for.

---

## 2. The two-domain authorization model

Mal3aby's Platform Owner console has always had two separate authorization domains. Before this
mission, only one was reachable.

**Domain A — `is_platform_owner()`, unchanged.** A `club_memberships` row with
`roles.key='platform_owner'`, `status='active'`. This is the original, sole authority every
existing `is_platform_owner()`-gated RPC and RLS policy depends on. **Nothing about Domain A was
touched by this mission** — every dependency chain that existed before still works byte-for-byte
identically (independently confirmed by a Phase 15 security review, see
`FINAL_OWNER_DECISIONS_REQUIRED.md`).

**Domain B — `platform_staff_memberships` / 6 seeded roles / 22 permission keys, now reachable.**
Schema: `platform_roles`, `platform_permissions`, `platform_role_permissions`,
`platform_custom_roles` + `platform_custom_role_permissions` (for Platform-Owner-authored custom
roles), and `platform_staff_memberships` (the identity link — one active row per user, exactly
one of `platform_role_id`/`platform_custom_role_id` set). Seeded in
`supabase/migrations/20260826121055_platform_staff_roles_schema.sql`:

| Role key | Intended for | Permission highlights |
|---|---|---|
| `platform_owner` | Catalog entry only — real owner authority still comes from Domain A | every one of the 22 keys |
| `platform_admin` | A trusted deputy | clubs (view+manage), staff (full CRUD), roles (full CRUD), support sessions, audit, settings.view |
| `platform_support` | Customer support | clubs.view, support.start_view, audit.view |
| `platform_finance` | Billing/finance | clubs.view, finance.view/manage, subscription.view/manage, audit.view |
| `platform_operations` | Day-to-day ops | clubs.view/manage, support.start_view/manage, audit.view |
| `platform_viewer` | Read-only | clubs.view, audit.view |

The 22 permission keys span 6 groups: `clubs`, `support`, `staff`, `roles`, `finance`,
`audit`, `settings`.

**The bridge**: `caller_platform_permission_keys()` (server-side RPC, already shipped before this
mission) is the single source of truth both domains funnel through. A real `is_platform_owner()`
account always resolves to holding every key (via the `has_platform_permission()` bridge — a
real owner is unconditionally treated as holding every permission, not by a redundant staff
membership row). A `platform_staff_memberships` holder resolves to their role's actual key set.
`AuthProvider.tsx` calls this once on session load/change (`loadPlatformAccess()`) and exposes
`isPlatformStaff: boolean` and `platformPermissionKeys: string[]` — a genuinely new, additive
signal alongside the untouched `isPlatformOwner`.

**What this mission fixed** (`src/app/routing/RequireAuth.tsx`, `RequirePlatformOwner`): before,
the route guard for the entire `/platform/*` tree checked only `isPlatformOwner`. It now allows
entry when `isPlatformOwner || isPlatformStaff`:

```tsx
if (!isPlatformOwner && !isPlatformStaff) {
  return <Navigate to="/app" replace />
}
```

This is a pure widening — a real owner's path is completely unchanged; a staff member with an
active `platform_staff_memberships` row can now reach the console shell. **Reaching the shell is
not the same as seeing every page** — least-privilege is enforced downstream at the nav level.

**Nav-level least-privilege filtering** (`src/app/layouts/PlatformLayout.tsx`): every `NavItem`
carries a `requiredPermissions: string[] | null`. `null` means always visible to anyone who can
reach the console (used only for Overview). Otherwise a staff caller must hold at least one of
the listed keys for the item to render; a real owner always sees everything
(`isPlatformOwner || !item.requiredPermissions || item.requiredPermissions.some(...)`
short-circuits on `isPlatformOwner`). Example: `/platform/plans` requires
`platform.finance.view` or `platform.finance.manage`; `/platform/staff` requires
`platform.staff.view`.

**Known gap, not fixed this mission** (Phase 15 security review, P2 — see Section 8 below): 4
RPCs behind nav items a staff member can now *see* still gate on `is_platform_owner()` only, not
`OR has_platform_permission(...)`. A staff member can click into Owners/Audit/Tenant-360/
Attention-Center and get a hard "not authorized" error. This is fail-closed (no leak), but the
staff-access feature does not functionally work end-to-end on those 4 screens yet.

---

## 3. Information architecture

7 nav sections, unchanged in shape from before this mission — the Deep Dive judged the existing
IA sound and recommended targeted fixes, not a rebuild. This mission only additively extended
what lives inside them:

1. **Overview** (`/platform`) — landing dashboard. Extended this mission with the Attention
   Center and Commercial Snapshot (Section 4/5 below), on top of the pre-existing Tenant
   Health/Commercial Signals stat groups.
2. **Clubs** (`/platform/clubs` list, `/platform/clubs/:clubId` detail, `/platform/owners`) —
   extended this mission with a Tenant Health badge column (Clubs list only, see Section 5),
   Last Activity (both list and detail), and an academy count (detail page). Owners page gained
   real pagination (Section 7).
3. **Commerce** (`/platform/plans`, `/platform/leads`) — unchanged this mission.
4. **Monitoring** (`/platform/reports`, `/platform/alerts`, `/platform/trials`,
   `/platform/audit`, `/platform/support-history`) — Reports gained a new WhatsApp tab (Section
   6). Audit gained real pagination (Section 7).
5. **Staff & Access** (`/platform/staff`, `/platform/roles`) — unchanged in IA; the underlying
   deactivate/role-change actions gained a required reason (Section 6).
6. **Sales Intelligence** (`/platform/sales/*`) — untouched this mission, out of scope.
7. **Settings** (`/platform/settings`) — untouched this mission.

---

## 4. The Attention Center

**What it is**: a genuine per-tenant exception list — one row per (club, problem) pair — replacing
the previous Overview panel's 6 per-metric aggregate cards, every one of which linked to the same
generic, unfiltered `/platform/clubs` list regardless of which was clicked (a confirmed Deep Dive
finding, Section 13). Each Attention Center item now links directly to that specific club's
Tenant 360 page.

**Source**: single RPC `get_platform_attention_items()`
(`supabase/migrations/20260908161500_platform_owner_v1_phase7_attention_center.sql`), rendered by
`PlatformOverviewPage.tsx`'s `fetchAttentionItems()`.

**Why one RPC, not client-side composition**: matches this codebase's own established convention
for exactly this shape of problem (`get_commercial_usage`, `get_platform_clubs_access`,
`get_platform_whatsapp_health` are all single batched, server-side RPCs). Composing 9 independent
per-tenant conditions client-side would mean up to 9 round trips on every Overview load —
reintroducing the exact N-round-trip anti-pattern an earlier phase of this same mission already
fixed once on this same page.

**The 9 conditions** (fixture-excluded throughout, `coalesce(c.is_test_fixture, false) = false`
on every branch):

1. `whatsapp_disconnected` (danger) — a club that once connected and is now not
   (`whatsapp_accounts.status not in ('not_connected','connected')`). A club that never set up
   WhatsApp at all is not flagged.
2. `whatsapp_failures` (warning) — count of failed WhatsApp sends in the trailing 7 days.
3. `flagged_duplicate` (warning) — an active club with `clubs.flagged_duplicate = true`.
4. `no_subscription` (danger) — an active club with zero `platform_subscriptions` rows at all (a
   real data-integrity gap, distinct from "expired").
5. `pending_upgrade_request` (warning) — one row per pending `commercial_upgrade_requests` row
   (a club with 2 pending requests surfaces as 2 items).
6. `expiring_soon` (warning) — the club's latest non-cancelled subscription ends within 3 days
   (trial) or 7 days (paid) — the same threshold as `isSubscriptionExpiringSoon()` in
   `labels.ts`, reimplemented in SQL since a stored procedure cannot call a TypeScript helper.
7. `expired` (danger) — latest non-cancelled subscription's `end_at` already passed but the row
   isn't marked cancelled — a distinct state from "expiring soon".
8. `over_plan_limit` (danger) — any of branches/fields/academy/staff/active_players is over its
   set (non-null) limit, per `commercial_entitlements_usage`.
9. `near_plan_limit` (warning) — same view, 80%–99% of limit (excludes rows already counted in
   condition 8).

**Deliberately skipped, not silently omitted**: "onboarding incomplete" (no such column exists
anywhere in the schema — confirmed via schema read, fabricating one would violate the mission's
"do not invent unreliable signals" instruction) and "new leads" (`contact_requests` has no
`club_id` column at all — an anonymous pre-signup inbox, cannot be expressed as a per-tenant row;
it stays its own small platform-wide card next to the Attention Center).

**Severity model**: fixed 2-level `danger`/`warning` classification per condition, sorted
danger-first then by recency. **Not a weighted score** — no single "health number" is computed
here (that's Tenant Health, Section 5, a structurally separate signal).

---

## 5. Tenant Health V1

**What it is**: a transparent per-club `HEALTHY`/`WATCH`/`AT_RISK` classification, computed
platform-wide in one batched call. Every row also carries a `reasons: text[]` array so a Platform
Owner never has to guess what a badge means — the classification is never a black-box score.

**Source**: `get_platform_tenant_health()`
(`supabase/migrations/20260908180000_platform_owner_v1_phase10_tenant_health.sql`), consumed only
by `PlatformClubsPage.tsx` (list column) as of this mission — **not yet on Tenant 360**, see
Section 8.

**Exact formula** (first matching tier wins, evaluated in this order):

**AT_RISK** if any of:
- `access = 'blocked'` (admin-suspended, no subscription, or past grace)
- any hard-enforced resource (branch/field/academy) is at or over its limit
- any controlled resource (staff/active_player) is in `over_limit` state (grace elapsed)
- WhatsApp circuit breaker is open (the connector has stopped sending entirely)

**WATCH** if not already AT_RISK, any of:
- `access = 'grace'` (past `end_at`, inside the grace window)
- subscription expiring soon (same 3-day-trial/7-day-paid threshold as the Attention Center)
- a hard-enforced resource is approaching its limit (80–99%)
- a controlled resource is in grace (over limit, but grace period still running)
- an overdue `platform_invoices` row exists for the club
- WhatsApp connection status is neither `connected` nor `not_connected`, or 7-day failures > 0
- `clubs.flagged_duplicate = true`
- the club is more than 30 days old **and** has zero recorded activity in the trailing 30 days

**HEALTHY** otherwise.

**Known limitation, stated explicitly rather than hidden**: the 30-day activity-staleness
threshold is a **reasoned default, not derived from real usage data** — Mal3aby has zero real
paying customers today, so no such distribution exists to derive it from. It was chosen to match
this schema's own "about a month" grace-window convention
(`platform_settings.default_grace_period_days`). See
[`FINAL_OWNER_DECISIONS_REQUIRED.md` #13](../../FINAL_OWNER_DECISIONS_REQUIRED.md) for the full
reasoning and the explicit call for the owner to revisit this once real tenants exist.

---

## 6. Commercial Snapshot

**What it computes**: `get_platform_commercial_snapshot()`
(`supabase/migrations/20260908170000_platform_owner_v1_phase6_commercial_snapshot.sql`) returns
one row: paying tenants, active trials, trials ending soon, expired-action-required count, MRR,
ARR, outstanding amount, and a trial-to-paid conversion rate field. Fixture-excluded throughout.
See [`PLATFORM_OWNER_METRICS_DEFINITIONS.md`](PLATFORM_OWNER_METRICS_DEFINITIONS.md) for every
exact formula.

**What it explicitly does NOT compute**: trial-to-paid conversion rate. This is **permanently
unavailable today, not a bug and not merely unimplemented** — there is no structural link in the
schema between a trial `platform_subscriptions` row and the paid row that follows it
(`create_platform_subscription()` never sets `previous_subscription_id`; that column is only
populated by `renew_platform_subscription()`/`change_platform_plan()`, both of which operate on
an already-paid row). The RPC always returns `trial_to_paid_conversion_rate = null` and
`trial_to_paid_conversion_rate_unavailable = true`, and the frontend renders an explicit "not yet
available" note rather than a fabricated percentage. A real fix requires a schema/RPC change
(e.g. `create_platform_subscription()` accepting an optional `p_converted_from_trial_id`) — a
product decision, not something this migration should silently retrofit. See Section 4 of
[`PLATFORM_OWNER_METRICS_DEFINITIONS.md`](PLATFORM_OWNER_METRICS_DEFINITIONS.md) and
`FINAL_OWNER_DECISIONS_REQUIRED.md` #11.

Collected revenue (cash collected this month) remains its own, separate, pre-existing metric
(`get_platform_revenue_report()`, unchanged) — deliberately kept mechanically and conceptually
apart from MRR/ARR/outstanding, per the mission directive.

---

## 7. The staff-action reason requirement — now server-enforced

Two of the most consequential admin actions — `deactivate_platform_staff` and
`set_platform_staff_role` — previously accepted no reason parameter at all (every prior real
audit row for these actions had `reason: NULL`, confirmed live by the Deep Dive: 4 production
rows, all null, permanently unexplainable).

Fixed in two passes this mission
(`supabase/migrations/20260908150000_platform_staff_actions_require_reason.sql`):

1. First pass added `p_reason text default null` to both RPCs, threaded through to
   `write_audit_log()`. The frontend (`PlatformStaffPage.tsx`) already disabled Save until a
   reason was typed.
2. **Revised after independent review**: an independent security reviewer (P2) and an
   independent UX reviewer (P1) both flagged that a direct RPC call (devtools, a script, a future
   UI regression) could still bypass the UI-only gate and pass `p_reason: null`. Fixed
   server-side to match this codebase's own established `platform_suspend_club()` precedent
   exactly: `if p_reason is null or length(trim(p_reason)) = 0 then raise exception`. `p_reason`
   keeps its `default null` in the signature only so the raised exception is a clear
   caller-facing error rather than a generic not-null-constraint failure.

The 4 pre-existing NULL-reason audit rows were **not** retroactively rewritten — `audit_logs` is
immutable by design (no UPDATE/DELETE policy for any role, ever), and fabricating a reason for a
real historical action would falsify the record. Those rows remain permanently `reason: NULL`,
correctly reflecting that no reason was captured at the time.

---

## 8. Real pagination on Owners and Audit

**Before**: `PlatformOwnersPage.tsx` and `PlatformAuditPage.tsx` both used an unbounded
in-memory "load more" accumulation pattern — a `pages` counter that re-fetched every page 0..N
on each render and concatenated results into one ever-growing client-side array/DOM. At
`audit_logs` = 2,197 rows (live-verified at Deep Dive time) and growing on every mutating action
platform-wide, this was a real, not hypothetical, scale risk.

**Fixed** (`supabase/migrations/20260908190000_platform_owner_v1_phase9_owners_audit_pagination.sql`):
`get_platform_club_owners()` and `get_platform_audit_log()` both gained a real `total_count`
column so the frontend can render Prev/Next + "page X of Y" instead of an open-ended "load more".
Both also gained a genuinely unique `ORDER BY` tiebreaker (primary key appended after the
timestamp column) — the previous ordering could skip or duplicate rows across
`LIMIT`/`OFFSET` page boundaries when two rows shared an identical timestamp (a real
possibility for audit rows written in the same transaction).

**Performance detail worth knowing**: `total_count` is computed via `count(*) over ()` (a window
function evaluated once per query plan), not a per-row correlated scalar subquery — an
independent Phase 14 performance review found the original draft recomputed the count once per
returned row (up to `p_limit` times) and had it fixed same-session before this migration landed.

Both changes are fully backward compatible — function name, parameters, and defaults are
unchanged; the new trailing `total_count` column is simply ignored by any caller not reading it
(e.g. `PlatformGlobalSearch.tsx`'s small lookup against `get_platform_club_owners`).

---

## 9. Known P2 follow-ups still open

Pulled directly from `FINAL_OWNER_DECISIONS_REQUIRED.md` — accurate as of this mission's end,
**none of these are fixed**:

- **`platform_invoices` has no index on `(club_id, status)`**, despite both
  `get_platform_commercial_snapshot()`'s `outstanding` CTE and `get_platform_tenant_health()`'s
  `overdue_invoices` CTE filtering/joining on exactly those columns, and both RPCs firing on
  every Overview/Clubs-page load. Deferred deliberately — it's a pre-existing table this
  mission's 6 migrations don't otherwise touch, and belongs in its own reviewed migration.
  **Action required before scaling meaningfully past ~100 tenants**:
  `create index idx_platform_invoices_club_status on public.platform_invoices (club_id, status);`
  — cheap, safe, additive, no data risk.
- **Nav-vs-RPC permission mismatch on 4 screens** (Section 2 above): `get_platform_club_owners`,
  `get_platform_audit_log`, `get_platform_club_360`, and `get_platform_attention_items` are all
  still gated `is_platform_owner()` only — pre-existing, not introduced by this branch, but now
  more visible since staff members can see these nav items. A legitimate staff member (e.g.
  `platform_support`) clicking Owners/Audit/Tenant-360/Attention-Center gets a hard "not
  authorized" error today. Fail-closed, not a leak — but not functionally working end-to-end.
  Fix: extend these 4 RPCs' authorization check to
  `is_platform_owner() OR has_platform_permission(<key>)`, matching the pattern already used
  correctly in `get_platform_commercial_snapshot()`/`get_platform_tenant_health()`.
- **Tenant 360's page-header badge shows only admin status** (active/suspended), not the more
  operationally relevant subscription/billing access state (full/grace/blocked), which lives in
  a separate card further down the page. "Is this club actually okay right now" isn't answerable
  from the very top of the page without scrolling.
- **Tenant Health badge is on the Clubs list only, not on Tenant 360** — deliberately deferred
  (a parallel agent was concurrently modifying `PlatformClubDetailPage.tsx` during this mission;
  adding the same badge there is a small, low-risk follow-up once that page's other work has
  been reviewed).
- **7 new/touched platform dashboard queries** inherit the app-wide react-query default
  (`staleTime: 30_000`, `refetchOnWindowFocus` on) rather than the longer explicit `staleTime`
  several other "left open all day" dashboards in this codebase use. Low priority, not fixed.

---

## 10. Related documents

- [`PLATFORM_OWNER_OPERATIONS_GUIDE.md`](PLATFORM_OWNER_OPERATIONS_GUIDE.md) — task-oriented
  guide for the actual Platform Owner running day-to-day operations.
- [`PLATFORM_OWNER_METRICS_DEFINITIONS.md`](PLATFORM_OWNER_METRICS_DEFINITIONS.md) — exact
  formula, source RPC, and file citation for every commercial/health metric in this console.
- [`PLATFORM_OWNER_DEEP_DIVE_REPORT.md`](PLATFORM_OWNER_DEEP_DIVE_REPORT.md) — the 859-line
  read-only baseline this mission was built against. Preserved as historical evidence; not
  modified by this mission.
- [`PLATFORM_OWNER_DEEP_DIVE_EVIDENCE_LOG.md`](PLATFORM_OWNER_DEEP_DIVE_EVIDENCE_LOG.md) — the
  raw working log behind that report. Preserved as historical evidence; not modified.
- [`FINAL_OWNER_DECISIONS_REQUIRED.md`](../../FINAL_OWNER_DECISIONS_REQUIRED.md) — the
  authoritative log of every product-judgment call, deferred item, and review finding from this
  mission (sections 6–19 cover this mission specifically).
