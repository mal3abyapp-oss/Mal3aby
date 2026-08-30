-- BOOKINGS/FIELDS PRODUCTION ACCEPTANCE, D4 CLOSURE: segmented
-- time-based pricing, per explicit project-owner policy decision
-- (2026-08-31). A booking spanning multiple adjacent pricing-rule
-- windows must be priced by splitting it at every rule boundary it
-- crosses and summing each segment at its own rate -- e.g. a field
-- priced 100/hr 08:00-12:00 and 150/hr 12:00-18:00, booked 11:00-13:00,
-- prices as (1h @ 100) + (1h @ 150) = 250 EGP, not a single blended or
-- fallback rate.
--
-- resolve_field_price() (the existing single-rate lookup, requires
-- FULL containment within one rule) is UNCHANGED and kept exactly as
-- it was -- it remains correct and in active use for every "price at
-- this single instant" display (the "price right now" cards on
-- BookingsPage/BookingsFieldDayView/BookingsMobileView/
-- FieldsManagement/PricingEditor all call it with start_time ==
-- end_time, a zero-duration point query that can never itself
-- straddle a boundary). Nothing about those call sites changes.
--
-- New: _resolve_field_price_segments_internal(), the shared
-- segmentation engine (SECURITY DEFINER, not directly callable by
-- clients -- same pattern as _field_available_starts_internal), used
-- by both the staff-facing and public entrypoints below, and by
-- _create_booking_internal/reschedule_booking directly (same schema,
-- same club, no cross-RPC round-trip needed inside another RPC).
--
-- Algorithm (requirements 2/3/5/6 from the approved policy):
--   1. Collect every candidate boundary point: the requested
--      start/end, plus every pricing_rules row's start_time/end_time
--      that falls strictly inside the requested range (field-specific
--      OR club-wide, matching this date's day-of-week or an exact
--      date_specific row -- the exact same rule-selection universe
--      resolve_field_price() already uses).
--   2. Sort and de-duplicate those points -> N+1 points define N
--      consecutive, non-overlapping segments spanning the full
--      requested range (by construction: covers every minute of the
--      requested duration exactly once, never double-charges).
--   3. For each segment, resolve the winning rule via the identical
--      containment + precedence predicate resolve_field_price() uses
--      (start_time <= segment_start and end_time >= segment_end,
--      ordered by (field_id is not null) desc, (date_specific is not
--      null) desc, priority desc) -- so segmented pricing can never
--      disagree with single-point pricing about which rule wins
--      inside a segment that happens to equal a whole rule's window.
--   4. Any segment with no winning rule is a real, named gap -- raise
--      a clear exception naming the exact uncovered time range, never
--      silently fall back to an unrelated/general rate (requirement
--      4). This is the direct, intentional replacement for the old
--      silent-fallback-to-a-broader-rule behavior that was D4's
--      original finding.
create or replace function public._resolve_field_price_segments_internal(
  p_field_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time
)
returns table(segment_start time, segment_end time, price_per_hour numeric, rule_id uuid)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_day_of_week int;
  v_points time[];
  v_point time;
  v_prev time;
  v_seg_start time;
  v_seg_end time;
  v_rule record;
