-- Production Audit Remediation, finding M-2 (2026-09-03).
--
-- QA-fixture exclusion (clubs.is_test_fixture = false) was applied
-- inconsistently across platform-owner aggregate screens.
-- search_platform_clubs() (PlatformClubsPage) and PlatformOverviewPage's
-- own club-count queries (clubs, then get_platform_clubs_access() over
-- that already-filtered id set) correctly excluded QA fixtures by
-- default -- see 20260901090000_add_clubs_is_test_fixture_marker.sql.
-- But every other platform-owner aggregate read either queried
-- platform_subscriptions/platform_payments/clubs/branches/
-- club_memberships directly from the client with no filter at all, or
-- (get_platform_whatsapp_health()) was a server-side RPC that was never
-- updated to filter when is_test_fixture was introduced. Live-confirmed
-- gaps:
--   * PlatformOverviewPage.fetchOverview: platform_subscriptions,
--     platform_payments, and get_platform_whatsapp_health() portions
--     (the clubs + get_platform_clubs_access() portion was already
--     correct).
--   * PlatformAlertsPage.fetchAlerts: platform_subscriptions and clubs
--     queries (both unfiltered).
--   * PlatformReportsPage: ALL FIVE tabs read directly from
--     platform_subscriptions/platform_payments/clubs/branches/
--     club_memberships with no filter -- Subscription, Revenue, and
--     Renewal tabs were not called out by name in the M-2 finding text,
--     but are the exact same unfiltered-client-query shape as Growth/
--     Usage (confirmed live against this file), so leaving them
--     unfiltered would just relocate the same bug two tabs over. Fixed
--     alongside Growth/Usage rather than partially.
--
-- FIX APPROACH: one reliable server-side source of truth, not scattered
-- ad hoc client-side .eq('is_test_fixture', false) predicates. Several
-- of the queries being replaced select through PostgREST nested embeds
-- (clubs(name_ar), platform_invoices(club_id, clubs(name_ar))) where a
-- client-side filter on the embedded row cannot exclude the parent row
-- at all (PostgREST embed filters shape the embedded object, they do
-- not drop the outer row) -- so a client-side fix was not even reliably
-- possible for those call sites, only an RPC-side one. New RPCs below
-- all share the exact same predicate style already established by
-- search_platform_clubs(): `coalesce(c.is_test_fixture, false) = false`
-- joined against public.clubs. get_platform_whatsapp_health() alone
-- also gets an opt-out parameter (p_club_id) rather than an
-- unconditional filter -- see its own comment below for why.
--
-- Every RPC below is a straight lift of its call site's existing
-- Supabase-js query into SQL -- same columns, same filters
-- (lifecycle_status != 'cancelled', reversed_at is null, membership
-- status = 'active'), same join shape -- with only the is_test_fixture
-- exclusion added and platform-owner authorization enforced server-side
-- (previously implicit via RLS alone). No new metrics, no behavior
-- change for real (non-fixture) tenant data.

