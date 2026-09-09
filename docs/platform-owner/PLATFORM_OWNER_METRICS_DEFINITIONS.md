# Platform Owner Metrics Definitions

Written 2026-09-08, branch `feature/platform-owner-control-plane-v1`. Precise, citable formulas
for every commercial/health metric this mission added or touched, written for someone who needs
to trust or audit the numbers, not just read a dashboard. Every formula below cites its exact
source RPC and migration file. No number here is invented or generously rounded — where a value
is a reasoned default rather than a derived fact, that is stated explicitly, matching this
mission's own "do not fake it" discipline throughout `FINAL_OWNER_DECISIONS_REQUIRED.md`.

**Deployment status**: none of the RPCs cited below have been applied to production as of this
writing (see `PLATFORM_OWNER_CONTROL_PLANE_V1.md`'s opening note). Formulas here describe what
the code will compute once deployed, not numbers already visible in production.

---

## 1. MRR (Monthly Recurring Revenue)

**Source**: `get_platform_commercial_snapshot()`,
`supabase/migrations/20260908170000_platform_owner_v1_phase6_commercial_snapshot.sql`.

**Exact definition**: for each real (non-fixture) club's single most-recent **current**
subscription row (`platform_subscriptions.lifecycle_status = 'active'`), included only if
`subscription_kind = 'paid'`:

1. **Complimentary subscriptions are excluded entirely** — non-revenue by definition
   (`create_platform_subscription()` always writes `price_snapshot = 0` for these rows; excluded
   explicitly anyway rather than relying on the zero, to make the intent unambiguous).
2. **Cancelled subscriptions are structurally excluded** — the CTE only selects
   `lifecycle_status = 'active'`.
3. **Trial subscriptions are excluded** — trials are structurally non-revenue.
4. **Monthly normalization**: the subscription's own immutable `*_snapshot` columns are used
   (never a live join to `platform_plans`, which would retroactively change historical MRR if the
   plan's price changed later):
   - if `interval_snapshot = 'month'`: `price_snapshot / interval_count_snapshot`
   - if `interval_snapshot = 'year'`: `price_snapshot / (interval_count_snapshot * 12)`
   - any other combination (defensive only — `interval_snapshot` is CHECK-constrained to exactly
     `('month','year')` at the table level) is excluded from MRR rather than guessed at.
5. **Founding-offer override — the one non-obvious part**: `price_snapshot` on a `paid`
   subscription row is **always the full list price**, confirmed by reading every write path
   (`create_platform_subscription`, `renew_platform_subscription`, `change_platform_plan`) — none
   of them ever writes a discounted amount into `price_snapshot`. The founding-offer 50%-off
   discount exists entirely as a **separate, read-time-only computation** in
   `founding_customer_slots` (`promotional_price` while `now() < promotion_end`, else
   `normal_price_after_promotion`). For a club holding a `founding_customer_slots` row, MRR uses
   that dynamic current-effective-price instead of `price_snapshot`, normalized by the same
   interval factor from the subscription's own snapshot (founding slots have no billing interval
   of their own — it's a per-club price override layered on the subscription's real cadence).

**MRR = sum of every qualifying club's monthly-normalized amount.**

**The resulting intentional divergence, stated explicitly so it is never mistaken for a
reconciliation bug**: MRR and the club's actual invoiced/collected amount
(`platform_invoices.amount`, `get_platform_revenue_report()`) will legitimately disagree for any
founder club during their promo window. MRR shows the discounted rate (the correct reading of
"MRR represents normalized recurring revenue"); invoices/collected revenue show the full
list-price amount actually invoiced and collected. The alternative (MRR always equal to
`price_snapshot`) would overstate founder-club revenue by 2x during the promo window — judged
clearly wrong, but the resulting gap is real and by design, not an error to reconcile away.

---

## 2. ARR (Annual Recurring Revenue)

**Source**: same RPC as MRR.

**Exact definition**: `ARR = MRR × 12`. Deliberately **not** computed independently from annual
subscriptions directly — that would risk a second, possibly-inconsistent MRR-shaped calculation.
ARR is derived from the same MRR figure the RPC already returns, per the mission directive's
explicit instruction.

**What it does and doesn't account for**: it inherits every MRR characteristic above verbatim,
including the founder-club discount override and the exclusion of complimentary/trial/cancelled
subscriptions. It does not forecast churn, expansion, or contraction — it is a simple ×12
projection of the current MRR snapshot, not a cohort-adjusted forecast.

---

## 3. Outstanding / collected revenue

**Outstanding amount** — **Source**: `get_platform_commercial_snapshot()`, same migration as
MRR.

**Exact definition**: `sum(platform_invoices.amount)` where `status IN ('pending', 'overdue')`,
joined through `clubs.is_test_fixture = false`. `void` invoices are correctly excluded (a voided
invoice is not owed). This is an **exact sum, not an estimate** — `platform_payments` has no
partial-balance/payment-allocations bridge table (confirmed by schema read); `record_platform_
payment()` flips `platform_invoices.status` straight to `'paid'`, a binary state with no
partial-payment concept to approximate.

**Collected revenue** — **Source**: `get_platform_revenue_report()` (pre-existing, unchanged by
this mission). Cash collected this month. **Deliberately not reimplemented or merged into the
new Commercial Snapshot RPC** — the frontend keeps calling this existing RPC and sums
client-side exactly as before, per the mission directive's explicit "keep collected revenue
conceptually separate from MRR/outstanding" requirement. `get_platform_commercial_snapshot()`
does not return a collected-revenue field at all, making the separation structural rather than a
UI convention someone could later blur.

---

## 4. Trial-to-paid conversion rate

**Source**: `get_platform_commercial_snapshot()`, same migration as MRR.

**Status**: **permanently `null` / unavailable today** — `trial_to_paid_conversion_rate` always
returns SQL `null`, and `trial_to_paid_conversion_rate_unavailable` always returns `true`.

**The structural reason, verified directly against every write path that can create a
`platform_subscriptions` row**: a trial-to-paid conversion is two fully independent, manually
triggered Platform Owner actions — optionally cancelling the trial row, then calling
`create_platform_subscription(kind='paid')` as a **brand-new row**. `previous_subscription_id` is
populated only by `renew_platform_subscription()` and `change_platform_plan()` — both of which
operate on an already-paid row. `create_platform_subscription()` itself **never** sets
`previous_subscription_id`, so a paid row created immediately after a trial carries **no
structural link back to that trial row**.

**Why a heuristic wasn't used instead**: the only available fallback (same `club_id`, paid
`start_at` shortly after trial `end_at`/`cancelled_at`) is a heuristic, not a real link, and would
silently misclassify:
- a club that re-trials (cancels a trial, later starts a fresh one, then converts — which trial
  does the paid row "belong" to?)
