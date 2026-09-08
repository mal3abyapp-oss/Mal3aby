-- PLATFORM OWNER CONTROL PLANE V1 -- Phase 4+5 (Tenant 360 + Last
-- Activity), 2026-09-08.
--
-- Builds on the read-only deep dive (docs/platform-owner/
-- PLATFORM_OWNER_DEEP_DIVE_REPORT.md Sections 5/7/12/23): two confirmed
-- gaps on Club 360 -- (1) academy shows entitlement/active state only,
-- no count, unlike branches/fields; (2) "no last-activity signal
-- exists anywhere in the product" -- a Platform Owner cannot tell an
-- engaged tenant from an abandoned one without opening 3+ separate
-- screens.
--
-- ============================================================
-- 1. get_platform_club_last_activity(p_club_id): the actual new
--    capability. Defensible "last meaningfully active" signal, pure
--    aggregation over EXISTING data -- no new event-tracking table, no
--    client-side ping/heartbeat, matching the mission's explicit "avoid
--    invasive event-tracking infrastructure for V1" instruction and the
--    existing count_active_customers_and_players() precedent (also a
--    pure aggregation over bookings/payments/attendance, no new table).
--
--    Three signals, exact columns confirmed via live schema read (same
--    columns count_active_customers_and_players() already documents
--    and relies on -- see 20260904210100_commercial_packaging_
--    usage_rpcs.sql's own header comment):
--      - bookings.created_at   (booking placed, any status -- even a
--        since-cancelled booking reflects the tenant was actively
--        using the product at that moment; excluding cancelled here
--        would undercount real usage, unlike the *active player count*
--        definition which deliberately excludes cancelled because that
--        RPC counts current commercial usage, not historical activity)
--      - payments.received_at  (money received, any status -- even a
--        later-voided payment reflects a real staff action taken)
--      - attendance.marked_at  (an academy session's attendance was
--        recorded -- the one signal for academy-only tenants with no
--        bookings/payments activity, e.g. a pure academy club)
--    MAX() of the three, plus which one it was. A club with zero
--    activity across all three (a brand-new or fully dormant tenant)
--    returns a null timestamp and null activity type -- rendered by the
--    frontend as "no recorded activity", not defaulted to
--    clubs.created_at (which would misleadingly imply activity that
--    never happened).
--
--    Deliberately NOT included: club_memberships (staff login has no
--    per-row last-seen column anywhere in the schema, confirmed by
--    grep -- would require new infrastructure, out of scope for V1 per
--    the mission's explicit instruction), WhatsApp notification_queue
--    (already surfaced separately via get_platform_whatsapp_health(),
--    duplicating it here would blur two different signals into one).
-- ============================================================
create or replace function public.get_platform_club_last_activity(p_club_id uuid)
returns table(
  last_activity_at timestamptz,
  last_activity_type text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_last_booking timestamptz;
  v_last_payment timestamptz;
  v_last_attendance timestamptz;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  select max(b.created_at) into v_last_booking
  from public.bookings b
  where b.club_id = p_club_id;

  select max(p.received_at) into v_last_payment
  from public.payments p
  where p.club_id = p_club_id;

  select max(a.marked_at) into v_last_attendance
  from public.attendance a
  where a.club_id = p_club_id;

  return query
  select
    greatest(v_last_booking, v_last_payment, v_last_attendance) as last_activity_at,
    case greatest(v_last_booking, v_last_payment, v_last_attendance)
      when v_last_booking then 'booking'
      when v_last_payment then 'payment'
      when v_last_attendance then 'attendance'
      else null
    end as last_activity_type;
end;
$function$;

comment on function public.get_platform_club_last_activity(uuid) is
  'Platform Owner Control Plane V1 Phase 5: defensible "last meaningfully active" signal -- MAX(bookings.created_at, payments.received_at, attendance.marked_at) for the club, plus which one it was. Pure aggregation over existing operational data, no new event-tracking table. Null/null means no recorded activity in any of the three signals (never defaulted to clubs.created_at). is_platform_owner()/has_platform_permission()-gated, matching search_platform_clubs()''s own authorization pattern exactly.';

revoke all on function public.get_platform_club_last_activity(uuid) from public;
revoke all on function public.get_platform_club_last_activity(uuid) from anon;
grant execute on function public.get_platform_club_last_activity(uuid) to authenticated;

-- ============================================================
-- 2. get_platform_club_360(): additive-only column extension. Same
--    CREATE OR REPLACE-with-new-trailing-columns pattern already used
--    elsewhere in this codebase for RETURNS TABLE functions (e.g.
--    get_platform_whatsapp_health's p_club_id addition) -- but for a
--    RETURNS TABLE change specifically, Postgres requires the function
--    to be dropped and recreated (CREATE OR REPLACE cannot add columns
--    to an existing composite return type in place). Confirmed only
--    one call site exists for this function
--    (PlatformClubDetailPage.tsx) via grep across src/ -- dropping and
--    recreating it here is safe; every existing column is preserved
--    byte-identical, only two new trailing columns are added
--    (academy_count, last_activity_at, last_activity_type), so any
--    other future consumer selecting by name (not by position) is
--    unaffected.
--
--    academy_count: same source/definition as
--    commercial_entitlements_usage.academy_used and
--    set_commercial_entitlements()'s own v_academy_used computation
--    (count of public.programs where club_id = p_club_id and
--    status = 'active') -- reusing the established definition rather
--    than inventing a new one, so this number always agrees with the
--    Limits card's own "used" figure for the same club.
--
--    last_activity_at/last_activity_type: delegates to
--    get_platform_club_last_activity() above rather than duplicating
--    its three-way MAX() inline, so there is exactly one place that
--    defines what "last activity" means.
-- ============================================================
drop function if exists public.get_platform_club_360(uuid);

create function public.get_platform_club_360(p_club_id uuid)
returns table(
  owner_user_id uuid,
  owner_name text,
  owner_email text,
  owner_phone text,
  branch_count bigint,
  field_count bigint,
  customer_count bigint,
  bookings_today bigint,
  bookings_this_month bigint,
  bookings_pending bigint,
  academy_count bigint,
  last_activity_at timestamptz,
  last_activity_type text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_owner record;
  v_today_start timestamptz := date_trunc('day', now());
  v_today_end timestamptz := date_trunc('day', now()) + interval '1 day';
  v_month_start timestamptz := date_trunc('month', now());
  v_last_activity record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select cm.user_id, p.full_name, u.email::text, p.phone
    into v_owner
  from public.club_memberships cm
  join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
  left join public.profiles p on p.user_id = cm.user_id
  left join auth.users u on u.id = cm.user_id
  where cm.club_id = p_club_id and cm.status = 'active'
  order by cm.created_at asc
  limit 1;

  -- get_platform_club_last_activity() itself re-checks authorization
  -- (is_platform_owner() already holds here, so its own check is
  -- always satisfied) -- called directly rather than inlining its
  -- three-way MAX() so both entry points (this RPC and the standalone
  -- one used by search_platform_clubs' batched variant below) share
  -- one definition.
  select la.last_activity_at, la.last_activity_type
    into v_last_activity
  from public.get_platform_club_last_activity(p_club_id) la;

  return query
  select
    v_owner.user_id,
    v_owner.full_name,
    v_owner.email,
    v_owner.phone,
    (select count(*) from public.branches b where b.club_id = p_club_id) as branch_count,
    (select count(*) from public.fields f where f.club_id = p_club_id) as field_count,
    (select count(*) from public.customers c where c.club_id = p_club_id) as customer_count,
    (select count(*) from public.bookings bk where bk.club_id = p_club_id and bk.start_at >= v_today_start and bk.start_at < v_today_end and bk.status not in ('cancelled')) as bookings_today,
    (select count(*) from public.bookings bk where bk.club_id = p_club_id and bk.start_at >= v_month_start and bk.status not in ('cancelled')) as bookings_this_month,
    (select count(*) from public.bookings bk where bk.club_id = p_club_id and bk.status = 'pending') as bookings_pending,
    (select count(*) from public.programs pr where pr.club_id = p_club_id and pr.status = 'active') as academy_count,
    v_last_activity.last_activity_at,
    v_last_activity.last_activity_type;
end;
$function$;

revoke all on function public.get_platform_club_360(uuid) from public;
revoke all on function public.get_platform_club_360(uuid) from anon;
grant execute on function public.get_platform_club_360(uuid) to authenticated;

comment on function public.get_platform_club_360(uuid) is
  'Platform Owner Control Plane V1 Phase 4: additive extension of the original Club 360 summary RPC (20260819110000) -- adds academy_count (same definition as commercial_entitlements_usage.academy_used) and last_activity_at/last_activity_type (delegates to get_platform_club_last_activity()). Every original column preserved unchanged.';

-- ============================================================
-- 3. search_platform_clubs(): batched last-activity for the Clubs list
--    (PlatformClubsPage.tsx), per the mission's explicit instruction to
--    avoid a per-row N+1 RPC-call-in-a-loop anti-pattern. This RPC
--    already computes exactly one row per club server-side inside a
--    single query plan (not a client-side loop calling a per-club RPC
--    N times) -- adding two more correlated-subquery columns to the
--    same `computed` CTE is a same-shape, same-cost extension, not a
--    new anti-pattern. Same drop+recreate necessity as above (RETURNS
--    TABLE column addition). Every existing column/parameter preserved
--    byte-identical; only two new trailing output columns added
--    (last_activity_at, last_activity_type) after total_count.
--
--    NOT delegating to get_platform_club_last_activity() row-by-row
--    here (that WOULD reintroduce the N+1 shape via a correlated
--    function call per output row) -- inlined as three correlated
--    MAX() subqueries per row instead, identical semantics, same
--    "one query plan, N rows" cost profile as every other column on
--    this CTE (branch_count-style pattern already used by
--    get_platform_usage_report() elsewhere in this codebase).
-- ============================================================
drop function if exists public.search_platform_clubs(text, text, text, text, boolean, integer, integer, boolean);

create function public.search_platform_clubs(
  p_search text default null,
  p_status text default null,
  p_access text default null,
  p_reason text default null,
  p_flagged_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0,
  p_include_test_fixtures boolean default false
)
returns table(
  club_id uuid,
  club_name text,
  club_code text,
  club_status text,
  club_country text,
  created_at timestamptz,
  flagged_duplicate boolean,
  owner_names text[],
  owner_emails text[],
  owner_phones text[],
  access text,
  reason text,
  total_count bigint,
  last_activity_at timestamptz,
  last_activity_type text
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  return query
  with owners as (
    select
      cm.club_id,
      array_agg(distinct p.full_name) filter (where p.full_name is not null) as owner_names,
      array_agg(distinct u.email::text) filter (where u.email is not null) as owner_emails,
      array_agg(distinct p.phone) filter (where p.phone is not null) as owner_phones
    from public.club_memberships cm
    join public.roles r on r.id = cm.role_id and r.key = 'club_owner'
    left join public.profiles p on p.user_id = cm.user_id
    left join auth.users u on u.id = cm.user_id
    group by cm.club_id
  ),
  latest_sub as (
    select distinct on (ps.club_id)
      ps.club_id, ps.end_at, ps.grace_period_days_snapshot
    from public.platform_subscriptions ps
    where ps.lifecycle_status != 'cancelled'
    order by ps.club_id, ps.start_at desc
  ),
  computed as (
    select
      c.id as club_id,
      c.name_ar as club_name,
      c.club_code,
      c.status as club_status,
      c.country as club_country,
      c.created_at,
      coalesce(c.flagged_duplicate, false) as flagged_duplicate,
      coalesce(c.is_test_fixture, false) as is_test_fixture,
      coalesce(o.owner_names, array[]::text[]) as owner_names,
      coalesce(o.owner_emails, array[]::text[]) as owner_emails,
      coalesce(o.owner_phones, array[]::text[]) as owner_phones,
      case
        when c.status in ('suspended', 'closed') then 'blocked'
        when ls.club_id is null then 'blocked'
        when now() < ls.end_at then 'full'
        when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'grace'
        else 'blocked'
      end as access,
      case
        when c.status in ('suspended', 'closed') then 'admin_suspended'
        when ls.club_id is null then 'no_subscription'
        when now() < ls.end_at then 'active'
        when now() < ls.end_at + (ls.grace_period_days_snapshot || ' days')::interval then 'in_grace'
        else 'expired'
      end as reason,
      (select max(b.created_at) from public.bookings b where b.club_id = c.id) as last_booking_at,
      (select max(pay.received_at) from public.payments pay where pay.club_id = c.id) as last_payment_at,
      (select max(a.marked_at) from public.attendance a where a.club_id = c.id) as last_attendance_at
    from public.clubs c
    left join owners o on o.club_id = c.id
    left join latest_sub ls on ls.club_id = c.id
  ),
  filtered as (
    select *
    from computed cc
    where (p_status is null or cc.club_status = p_status)
      and (p_access is null or cc.access = p_access)
      and (p_reason is null or cc.reason = p_reason)
      and (not p_flagged_only or cc.flagged_duplicate)
      and (p_include_test_fixtures or not cc.is_test_fixture)
      and (
        p_search is null or p_search = ''
        or cc.club_name ilike '%' || p_search || '%'
        or cc.club_code ilike '%' || p_search || '%'
        or exists (select 1 from unnest(cc.owner_names) n where n ilike '%' || p_search || '%')
        or exists (select 1 from unnest(cc.owner_emails) e where e ilike '%' || p_search || '%')
        or exists (select 1 from unnest(cc.owner_phones) ph where ph ilike '%' || p_search || '%')
      )
  )
  select
    f.club_id, f.club_name, f.club_code, f.club_status, f.club_country,
    f.created_at, f.flagged_duplicate, f.owner_names, f.owner_emails,
    f.owner_phones, f.access, f.reason,
    count(*) over ()::bigint as total_count,
    greatest(f.last_booking_at, f.last_payment_at, f.last_attendance_at) as last_activity_at,
    case greatest(f.last_booking_at, f.last_payment_at, f.last_attendance_at)
      when f.last_booking_at then 'booking'
      when f.last_payment_at then 'payment'
      when f.last_attendance_at then 'attendance'
      else null
    end as last_activity_type
  from filtered f
  order by f.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

revoke all on function public.search_platform_clubs(text, text, text, text, boolean, integer, integer, boolean) from public;
revoke all on function public.search_platform_clubs(text, text, text, text, boolean, integer, integer, boolean) from anon;
grant execute on function public.search_platform_clubs(text, text, text, text, boolean, integer, integer, boolean) to authenticated;

comment on function public.search_platform_clubs(text, text, text, text, boolean, integer, integer, boolean) is
  'Platform Owner Control Plane V1 Phase 5 (last-activity list integration): additive extension of the 20260901090000 version -- adds last_activity_at/last_activity_type as two more correlated-subquery columns in the same computed CTE (same one-query-plan cost shape as every other column here, not a per-row RPC loop). Every existing column/parameter preserved unchanged.';

-- ============================================================
-- 4. Indexes: bookings.club_id and attendance.club_id already exist
--    (idx_bookings_club_id, attendance_club_id_idx) and
--    idx_payments_club_status_received_at already covers the payments
--    MAX(received_at) lookup, but a MAX(created_at)/MAX(marked_at)
--    scoped by club_id alone benefits from a composite index rather
--    than an index-then-filter scan, once table volume grows beyond
--    today's handful of test-fixture clubs. At current live scale (13
--    clubs, all test fixtures, per the deep dive) this is not yet a
--    measurable bottleneck -- added now because it is cheap and
--    correct, not because a real performance problem was observed,
--    matching this migration's own "don't over-engineer for a scale
--    that doesn't exist yet" instruction while still closing the one
--    genuinely missing index each new correlated-subquery column here
--    introduces.
-- ============================================================
create index if not exists idx_bookings_club_id_created_at
  on public.bookings (club_id, created_at desc);

create index if not exists idx_attendance_club_id_marked_at
  on public.attendance (club_id, marked_at desc);