-- ============================================================
-- 1. get_platform_whatsapp_health(): add the missing filter to the
--    existing RPC (this is the one call site here that already read
--    through an RPC rather than a raw client query, so the M-2 finding
--    is fixed at its actual source per the audit's own guidance to
--    check each RPC's real SQL body first).
--
--    Unlike the other RPCs in this migration, this one is NOT
--    aggregate-only: PlatformClubDetailPage.tsx also calls it and
--    filters the result to one specific clubId to render that club's
--    own WhatsApp health card -- including for a QA/test-fixture club,
--    whose own Detail page a platform owner or support session can
--    still legitimately open (get_platform_club_360() itself is
--    per-club and intentionally never fixture-filtered). Blanket-
--    filtering this RPC would have silently broken that card into a
--    permanent "not found" for every fixture club's own detail view --
--    a real regression, not a hypothetical one. Added an optional
--    p_club_id parameter instead: null (the aggregate/dashboard case,
--    Overview) excludes fixtures as intended; a specific club id (the
--    single-club Detail-page case) always returns that club regardless
--    of is_test_fixture, matching get_platform_club_360()'s existing
--    per-club-always-visible behavior. Old zero-arg call shape
--    (`supabase.rpc('get_platform_whatsapp_health')`) keeps working
--    unmodified since the new parameter defaults to null.
-- ============================================================
create or replace function public.get_platform_whatsapp_health(p_club_id uuid default null)
returns table(
  club_id uuid,
  club_name text,
  connection_status text,
  connected_phone_masked text,
  last_seen_at timestamptz,
  circuit_breaker_open boolean,
  failed_count_7d bigint,
  pending_count bigint
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
  select
    c.id as club_id,
    c.name_ar as club_name,
    coalesce(wa.status, 'not_connected') as connection_status,
    case when wa.connected_phone_number is not null
      then '...' || right(wa.connected_phone_number, 4)
      else null
    end as connected_phone_masked,
    wa.last_seen_at,
    (wa.circuit_breaker_open_until is not null and wa.circuit_breaker_open_until > now()) as circuit_breaker_open,
    (select count(*) from public.notification_queue nq
       where nq.club_id = c.id and nq.channel = 'whatsapp' and nq.status = 'failed'
         and nq.created_at > now() - interval '7 days') as failed_count_7d,
    (select count(*) from public.notification_queue nq
       where nq.club_id = c.id and nq.channel = 'whatsapp' and nq.status = 'pending') as pending_count
  from public.clubs c
  left join public.whatsapp_accounts wa on wa.club_id = c.id
  where (p_club_id is not null and c.id = p_club_id)
     or (p_club_id is null and coalesce(c.is_test_fixture, false) = false)
  order by c.created_at desc;
end;
$function$;

revoke all on function public.get_platform_whatsapp_health(uuid) from public;
revoke all on function public.get_platform_whatsapp_health(uuid) from anon;
grant execute on function public.get_platform_whatsapp_health(uuid) to authenticated;

comment on function public.get_platform_whatsapp_health(uuid) is
  'Production audit remediation (M-2): the aggregate/no-argument call (p_club_id null, used by PlatformOverviewPage) now excludes QA/test/demo tenant fixtures (clubs.is_test_fixture) by default, matching search_platform_clubs(). A specific p_club_id (used by PlatformClubDetailPage to render one club''s own WhatsApp health card) always returns that club regardless of is_test_fixture, matching get_platform_club_360()''s existing per-club-always-visible behavior -- a fixture club''s own Detail page must still work.';

-- CREATE OR REPLACE FUNCTION with a new parameter creates a SECOND
-- overload in Postgres rather than replacing the original -- the same
-- documented pitfall fixed for search_platform_clubs() by
-- 20260901090500_drop_search_platform_clubs_stale_overload.sql. Drop
-- the stale zero-arg overload explicitly so no caller can still invoke
-- an unfiltered version of this RPC.
drop function if exists public.get_platform_whatsapp_health();

-- ============================================================
-- 2. get_platform_alert_subscriptions(): replaces PlatformAlertsPage's
--    two direct queries (platform_subscriptions with clubs(name_ar)
--    embed, and a separate unfiltered clubs id/name_ar list used to
--    detect clubs with zero subscription rows). Both fixture-excluded
--    via the same join. Returned shape mirrors the original embed
--    field names 1:1 so the frontend mapping barely changes.
-- ============================================================
create or replace function public.get_platform_alert_subscriptions()
returns table(
  club_id uuid,
  club_name text,
  has_subscription boolean,
  subscription_id uuid,
  subscription_kind text,
  lifecycle_status text,
  end_at timestamptz,
  grace_period_days_snapshot int
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
  with latest_sub as (
    select distinct on (ps.club_id)
      ps.id, ps.club_id, ps.subscription_kind, ps.lifecycle_status,
      ps.end_at, ps.grace_period_days_snapshot
    from public.platform_subscriptions ps
    where ps.lifecycle_status != 'cancelled'
    order by ps.club_id, ps.start_at desc
  )
  select
    c.id as club_id,
    c.name_ar as club_name,
    (ls.club_id is not null) as has_subscription,
    ls.id as subscription_id,
    ls.subscription_kind,
    ls.lifecycle_status,
    ls.end_at,
    ls.grace_period_days_snapshot
  from public.clubs c
  left join latest_sub ls on ls.club_id = c.id
  where coalesce(c.is_test_fixture, false) = false;
end;
$function$;

revoke all on function public.get_platform_alert_subscriptions() from public;
revoke all on function public.get_platform_alert_subscriptions() from anon;
grant execute on function public.get_platform_alert_subscriptions() to authenticated;

comment on function public.get_platform_alert_subscriptions() is
  'Production audit remediation (M-2): server-side source for PlatformAlertsPage, replacing two unfiltered direct table queries (platform_subscriptions + clubs) with one QA-fixture-excluded (clubs.is_test_fixture) RPC. One row per club (matching the original per-club "no subscription" detection), with the latest non-cancelled subscription (if any) joined in -- same lifecycle_status != cancelled and latest-by-start_at selection the original client code used.';

-- ============================================================
-- 3. get_platform_subscription_report(): replaces PlatformReportsPage's
--    Subscription tab query (also reused by PlatformOverviewPage's
--    trial/expiring-soon counts and platform_payments revenue portion
--    below -- see #4/#5).
-- ============================================================
create or replace function public.get_platform_subscription_report()
returns table(
  club_id uuid,
  club_name text,
  plan_name_snapshot text,
  lifecycle_status text,
  start_at timestamptz,
  end_at timestamptz,
  price_snapshot numeric,
  subscription_kind text,
  grace_period_days_snapshot int
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
  select
    ps.club_id,
    c.name_ar as club_name,
    ps.plan_name_snapshot,
    ps.lifecycle_status,
    ps.start_at,
    ps.end_at,
    ps.price_snapshot,
    ps.subscription_kind,
    ps.grace_period_days_snapshot
  from public.platform_subscriptions ps
  join public.clubs c on c.id = ps.club_id
  where coalesce(c.is_test_fixture, false) = false
  order by ps.start_at desc;
end;
$function$;

revoke all on function public.get_platform_subscription_report() from public;
revoke all on function public.get_platform_subscription_report() from anon;
grant execute on function public.get_platform_subscription_report() to authenticated;

comment on function public.get_platform_subscription_report() is
  'Production audit remediation (M-2): server-side source for PlatformReportsPage''s Subscription tab (and PlatformOverviewPage''s trial/expiring-soon counts, and the Renewal tab via the same underlying rows), QA-fixture-excluded (clubs.is_test_fixture) via join to clubs. Replaces an unfiltered direct platform_subscriptions query with a clubs(name_ar) embed.';

-- ============================================================
-- 4. get_platform_revenue_report(): replaces PlatformReportsPage's
--    Revenue tab query and PlatformOverviewPage's revenueThisMonth
--    portion (platform_payments -> platform_invoices -> clubs join).
-- ============================================================
create or replace function public.get_platform_revenue_report()
returns table(
  amount numeric,
  method text,
  recorded_at timestamptz,
  club_id uuid,
  club_name text
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
  select
    pp.amount,
    pp.method,
    pp.recorded_at,
    pi.club_id,
    c.name_ar as club_name
  from public.platform_payments pp
  join public.platform_invoices pi on pi.id = pp.platform_invoice_id
  join public.clubs c on c.id = pi.club_id
  where pp.reversed_at is null
    and coalesce(c.is_test_fixture, false) = false
  order by pp.recorded_at desc;
end;
$function$;

revoke all on function public.get_platform_revenue_report() from public;
revoke all on function public.get_platform_revenue_report() from anon;
grant execute on function public.get_platform_revenue_report() to authenticated;

comment on function public.get_platform_revenue_report() is
  'Production audit remediation (M-2): server-side source for PlatformReportsPage''s Revenue tab and PlatformOverviewPage''s revenueThisMonth, QA-fixture-excluded (clubs.is_test_fixture) via platform_payments -> platform_invoices -> clubs join. Same reversed_at is null filter as the original client queries.';

-- ============================================================
-- 5. get_platform_growth_report(): replaces PlatformReportsPage's
--    Growth tab raw clubs query.
-- ============================================================
create or replace function public.get_platform_growth_report()
returns table(
  club_id uuid,
  club_name text,
  status text,
  created_at timestamptz
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
  select c.id as club_id, c.name_ar as club_name, c.status, c.created_at
  from public.clubs c
  where coalesce(c.is_test_fixture, false) = false
  order by c.created_at desc;
end;
$function$;

revoke all on function public.get_platform_growth_report() from public;
revoke all on function public.get_platform_growth_report() from anon;
grant execute on function public.get_platform_growth_report() to authenticated;

comment on function public.get_platform_growth_report() is
  'Production audit remediation (M-2): server-side source for PlatformReportsPage''s Growth tab, QA-fixture-excluded (clubs.is_test_fixture). Replaces an unfiltered direct clubs query.';

-- ============================================================
-- 6. get_platform_usage_report(): replaces PlatformReportsPage's Usage
--    tab (clubs + branches + club_memberships, aggregated client-side).
--    Aggregation now happens server-side too, since it is a straight
--    per-club count with no reason to round-trip all raw branch/
--    membership rows to the client just to count them.
-- ============================================================
create or replace function public.get_platform_usage_report()
returns table(
  club_id uuid,
  club_name text,
  branch_count bigint,
  staff_count bigint
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
  select
    c.id as club_id,
    c.name_ar as club_name,
    (select count(*) from public.branches b where b.club_id = c.id) as branch_count,
    (select count(*) from public.club_memberships cm where cm.club_id = c.id and cm.status = 'active') as staff_count
  from public.clubs c
  where coalesce(c.is_test_fixture, false) = false
  order by c.created_at desc;
end;
$function$;

revoke all on function public.get_platform_usage_report() from public;
revoke all on function public.get_platform_usage_report() from anon;
grant execute on function public.get_platform_usage_report() to authenticated;

comment on function public.get_platform_usage_report() is
  'Production audit remediation (M-2): server-side source for PlatformReportsPage''s Usage tab, QA-fixture-excluded (clubs.is_test_fixture). Replaces three unfiltered direct queries (clubs, branches, club_memberships) aggregated client-side with one RPC that aggregates server-side, same active-membership-only staff count and per-club branch count as the original.';
