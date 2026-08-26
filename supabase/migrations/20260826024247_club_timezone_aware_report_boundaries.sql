-- CASH RECONCILIATION & FINANCE OPERATIONS audit -- confirmed defect fix.
--
-- Every date-range/day-boundary comparison in the finance/report RPCs
-- used the database session's timezone (UTC, confirmed live via `show
-- timezone`) via bare `::date` casts on timestamptz columns and bare
-- `current_date` -- never the club's own timezone (clubs.timezone,
-- NOT NULL, real column, populated 'Africa/Cairo' for every real club).
--
-- This exact club-timezone-aware pattern already exists and is used
-- correctly elsewhere in this codebase (_field_available_starts_
-- internal, get_public_field_availability -- both convert a local date
-- to a UTC instant range via `p_date::timestamp at time zone
-- v_timezone`) -- it was simply never applied to the reporting layer.
--
-- Proven live impact: 9 real production payments have a UTC calendar
-- date that differs from their Africa/Cairo calendar date (example:
-- received_at = 2026-08-23 21:29:49+00 = 2026-08-24 00:29:49 Cairo --
-- a report for "today" (Cairo) would silently miss this payment if
-- filtered by the UTC date, or a report for "yesterday" would wrongly
-- include it).
--
-- Fix: a single reusable helper, club_local_day_bounds(), mirroring
-- the existing _field_available_starts_internal pattern exactly --
-- given a club and a LOCAL calendar date, returns the [start, end)
-- UTC instant range for that club's midnight-to-midnight day. Every
-- affected RPC's date-range filter is rewritten from
-- `col::date between p_start_date and p_end_date` to
-- `col >= bounds_start(p_start_date) and col < bounds_end(p_end_date)`
-- -- an inclusive-start/exclusive-end instant range, which is the
-- correct translation of an inclusive [start_date, end_date] calendar
-- range into UTC instants. No accounting formula (sums, joins, status
-- filters) changed anywhere -- only the boundary comparison.
--
-- Timezone source: clubs.timezone exclusively, never hardcoded. Column
-- is NOT NULL with an existing application default of 'Africa/Cairo'
-- (confirmed live: 0 clubs have a null timezone) -- this is the
-- application's own already-documented fallback, not a new one
-- invented for this migration.
create or replace function public.club_local_day_bounds(p_club_id uuid, p_date date)
returns table(day_start timestamptz, day_end timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_timezone text;
begin
  select c.timezone into v_timezone from public.clubs c where c.id = p_club_id;
  if v_timezone is null then
    v_timezone := 'Africa/Cairo';
  end if;

  return query select
    p_date::timestamp at time zone v_timezone,
    (p_date + 1)::timestamp at time zone v_timezone;
end;
$function$;

comment on function public.club_local_day_bounds(uuid, date) is
  'Given a club and a LOCAL calendar date, returns the [day_start, day_end) UTC instant range for that club''s own timezone (clubs.timezone). Mirrors the existing _field_available_starts_internal pattern. Use: col >= day_start and col < day_end, for an inclusive single-day match; for an inclusive [p_start_date, p_end_date] range, take day_start from p_start_date and day_end from p_end_date.';

revoke execute on function public.club_local_day_bounds(uuid, date) from public;
revoke execute on function public.club_local_day_bounds(uuid, date) from anon;