- a club whose trial was cancelled for an unrelated reason (fraud, duplicate signup) and later
  paid independently, with no causal connection to the earlier trial at all

Per the mission directive's explicit instruction to mark rather than guess when the data model
doesn't cleanly support a metric, this returns `null` with the unavailability flag set, and the
frontend renders an honest "not yet available" state instead of a fabricated rate.

**What schema change would be needed to compute it for real**: `create_platform_subscription()`
would need a new optional parameter (e.g. `p_converted_from_trial_id uuid`) so the Platform Owner
explicitly declares the link at the moment of conversion. This is **a real product decision, not
something this mission decided or should decide unilaterally** — open questions include whether
the link should be mandatory or optional at the moment of conversion, and whether it should be
auto-suggested from the same club's most recent cancelled trial. See
`FINAL_OWNER_DECISIONS_REQUIRED.md` #11 for the full framing.

---

## 5. Tenant Health classification (HEALTHY / WATCH / AT_RISK)

**Source**: `get_platform_tenant_health()`,
`supabase/migrations/20260908180000_platform_owner_v1_phase10_tenant_health.sql`.

**Exact signals used**, in the order the function evaluates them (first matching tier wins):

**AT_RISK** if any of:
- `access = 'blocked'` — derived identically to `get_platform_clubs_access()`'s own logic (club
  status `suspended`/`closed`, OR no non-cancelled subscription row, OR
  `now()` past `end_at + grace_period_days_snapshot`)
