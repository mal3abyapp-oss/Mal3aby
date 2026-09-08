# Platform Owner Operations Guide

Written 2026-09-08, branch `feature/platform-owner-control-plane-v1`. This is a practical,
task-oriented guide for the Platform Owner — the business operator running Mal3aby's first ~25
real customers day to day — not a developer reference. For the technical "what was built and
why" account, see [`PLATFORM_OWNER_CONTROL_PLANE_V1.md`](PLATFORM_OWNER_CONTROL_PLANE_V1.md). For
exact metric formulas, see
[`PLATFORM_OWNER_METRICS_DEFINITIONS.md`](PLATFORM_OWNER_METRICS_DEFINITIONS.md).

**Read this first — deployment status**: everything described below that references the
Attention Center, Commercial Snapshot, Tenant Health badges, WhatsApp usage tab, academy count,
or Last Activity depends on 6 database migrations that **have not yet been applied to
production** as of this writing. Until an engineer applies them, those specific sections of
Overview/Clubs/Reports will show a graceful "could not load" error with a Retry button — not
broken, just not live yet. Everything else in this guide (suspend/reactivate, plan changes,
staff management, the existing dashboard cards) works today, unchanged.

---

## 1. A suggested daily/weekly workflow

**Every day, in this order:**

1. **Open Overview first** (`/platform`). Check the "Tenant health" row (Total/Active/
   Admin-Suspended/Blocked-Access clubs) for anything unexpected — a jump in Blocked-Access is
   worth investigating immediately, since it means a real club currently cannot use the product.
2. **Triage the Attention Center** (the "Needs attention" section, once the pending migrations
   are live). This is the single most important part of your daily routine — it is a ranked
   list, danger items first, of specific (club, problem) pairs, each one clickable straight to
   that club's Tenant 360 page. Work through it top to bottom. See Section 4 below for exactly
   what to do for each condition type.
3. **Scan for new leads** — the small "New Leads" card next to the Attention Center (this is
   separate from Sales Intelligence's own pipeline; it's the older, simpler `contact_requests`
   inbox).

**Weekly, or whenever you're reviewing the business, not firefighting:**

4. **Check the Commercial Snapshot** (once live) — paying tenants, active trials, MRR, ARR,
   outstanding amount. This is a point-in-time snapshot, not a trend — compare it mentally to
   last week's numbers if you want to track growth, since there's no built-in trend view yet.
5. **Check Trials** (`/platform/trials`) if you want the full list of every trial's exact state,
   not just the "ending soon" exceptions already surfaced on Overview/Attention Center.
6. **Scan the Clubs list** (`/platform/clubs`) sorted by Health column (once live) for anything
   sitting at WATCH or AT_RISK that the Attention Center didn't already surface — Tenant Health
   and the Attention Center overlap heavily but are not identical (Tenant Health also considers
   activity staleness, which the Attention Center does not).

**Do not** feel obligated to check every screen every day at 25 customers — the Attention Center
exists specifically so you don't have to. If it's empty, nothing urgent needs you today.

---

## 2. Reading a tenant's health badge

Once the pending migrations are live, the Clubs list (`/platform/clubs`) shows a Health column —
a colored badge with the club's current classification. **Hover over the badge to see exactly
why** — every badge carries a `reasons` tooltip, never just the label alone.

| Badge | Meaning | What it means operationally |
|---|---|---|
| **HEALTHY** (green) | No signal is flagged | No action needed. |
| **WATCH** (yellow) | At least one soft signal is present — grace period, expiring soon, approaching a plan limit, an overdue invoice, WhatsApp acting up, flagged as a possible duplicate, or genuinely stale (30+ days old with no recorded activity in the last 30 days) | Worth a look, not urgent. Check the tooltip for which specific reason(s) apply, then decide if outreach makes sense (e.g. a trial ending soon might warrant a check-in call). |
| **AT_RISK** (red) | Access is blocked (suspended, no subscription, or past grace), a plan limit is genuinely exceeded, a controlled resource's grace period has fully elapsed, or WhatsApp has stopped sending entirely | The club likely cannot use the product properly right now, or is about to lose access. This is your highest-priority category — go to that club's Tenant 360 page and act. |

