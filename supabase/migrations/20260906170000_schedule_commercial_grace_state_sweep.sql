-- MAL3ABY FINAL PRE-SALES HARDENING -- Workstream 3: actually invoke
-- refresh_commercial_grace_state() on a schedule.
--
-- ROOT CAUSE (confirmed live before writing this migration, not assumed
-- from the prior review alone): refresh_commercial_grace_state(p_club_id)
-- gates on `if not public.is_platform_owner() then raise exception`.
-- is_platform_owner() resolves auth.uid() from the request.jwt.claims
-- GUC, which is null for every pg_cron-invoked call in this project (all
-- 3 existing jobs run as role `postgres` with no JWT context -- proven
-- live: `select auth.uid()` inside a simulated cron call returns null,
-- so `is_platform_owner()` returns false and the function would raise
-- 'not authorized' on literally every scheduled invocation). This is the
-- SAME bug class already root-caused and fixed twice in this codebase
-- for the Sales module (20260904130300_fix_sales_upsert_discovered_lead_
-- service_role_auth.sql, 20260904140100_fix_sales_service_role_auth_
-- current_user_bug_class.sql) -- both confirm `auth.uid() is null` (not
-- `current_user = 'service_role'`, which is proven NOT to survive a
-- SECURITY DEFINER boundary) is the correct, safe discriminator here,
-- specifically because the function already has no anon/public grant --
-- so reaching the body with a null auth.uid() can only mean a trusted
-- service_role/cron caller, never a client bypass. Applying the exact
-- same proven fix here rather than inventing a new pattern.
--
-- SCOPE NOTE: refresh_commercial_grace_state(p_club_id uuid) operates on
-- ONE club per call (confirmed via its own signature) -- it is not a
-- set-based sweep. A new service_role-only wrapper,
-- sweep_commercial_grace_state(), does the "all clubs" iteration, using
-- the exact per-row error-isolation shape expire_stale_booking_holds()
-- already established (a `for ... loop` with each row handled inside
-- its own `begin/exception` block) so one club's failure (e.g. an
-- unexpected null in commercial_entitlements) cannot abort the sweep for
-- every other club.
--
-- IDEMPOTENCY (verified by reading the function body, not assumed): a
-- second consecutive run for a club already in grace hits
-- `insert ... on conflict (club_id, resource_type) do nothing` -- it
-- does NOT reset first_over_limit_at, so grace does not re-extend on
-- every sweep tick. A club that drops back under its limit hits the
-- `else delete from commercial_resource_grace_state where ...` branch,
-- correctly clearing grace state so a LATER re-crossing starts a fresh
-- grace period rather than reusing a stale timestamp -- this is the
-- "renewed/reactivated" case the task asked to check for specifically;
-- it was already handled correctly in the original migration, no fix
-- needed for that case. Both already verified via live read-only
-- reasoning against the current function body plus a rolled-back
-- simulated-cron-context query (see task chat for the exact evidence).
--
-- CADENCE: daily, not per-minute. Matches expire_due_academy_
-- subscriptions()'s own reasoning exactly (a commercial grace period is
-- measured in days, not seconds/minutes of precision -- unlike the live
-- booking-payment hold), scheduled at a different off-peak, non-round
-- UTC minute so it does not cluster with the existing 03:17 job.

-- ============================================================
-- Fix: refresh_commercial_grace_state(p_club_id) must accept a genuine
-- service_role/cron caller (auth.uid() is null) in addition to a real
-- interactive platform_owner. No other behavior change -- grace-state
-- computation logic is byte-identical to the version this replaces.
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
  if not (
    auth.uid() is null  -- service_role/pg_cron caller: no anon/authenticated grant exists on this function, so reaching this point already proves trust (same discriminator as sales_upsert_discovered_lead(), 20260904130300)
    or public.is_platform_owner()
  ) then
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
  'Platform-owner OR service_role/pg_cron caller (auth.uid() is null). Recomputes commercial_resource_grace_state for one club. Idempotent: already-in-grace clubs are left untouched (on conflict do nothing, first_over_limit_at never resets on repeat runs); a club back under its limit has its grace row deleted so a future re-crossing starts a fresh grace period. Called per-club by sweep_commercial_grace_state() (scheduled daily via pg_cron) and remains directly callable by Platform Owner tooling for an on-demand single-club refresh.';

-- ============================================================
-- sweep_commercial_grace_state(): the actual scheduled entry point.
-- Iterates every club with a commercial_entitlements row, calling
-- refresh_commercial_grace_state() per club with per-row exception
-- isolation -- mirrors expire_stale_booking_holds()'s own loop shape
-- exactly so one bad club can never block the rest of the sweep.
-- service_role-only: not meant to be called directly by any client, only
-- by pg_cron (or, if ever needed, a Platform-Owner "refresh all now"
-- tooling action added later via a thin service_role-invoking path).
-- ============================================================
create or replace function public.sweep_commercial_grace_state()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_count integer := 0;
begin
  for v_club_id in
    select club_id from public.commercial_entitlements
    where staff_limit is not null or active_player_limit is not null
  loop
    begin
      perform public.refresh_commercial_grace_state(v_club_id);
      v_count := v_count + 1;
    exception when others then
      -- Per-row isolation, same discipline as expire_stale_booking_holds():
      -- one club's unexpected failure must never abort the sweep for
      -- every other club. Nothing else in this project's cron jobs logs
      -- to a dedicated error table (they rely on cron.job_run_details
      -- for the overall job status), so this matches existing practice
      -- rather than introducing a new one-off error-logging mechanism.
      raise warning 'sweep_commercial_grace_state: failed for club %: %', v_club_id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.sweep_commercial_grace_state() from public, anon, authenticated;
grant execute on function public.sweep_commercial_grace_state() to service_role;

comment on function public.sweep_commercial_grace_state() is
  'Scheduled (pg_cron, daily) entry point that calls refresh_commercial_grace_state() for every club with a staff_limit or active_player_limit set. Per-club error isolation: one club failing does not block the rest. service_role-only.';

create extension if not exists pg_cron;

-- Off-peak, non-round UTC time distinct from the existing 03:17 job so
-- the two do not cluster on the same minute.
select cron.schedule(
  'sweep-commercial-grace-state',
  '41 3 * * *',
  $$select public.sweep_commercial_grace_state();$$
);
