# MAL3ABY V1 — Commercial Packaging

**Status: implemented, merged to `main`, DB foundation production-verified live. Frontend deployment to `mal3aby.app` is pending explicit owner authorization (see [MAL3ABY_V1_PACKAGING_ACCEPTANCE.md](MAL3ABY_V1_PACKAGING_ACCEPTANCE.md) for the exact blocker).**

This document is the single source of truth for Mal3aby's V1 commercial packaging: the three paid tiers, pricing, capacity limits, the active-player/customer definition, controlled-vs-hard-enforced resources, WhatsApp policy, trial mechanics, and the Founding Customer offer. It reflects what is actually implemented and deployed to the production database, not an aspirational plan.

## 1. Tiers and pricing

| Tier | Monthly (EGP) | Annual (EGP) | Annual discount |
|---|---:|---:|---:|
| Starter | 1,790 | 18,000 | 16.2% (vs. 12× monthly = 21,480) |
| Growth | 2,990 | 30,000 | 16.4% (vs. 12× monthly = 35,880) |
| Pro | 4,990 | 50,000 | 16.5% (vs. 12× monthly = 59,880) |
| Enterprise | Custom | Custom | — (not a `platform_plans` row; sales-negotiated) |

All prices are in EGP. Annual prices are deliberately round, commercially clean numbers (18,000 / 30,000 / 50,000), not raw 12×-with-15%-off arithmetic — the discount percentage is a *consequence* of the chosen round number, not the other way around.

## 2. Capacity limits per tier

| Resource | Starter | Growth | Pro | Enforcement |
|---|---:|---:|---:|---|
| Branches | 1 | 3 | 6 | **Hard** (BEFORE INSERT trigger) |
| Fields/facilities | 3 | 10 | 25 | **Hard** (BEFORE INSERT trigger) |
| Academies | 1 | 3 | 6 | **Hard** (BEFORE INSERT trigger) |
| Staff | 5 | 15 | 40 | **Controlled** (grace-state, never blocks) |
| Active players/customers | 300 | 1,000 | 3,000 | **Controlled** (grace-state, never blocks) |
| Bookings | Unlimited | Unlimited | Unlimited | — |
| Reporting | Full | Full | Full | — |

`NULL` on any `commercial_entitlements` limit column means unlimited (pre-existing schema convention, reused as-is — never redefined for this release).

### Hard-enforced resources (branch / field / academy)
Unchanged from before this release. A club at its limit gets a real `INSERT` rejection from `enforce_branch_limit()` / `enforce_field_limit()` / `enforce_academy_limit()` (BEFORE INSERT triggers), with a Platform-Owner-visible upgrade-request flow (`request_commercial_upgrade`) already in production before this session.

### Controlled resources (staff / active players)
New this release, deliberately **not** trigger-enforced:
- **80% of limit** → `warning` status.
- **100%+ of limit** → `grace` status. The club is never blocked from adding more staff or serving more players.
- Grace period defaults to **7 days** (`commercial_entitlements.controlled_resource_grace_days`, `commercial_resource_grace_state` table), after which an unresolved over-limit club is flagged `over_limit` — still never blocked, deleted, disabled, or auto-upgraded, and never automatically charged.
- Status is computed at read time by `get_commercial_usage(p_club_id)`, refreshed by `refresh_commercial_grace_state()` (service-role/`postgres` only — no `authenticated` grant).

This distinction (hard vs. controlled) is deliberate: branch/field/academy creation is a discrete, infrequent, staff-driven action where a hard stop is reasonable UX. Staff count and active-player count grow continuously through normal day-to-day usage (bookings, attendance, hiring) — hard-blocking either would silently break a club's ability to operate. The product decision was to warn and grace instead, and let the Platform Owner or the club decide on an upgrade.

## 3. Active player/customer definition (exact, deterministic, auditable)

Implemented in `count_active_customers_and_players(p_club_id uuid) returns integer`:

- **Active customer**: a `customers` row (not merged into another customer — `merged_into_customer_id is null`) with at least one qualifying activity in the **trailing 90 days**:
  - a non-cancelled `bookings` row (`status <> 'cancelled'`), keyed on `created_at`, **or**
  - a completed `payments` row (`status = 'completed'`), keyed on `received_at`.
- **Active player**: a `players` row with `status = 'active'` and at least one `attendance` row in the trailing 90 days, keyed on `marked_at` (the attendance event timestamp — deliberately not `training_sessions.session_date`, which can be a future, not-yet-occurred session and would overcount).
- **Deduplication**: an active player linked to a guardian (`guardian_links`) is counted under that guardian's customer id, not as a separate unit — one real family/household is one unit, matching how the product actually bills and communicates with them. An active player with no guardian link (e.g. a self-registered adult) counts as its own unit.
- Final count = `|active customers ∪ guardian-resolved active players| + |active players without a guardian|`.