**Important**: Tenant Health is not currently shown on the Tenant 360 page itself, only on the
Clubs list — see Section 5 below for what to do when a badge points you toward AT_RISK/WATCH; you
will need to navigate from the list into the detail page to actually act.

A dash (`—`) in the Health column means the health data failed to load or hasn't loaded yet —
**not** that the club is healthy. Refresh if you see a dash for every row.

---

## 3. Onboarding and managing platform staff

The console supports 6 platform staff roles beyond your own owner account, managed at
`/platform/staff` (accounts) and `/platform/roles` (custom roles, if you need something finer
than the 6 built-in ones).

| Role | What they can do |
|---|---|
| **Platform Admin** | Nearly everything you can do except being the literal owner account — manage clubs, full staff/role CRUD, support sessions, view audit and settings. Use for a trusted deputy. |
| **Platform Support** | View clubs, start view-only support sessions, view audit log. Good for a customer-support hire who needs to look things up and start a supervised support session, but shouldn't change billing or staff. |
| **Platform Finance** | View clubs, full finance/subscription view+manage, view audit. Use for whoever handles billing/invoicing/plan changes. |
| **Platform Operations** | View+manage clubs, full support session access, view audit. Use for day-to-day operational work (suspending/reactivating, running support sessions) without finance or staff-management access. |
| **Platform Viewer** | View clubs and audit log only, nothing else. Use for a stakeholder who needs visibility with zero write access. |
| **Platform Owner** (yourself) | Everything, unconditionally. Only you should hold this. |

**Why the reason-required actions matter**: deactivating a staff member or changing their role
are both consequential — they immediately affect a real person's access, and (for deactivation)
force-end any support session they currently have open. Both actions now **require you to type a
real, non-empty reason** before the system will let you proceed — this is enforced by the
database itself, not just the screen, so there's no way to bypass it even by accident. This
closes a real gap: before this fix, every deactivation/role-change in the audit log had no
recorded reason at all, making it impossible to explain later why an action was taken. Every
reason you type from today onward is permanently recorded in the audit log.

**A note on the one real staff account that existed before this mission**: the Deep Dive found
exactly one real platform staff membership in production, seeded but unable to log in (a real
architectural gap this mission fixed, see `PLATFORM_OWNER_CONTROL_PLANE_V1.md` Section 2). That
person should now be able to reach `/platform/*` — worth confirming with them directly once this
branch is deployed.

---

## 4. What actions are "dangerous" (require confirmation + a reason), and why

Every one of the following shows a confirmation dialog and requires you to type a reason before
it will proceed — this is deliberate friction on actions that are hard or impossible to undo
silently, or that materially affect a real tenant's access or a real person's employment access:

| Action | What it does | Why it's gated |
|---|---|---|
| **Suspend club** | Immediately blocks the club's access to the product (admin-level, independent of billing state) | The most consequential single action against a real tenant — cuts off a paying (or trialing) customer entirely |
| **Reactivate club** | Undoes a suspension | No reason required (this is an undo of an already-confirmed action, not a new destructive one) |
| **Cancel subscription** | Ends the club's current subscription | Directly affects billing/access; needs a documented business reason |
| **Deactivate staff member** | Immediately revokes their console access and force-ends any open support session they have | Comparably consequential to suspending a club — a real person's employee access disappears immediately |
| **Change staff role** | Reassigns which permissions a staff member holds | Privilege-adjacent — a server-side check also prevents you from ever granting a role with permissions you don't hold yourself |
| **Record a payment** | Marks an invoice paid | Financial record — should always have a documented "why"/source |
| **Reverse a payment** | Undoes a recorded payment | Financial correction — needs a clear explanation for the audit trail |
| **Edit commercial limits** (branch/field/academy/staff/active-player caps) | Changes what a club is entitled to use | Directly affects what the tenant can and can't do — the "confirmed unaudited commercial-write path" this codebase specifically fixed to require auditing |

**Every one of these actions is written to the audit log** (`/platform/audit`), including your
typed reason, who did it, and the before/after values where applicable. This log is immutable —
nothing can ever be edited or deleted from it, including by you.

---

## 5. What to do when the Attention Center flags something

Once the pending migrations are live, each Attention Center item maps to a suggested action:

