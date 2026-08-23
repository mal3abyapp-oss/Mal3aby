-- BOOKING ENGINE / AVAILABILITY directive, sections 21-24: dynamically
-- computed availability, server-side, for a chosen DURATION -- not a
-- fixed-grid client walk. Confirmed by audit (grep across src/ + a
-- pg_proc scan for anything ILIKE '%availab%') that the only existing
-- availability primitive is get_public_field_availability(field, date),
-- which already does the right thing at the RAW-DATA layer: it returns
-- open_time/close_time/has_any_config plus a merged busy_ranges jsonb
-- array (bookings in blocking statuses UNION field_blocks), using the
-- correct half-open overlap predicate (start_at < day_end AND end_at >
-- day_start). That primitive is reused as-is here, NOT rebuilt --
-- get_field_available_starts below is a thin, server-side computation
-- LAYERED ON TOP of the same query shape, so there is exactly one
-- overlap predicate in the codebase, mirrored (not duplicated) from
-- get_public_field_availability's own busy_ranges subquery.
--
-- Confirmed gap this closes: PublicClubBookingPage.tsx currently
-- hardcodes `const DURATION_MINUTES = 60` and walks busy_ranges
-- client-side in a useMemo to build the visible slot list. That's a
-- CLIENT-COMPUTED availability decision (the exact anti-pattern
-- section 21 forbids) and has zero support for variable duration. The
-- DB-level exclusion constraint still protects the actual booking
-- attempt regardless, but the UI itself was never told which of
-- 30/60/90/120-minute durations are actually free from a given start
-- (section 23), nor could it correctly show "10:30 immediately
-- available after a 09:00-10:30 booking" for anything but a 60-minute
-- duration.
--
-- Design: ONE function, get_field_available_starts(field, date,
-- duration_minutes, increment_minutes default 30), returns every
-- candidate start time at the given increment across the day's
-- operating hours, each flagged is_available using the SAME half-open
-- overlap rule the DB exclusion constraint enforces:
--   candidate_start < busy.end_at AND candidate_start + duration > busy.start_at
-- A candidate is also rejected if candidate_start + duration would run
-- past close_time (can't offer a start that can't fit), or if
-- candidate_start is not strictly in the future (server clock, not
-- client clock). This lets the SAME function serve "what starts are
-- free for this duration" (public + staff booking) AND "what
-- durations are free from this start" (duration picker after a start
-- is chosen) -- the caller just filters/regroups the same rows
-- client-side for display; the AVAILABILITY DECISION itself is 100%
-- server-computed either way.
--
-- Two entrypoints, matching the existing public/staff split:
--   - get_field_available_starts: SECURITY DEFINER, staff-facing
--     (requires branch access, same as resolve_field_operating_hours
--     callers elsewhere) -- used by the staff calendar/QuickBookingSheet.
--   - get_public_field_available_starts: wraps it with the exact same
--     public-visibility gate get_public_field_availability already
--     uses (field active, club public_booking_enabled/active) -- used
--     by PublicClubBookingPage.tsx. Granted to anon, same as its
--     sibling.
-- Neither exposes customer/booking identity -- only start_at/end_at/
-- is_available, matching directive section 28 (public sees
-- available/unavailable only).

