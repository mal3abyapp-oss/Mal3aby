# MAL3ABY V1 — Pricing Migration

This document records the legacy `platform_plans` inventory, the subscription-reference audit that gated every decision below, the exact migration steps taken, and an explicit confirmation that no historical billing data was altered.

## 1. Legacy plan inventory (before this release)

| id | name | monthly price (EGP) | `is_public` before | `display_order` |
|---|---|---:|---|---:|
| `d1a05e72-1d91-418a-a943-55b1deb2328e` | Monthly | 499 | true | 1 |
| `2ffe755e-bf96-4341-993d-f33d75c8076c` | Quarterly | 1,349/mo equiv. | true | 2 |
| `21988a54-0bda-433c-8e3d-d0d92b4756e9` | Semi-Annual | 2,499/mo equiv. | true | 3 |
| `21c0c577-2596-4809-a932-5092685f6161` | Annual | 4,499/yr | true | 4 |

## 2. Subscription-reference audit (the gate for every archival decision)

Run against `platform_subscriptions.plan_id` before any `platform_plans` row was touched:

| Plan | Live `platform_subscriptions` references |
|---|---:|
| Monthly | **4** |
| Quarterly | **0** |
| Semi-Annual | **0** |
| Annual | **1** |

**Rule applied:** a plan is only archived (`is_public = false`) if it has **zero** live subscription references. A plan with any real reference stays public — not because the pricing itself must remain sellable to new customers (it is excluded from the new public pricing page's display via a `display_order` threshold), but because Mal3aby's own admin/reporting surfaces that resolve a plan by `platform_plans` join must keep resolving correctly for existing subscribers, and `is_public` gates more than the public marketing page.

## 3. What was actually changed

- **Quarterly** (0 references) → archived: `is_public = false`.
- **Semi-Annual** (0 references) → archived: `is_public = false`.
- **Monthly** (4 references) → **left public**, unchanged pricing, unchanged everything. Excluded from the new `/pricing` page's rendered set via `NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER = 10` (Monthly's `display_order` is 1) — visible to nothing except code/admin paths that already resolve it by id for an existing subscriber.
- **Annual** (1 reference) → **left public**, unchanged pricing, unchanged everything. Same exclusion via `display_order = 4`.
- **6 new rows added** (not modifications): Starter/Growth/Pro × monthly/annual, `display_order` 10–31, the actual new commercially-packaged tiers described in [MAL3ABY_V1_COMMERCIAL_PACKAGING.md](MAL3ABY_V1_COMMERCIAL_PACKAGING.md).

No existing `platform_plans` row's `price`, `billing_interval`, or `id` was ever modified. No row was deleted.

## 4. Why this is safe for the 5 existing legacy subscribers

`platform_subscriptions` carries its own **immutable snapshot columns** — `price_snapshot`, `currency_snapshot`, `interval_snapshot`, `grace_period_days_snapshot` — captured at subscription-creation time. A club's actual bill, renewal terms, and grace period are read from its own subscription row's snapshot, never re-derived live from `platform_plans`. This means:

- Archiving Quarterly/Semi-Annual (`is_public = false`) has **zero effect** on any existing subscriber, because there are none.
- Even if Monthly or Annual's `platform_plans.price` were ever changed in the future (it was **not**, in this release), the 4 Monthly and 1 Annual subscribers' actual charged price would be unaffected — the snapshot, not the live plan row, is authoritative for an existing subscription.

This snapshot-immutability guarantee — not a promise to "never touch the plan," but a structural one — is the actual reason archival/new-tier-addition was safe to do without individually migrating or renegotiating with existing subscribers.

## 5. Historical invoice / billing data

**No historical invoice amount was altered.** No `invoices`, `platform_subscriptions`, or payment-record row was written to as part of this migration. The migration touched only `platform_plans` (added 6 rows, flipped `is_public` on 2 pre-existing zero-reference rows) and `commercial_entitlements` (added 3 new nullable columns: `staff_limit`, `active_player_limit`, `controlled_resource_grace_days` — additive, backward-compatible, no existing row's meaning changed).

## 6. Migration files (chronological)

1. `20260904210000_commercial_packaging_plans_and_entitlements.sql` — the 6 new tier rows, the archival of Quarterly/Semi-Annual, the 3 new `commercial_entitlements` columns, `create_platform_subscription()` update to seed them.
2. `20260904210100_commercial_packaging_usage_rpcs.sql` — usage counting RPCs (`count_active_customers_and_players`, `count_active_staff`, `get_commercial_usage`), grace-state table and refresh function.
3. `20260904210200_commercial_packaging_founding_offer.sql` — founding offer table, claim RPC, original status RPC.
4. `20260904210300_commercial_packaging_trial_gate_on_onboarding.sql` — onboarding-gated trial start.
5. `20260904210400_commercial_packaging_whatsapp_usage_visibility.sql` — WhatsApp usage visibility for the Platform Owner.
6. `20260904210500_commercial_packaging_public_plans_view_extend.sql` — extends `public_plans` with id/name/capacity columns for the new pricing page.
7. `20260904220000_fix_founding_offer_status_non_founder_price.sql` — non-founder `current_effective_price` fix (see acceptance doc for defect detail).
8. `20260904220100_founding_slots_public_count_view.sql` — anon-safe `founding_offer_public_status` view.

All 8 migrations are applied to and confirmed live on production project `gxkrtlvpjwxhcqdisyob`.