begin
  select club_id into v_club_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  if p_end_time <= p_start_time then
    raise exception 'end time must be after start time';
  end if;

  v_day_of_week := extract(dow from p_date)::int;

  -- Boundary points: requested start/end, plus every applicable
  -- rule's own start/end that falls strictly inside the requested
  -- range (a boundary exactly at the requested start or end doesn't
  -- create a new segment -- it's already one of the two endpoints).
  select array_agg(distinct pt order by pt) into v_points
  from (
    select p_start_time as pt
    union all
    select p_end_time
    union all
    select r.start_time
    from public.pricing_rules r
    where r.club_id = v_club_id
      and (r.field_id = p_field_id or r.field_id is null)
      and (
        (r.date_specific = p_date)
        or (r.date_specific is null and r.day_of_week = v_day_of_week)
      )
      and r.start_time > p_start_time and r.start_time < p_end_time
    union all
    select r.end_time
    from public.pricing_rules r
    where r.club_id = v_club_id
      and (r.field_id = p_field_id or r.field_id is null)
      and (
        (r.date_specific = p_date)
        or (r.date_specific is null and r.day_of_week = v_day_of_week)
      )
      and r.end_time > p_start_time and r.end_time < p_end_time
  ) boundary_points(pt);

  v_prev := null;
  foreach v_point in array v_points loop
    if v_prev is not null then
      v_seg_start := v_prev;
      v_seg_end := v_point;

      select r.price_per_hour, r.id into v_rule
      from public.pricing_rules r
      where r.club_id = v_club_id
        and (r.field_id = p_field_id or r.field_id is null)
        and (
          (r.date_specific = p_date)
          or (r.date_specific is null and r.day_of_week = v_day_of_week)
        )
        and r.start_time <= v_seg_start
        and r.end_time >= v_seg_end
      order by
        (r.field_id is not null) desc,
        (r.date_specific is not null) desc,
        r.priority desc
      limit 1;

      if v_rule.price_per_hour is null then
        raise exception 'no pricing rule covers %-% -- add a pricing rule for this time range before booking it', v_seg_start, v_seg_end;
      end if;

      segment_start := v_seg_start;
      segment_end := v_seg_end;
      price_per_hour := v_rule.price_per_hour;
      rule_id := v_rule.id;
      return next;

      v_rule := null;
    end if;
    v_prev := v_point;
  end loop;
end;
$function$;

revoke all on function public._resolve_field_price_segments_internal(uuid, date, time, time) from public;
revoke all on function public._resolve_field_price_segments_internal(uuid, date, time, time) from anon;
grant execute on function public._resolve_field_price_segments_internal(uuid, date, time, time) to authenticated;
grant execute on function public._resolve_field_price_segments_internal(uuid, date, time, time) to service_role;

-- Client-facing entrypoint (staff-facing, same permission pattern as
-- resolve_field_price/get_field_available_starts): returns the full
-- segment breakdown AND the summed total, so the UI can show both
-- "here's exactly how this is priced" (requirement 14 -- visible in
-- staff booking creation, public booking, booking details, invoice,
-- reschedule) and the single authoritative number.
create or replace function public.resolve_field_price_total(
  p_field_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time
)
returns table(segment_start time, segment_end time, price_per_hour numeric, hours numeric, segment_total numeric)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('field.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
  select
    s.segment_start,
    s.segment_end,
    s.price_per_hour,
    round(extract(epoch from (s.segment_end - s.segment_start)) / 3600.0, 4) as hours,
    round(s.price_per_hour * (extract(epoch from (s.segment_end - s.segment_start)) / 3600.0), 2) as segment_total
  from public._resolve_field_price_segments_internal(p_field_id, p_date, p_start_time, p_end_time) s;
end;
$function$;

revoke all on function public.resolve_field_price_total(uuid, date, time, time) from public;
revoke all on function public.resolve_field_price_total(uuid, date, time, time) from anon;
grant execute on function public.resolve_field_price_total(uuid, date, time, time) to authenticated;
grant execute on function public.resolve_field_price_total(uuid, date, time, time) to service_role;

-- Public (anonymous) equivalent, same visibility gate
-- get_public_field_available_starts already uses (field active, club
-- public_booking_enabled/active) -- used by PublicClubBookingPage.tsx
-- to show the real segmented total before a customer confirms.
create or replace function public.get_public_field_price_total(
  p_field_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time
)
returns table(segment_start time, segment_end time, price_per_hour numeric, hours numeric, segment_total numeric)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  select f.club_id into v_club_id
    from public.fields f
    join public.clubs c on c.id = f.club_id
    where f.id = p_field_id and f.status = 'active' and c.public_booking_enabled = true and c.status = 'active';

  if v_club_id is null then
    raise exception 'field not found or not publicly bookable';
  end if;

  return query
  select
    s.segment_start,
    s.segment_end,
    s.price_per_hour,
    round(extract(epoch from (s.segment_end - s.segment_start)) / 3600.0, 4) as hours,
    round(s.price_per_hour * (extract(epoch from (s.segment_end - s.segment_start)) / 3600.0), 2) as segment_total
  from public._resolve_field_price_segments_internal(p_field_id, p_date, p_start_time, p_end_time) s;
end;
$function$;

revoke all on function public.get_public_field_price_total(uuid, date, time, time) from public;
grant execute on function public.get_public_field_price_total(uuid, date, time, time) to anon;
grant execute on function public.get_public_field_price_total(uuid, date, time, time) to authenticated;
grant execute on function public.get_public_field_price_total(uuid, date, time, time) to service_role;