- any **hard-enforced** resource (branch/field/academy, from `commercial_entitlements_usage`) is
  at or over its limit: `used >= limit`, limit not null
- any **controlled** resource (staff/active_player) is in `over_limit` state — i.e.
  `now() > first_over_limit_at + controlled_resource_grace_days` (grace period already elapsed)
- WhatsApp's circuit breaker is open (`whatsapp_accounts.circuit_breaker_open_until > now()`) —
  the connector has stopped sending entirely, distinct from merely experiencing some failures

**WATCH** if not already AT_RISK, any of:
- `access = 'grace'` — past `end_at`, still inside the grace window
- subscription expiring soon — same 3-day-trial/7-day-paid threshold as
  `isSubscriptionExpiringSoon()` in `labels.ts`, mirrored in SQL (a stored procedure cannot call
  a TypeScript helper — any future change to that threshold must be mirrored by hand in both
  places)
- a hard-enforced resource is "approaching" its limit: `80% <= used < 100%`
- a controlled resource is in `grace` state (over limit, but grace period still running)
- an `overdue` `platform_invoices` row exists for the club (a real, distinct WATCH-worthy signal —
  money owed, but access not yet cut)
- WhatsApp connection status is neither `connected` nor `not_connected` (genuinely
  disconnected/erroring, not just never configured), OR 7-day failed-message count > 0
- `clubs.flagged_duplicate = true`
- the club is **more than 30 days old** (`clubs.created_at`) AND has **zero recorded activity in
  the trailing 30 days** (same Last Activity definition as Section 6 below) — this signal alone
  never promotes a club to AT_RISK, and never fires for a club still within its first 30 days

**HEALTHY** otherwise.

**Exact threshold citations**: 80% approaching-limit threshold matches the same value already
established elsewhere in this codebase's billing review (the same 80% used by the Attention
Center's `near_plan_limit` condition and by `get_commercial_usage()`'s own severity tiers). The
3-day/7-day expiring-soon threshold matches `isSubscriptionExpiringSoon()` in
`src/features/platform/labels.ts`.

**What tips a club between tiers, in one sentence**: a club moves HEALTHY→WATCH the moment any
single soft signal above appears (grace, near-limit, overdue invoice, WhatsApp trouble, flagged,
or stale); it moves (WATCH or HEALTHY)→AT_RISK only when access is actually blocked, a hard limit
is actually breached (not just approached), a controlled resource's grace has actually elapsed,
or WhatsApp has actually stopped sending — i.e. AT_RISK is reserved for conditions where the
tenant's actual ability to use the product is already compromised, not merely trending that way.

**The 30-day threshold — explicitly a reasoned default, not a derived fact**: chosen to match
this schema's own "about a month" grace-window convention
(`platform_settings.default_grace_period_days`), **not derived from any real distribution of
tenant activity** — Mal3aby has zero real paying customers as of this mission, so no such data
exists to derive it from. Flagged in `FINAL_OWNER_DECISIONS_REQUIRED.md` #13 for explicit owner
review once real tenants exist. The mission's own example question that shaped this design:
"should a club with zero activity ever since trial start be AT_RISK, or is that just a brand-new
signup that hasn't had time yet?" — resolved conservatively by never flagging a club within its
first 30 days, so a legitimate new signup is never penalized for not having activity yet.

---

## 6. Last Activity

**Source**: `get_platform_club_last_activity(p_club_id)` (single-club version) and the same
formula inlined in `search_platform_clubs()` (list version) and `get_platform_tenant_health()`
(health version) —
`supabase/migrations/20260908160000_platform_club_360_academy_count_and_last_activity.sql` for
the first two, `20260908180000_platform_owner_v1_phase10_tenant_health.sql` reuses the identical
formula rather than calling the RPC per-club (to avoid an N+1 shape at scale).

**Exact definition**: `MAX()` of exactly 3 event types, deliberately including cancelled/void
records:

1. `bookings.created_at` — booking placed, **any status, including cancelled**
2. `payments.received_at` — payment received, **any status, including later-voided**
3. `attendance.marked_at` — an academy attendance record was marked

