-- Gate 1 (Booking Time Integrity) -- server-side fix.
--
-- Root cause trace (documented per the audit's required trace order):
--   User selects a time on the calendar (venue-local wall clock, e.g.
--   18:00 Africa/Cairo)
--   -> Frontend built a NAIVE string "date+T+time+:00" (no offset)   [FIXED: src/lib/domain/time.ts::toInstant now used at every write/read site]
--   -> Sent as p_start_at/p_end_at, typed `timestamp with time zone`
--   -> Postgres parsed the naive string using the DB SESSION's default
--      timezone (`show timezone` = 'UTC' on this project), not the
--      club's real venue timezone -- so 18:00 got stored as 18:00 UTC
--      instead of 18:00 Africa/Cairo (15:00 UTC during Cairo's current
--      DST, i.e. a ~3h drift matching the reported symptom exactly).
--   -> Frontend fix (already applied) makes the CLIENT send a correct,
--      already-converted UTC instant. This migration fixes the second
--      half of the bug: _create_booking_internal derived "which
--      calendar day / which wall-clock time" from that timestamptz via
--      bare `p_start_at::date` / `p_start_at::time` casts, which ALSO
--      implicitly use the session's UTC timezone rather than the
--      venue's -- so even with a correct instant, operating-hours
--      lookup, pricing-rule resolution, and the same-day-span check
--      would silently use the wrong local date/time whenever the
--      venue's offset from UTC is nonzero (i.e. always, for this
--      product's real customers).
--
-- Fix: resolve the club's own `clubs.timezone` (IANA name, never
-- hardcoded) and derive the local date/time via `AT TIME ZONE`, which
-- correctly accounts for DST at that specific instant.

create or replace function public._create_booking_internal(
  p_field_id uuid,
  p_customer_id uuid,
  p_start_at timestamp with time zone,
  p_end_at timestamp with time zone,
  p_discount_amount numeric,
  p_notes text,
  p_record_payment boolean,
  p_payment_method text,
  p_payment_amount numeric,
  p_booking_series_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_timezone text;
  v_local_date date;
  v_local_start_time time;
  v_local_end_time time;
  v_price_per_hour numeric;
  v_hours numeric;
  v_total_price numeric;
  v_booking_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_payment_id uuid;
  v_hours_row record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, branch_id into v_club_id, v_branch_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;
  select * into v_field from public.fields where id = p_field_id;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new bookings';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = v_club_id) then
    raise exception 'customer not found in this club';
  end if;

  if p_booking_series_id is not null and not exists (
    select 1 from public.booking_series
    where id = p_booking_series_id
      and club_id = v_club_id
      and field_id = p_field_id
      and customer_id = p_customer_id
  ) then
    raise exception 'booking series does not match this club/field/customer';
  end if;

  if p_end_at <= p_start_at then
    raise exception 'end time must be after start time';
  end if;

  -- Venue Timezone: always resolved from the club's own record, never
  -- hardcoded to Egypt/UTC+3/any fixed offset, so this is correct for
  -- any IANA zone and automatically correct across DST transitions.
  select timezone into v_timezone from public.clubs where id = v_club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

  -- Business Date / Business Time: the venue-local wall-clock values
  -- this booking actually represents to a human standing at the venue
  -- -- NOT the UTC calendar day/time the raw timestamptz happens to
  -- fall on.
  v_local_date := (p_start_at at time zone v_timezone)::date;
  v_local_start_time := (p_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_end_at at time zone v_timezone)::time;

  if v_local_date <> ((p_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;

  select * into v_hours_row from public.resolve_field_operating_hours(p_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then
    raise exception 'field is closed on this day';
  end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'booking time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  -- Conflict detection stays instant-based (tstzrange comparison of the
  -- real UTC instants) -- this part was always correct and remains
  -- timezone-agnostic by design, which is the right way to detect
  -- overlap regardless of venue timezone.
  if exists (
    select 1 from public.field_blocks
    where field_id = p_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    raise exception 'field is blocked during this time';
  end if;

  v_price_per_hour := public.resolve_field_price(
    p_field_id, v_local_date, v_local_start_time, v_local_end_time
  );
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

  if p_discount_amount > 0 then
    if not public.has_permission('booking.discount.apply', v_club_id) then
      raise exception 'not authorized to apply a discount';
    end if;
    if p_discount_amount > v_total_price * 0.3 and not public.has_permission('booking.discount.override', v_club_id) then
      raise exception 'discount exceeds the standard limit -- requires override permission';
    end if;
  end if;

  insert into public.bookings (
    club_id, branch_id, field_id, customer_id, start_at, end_at,
    status, total_price, discount_amount, notes, booking_series_id, created_by
  ) values (
    v_club_id, v_branch_id, p_field_id, p_customer_id, p_start_at, p_end_at,
    'pending_payment', v_total_price, p_discount_amount, p_notes, p_booking_series_id, auth.uid()
  ) returning id into v_booking_id;

  perform public.write_audit_log(
    v_club_id, 'booking.create', 'booking', v_booking_id, null,
    jsonb_build_object('field_id', p_field_id, 'customer_id', p_customer_id, 'total_price', v_total_price, 'discount_amount', p_discount_amount),
    null
  );

  if p_discount_amount > 0 then
    perform public.write_audit_log(
      v_club_id, 'booking.discount.apply', 'booking', v_booking_id, null,
      jsonb_build_object('discount_amount', p_discount_amount, 'total_price', v_total_price),
      null
    );
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, p_customer_id, 'issued', v_total_price, p_discount_amount, v_total_price - p_discount_amount, now(), auth.uid())
  returning id into v_invoice_id;

  perform public.write_audit_log(
    v_club_id, 'invoice.issue', 'invoice', v_invoice_id, null,
    jsonb_build_object('invoice_number', v_invoice_number, 'total', v_total_price - p_discount_amount),
    null
  );

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price - p_discount_amount);

  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    if not public.has_permission('payment.create', v_club_id) then
      raise exception 'not authorized to record a payment';
    end if;

    insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by)
    values (v_club_id, v_branch_id, p_customer_id, coalesce(p_payment_method, 'cash'), p_payment_amount, auth.uid())
    returning id into v_payment_id;

    perform public.write_audit_log(
      v_club_id, 'payment.record', 'payment', v_payment_id, null,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'invoice_id', v_invoice_id),
      null
    );

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, least(p_payment_amount, v_total_price - p_discount_amount));

    update public.bookings set status = 'confirmed' where id = v_booking_id;
  end if;

  return v_booking_id;
end;
$$;