-- Shared internal engine (the ONLY place the candidate-generation +
-- overlap predicate is written). Both the staff-facing and public-
-- facing entrypoints below delegate to this -- staff after their own
-- permission check, public after its own visibility check -- so there
-- is exactly one implementation of "what starts are free," matching
-- the same half-open interval math as the live GIST exclusion
-- constraint (no_overlapping_field_bookings) and as
-- get_public_field_availability's busy_ranges subquery. Not directly
-- exposed to PostgREST beyond authenticated/service_role -- callers go
-- through get_field_available_starts (staff) or
-- get_public_field_available_starts (public), each with its own gate.
create or replace function public._field_available_starts_internal(
  p_field_id uuid,
  p_date date,
  p_duration_minutes int,
  p_increment_minutes int default 30
)
returns table(start_at timestamptz, end_at timestamptz, is_available boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_timezone text;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_hours record;
  v_open_at timestamptz;
  v_close_at timestamptz;
begin
  select c.timezone into v_timezone
    from public.fields f join public.clubs c on c.id = f.club_id
    where f.id = p_field_id;

  v_day_start := p_date::timestamp at time zone v_timezone;
  v_day_end := (p_date + 1)::timestamp at time zone v_timezone;

  select * into v_hours from public.resolve_field_operating_hours(p_field_id, p_date);
  if not v_hours.has_any_config or v_hours.open_time is null then
    return;
  end if;

  v_open_at := p_date::timestamp at time zone v_timezone + v_hours.open_time;
  v_close_at := p_date::timestamp at time zone v_timezone + v_hours.close_time;

  return query
  with busy as (
    select b.start_at, b.end_at
    from public.bookings b
    where b.field_id = p_field_id
      and b.status in ('pending_payment', 'confirmed', 'checked_in')
      and b.start_at < v_day_end and b.end_at > v_day_start
    union all
    select fb.start_at, fb.end_at
    from public.field_blocks fb
    where fb.field_id = p_field_id
      and fb.start_at < v_day_end and fb.end_at > v_day_start
  ),
  candidates as (
    select gs as candidate_start
    from generate_series(v_open_at, v_close_at - make_interval(mins => p_duration_minutes), make_interval(mins => p_increment_minutes)) as gs
  )
  select
    c.candidate_start,
    c.candidate_start + make_interval(mins => p_duration_minutes),
    c.candidate_start > now()
      and not exists (
        select 1 from busy
        where busy.start_at < (c.candidate_start + make_interval(mins => p_duration_minutes))
          and busy.end_at > c.candidate_start
      )
  from candidates c
  order by c.candidate_start;
end;
$function$;

revoke all on function public._field_available_starts_internal(uuid, date, int, int) from public;
revoke all on function public._field_available_starts_internal(uuid, date, int, int) from anon;
grant execute on function public._field_available_starts_internal(uuid, date, int, int) to authenticated;
grant execute on function public._field_available_starts_internal(uuid, date, int, int) to service_role;

-- Staff-facing entrypoint: requires real club membership + booking.create
-- permission on this field's club, same authorization pattern used
-- throughout the staff booking engine. Used by the staff calendar and
-- QuickBookingSheet's duration picker.
create or replace function public.get_field_available_starts(
  p_field_id uuid,
  p_date date,
  p_duration_minutes int,
  p_increment_minutes int default 30
)
returns table(start_at timestamptz, end_at timestamptz, is_available boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'duration must be positive';
  end if;
  if p_increment_minutes is null or p_increment_minutes <= 0 then
    raise exception 'increment must be positive';
  end if;

  select f.club_id into v_club_id from public.fields f where f.id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
  select * from public._field_available_starts_internal(p_field_id, p_date, p_duration_minutes, p_increment_minutes);
end;
$function$;

revoke all on function public.get_field_available_starts(uuid, date, int, int) from public;
revoke all on function public.get_field_available_starts(uuid, date, int, int) from anon;
grant execute on function public.get_field_available_starts(uuid, date, int, int) to authenticated;
grant execute on function public.get_field_available_starts(uuid, date, int, int) to service_role;

create or replace function public.get_public_field_available_starts(
  p_field_id uuid,
  p_date date,
  p_duration_minutes int,
  p_increment_minutes int default 30
)
returns table(start_at timestamptz, end_at timestamptz, is_available boolean)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  if p_duration_minutes is null or p_duration_minutes <= 0 then
    raise exception 'duration must be positive';
  end if;
  if p_increment_minutes is null or p_increment_minutes <= 0 then
    raise exception 'increment must be positive';
  end if;

  select f.club_id into v_club_id
    from public.fields f
    join public.clubs c on c.id = f.club_id
    where f.id = p_field_id and f.status = 'active' and c.public_booking_enabled = true and c.status = 'active';

  if v_club_id is null then
    raise exception 'field not found or not publicly bookable';
  end if;

  return query
  select * from public._field_available_starts_internal(p_field_id, p_date, p_duration_minutes, p_increment_minutes);
end;
$function$;

revoke all on function public.get_public_field_available_starts(uuid, date, int, int) from public;
grant execute on function public.get_public_field_available_starts(uuid, date, int, int) to anon;
grant execute on function public.get_public_field_available_starts(uuid, date, int, int) to authenticated;
grant execute on function public.get_public_field_available_starts(uuid, date, int, int) to service_role;