**Why cancelled/voided rows are deliberately included, not excluded**: a cancelled booking or a
later-reversed payment still reflects a real person at the club taking a real action at that
moment — excluding it would make a club with recent-but-cancelled activity look more dormant than
it actually was. This is a **deliberately different definition** from
`count_active_customers_and_players()`'s active-player count, which excludes both cancelled and
voided rows, because that RPC counts *current commercial usage*, not *historical activity* — the
two RPCs answer genuinely different questions and are not meant to agree.

**What happens when a club has zero activity across all three signals**: the function returns a
`null` timestamp and `null` activity type — rendered by the frontend as "no recorded activity",
**never** defaulted to `clubs.created_at` (which would misleadingly imply activity that never
happened).

**Deliberately excluded signals**: staff login/last-seen (no such column exists anywhere in the
schema — would require new infrastructure, out of scope for V1) and WhatsApp message activity
(already surfaced separately via `get_platform_whatsapp_health()` — folding it into "last
activity" would blur two distinct signals the console keeps separate).

---

## 7. Every Attention Center condition's exact trigger logic

**Source**: `get_platform_attention_items()`,
`supabase/migrations/20260908161500_platform_owner_v1_phase7_attention_center.sql`. Every branch
below is `UNION ALL`'d together and filters to `coalesce(c.is_test_fixture, false) = false`.

| # | `problem_type` | Severity | Exact trigger |
|---|---|---|---|
| 1 | `whatsapp_disconnected` | danger | `whatsapp_accounts.status NOT IN ('not_connected', 'connected')` — i.e. a club that once connected and is now in an error/disconnected state, not a club that never configured WhatsApp |
| 2 | `whatsapp_failures` | warning | `count(*)` of `notification_queue` rows where `channel = 'whatsapp'`, `status = 'failed'`, `created_at > now() - interval '7 days'`, grouped per club; `detail` carries the raw count |
| 3 | `flagged_duplicate` | warning | `clubs.flagged_duplicate = true` AND `clubs.status = 'active'` (a club already suspended for this reason isn't re-flagged as still "live") |
| 4 | `no_subscription` | danger | `clubs.status NOT IN ('suspended','closed')` AND zero rows exist in `platform_subscriptions` for that club at all |
| 5 | `pending_upgrade_request` | warning | one row per `commercial_upgrade_requests` row where `status = 'pending'` — a club with 2 pending requests yields 2 items |
| 6 | `expiring_soon` | warning | latest non-cancelled subscription: `end_at > now()` AND `end_at <= now() + (3 days if subscription_kind='trial' else 7 days)` |
| 7 | `expired` | danger | latest non-cancelled subscription: `end_at <= now()` (already past, but `lifecycle_status` hasn't been transitioned to `cancelled`) |
| 8 | `over_plan_limit` | danger | any of branches/fields/academy/staff/active_players (`commercial_entitlements_usage`): `resource_limit IS NOT NULL AND resource_used > resource_limit` |
| 9 | `near_plan_limit` | warning | same 5 resources: `resource_limit IS NOT NULL AND resource_used <= resource_limit AND resource_used >= resource_limit * 0.8` (excludes rows already counted under condition 8) |

**Ordering**: `ORDER BY severity, context_at DESC NULLS LAST` — danger items first, then warning,
each group most-recent-first. This is a fixed 2-level classification, **not** a weighted score —
no composite ranking beyond this ordering is computed anywhere.

**Explicitly and permanently excluded** (not a gap to fill later — confirmed structurally
impossible or unreliable):
- **Onboarding incomplete** — confirmed via schema read
  (`20260815180000_phase3d_onboarding.sql`) that neither `clubs` nor `platform_subscriptions` has
  any real onboarding-status/progress column. Only `flagged_duplicate` exists and is already
  condition 3.
- **New leads** (`contact_requests`) — confirmed via schema read that this table has no `club_id`
  column at all (an anonymous, pre-signup, insert-only inbox, explicitly documented in its own
  table comment as "not a CRM"). It cannot be expressed as a `(club, problem)` row and remains its
  own separate platform-wide card on Overview.