This is a single SQL function, callable and independently auditable by anyone with schema access — not an approximation, and not derived from a mutable cache.

## 4. Trial

- **Demo → Onboarding → 14-day trial → Paid.**
- Trial START is gated on **onboarding completion** (`clubs.onboarding_completed_at`, set by `mark_club_onboarding_complete()`), not on account creation. `complete_new_club_onboarding()` no longer inserts a trial entitlement itself — the atomic `automatic_trial_entitlements` claim (pre-existing UNIQUE-constraint pattern) still guarantees one trial per club, but the trial clock does not start until onboarding is actually done.
- Both the customer and the Platform Owner can see trial status, start date, end date, days remaining, and next action via the existing entitlements/subscription surfaces plus this release's new usage cards.

## 5. Founding Customer offer

- **First 5 PAYING customers only.** Enforced server-side, atomically, via `founding_customer_slots` (`slot_number` `PRIMARY KEY CHECK (between 1 and 5)`), claimed through `claim_founding_customer_slot()` using a `for v_candidate in 1..5 loop ... exception when unique_violation then continue` pattern — the same atomic-claim idiom already proven in this codebase by `automatic_trial_entitlements`. This is a real database constraint, not an application-level check that a race condition or a compromised client could bypass.
- **50% off list price for the first 3 months**, then automatic reversion to full list price — never permanent, never lifetime. `promotion_end` and `normal_price_after_promotion` are stored explicitly per claimed slot.
- `get_founding_offer_status(p_club_id)` returns founder status, slot number, list price, promotional price, promotion start/end, normal price after promotion, `current_effective_price` (computed: promotional price while `now() < promotion_end`, else the normal post-promotion price), and slots remaining.
- **Non-founder fix (this session)**: `current_effective_price` for a non-founder club now resolves from that club's own most recent active paid `platform_subscriptions.price_snapshot` (falls back to `null` only if no active paid subscription exists, e.g. still trialing). Previously this was always `null` for every non-founder — see [MAL3ABY_V1_PACKAGING_ACCEPTANCE.md](MAL3ABY_V1_PACKAGING_ACCEPTANCE.md) for the defect record.
- The Platform Owner sees, per tenant: founder eligibility/slot number, discount, promotion dates, and the normal price it reverts to — via the new `CommercialUsageAndFoundingOfferCard` on the club detail page.
- Public visitors see only an aggregate slots-remaining count (0–5), via the narrow `founding_offer_public_status` view — never club identity, price, or claim details (those stay fully RLS-protected on `founding_customer_slots`).
- **As of this document, 0 of 5 slots are claimed** — no real financial charges have been processed as part of this work, per the mission's explicit constraint.

## 6. WhatsApp policy

No public numeric quota in this release. Required, exact wording, used verbatim on the public pricing page:
- Arabic: **"واتساب مشمول وفق سياسة الاستخدام العادل"**
- English: **"WhatsApp included under Fair Usage Policy"**

The Platform Owner gets usage visibility only (`whatsapp_usage_by_club` view, `get_whatsapp_usage_platform_wide()`) — there is no billing system attached to WhatsApp usage in this release.

## 7. Legacy plans

See [MAL3ABY_V1_PRICING_MIGRATION.md](MAL3ABY_V1_PRICING_MIGRATION.md) for the full inventory and audit. Summary: Quarterly and Semi-Annual (0 live subscription references each) were archived (`is_public = false`); Monthly (4 references) and Annual (1 reference) remain public only for existing-subscriber protection and are excluded from the new public pricing page's display, never shown to new customers, never blindly rewritten.

## 8. Support and onboarding levels

| Tier | Support | Onboarding |
|---|---|---|
| Starter | Standard | Basic (self-guided) |
| Growth | Priority | Guided |
| Pro | Priority | Guided + data migration assistance |
| Enterprise | Dedicated | Full configuration service & staff training |

## 9. Public pricing page

`/pricing` (`src/features/public-site/PricingPage.tsx`): real tier data sourced live from the extended `public_plans` view (never hardcoded), Arabic + English, responsive (mobile-verified single-column, desktop 3-column grid), Growth marked "Recommended", Founding Customer promotion shown as a **separate banner section** above the plan cards — never a deceptive crossed-out price on the cards themselves — and a static (non-DB) Enterprise card with a Contact Us CTA.
