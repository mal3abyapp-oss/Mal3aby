-- Platform Owner Control Plane V1, Phase 6 (Commercial Snapshot V1).
--
-- get_platform_commercial_snapshot(): one SECURITY DEFINER RPC returning a
-- single row of platform-wide commercial metrics, matching the established
-- style of get_platform_revenue_report()/get_commercial_usage() (is_platform_
-- owner()-or-has_platform_permission-gated, revoke public/anon, grant
-- authenticated only).
--
-- ============================================================
-- METRIC-BY-METRIC DEFINITION (read before touching this function)
-- ============================================================
--
-- PAYING TENANTS: count of distinct clubs with a CURRENT
-- platform_subscriptions row where subscription_kind = 'paid' and
-- lifecycle_status = 'active', joined through clubs.is_test_fixture = false.
-- Reliable -- both columns are the real, current-period source of truth
-- (ADR-038: one row per billing period, "current" = not cancelled).
--
-- ACTIVE TRIALS: same shape, subscription_kind = 'trial' and
-- lifecycle_status = 'trial' (the only two lifecycle_status values a trial
-- row can ever legitimately hold per its own CHECK constraint before
-- cancellation).
--
-- TRIALS ENDING SOON: reuses the exact 3-day-trial/7-day-paid threshold
-- from isSubscriptionExpiringSoon() (src/features/platform/labels.ts) --
-- reimplemented here in SQL as the identical two-branch day-count logic
-- (trial: end_at within 3 days; paid: within 7 days) because the frontend
-- helper cannot be called from a stored procedure. Any future change to
-- labels.ts's threshold must be mirrored here by hand -- there is no single
-- source of truth across the DB/frontend boundary for this one constant,
-- flagged rather than silently risked.
--
-- EXPIRED / ACTION REQUIRED: reuses get_club_platform_access()'s own
-- derivation (blocked = club status suspended/closed, OR no non-cancelled
-- subscription row, OR now() past end_at + grace_period_days_snapshot) by
-- calling the same real logic get_platform_clubs_access() already
-- encapsulates, not a re-derived copy -- see the CTE below, which mirrors
-- get_platform_clubs_access() 1:1 (same table, same predicate) rather than
-- calling it in a loop (avoids one RPC call per club).
--
-- MRR (Monthly Recurring Revenue) -- the highest-risk metric in this
-- migration. Defined EXACTLY as follows, per club, using ONLY that club's
-- single most-recent CURRENT subscription row (lifecycle_status='active',
-- subscription_kind IN ('paid','complimentary'), real club):
--   1. subscription_kind = 'complimentary' -> EXCLUDED from MRR entirely.
--      Complimentary is non-revenue by definition (create_platform_
--      subscription() itself always writes price_snapshot = 0 for these
--      rows) -- summing it would be summing a zero anyway, but it is
--      excluded explicitly rather than relying on the zero to make the
--      intent unambiguous in code.
--   2. subscription_kind = 'paid':
--      a. Monthly-normalized LIST amount = price_snapshot / interval_count
--         when interval_snapshot = 'month', or
--         price_snapshot / (interval_count * 12) when interval_snapshot =
--         'year'. This reads platform_plans.billing_interval /
--         billing_interval_count via the subscription's own *_snapshot
--         columns (immutable at subscription-creation time per ADR-029/030
--         -- a later edit to platform_plans must NOT retroactively change
--         an already-created subscription's contribution to MRR, and
--         reading the snapshot columns instead of live-joining
--         platform_plans guarantees that). interval_snapshot is
--         CHECK-constrained to only ('month','year') at the table level, so
--         no third branch is needed or silently mis-handled.
--      b. FOUNDING-OFFER OVERRIDE: price_snapshot is confirmed, by reading
--         create_platform_subscription()/renew_platform_subscription()/
--         change_platform_plan() directly, to ALWAYS be the full LIST price
--         for a paid subscription -- none of the three write paths that can
--         populate a 'paid' row ever writes a discounted amount into
--         price_snapshot. The founding-offer 50%-off discount exists
--         entirely as a separate, read-time computation in
--         founding_customer_slots / get_founding_offer_status() (promo_
--         price while now() < promotion_end, else normal_price_after_
--         promotion). Using price_snapshot directly for a founder club
--         would therefore silently overstate MRR by 2x for every founder
--         still inside their promo window. Fixed here: for a club holding a
--         founding_customer_slots row, the monthly-normalized amount is
--         computed from founding_customer_slots' own current_effective_
--         price (promotional_price while now() < promotion_end, else
--         normal_price_after_promotion) instead of price_snapshot, using
--         the SAME interval-normalization factor from the subscription
--         snapshot (founding_customer_slots has no interval of its own --
--         it is a per-club price override layered on the subscription's
--         real billing cadence, confirmed via schema read: founding_
--         customer_slots has no billing_interval column at all).
--         founding_customer_slots.promotional_price/promotion_end are read
--         directly (not list_price/normal_price_after_promotion, which are
--         the non-discounted references) -- this is the "only apply list
--         price after the promotion window ends" rule from the mission
--         directive, expressed as the same now()-vs-promotion_end branch
--         get_founding_offer_status() already uses, not a re-guessed one.
--      c. Cancelled subscriptions are structurally excluded (the CURRENT-
--         subscription CTE below only selects lifecycle_status='active').
--      d. Test-fixture clubs are always excluded (join to clubs, is_test_
--         fixture = false).
--   MRR = sum of every qualifying club's monthly-normalized amount.
--   No other subscription shape exists in the current schema
--   (subscription_kind is CHECK-constrained to exactly trial/paid/
--   complimentary) -- nothing was silently excluded here beyond trial
--   (structurally non-revenue, not "current" in the paid/complimentary
--   sense) and complimentary (explicitly non-revenue).
--
-- ARR: MRR * 12. Deliberately NOT computed independently from annual
-- subscriptions directly (that would risk a second, possibly-inconsistent
-- MRR-shaped calculation) -- derived from the same MRR figure this RPC
-- already returns, per the mission directive's explicit instruction.
--
-- COLLECTED REVENUE (this month): NOT reimplemented here. The frontend
-- consumer must keep calling the existing get_platform_revenue_report() and
-- sum client-side exactly as PlatformOverviewPage.tsx already does --
-- kept conceptually and mechanically separate from this RPC's MRR/ARR/
-- outstanding fields per the mission directive's explicit "keep collected
-- revenue conceptually separate from MRR/outstanding" requirement. This RPC
-- does not return a collected-revenue field at all, to make that separation
-- structural, not just a UI convention someone could accidentally blur
-- later.
--
-- OUTSTANDING AMOUNT: reliably derivable. platform_invoices.status is
-- CHECK-constrained to ('pending','paid','overdue','void') and platform_
-- payments has NO payment_allocations-equivalent bridge table (confirmed by
-- schema read: platform_payments.platform_invoice_id is a plain FK, one
-- invoice can receive multiple payment rows over time, but record_platform_
-- payment() flips platform_invoices.status straight to 'paid' -- a binary
-- state, not a partial-balance tracker; there is no partial-payment /
-- remaining-balance concept anywhere in this schema, unlike the club-side
-- billing tables' payment_allocations pattern). Outstanding = sum(amount)
-- across platform_invoices where status IN ('pending','overdue'), joined
-- through clubs.is_test_fixture = false. 'void' invoices are correctly
-- excluded (a voided invoice is not owed). This is a real, exact sum --
-- not an estimate -- because there is no partial-payment state to
-- approximate.
--
-- TRIAL -> PAID CONVERSION RATE: MARKED AS A LIMITATION (returns null),
-- NOT implemented. Verified directly against the write paths (create_
-- platform_subscription / renew_platform_subscription / change_platform_
-- plan / cancel_platform_subscription): a trial-to-paid conversion is two
-- fully independent manual Platform Owner actions -- optionally cancelling
-- the trial row, then calling create_platform_subscription(kind='paid')
-- as a BRAND NEW row. previous_subscription_id is populated ONLY by
-- renew_platform_subscription() and change_platform_plan() (both of which
-- operate on an already-paid row) -- create_platform_subscription() itself
-- NEVER sets previous_subscription_id, so a paid row created after a trial
-- carries no structural link back to that trial row. The only available
-- heuristic (same club_id, paid.start_at close to trial.end_at/cancelled_
-- at) is exactly that -- a heuristic, not a real link -- and would silently
-- misclassify a club that re-trials, or whose trial was cancelled for an
-- unrelated reason (fraud, duplicate signup) and later paid independently.
-- Per the mission directive's explicit instruction to mark rather than
-- guess when the data model doesn't cleanly support a metric, this is
-- returned as null with trial_to_paid_conversion_rate_unavailable = true
-- so the frontend can render an honest "not yet available" state instead
-- of a fabricated rate. Building a real link would require a schema change
-- (e.g. create_platform_subscription() accepting an optional p_converted_
-- from_trial_id) -- a product/engineering decision outside this migration's
-- scope, not something to retrofit silently here.
-- ============================================================

create or replace function public.get_platform_commercial_snapshot()
returns table(
  paying_tenants integer,
  active_trials integer,
  trials_ending_soon integer,
  expired_action_required integer,
  mrr numeric,
  arr numeric,
  outstanding_amount numeric,
  trial_to_paid_conversion_rate numeric,
  trial_to_paid_conversion_rate_unavailable boolean
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- platform.finance.view is the real seeded permission key covering
  -- commercial/finance reporting (see 20260826121055_platform_staff_roles_
  -- schema.sql's finance permission group -- platform.finance.view /
  -- platform.finance.manage / platform.subscription.view /
  -- platform.subscription.manage) -- not a placeholder key.
  if not (public.is_platform_owner() or public.has_platform_permission('platform.finance.view')) then
    raise exception 'not authorized';
  end if;

  return query
  with real_clubs as (
    select c.id, c.status
    from public.clubs c
    where coalesce(c.is_test_fixture, false) = false
  ),
  -- Mirrors get_platform_clubs_access()'s own latest-non-cancelled-
  -- subscription CTE exactly (same table, same predicate, same "most
  -- recent by start_at" tie-break) so this RPC's access-derived counts can
  -- never silently disagree with what PlatformClubsPage/Overview already
  -- show for the same club.
  latest_sub as (
    select distinct on (ps.club_id)
      ps.club_id, ps.subscription_kind, ps.lifecycle_status, ps.end_at,
      ps.grace_period_days_snapshot, ps.price_snapshot, ps.interval_snapshot,
      ps.interval_count_snapshot
    from public.platform_subscriptions ps
    join real_clubs rc on rc.id = ps.club_id
    where ps.lifecycle_status != 'cancelled'
    order by ps.club_id, ps.start_at desc
  ),
  access_derived as (
    select
      rc.id as club_id,
      case
        when rc.status in ('suspended', 'closed') then 'blocked'
        when ls.club_id is null then 'blocked'
        when now() < ls.end_at then 'full'
        when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'grace'
        else 'blocked'
      end as access
    from real_clubs rc
    left join latest_sub ls on ls.club_id = rc.id
  ),
  mrr_rows as (
    select
      ls.club_id,
      -- Founding-offer override: use the founder's current dynamic
      -- effective price (already correctly promo-vs-list-branched by
      -- now() vs promotion_end) instead of price_snapshot, which is
      -- always list price on a paid row regardless of any founding
      -- discount. Non-founder clubs fall through to price_snapshot.
      case when fcs.club_id is not null
        then (case when now() < fcs.promotion_end then fcs.promotional_price else fcs.normal_price_after_promotion end)
        else ls.price_snapshot
      end as effective_price,
      ls.interval_snapshot,
      ls.interval_count_snapshot
    from latest_sub ls
    left join public.founding_customer_slots fcs on fcs.club_id = ls.club_id
    where ls.subscription_kind = 'paid' and ls.lifecycle_status = 'active'
  ),
  mrr_normalized as (
    select
      club_id,
      case
        when interval_snapshot = 'month' and interval_count_snapshot > 0
          then effective_price / interval_count_snapshot
        when interval_snapshot = 'year' and interval_count_snapshot > 0
          then effective_price / (interval_count_snapshot * 12)
        -- Defensive only: interval_snapshot is CHECK-constrained to
        -- ('month','year') and interval_count_snapshot > 0 at the table
        -- level for every row that can reach here (paid subscriptions
        -- always snapshot a real plan's interval). A row that somehow
        -- still fails both branches is excluded from MRR rather than
        -- guessed at, matching this migration's own "exclude and
        -- document" rule rather than assuming /1.
        else null
      end as monthly_amount
    from mrr_rows
  ),
  trial_paid_counts as (
    select
      count(*) filter (where subscription_kind = 'paid' and lifecycle_status = 'active') as paying,
      count(*) filter (where subscription_kind = 'trial' and lifecycle_status = 'trial') as trialing,
      count(*) filter (
        where subscription_kind = 'trial' and lifecycle_status = 'trial'
          and ceil(extract(epoch from (end_at - now())) / 86400.0) >= 0
          and ceil(extract(epoch from (end_at - now())) / 86400.0) <= 3
      ) as trials_ending_soon_count,
      count(*) filter (
        where subscription_kind = 'paid' and lifecycle_status = 'active'
          and ceil(extract(epoch from (end_at - now())) / 86400.0) >= 0
          and ceil(extract(epoch from (end_at - now())) / 86400.0) <= 7
      ) as paid_ending_soon_count
    from latest_sub
  ),
  expired_count as (
    select count(*) as n from access_derived where access = 'blocked'
  ),
  outstanding as (
    select coalesce(sum(pi.amount), 0) as amt
    from public.platform_invoices pi
    join real_clubs rc on rc.id = pi.club_id
    where pi.status in ('pending', 'overdue')
  ),
  mrr_total as (
    select coalesce(sum(monthly_amount), 0) as amt from mrr_normalized
  )
  select
    tpc.paying::integer,
    tpc.trialing::integer,
    (tpc.trials_ending_soon_count + tpc.paid_ending_soon_count)::integer,
    ec.n::integer,
    round(mt.amt, 2),
    round(mt.amt * 12, 2),
    round(o.amt, 2),
    null::numeric,
    true
  from trial_paid_counts tpc, expired_count ec, outstanding o, mrr_total mt;
end;
$function$;

revoke all on function public.get_platform_commercial_snapshot() from public;
revoke all on function public.get_platform_commercial_snapshot() from anon;
grant execute on function public.get_platform_commercial_snapshot() to authenticated;

comment on function public.get_platform_commercial_snapshot() is
  'Platform Owner Control Plane V1, Phase 6. Platform-wide commercial snapshot (paying tenants / active trials / trials-ending-soon / expired-action-required / MRR / ARR / outstanding amount), QA-fixture-excluded throughout. MRR excludes complimentary and cancelled subscriptions, normalizes monthly vs. annual via each subscription''s own immutable *_snapshot columns (never a live platform_plans join, which would retroactively change historical MRR), and overrides price_snapshot with founding_customer_slots'' dynamic current-effective-price for founder clubs (price_snapshot is always list price on a paid row -- confirmed by reading every write path -- the founding discount is a read-time-only computation layered on top). ARR = MRR * 12, derived not independently computed. trial_to_paid_conversion_rate is always null (trial_to_paid_conversion_rate_unavailable = true): create_platform_subscription() never links a new paid row back to a prior trial row via previous_subscription_id (that column is populated only by renew_platform_subscription()/change_platform_plan(), which operate on already-paid rows) -- no reliable trial->paid link exists in the current schema, and same-club-id heuristics were rejected as guessing, not deriving. Caller must be is_platform_owner() or hold the platform.finance.view platform permission.';