| Condition | What it means | Suggested action |
|---|---|---|
| **WhatsApp disconnected** | The club's WhatsApp connection dropped after previously working | Open Tenant 360 → WhatsApp card, then ask the club owner to reconnect (there's no in-console retry/reconnect button — this is a known limitation) |
| **WhatsApp failures (7d)** | A count of recent failed WhatsApp sends | Check the failure count; if high, the club may need to reconnect or check their number's status with Meta |
| **Flagged duplicate** | This club was flagged as a possible duplicate signup | Review the flag reason (shown on Tenant 360's Identity card) and decide whether to suspend, merge manually, or clear the flag |
| **No subscription** | An active club with zero subscription rows at all — a real data-integrity gap | Investigate immediately; this shouldn't happen through the normal signup flow — create a subscription for them via Tenant 360 or escalate to engineering if you can't explain how it happened |
| **Pending upgrade request** | The club has requested more of a limited resource (branches/fields/etc.) | Go to Tenant 360's Requests tab, review, and approve or dismiss with a reason |
| **Expiring soon** | Trial ends within 3 days, or paid subscription within 7 days | Reach out proactively — for a trial, this is your conversion window; for paid, a renewal reminder |
| **Expired** | Subscription's end date has passed but it isn't marked cancelled yet | Decide whether to renew, downgrade, or formally cancel via Tenant 360 |
| **Over plan limit** | A hard-enforced resource (branch/field/academy) has exceeded its cap | The club is currently blocked from creating more of that resource — reach out about upgrading, or approve their pending upgrade request if one exists |
| **Near plan limit (80%+)** | Same resources, approaching but not yet over | A heads-up, not urgent — good context before their next renewal conversation |

---

## 6. What still requires developer or Supabase Dashboard help today

Be honest with yourself and your team about these gaps — do not treat the console as more
complete than it is:

- **The 6 pending migrations themselves.** Until an engineer applies them (a deliberate,
  separately-authorized step — this was never done during this mission per explicit instruction),
  the Attention Center, Commercial Snapshot, Tenant Health badges, the WhatsApp usage tab on
  Reports, academy counts, and Last Activity will all show a "could not load" error state, not
  real data. This is expected, not a bug, and resolves itself once the migrations run.
- **4 screens will show "not authorized" to staff members even after they can log in**: Owners,
  Audit, Tenant 360 (the detail page itself), and the Attention Center's underlying data are all
  still gated to the literal owner account only at the database level, even though staff members
  can now see these items in the nav. If a staff member reports a "not authorized" error on one
  of these specific screens, this is the known cause — not a new bug, and not something you can
  fix from the UI. It needs an engineer to widen those 4 RPCs' authorization check.
- **The `platform_invoices` table has no index on `(club_id, status)`** yet. Not visible to you
  today at low tenant counts, but should be added by an engineer before scaling meaningfully past
  ~100 tenants — it's a one-line, safe migration, just not yet written and applied.
- **No WhatsApp retry/reconnect button exists in the console.** If a club's WhatsApp disconnects,
  today's workaround is asking the club owner to reconnect themselves from their own side, or
  escalating to engineering. This has not changed with this mission.
- **Trial-to-paid conversion rate cannot be shown — ever, with the current data model**, not just
  "not yet built." See `PLATFORM_OWNER_METRICS_DEFINITIONS.md` Section 4 for the full reason.
  Making this available requires an engineering + product decision on how to link a trial to the
  paid subscription that follows it — flag to your team if this is something you want to invest
  in.
- **The 30-day activity-staleness threshold used by Tenant Health is a starting guess**, not
  something tuned against real customer behavior (Mal3aby has no real paying customers as of this
  writing). Once you have real usage patterns, revisit whether 30 days is the right window —
  this requires an engineer to change a SQL constant, not a UI setting.
- **No bulk actions, no CSV export** anywhere in the console. At 25 customers this should still be
  manageable one-at-a-time; flag to your team once it starts to feel painful.

If in doubt about whether something is "done" or "known-incomplete," check
[`FINAL_OWNER_DECISIONS_REQUIRED.md`](../../FINAL_OWNER_DECISIONS_REQUIRED.md) — it is the single
most currently accurate source of what's real versus what's still open, and is written for
exactly this kind of question.
