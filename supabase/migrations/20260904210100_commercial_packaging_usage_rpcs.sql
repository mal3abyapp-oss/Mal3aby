-- MAL3ABY V1 COMMERCIAL PACKAGING -- Step 2: active player/customer
-- counting, staff counting, and usage-visibility RPCs for the two
-- CONTROLLED (non-blocking, grace-state) resources.
--
-- ============================================================
-- count_active_customers_and_players(p_club_id): deterministic
-- "active player/customer" count per the mission's exact definition --
-- a unique customer/player belonging to the tenant with at least one
-- qualifying activity (booking OR payment OR attendance) within the
-- trailing 90 days, no double-counting, excluding archived/deleted
-- records.
--
-- Schema reality (confirmed via direct read of live schema + ADR-002):
--   - customers: no player_id, no status column. Lifecycle is
--     merged_into_customer_id (non-null = archived-into-another,
--     exclude) -- there is no separate "deleted" flag.
--   - players: has status ('active'/'inactive').
--   - bookings.customer_id (NOT NULL) -- no player_id. A booking is a
--     customer-level event.
--   - payments.customer_id (NOT NULL) -- no player_id, no created_at
--     (uses received_at as its timestamp column). Same shape otherwise.
--   - attendance.player_id (NOT NULL) -- no customer_id, no created_at
--     (uses marked_at). The opposite key from bookings/payments.
--   - guardian_links(customer_id, player_id) is the only bridge between
--     the two identity spaces (ADR-002: "a customer becomes a
--     guardian by having rows in guardian_links").
--
-- Dedup decision (documented, not silently assumed): a "unique active
-- customer/player" is counted as ONE unit of usage per distinct
-- customer_id OR player_id that has a qualifying activity, UNIONed and
-- then deduplicated by resolving player activity back to its paying
-- customer via guardian_links where a link exists, falling back to
-- counting the player_id itself as a distinct unit when no
-- guardian_links row exists (a self-registered player with no linked
-- guardian customer). This avoids double-counting a guardian+child pair
-- who both show activity (the guardian's booking/payment AND the
-- child's attendance) as 2 billable units when they are naturally one
-- family/account relationship -- while still counting a player with no
-- guardian link (e.g. an adult academy member who is their own
-- customer row) as exactly 1.
--
-- Qualifying activity (documented interpretation, since the mission
-- text leaves "booking" underspecified): bookings.status <> 'cancelled'
-- (a cancelled booking never represented real usage); payments.status =
-- 'completed' (a void payment isn't real revenue-bearing activity);
-- attendance any status (even 'absent'/'excused' reflects the player
-- was actively enrolled/scheduled, which is the commercially relevant
-- signal -- only a genuinely non-existent/archived player is excluded).
-- ============================================================
create or replace function public.count_active_customers_and_players(p_club_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  with active_customers as (
    -- Customers with a qualifying booking or payment in the trailing 90
    -- days, excluding merged/archived customer records.
    select c.id as customer_id
    from public.customers c
    where c.club_id = p_club_id
      and c.merged_into_customer_id is null
      and (
        exists (
          select 1 from public.bookings b
          where b.customer_id = c.id and b.status <> 'cancelled'
            and b.created_at > now() - interval '90 days'
        )
        or exists (
          select 1 from public.payments pay
          where pay.customer_id = c.id and pay.status = 'completed'
            and pay.received_at > now() - interval '90 days'
        )
      )
  ),
  active_players as (
    -- Active (non-archived) players with a qualifying attendance record
    -- in the trailing 90 days. attendance has no created_at column --
    -- marked_at is the attendance-event timestamp and is used here for
    -- recency (when the attendance was recorded), which is the correct
    -- "qualifying activity" signal (not training_sessions.session_date,
    -- which can be scheduled in the future for a not-yet-occurred
    -- session).
    select p.id as player_id
    from public.players p
    where p.club_id = p_club_id
      and p.status = 'active'
      and exists (
        select 1 from public.attendance a
        where a.player_id = p.id
          and a.marked_at > now() - interval '90 days'
      )
  ),
  players_resolved_to_guardian as (
    -- Active players that DO have a guardian customer link: their usage
    -- is attributed to that customer (avoids double-counting a
    -- guardian+child pair as 2 units).
    select gl.customer_id
    from active_players ap
    join public.guardian_links gl on gl.player_id = ap.player_id
  ),
  players_without_guardian as (
    -- Active players with NO guardian_links row at all: counted as
    -- their own distinct unit (e.g. an adult self-registered member).
    select ap.player_id
    from active_players ap
    where not exists (select 1 from public.guardian_links gl where gl.player_id = ap.player_id)
  )
  select
    (select count(*) from (
      select customer_id from active_customers
      union
      select customer_id from players_resolved_to_guardian
    ) all_customer_units)
    +
    (select count(*) from players_without_guardian);
$$;

comment on function public.count_active_customers_and_players(uuid) is
  'Deterministic active player/customer count per MAL3ABY_V1_COMMERCIAL_PACKAGING.md: a unique customer (with qualifying booking/payment in trailing 90 days) or a guardian-less active player (with qualifying attendance in trailing 90 days), deduplicated so a guardian+linked-child pair counts once. Excludes merged customers and inactive players.';

revoke all on function public.count_active_customers_and_players(uuid) from public, anon;
grant execute on function public.count_active_customers_and_players(uuid) to authenticated;

-- ============================================================
-- count_active_staff(p_club_id): staff = active club_memberships rows
-- (any role, excluding the customer/portal identity plane entirely --
-- club_memberships is exclusively staff/owner/manager roles per the
-- existing architecture, portal customers never get a club_memberships
-- row). Matches the existing convention used by every other active-count
-- in this schema (status = 'active').
-- ============================================================
create or replace function public.count_active_staff(p_club_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select count(*)::integer
  from public.club_memberships cm
  where cm.club_id = p_club_id and cm.status = 'active';
$$;

comment on function public.count_active_staff(uuid) is
  'Count of active club_memberships rows for a club -- the staff-usage number for the staff_limit controlled resource.';

revoke all on function public.count_active_staff(uuid) from public, anon;
grant execute on function public.count_active_staff(uuid) to authenticated;

-- ============================================================
-- get_commercial_usage(p_club_id): single RPC giving BOTH club-owner
-- and platform-owner callers a unified usage-vs-limit view across all 5
-- resource types (branch/field/academy = hard-enforced; staff/
-- active_player = controlled/grace). Returns one row per resource_type
-- with usage, limit, percentage, and a computed status label so the
-- frontend never re-implements the 80%/100%/grace threshold logic.
--
-- Authorization: club_id must be in the caller's user_club_ids() OR the
-- caller must be platform_owner -- same pattern as
-- commercial_entitlements_usage view's RLS, but expressed as an
-- explicit RPC-level check since this aggregates staff/active-player
-- counts that themselves require SECURITY DEFINER to compute across
-- tables the calling role may not have direct SELECT on.
-- ============================================================
create or replace function public.get_commercial_usage(p_club_id uuid)
returns table(
  resource_type text,
  usage_count integer,
  resource_limit integer,
  percentage numeric,
  status text,
  is_controlled boolean,
  grace_days integer,
  over_limit_since timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ce record;
  v_staff_usage integer;
  v_player_usage integer;
  v_branch_usage integer;
  v_field_usage integer;
  v_academy_usage integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids())) and not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_ce from public.commercial_entitlements where club_id = p_club_id;

  -- BUG FIX (found live via a real authenticated RPC call before this
  -- function was ever exercised end-to-end): every bare `status` column
  -- reference below must be table-qualified. This function's own
  -- `returns table(..., status text, ...)` OUT parameter list declares
  -- `status` as an implicit PL/pgSQL variable in scope for the ENTIRE
  -- function body -- an unqualified `status = 'active'` inside a
  -- subquery is genuinely ambiguous between that variable and
  -- branches.status/fields.status/programs.status, and Postgres
  -- correctly refuses to guess (42702 "column reference is ambiguous").
  -- Confirmed live: calling this RPC before this fix failed on exactly
  -- this error on the v_branch_usage line, the first bare `status`
  -- reference reached.
  v_branch_usage := (select count(*) from public.branches b where b.club_id = p_club_id and b.status = 'active');
  v_field_usage := (select count(*) from public.fields f where f.club_id = p_club_id and f.status = 'active');
  -- Also: this must count public.programs, not public.groups, to match
  -- enforce_academy_limit()'s own authoritative counting query exactly
  -- (see 20260816100000_commercial_entitlements.sql -- "one active
  -- Academy Program = one licensed academy unit"). Counting from
  -- `groups` instead would show a usage number that disagrees with what
  -- the real INSERT-time trigger enforces -- e.g. a club with 1 program
  -- containing 3 groups would display "3/1 academies" here while the
  -- trigger correctly still allows exactly 1 (it's already at its limit
  -- of 1 program, not 3).
  v_academy_usage := (select count(*) from public.programs pr where pr.club_id = p_club_id and pr.status = 'active');
  v_staff_usage := public.count_active_staff(p_club_id);
  v_player_usage := public.count_active_customers_and_players(p_club_id);

  -- Hard-enforced resources: status is informational only here (the
  -- BEFORE INSERT triggers are the real enforcement point) -- 'blocked'
  -- reflects that a further INSERT would be rejected today, matching
  -- existing trigger behavior exactly, not a new blocking mechanism.
  return query select 'branch_limit'::text, v_branch_usage, v_ce.branch_limit,
    case when v_ce.branch_limit is null or v_ce.branch_limit = 0 then null
         else round(100.0 * v_branch_usage / v_ce.branch_limit, 1) end,
    case when v_ce.branch_limit is null then 'unlimited'
         when v_branch_usage >= v_ce.branch_limit then 'blocked'
         when v_branch_usage >= v_ce.branch_limit * 0.8 then 'approaching_limit'
         else 'normal' end,
    false, null::integer, null::timestamptz;

  return query select 'field_limit'::text, v_field_usage, v_ce.field_limit,
    case when v_ce.field_limit is null or v_ce.field_limit = 0 then null
         else round(100.0 * v_field_usage / v_ce.field_limit, 1) end,
    case when v_ce.field_limit is null then 'unlimited'
         when v_field_usage >= v_ce.field_limit then 'blocked'
         when v_field_usage >= v_ce.field_limit * 0.8 then 'approaching_limit'
         else 'normal' end,
    false, null::integer, null::timestamptz;

  return query select 'academy_limit'::text, v_academy_usage, v_ce.academy_limit,
    case when v_ce.academy_limit is null or v_ce.academy_limit = 0 then null
         else round(100.0 * v_academy_usage / v_ce.academy_limit, 1) end,
    case when v_ce.academy_limit is null then 'unlimited'
         when v_academy_usage >= v_ce.academy_limit then 'blocked'
         when v_academy_usage >= v_ce.academy_limit * 0.8 then 'approaching_limit'
         else 'normal' end,
    false, null::integer, null::timestamptz;

  -- Controlled resources: never 'blocked'. NORMAL < 80%, APPROACHING
  -- 80-99%, GRACE at exactly the limit through grace_days after,
  -- OVER_LIMIT once grace has elapsed. over_limit_since is looked up
  -- from commercial_resource_grace_state (created below) so the
  -- frontend can show "X days remaining in grace".
  return query select 'staff_limit'::text, v_staff_usage, v_ce.staff_limit,
    case when v_ce.staff_limit is null or v_ce.staff_limit = 0 then null
         else round(100.0 * v_staff_usage / v_ce.staff_limit, 1) end,
    case when v_ce.staff_limit is null then 'unlimited'
         when v_staff_usage < v_ce.staff_limit * 0.8 then 'normal'
         when v_staff_usage < v_ce.staff_limit then 'approaching_limit'
         when (select grs.first_over_limit_at from public.commercial_resource_grace_state grs
               where grs.club_id = p_club_id and grs.resource_type = 'staff_limit') is null then 'grace'
         when now() <= (select grs.first_over_limit_at from public.commercial_resource_grace_state grs
               where grs.club_id = p_club_id and grs.resource_type = 'staff_limit')
               + (coalesce(v_ce.controlled_resource_grace_days, 7) || ' days')::interval then 'grace'
         else 'over_limit' end,
    true, coalesce(v_ce.controlled_resource_grace_days, 7),
    (select grs.first_over_limit_at from public.commercial_resource_grace_state grs
     where grs.club_id = p_club_id and grs.resource_type = 'staff_limit');

  return query select 'active_player_limit'::text, v_player_usage, v_ce.active_player_limit,
    case when v_ce.active_player_limit is null or v_ce.active_player_limit = 0 then null
         else round(100.0 * v_player_usage / v_ce.active_player_limit, 1) end,
    case when v_ce.active_player_limit is null then 'unlimited'
         when v_player_usage < v_ce.active_player_limit * 0.8 then 'normal'
         when v_player_usage < v_ce.active_player_limit then 'approaching_limit'
         when (select grs.first_over_limit_at from public.commercial_resource_grace_state grs
               where grs.club_id = p_club_id and grs.resource_type = 'active_player_limit') is null then 'grace'
         when now() <= (select grs.first_over_limit_at from public.commercial_resource_grace_state grs
               where grs.club_id = p_club_id and grs.resource_type = 'active_player_limit')
               + (coalesce(v_ce.controlled_resource_grace_days, 7) || ' days')::interval then 'grace'
         else 'over_limit' end,
    true, coalesce(v_ce.controlled_resource_grace_days, 7),
    (select grs.first_over_limit_at from public.commercial_resource_grace_state grs
     where grs.club_id = p_club_id and grs.resource_type = 'active_player_limit');
end;
$$;

revoke all on function public.get_commercial_usage(uuid) from public, anon;
grant execute on function public.get_commercial_usage(uuid) to authenticated;

comment on function public.get_commercial_usage(uuid) is
  'Unified usage-vs-limit view for all 5 commercial resource types (branch/field/academy = hard; staff/active_player = controlled/grace). Authorized for the club''s own members OR platform_owner. Never mutates state -- read-only.';

-- ============================================================
-- commercial_resource_grace_state: tracks WHEN a club first crossed
-- 100% on a controlled resource, so grace expiry is a fixed, auditable
-- point in time rather than recomputed differently each read. One row
-- per (club_id, resource_type); cleared (row deleted) once usage drops
-- back under the limit, so grace always restarts fresh on a genuinely
-- new overage rather than accumulating stale state.
-- ============================================================
create table if not exists public.commercial_resource_grace_state (
  club_id uuid not null references public.clubs(id) on delete cascade,
  resource_type text not null check (resource_type in ('staff_limit', 'active_player_limit')),
  first_over_limit_at timestamptz not null default now(),
  primary key (club_id, resource_type)
);

alter table public.commercial_resource_grace_state enable row level security;

create policy "commercial_resource_grace_state_select_own_club" on public.commercial_resource_grace_state
  for select using (club_id in (select public.user_club_ids()));

create policy "commercial_resource_grace_state_platform_owner_full" on public.commercial_resource_grace_state
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

comment on table public.commercial_resource_grace_state is
  'Tracks the first-crossed-100%-usage timestamp per club per controlled resource (staff_limit, active_player_limit). Row deleted once usage drops back under the limit -- refresh_commercial_grace_state() is the only writer, called by get_commercial_usage() callers via a scheduled/periodic sweep, never by direct client write.';

-- ============================================================
-- refresh_commercial_grace_state(p_club_id): recomputes and persists
-- grace-state rows for a single club's controlled resources. Called by
-- Platform-Owner-facing tooling and can be scheduled (pg_cron or an
-- Edge Function sweep) -- not wired to a cron job in this migration
-- (no new paid scheduling infrastructure introduced), but safe to call
-- on demand, idempotent, and cheap (two count queries).
-- ============================================================
create or replace function public.refresh_commercial_grace_state(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ce record;
  v_staff_usage integer;
  v_player_usage integer;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_ce from public.commercial_entitlements where club_id = p_club_id;
  if v_ce is null then
    return;
  end if;

  v_staff_usage := public.count_active_staff(p_club_id);
  v_player_usage := public.count_active_customers_and_players(p_club_id);

  if v_ce.staff_limit is not null and v_staff_usage >= v_ce.staff_limit then
    insert into public.commercial_resource_grace_state (club_id, resource_type)
    values (p_club_id, 'staff_limit')
    on conflict (club_id, resource_type) do nothing;
  else
    delete from public.commercial_resource_grace_state
    where club_id = p_club_id and resource_type = 'staff_limit';
  end if;

  if v_ce.active_player_limit is not null and v_player_usage >= v_ce.active_player_limit then
    insert into public.commercial_resource_grace_state (club_id, resource_type)
    values (p_club_id, 'active_player_limit')
    on conflict (club_id, resource_type) do nothing;
  else
    delete from public.commercial_resource_grace_state
    where club_id = p_club_id and resource_type = 'active_player_limit';
  end if;
end;
$$;

revoke all on function public.refresh_commercial_grace_state(uuid) from public, anon, authenticated;
grant execute on function public.refresh_commercial_grace_state(uuid) to service_role;

comment on function public.refresh_commercial_grace_state(uuid) is
  'Platform-owner/service-role-only. Recomputes commercial_resource_grace_state for one club. Idempotent, safe to call repeatedly. Not wired to a cron schedule in this migration -- no new paid scheduling infrastructure introduced; intended to be called from Platform Owner tooling or a future scheduled sweep.';

-- Extend commercial_entitlements_usage view with staff/active_player
-- columns so existing club-side/platform-side readers of this view gain
-- the new data without a breaking column removal (additive only).
create or replace view public.commercial_entitlements_usage
with (security_invoker = true) as
select
  c.id as club_id,
  c.name_ar as club_name,
  ce.branch_limit,
  (select count(*) from public.branches b where b.club_id = c.id and b.status = 'active') as branches_used,
  ce.field_limit,
  (select count(*) from public.fields f where f.club_id = c.id and f.status = 'active') as fields_used,
  ce.academy_limit,
  -- Same fix as get_commercial_usage() above: must count programs, not
  -- groups, to match enforce_academy_limit()'s own authoritative query.
  (select count(*) from public.programs p where p.club_id = c.id and p.status = 'active') as academy_used,
  ce.staff_limit,
  public.count_active_staff(c.id) as staff_used,
  ce.active_player_limit,
  public.count_active_customers_and_players(c.id) as active_players_used
from public.clubs c
left join public.commercial_entitlements ce on ce.club_id = c.id;

comment on view public.commercial_entitlements_usage is
  'Club-scoped entitlement usage across all 5 commercial resource types. RLS-invoker: a club-side query only ever sees its own club via user_club_ids(); platform_owner sees all via is_platform_owner()-gated policies on the underlying tables it reads through. staff_used/active_players_used added for the commercial packaging release -- previously branches/fields/academy only.';
