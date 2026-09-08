-- Platform Owner Control Plane V1, Phase 7 -- Attention Center.
--
-- Upgrades PlatformOverviewPage's "Needs attention" panel from 6
-- per-METRIC-TYPE aggregate cards (each linking to the same generic
-- unfiltered /platform/clubs list, a confirmed deep-dive finding --
-- PLATFORM_OWNER_DEEP_DIVE_REPORT.md Section 13) into a genuine
-- per-TENANT list: one row per (club, problem) pair, so a Platform
-- Owner sees "Club X: trial ends in 2 days" as one specific, clickable
-- line item instead of just an aggregate count.
--
-- Architecture decision (per mission instruction, "use your judgment,
-- justify whichever you pick"): a single new RPC, not N client-side
-- queries. Chosen over client-side composition because (a) this
-- codebase's own established convention for exactly this shape of
-- problem is "one deterministic authorized-only RPC entry point"
-- (get_commercial_usage, get_founding_offer_status, get_platform_clubs_
-- access, get_platform_whatsapp_health -- all batched, all server-side),
-- (b) composing 5+ independent per-tenant conditions client-side would
-- mean 5+ separate round trips (WhatsApp health, subscriptions,
-- entitlements usage, upgrade requests, duplicate flags) all fetched on
-- every Overview load, which is exactly the N-round-trip anti-pattern
-- Phase A (get_platform_clubs_access) already fixed once on this same
-- page, and (c) "one row per (club, problem)" unioned across
-- structurally different source tables is naturally a SQL UNION ALL,
-- not an easy client-side merge.
--
-- Deliberately NOT a scoring engine (per explicit mission instruction):
-- each condition below is a simple, independent, deterministic rule
-- ("trial end_at within 3 days AND lifecycle_status='trial'" = one row).
-- No weighting, no composite score, no ranking beyond a fixed severity
-- ordering (danger before warning) -- exactly the V1 shape the mission
-- calls out as correct.
--
-- Conditions covered (6 kept + 4 genuinely new, all backed by real,
-- already-reliable data -- no fabricated signal):
--   1. whatsapp_disconnected      (kept, now per-club not aggregate)
--   2. whatsapp_failures          (kept, now per-club not aggregate)
--   3. flagged_duplicate          (kept, now per-club -- was already 1:1 club:row)
--   4. no_subscription            (kept, now per-club -- was already 1:1 club:row)
--   5. pending_upgrade_request    (kept, now per-club, one row per pending request)
--   6. trial_ending_soon          (NEW -- reuses the exact isSubscriptionExpiringSoon
--                                   threshold already centralized in labels.ts:
--                                   trial <=3 days / paid <=7 days, mirrored here
--                                   in SQL so both layers agree)
--   7. trial_expired              (NEW -- end_at already passed, lifecycle_status
--                                   still 'trial'/'active', i.e. not yet cancelled --
--                                   a real, distinct state from "expiring soon")
--   8. over_plan_limit            (NEW -- commercial_entitlements_usage, *_used >
--                                   *_limit, limit not null i.e. genuinely capped)
--   9. near_plan_limit            (NEW -- same view, *_used >= 80% of *_limit,
--                                   matching the 80% warning threshold already
--                                   established elsewhere in this codebase's
--                                   billing review; excludes rows already over)
--
-- "New leads" (contact_requests) is deliberately NOT included here --
-- confirmed via schema read that contact_requests has NO club_id column
-- at all (an anonymous, pre-signup, insert-only inbox, not tenant-scoped
-- -- see its own table comment). It cannot be expressed as a (club,
-- problem) row and stays on Overview as its own platform-wide exception
-- card, unchanged.
--
-- "Onboarding incomplete" is deliberately SKIPPED per explicit mission
-- instruction: confirmed via schema read (20260815180000_phase3d_
-- onboarding.sql) that neither clubs nor platform_subscriptions has any
-- real onboarding-status/progress column -- only flagged_duplicate
-- exists on clubs, already covered above. Fabricating an onboarding
-- signal from unrelated columns would be exactly the kind of invented,
-- unreliable condition the mission explicitly warns against.
--
-- Fixture isolation: every branch below joins through clubs and applies
-- coalesce(c.is_test_fixture, false) = false, the same predicate style
-- established by the M-2 remediation (20260903140100) and already
-- applied to this same page's other queries in Phase 3 of this mission.
create or replace function public.get_platform_attention_items()
returns table(
  club_id uuid,
  club_name text,
  problem_type text,
  severity text,
  detail text,
  context_at timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  return query

  -- 1. WhatsApp disconnected -- a club that once connected (had a
  -- whatsapp_accounts row) and is now not connected. A club that never
  -- set up WhatsApp at all isn't an exception, it's just unconfigured --
  -- same distinction PlatformOverviewPage's existing client-side filter
  -- already makes, now expressed server-side.
  select
    c.id as club_id,
    c.name_ar as club_name,
    'whatsapp_disconnected'::text as problem_type,
    'danger'::text as severity,
    wa.status as detail,
    wa.last_seen_at as context_at
  from public.whatsapp_accounts wa
  join public.clubs c on c.id = wa.club_id
  where coalesce(c.is_test_fixture, false) = false
    and wa.status not in ('not_connected', 'connected')

  union all

  -- 2. WhatsApp failures in the last 7 days.
  select
    c.id,
    c.name_ar,
    'whatsapp_failures',
    'warning',
    (count(*))::text,
    max(nq.created_at)
  from public.notification_queue nq
  join public.clubs c on c.id = nq.club_id
  where coalesce(c.is_test_fixture, false) = false
    and nq.channel = 'whatsapp'
    and nq.status = 'failed'
    and nq.created_at > now() - interval '7 days'
  group by c.id, c.name_ar

  union all

  -- 3. Flagged duplicate (active clubs only -- a club the Platform Owner
  -- already suspended for this reason shouldn't keep showing as live).
  select
    c.id,
    c.name_ar,
    'flagged_duplicate',
    'warning',
    c.flagged_duplicate_reason,
    c.created_at
  from public.clubs c
  where coalesce(c.is_test_fixture, false) = false
    and c.flagged_duplicate = true
    and c.status = 'active'

  union all

  -- 4. No subscription at all (real data-integrity gap, not just
  -- expired -- a club with zero platform_subscriptions rows).
  select
    c.id,
    c.name_ar,
    'no_subscription',
    'danger',
    null::text,
    c.created_at
  from public.clubs c
  where coalesce(c.is_test_fixture, false) = false
    and c.status not in ('suspended', 'closed')
    and not exists (
      select 1 from public.platform_subscriptions ps where ps.club_id = c.id
    )

  union all

  -- 5. Pending upgrade request -- one row per pending request (a club
  -- with two pending requests correctly surfaces as two attention items,
  -- not silently collapsed into one).
  select
    c.id,
    c.name_ar,
    'pending_upgrade_request',
    'warning',
    cur.limit_type,
    cur.created_at
  from public.commercial_upgrade_requests cur
  join public.clubs c on c.id = cur.club_id
  where coalesce(c.is_test_fixture, false) = false
    and cur.status = 'pending'

  union all

  -- 6. Trial ending soon -- same threshold as isSubscriptionExpiringSoon()
  -- in labels.ts (trial: <=3 days, paid: <=7 days), mirrored here in SQL
  -- so the two layers can never disagree on which subscriptions qualify.
  -- Only the latest non-cancelled subscription per club is considered.
  select
    c.id,
    c.name_ar,
    'expiring_soon',
    'warning',
    ps.subscription_kind,
    ps.end_at
  from (
    select distinct on (club_id) *
    from public.platform_subscriptions
    where lifecycle_status != 'cancelled'
    order by club_id, start_at desc
  ) ps
  join public.clubs c on c.id = ps.club_id
  where coalesce(c.is_test_fixture, false) = false
    and ps.end_at > now()
    and ps.end_at <= now() + case when ps.subscription_kind = 'trial' then interval '3 days' else interval '7 days' end

  union all

  -- 7. Trial/subscription already expired but not yet marked cancelled --
  -- a distinct state from "expiring soon" (already past end_at).
  select
    c.id,
    c.name_ar,
    'expired',
    'danger',
    ps.subscription_kind,
    ps.end_at
  from (
    select distinct on (club_id) *
    from public.platform_subscriptions
    where lifecycle_status != 'cancelled'
    order by club_id, start_at desc
  ) ps
  join public.clubs c on c.id = ps.club_id
  where coalesce(c.is_test_fixture, false) = false
    and ps.end_at <= now()

  union all

  -- 8. Over a commercial plan limit (limit genuinely set, i.e. not null
  -- / uncapped, and usage has exceeded it).
  select
    c.id,
    c.name_ar,
    'over_plan_limit',
    'danger',
    x.resource_label,
    now()
  from public.commercial_entitlements_usage u
  join public.clubs c on c.id = u.club_id
  cross join lateral (
    values
      ('branches', u.branch_limit, u.branches_used),
      ('fields', u.field_limit, u.fields_used),
      ('academy', u.academy_limit, u.academy_used),
      ('staff', u.staff_limit, u.staff_used),
      ('active_players', u.active_player_limit, u.active_players_used)
  ) as x(resource_label, resource_limit, resource_used)
  where coalesce(c.is_test_fixture, false) = false
    and x.resource_limit is not null
    and x.resource_used > x.resource_limit

  union all

  -- 9. Near a commercial plan limit -- 80% threshold, the same warning
  -- threshold already established elsewhere in this codebase's billing
  -- review. Excludes rows already over (condition 8 above), so a club
  -- never double-counts both near and over for the same resource.
  select
    c.id,
    c.name_ar,
    'near_plan_limit',
    'warning',
    x.resource_label,
    now()
  from public.commercial_entitlements_usage u
  join public.clubs c on c.id = u.club_id
  cross join lateral (
    values
      ('branches', u.branch_limit, u.branches_used),
      ('fields', u.field_limit, u.fields_used),
      ('academy', u.academy_limit, u.academy_used),
      ('staff', u.staff_limit, u.staff_used),
      ('active_players', u.active_player_limit, u.active_players_used)
  ) as x(resource_label, resource_limit, resource_used)
  where coalesce(c.is_test_fixture, false) = false
    and x.resource_limit is not null
    and x.resource_used <= x.resource_limit
    and x.resource_used >= x.resource_limit * 0.8

  order by severity, context_at desc nulls last;
end;
$function$;

revoke all on function public.get_platform_attention_items() from public, anon, authenticated;
grant execute on function public.get_platform_attention_items() to authenticated;

comment on function public.get_platform_attention_items() is
  'Platform Owner Control Plane V1, Phase 7. Genuine per-tenant Attention Center: one row per (club, problem) pair across 9 deterministic, independently-evaluated conditions (not a scoring engine). QA/test-fixture clubs excluded throughout. Each caller must resolve club_id to /platform/clubs/:clubId (Tenant 360) on the frontend -- this RPC deliberately returns club_id on every row so the frontend never needs to link to a generic unfiltered list, the exact anti-pattern this phase fixes (deep dive Section 13).';
