-- Platform Owner Control Plane V1, Phase 10 (Tenant Health V1).
--
-- get_platform_tenant_health(): a transparent HEALTHY / WATCH / AT_RISK
-- classification per real (non-fixture) club, batched platform-wide (one
-- RPC call, not one per club -- matches get_platform_clubs_access()'s own
-- batched style so PlatformClubsPage's list can render a health column
-- without an N+1 RPC fan-out).
--
-- ============================================================
-- WHY NOT A BLACK-BOX SCORE
-- ============================================================
-- Per the mission directive: "A HEALTHY / WATCH / AT RISK model is
-- preferable to an unjustified 0-100 score." This returns exactly those
-- three labels, plus a `reasons` text[] on every row so the frontend can
-- show WHY a tenant got its classification, not just the enum -- a
-- Platform Owner should never have to guess what a WATCH badge means for
-- a specific club.
--
-- ============================================================
-- INPUTS USED, AND WHY EACH ONE WAS INCLUDED OR EXCLUDED
-- ============================================================
-- 1. SUBSCRIPTION STATE -- INCLUDED. Reuses get_platform_clubs_access()'s
--    own access derivation (mirrored here identically, not re-derived --
--    see access_derived CTE, same predicate as
--    20260819100000_platform_phase_a_correctness_security_scale.sql).
--    access='blocked' (admin-suspended, no subscription, or past grace)
--    is the single strongest AT_RISK signal available -- a blocked club
--    genuinely cannot use the product right now.
-- 2. PAYMENT STATE -- INCLUDED, narrowly: an OVERDUE platform_invoices
--    row (status='overdue') for a club that is otherwise not already
--    'blocked' is a real, distinct WATCH-worthy signal (money owed, but
--    access not yet cut) -- distinct from access-blocked, so surfaced
--    separately in `reasons` even when it doesn't change the tier alone.
-- 3. ONBOARDING COMPLETION -- EXCLUDED per the mission directive's
--    explicit instruction ("deep dive found this doesn't exist as
--    trackable data -- SKIP this input, do not fabricate it"). Confirmed
--    again here: no onboarding-progress/step-completion column exists on
--    clubs or any related table in this migration set.
-- 4. LAST ACTIVITY -- INCLUDED, narrowly. get_platform_club_last_activity()
--    / search_platform_clubs()'s last_activity_at/last_activity_type
--    columns (20260908160000_platform_club_360_academy_count_and_
--    last_activity.sql, landed by the parallel Tenant 360 agent DURING
--    this same mission -- confirmed present by re-checking supabase/
--    migrations/ immediately before writing this function, per the
--    mission directive's own "if their RPC/column exists by the time you
--    implement this, use it" instruction) define last activity as
--    MAX(bookings.created_at, payments.received_at, attendance.marked_at)
--    for the club. Reused here BY FORMULA (the same three correlated
--    MAX() subqueries, same "one query plan, N rows" shape
--    search_platform_clubs() itself uses), not by calling that RPC
--    per-club (would reintroduce the exact N+1 shape this mission's own
--    review checklist warns against) and not by calling
--    get_platform_club_last_activity() per-club either, for the same
--    reason. This is the SAME underlying signal as whatsapp_accounts.
--    last_seen_at is NOT reused a second time here (that stays scoped to
--    WhatsApp health below, avoiding double-counting one signal under
--    two labels).
--
--    THE GENUINELY UNDECIDED PART, per the mission directive's own
--    example question ("should a club with zero real activity ever since
--    trial start be AT_RISK, or is that just a brand-new signup that
--    hasn't had time yet?"): a club that is very new (created recently)
--    and has zero activity yet is NOT flagged here -- doing so would
--    misclassify every legitimate brand-new signup as unhealthy on day
--    one, which is worse than not flagging it at all. Only a club whose
--    clubs.created_at is more than 30 days old AND has zero recorded
--    activity in the trailing 30 days (or ever) is surfaced, as a WATCH-
--    tier ('activity_stale' or 'activity_never_recorded') reason -- never
--    AT_RISK on its own, since low/no activity is a business-judgment
--    signal, not a technical failure the way access_blocked or
--    hard_limit_at_or_over are. The 30-day threshold itself is a
--    reasoned default (matches this schema's own controlled_resource_
--    grace_days default and platform_settings.default_grace_period_days
--    convention of "about a month" as the standard grace window in this
--    product), not a value derived from any real usage-pattern data --
--    flagged as a placeholder worth owner review in FINAL_OWNER_
--    DECISIONS_REQUIRED.md rather than silently treated as final.
-- 5. USAGE / PLAN-LIMIT PRESSURE -- INCLUDED. Two real, already-computed
--    signals, reused rather than re-derived:
--    a. Hard-enforced resources (branch/field/academy) AT or OVER their
--       limit, read from commercial_entitlements_usage (the same view
--       PlatformReportsPage's Usage tab and the club-side UI both already
--       trust) -- a club at >=100% of a hard-enforced limit cannot create
--       more of that resource right now, a genuine AT_RISK-adjacent
--       operational fact, not a guess.
--    b. Controlled resources (staff/active_player) in 'over_limit' state
--       (grace period already elapsed), read from
--       commercial_resource_grace_state.first_over_limit_at +
--       commercial_entitlements.controlled_resource_grace_days -- the
--       exact same grace-elapsed condition get_commercial_usage() itself
--       computes per-club, mirrored here platform-wide via a join instead
--       of calling get_commercial_usage() once per club (would be a real
--       N+1 RPC-in-a-loop performance risk at scale, per this mission's
--       own review-checklist instruction to add indexes/avoid N+1 based
--       on real access patterns). A club merely 'approaching_limit'
--       (80-99%, not yet at/over) is WATCH-worthy, not AT_RISK -- matches
--       get_commercial_usage()'s own three-tier severity, not collapsed
--       into one bucket here.
-- 6. WHATSAPP HEALTH -- INCLUDED. Reuses get_platform_whatsapp_health()'s
--    own columns unchanged (connection_status, circuit_breaker_open,
--    failed_count_7d) via a direct join to whatsapp_accounts +
--    notification_queue, matching that RPC's own predicates exactly
--    (called inline here rather than via the RPC itself, since that RPC
--    is STABLE/SECURITY DEFINER and calling it once per health-check
--    invocation already returns the full platform-wide set -- this
--    function performs the same underlying query directly to combine it
--    with the other signals in one pass rather than two round trips).
-- 7. UNRESOLVED OPERATIONAL CONDITIONS -- INCLUDED, narrowly:
--    clubs.flagged_duplicate = true (an existing, real signal already
--    surfaced on Overview/Clubs) is folded in as a WATCH-worthy reason --
--    a flagged-duplicate club is a real "needs a look" condition even
--    when every commercial signal is otherwise healthy.
--
-- ============================================================
-- THE FORMULA (exact, in priority order -- first matching tier wins)
-- ============================================================
-- AT_RISK if ANY of:
--   - access = 'blocked' (admin-suspended, no subscription, or expired
--     past grace -- club cannot use the product right now)
--   - any hard-enforced resource (branch/field/academy) is AT or OVER
--     its limit (usage_count >= resource_limit, limit not null)
--   - any controlled resource (staff/active_player) is in OVER_LIMIT
--     state (grace period already elapsed)
--   - WhatsApp circuit_breaker_open = true (the connector has stopped
--     sending entirely, not just experiencing occasional failures)
-- WATCH if, not already AT_RISK, ANY of:
--   - access = 'grace' (past end_at, inside the grace window -- not yet
--     blocked, but on a countdown)
--   - subscription is expiring soon (isSubscriptionExpiringSoon's own
--     3-day-trial / 7-day-paid threshold, mirrored in SQL exactly as in
--     get_platform_commercial_snapshot() -- see that migration's own
--     comment for why this can't be a single cross-language source of
--     truth)
--   - any hard-enforced resource is 'approaching_limit' (>=80%, <100%)
--   - any controlled resource is in 'grace' state (over limit, grace
--     period still running)
--   - an OVERDUE platform_invoice exists for this club
--   - WhatsApp connection_status is neither 'connected' nor
--     'not_connected' (i.e. genuinely disconnected/erroring, not just
--     never configured) OR failed_count_7d > 0
--   - clubs.flagged_duplicate = true
--   - the club is more than 30 days old (clubs.created_at) AND has zero
--     recorded activity (MAX of bookings/payments/attendance, see input
--     #4 above) in the trailing 30 days -- never AT_RISK on its own, and
--     never flagged for a club still within its first 30 days
-- HEALTHY otherwise.
--
-- This mirrors the mission directive's own example rule shape, adapted to
-- what this schema can actually support today -- not copied blindly (the
-- example's "over a hard commercial limit" is split here into the real
-- hard-enforced vs. controlled-resource distinction this schema already
-- makes, since collapsing them would misclassify a club merely in a
-- healthy grace window as equally severe as one already over_limit).
-- ============================================================

create or replace function public.get_platform_tenant_health()
returns table(
  club_id uuid,
  health text,
  reasons text[]
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  return query
  with real_clubs as (
    select c.id, c.status, c.flagged_duplicate, c.created_at
    from public.clubs c
    where coalesce(c.is_test_fixture, false) = false
  ),
  -- Same MAX(bookings.created_at, payments.received_at,
  -- attendance.marked_at) definition as get_platform_club_last_activity()
  -- / search_platform_clubs(), reused by formula (three correlated
  -- MAX() subqueries, one query plan) rather than by per-club RPC call.
  last_activity as (
    select
      rc.id as club_id,
      greatest(
        (select max(b.created_at) from public.bookings b where b.club_id = rc.id),
        (select max(pay.received_at) from public.payments pay where pay.club_id = rc.id),
        (select max(a.marked_at) from public.attendance a where a.club_id = rc.id)
      ) as last_activity_at
    from real_clubs rc
  ),
  latest_sub as (
    select distinct on (ps.club_id)
      ps.club_id, ps.subscription_kind, ps.lifecycle_status, ps.end_at,
      ps.grace_period_days_snapshot
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
      end as access,
      coalesce(
        ls.club_id is not null
        and ceil(extract(epoch from (ls.end_at - now())) / 86400.0) >= 0
        and ceil(extract(epoch from (ls.end_at - now())) / 86400.0) <= (case when ls.subscription_kind = 'trial' then 3 else 7 end),
        false
      ) as expiring_soon
    from real_clubs rc
    left join latest_sub ls on ls.club_id = rc.id
  ),
  -- Explicit per-resource-type check (branch/field/academy each compared
  -- independently via a lateral VALUES unpack, then OR'd across all
  -- three) -- avoids repeating the same >=limit / >=80%-of-limit
  -- comparison three times inline.
  hard_limit_flags as (
    select
      ceu.club_id,
      bool_or(v.used >= v.lim) filter (where v.lim is not null) as any_at_or_over,
      bool_or(v.used >= v.lim * 0.8 and v.used < v.lim) filter (where v.lim is not null) as any_approaching
    from public.commercial_entitlements_usage ceu
    cross join lateral (values
      (ceu.branches_used, ceu.branch_limit),
      (ceu.fields_used, ceu.field_limit),
      (ceu.academy_used, ceu.academy_limit)
    ) as v(used, lim)
    group by ceu.club_id
  ),
  controlled_state as (
    select
      grs.club_id,
      bool_or(
        now() > grs.first_over_limit_at + (coalesce(ce.controlled_resource_grace_days, 7) || ' days')::interval
      ) as any_over_limit,
      bool_or(
        now() <= grs.first_over_limit_at + (coalesce(ce.controlled_resource_grace_days, 7) || ' days')::interval
      ) as any_in_grace
    from public.commercial_resource_grace_state grs
    left join public.commercial_entitlements ce on ce.club_id = grs.club_id
    group by grs.club_id
  ),
  overdue_invoices as (
    select distinct pi.club_id
    from public.platform_invoices pi
    join real_clubs rc on rc.id = pi.club_id
    where pi.status = 'overdue'
  ),
  whatsapp as (
    select
      c.id as club_id,
      coalesce(wa.circuit_breaker_open_until is not null and wa.circuit_breaker_open_until > now(), false) as circuit_open,
      coalesce(wa.status, 'not_connected') as connection_status,
      (select count(*) from public.notification_queue nq
         where nq.club_id = c.id and nq.channel = 'whatsapp' and nq.status = 'failed'
           and nq.created_at > now() - interval '7 days') as failed_7d
    from real_clubs c
    left join public.whatsapp_accounts wa on wa.club_id = c.id
  )
  select
    rc.id as club_id,
    case
      when ad.access = 'blocked'
        or coalesce(hlf.any_at_or_over, false)
        or coalesce(cs.any_over_limit, false)
        or wh.circuit_open
        then 'AT_RISK'
      when ad.access = 'grace'
        or ad.expiring_soon
        or coalesce(hlf.any_approaching, false)
        or coalesce(cs.any_in_grace, false)
        or oi.club_id is not null
        or (wh.connection_status != 'connected' and wh.connection_status != 'not_connected')
        or wh.failed_7d > 0
        or rc.flagged_duplicate
        or (rc.created_at < now() - interval '30 days'
            and (la.last_activity_at is null or la.last_activity_at < now() - interval '30 days'))
        then 'WATCH'
      else 'HEALTHY'
    end as health,
    array_remove(array[
      case when ad.access = 'blocked' then 'access_blocked' end,
      case when ad.access = 'grace' then 'access_in_grace' end,
      case when ad.expiring_soon then 'subscription_expiring_soon' end,
      case when coalesce(hlf.any_at_or_over, false) then 'hard_limit_at_or_over' end,
      case when coalesce(hlf.any_approaching, false) then 'hard_limit_approaching' end,
      case when coalesce(cs.any_over_limit, false) then 'controlled_limit_over' end,
      case when coalesce(cs.any_in_grace, false) then 'controlled_limit_in_grace' end,
      case when oi.club_id is not null then 'invoice_overdue' end,
      case when wh.circuit_open then 'whatsapp_circuit_breaker_open' end,
      case when wh.connection_status != 'connected' and wh.connection_status != 'not_connected' then 'whatsapp_disconnected' end,
      case when wh.failed_7d > 0 then 'whatsapp_failures_7d' end,
      case when rc.flagged_duplicate then 'flagged_duplicate' end,
      case when rc.created_at < now() - interval '30 days' and la.last_activity_at is null then 'activity_never_recorded' end,
      case when rc.created_at < now() - interval '30 days' and la.last_activity_at is not null and la.last_activity_at < now() - interval '30 days' then 'activity_stale' end
    ], null) as reasons
  from real_clubs rc
  left join access_derived ad on ad.club_id = rc.id
  left join hard_limit_flags hlf on hlf.club_id = rc.id
  left join controlled_state cs on cs.club_id = rc.id
  left join overdue_invoices oi on oi.club_id = rc.id
  left join whatsapp wh on wh.club_id = rc.id
  left join last_activity la on la.club_id = rc.id;
end;
$function$;

revoke all on function public.get_platform_tenant_health() from public;
revoke all on function public.get_platform_tenant_health() from anon;
grant execute on function public.get_platform_tenant_health() to authenticated;

comment on function public.get_platform_tenant_health() is
  'Platform Owner Control Plane V1, Phase 10. Transparent HEALTHY/WATCH/AT_RISK classification, batched platform-wide (all real, non-fixture clubs in one call), with a `reasons` text[] explaining WHY on every row -- never just the label. Formula documented in full in this function''s migration file comment. Deliberately excludes onboarding-completion (no trackable data exists anywhere in the schema). Includes last-activity (MAX of bookings/payments/attendance, same definition as get_platform_club_last_activity()/search_platform_clubs(), landed by a parallel agent during this same mission) narrowly: only a club older than 30 days with zero activity in the trailing 30 days is flagged (WATCH-tier only, never AT_RISK) -- a brand-new signup is never penalized for having no activity yet. The 30-day threshold is a reasoned default, not derived from real usage-pattern data -- flagged for owner review in FINAL_OWNER_DECISIONS_REQUIRED.md. Caller must be is_platform_owner() or hold the platform.club.view platform permission.';
