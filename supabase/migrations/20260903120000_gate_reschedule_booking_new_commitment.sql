-- FINDING M-7 (production audit, class D -- architecture-level duplication:
-- parallel gate implementations patched individually instead of at the
-- shared invariant): reschedule_booking() has no
-- club_write_allowed(club, 'new_commitment') subscription gate, unlike
-- _create_booking_internal() in the same file which correctly calls it.
-- A blocked/expired tenant cannot create a new booking but COULD
-- reschedule an existing one to a new field/time and reprice its
-- invoice -- economically equivalent to writing a new commitment, since
-- reschedule_booking freely changes field_id/branch_id/start_at/end_at
-- and (when nothing has been paid yet) the invoice total.
--
-- Root-cause history (why this recurred): reschedule_booking() DID have
-- this exact gate when it was first introduced in
-- 20260823030000_booking_reschedule_engine.sql. The very next
-- redefinition, 20260824020000_wire_email_channel_into_booking_flow.sql,
-- silently dropped it while rewiring the function body (that migration's
-- club_write_allowed() grep hit belongs to the neighboring
-- _create_booking_internal(), not reschedule_booking -- easy to miss
-- since Postgres `create or replace function` requires restating the
-- entire body every time, so a check that isn't re-typed just silently
-- disappears with no diagnostic). Every subsequent redefinition
-- (20260824360000, 20260829210000, and this file's predecessor
-- 20260830214542) copied the already-gateless body forward. Notably,
-- 20260829210000_fix_qr_attendance_stale_status_and_reschedule_module_gate.sql
-- already re-added the *_fields_module_active()* guard to this same
-- function for the identical reason (module gate dropped by an earlier
-- redefinition, restored in isolation) without noticing the commercial
-- subscription gate had suffered the same fate. Both gates are
-- duplicated per-RPC rather than derived from one shared enforcement
-- path, so every `create or replace function reschedule_booking(...)`
-- is a fresh chance to lose either one silently -- the audit's
-- cross-cutting theme for this finding class.
--
-- Fix: add the identical club_write_allowed(v_club_id, 'new_commitment')
-- check, in the same place (immediately after the club-scoped
-- _fields_module_active() check, before any field/time/price
-- resolution) and with the exact same error message
-- _create_booking_internal() raises, so the tenant sees one consistent
-- error for "your subscription doesn't allow this" regardless of which
-- booking RPC they hit.
--
-- Scope note (per the audit instruction not to gate legitimate
-- non-revenue administrative operations): cancel_booking, no-show
-- marking, and field-block/maintenance RPCs are deliberately NOT
-- touched here -- they do not create or reprice a commitment. See the
-- report accompanying this migration for the full list of booking/
-- membership RPCs already gated vs. newly gated vs. deliberately left
-- ungated.
--
-- Every other line of reschedule_booking() is left exactly as it was in
-- 20260830214542_wire_segmented_pricing_into_booking_rpcs.sql -- this
-- migration changes ONLY the addition of the subscription gate.

create or replace function public.reschedule_booking(
  p_booking_id uuid, p_new_start_at timestamp with time zone, p_new_end_at timestamp with time zone,
  p_new_field_id uuid default null::uuid, p_reason text default null::text
)
returns TABLE(booking_id uuid, new_total_price numeric, price_changed boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_booking record;
  v_target_field_id uuid;
  v_club_id uuid;
  v_branch_id uuid;
  v_field record;
  v_timezone text;
  v_local_date date;
  v_local_start_time time;
  v_local_end_time time;
  v_hours numeric;
  v_new_total_price numeric;
  v_effective_unit_price numeric;
  v_price_changed boolean := false;
  v_hours_row record;
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_qr_token text;
  v_timezone_for_msg text;
  v_paid numeric := 0;
  v_old_start_at timestamptz;
  v_old_end_at timestamptz;
  v_old_field_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_booking
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id)
  for update;

  if v_booking.id is null then
    raise exception 'booking not found or you do not have permission to reschedule it';
  end if;

  v_club_id := v_booking.club_id;

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new bookings';
  end if;

  v_target_field_id := coalesce(p_new_field_id, v_booking.field_id);
  v_old_start_at := v_booking.start_at;
  v_old_end_at := v_booking.end_at;
  v_old_field_id := v_booking.field_id;

  if v_booking.status not in ('pending_payment', 'confirmed') then
    raise exception 'only a pending or confirmed booking can be rescheduled (current status: %)', v_booking.status;
  end if;
  if v_booking.start_at <= now() then
    raise exception 'a booking that has already started cannot be rescheduled';
  end if;

  if p_new_end_at <= p_new_start_at then
    raise exception 'end time must be after start time';
  end if;
  if p_new_start_at <= now() then
    raise exception 'the new booking time must be in the future';
  end if;

  select branch_id into v_branch_id from public.fields where id = v_target_field_id and club_id = v_club_id;
  if v_branch_id is null then
    raise exception 'field not found in this club';
  end if;
  select * into v_field from public.fields where id = v_target_field_id;

  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  select timezone into v_timezone from public.clubs where id = v_club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

  v_local_date := (p_new_start_at at time zone v_timezone)::date;
  v_local_start_time := (p_new_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_new_end_at at time zone v_timezone)::time;

  if v_local_date <> ((p_new_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;

  select * into v_hours_row from public.resolve_field_operating_hours(v_target_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then
    raise exception 'field is closed on this day';
  end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'the new time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  if exists (
    select 1 from public.field_blocks
    where field_id = v_target_field_id
      and tstzrange(start_at, end_at, '[)') && tstzrange(p_new_start_at, p_new_end_at, '[)')
  ) then
    raise exception 'field is blocked during the new time';
  end if;

  if v_booking.invoice_id is not null then
    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa where pa.invoice_id = v_booking.invoice_id;
  end if;

  -- D4 CLOSURE: segmented pricing, same engine _create_booking_internal
  -- now uses -- was resolve_field_price() x v_hours (single rate).
  v_hours := extract(epoch from (p_new_end_at - p_new_start_at)) / 3600.0;
  select coalesce(sum(s.segment_total), 0) into v_new_total_price
  from public.resolve_field_price_total(v_target_field_id, v_local_date, v_local_start_time, v_local_end_time) s;
  v_effective_unit_price := round(v_new_total_price / v_hours, 4);

  begin
    update public.bookings
    set field_id = v_target_field_id,
        branch_id = v_branch_id,
        start_at = p_new_start_at,
        end_at = p_new_end_at,
        total_price = case when v_paid = 0 then v_new_total_price else v_booking.total_price end
    where id = p_booking_id;
  exception when exclusion_violation then
    raise exception 'the new time was just booked by someone else -- please choose another time';
  end;

  v_price_changed := (v_paid = 0) and (v_new_total_price is distinct from v_booking.total_price);

  if v_paid = 0 and v_booking.invoice_id is not null and v_price_changed then
    update public.invoices
    set subtotal = v_new_total_price,
        total = v_new_total_price - discount,
        updated_at = now()
    where id = v_booking.invoice_id;

    update public.invoice_items
    set quantity = v_hours,
        unit_price = v_effective_unit_price,
        line_total = v_new_total_price - v_booking.discount_amount
    where invoice_id = v_booking.invoice_id and reference_type = 'booking' and reference_id = p_booking_id;

    perform public.write_audit_log(
      v_club_id, 'invoice.reprice_on_reschedule', 'invoices', v_booking.invoice_id,
      jsonb_build_object('total', v_booking.total_price), jsonb_build_object('total', v_new_total_price),
      'booking rescheduled: ' || coalesce(p_reason, 'no reason given')
    );
  end if;

  perform public.write_audit_log(
    v_club_id, 'booking.reschedule', 'bookings', p_booking_id,
    jsonb_build_object('field_id', v_old_field_id, 'start_at', v_old_start_at, 'end_at', v_old_end_at, 'total_price', v_booking.total_price),
    jsonb_build_object('field_id', v_target_field_id, 'start_at', p_new_start_at, 'end_at', p_new_end_at, 'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end),
    p_reason
  );

  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  v_qr_token := public._mint_booking_qr_token_internal(p_booking_id, v_club_id, p_new_end_at + interval '2 hours', auth.uid());

  select name, full_name into v_club_name, v_customer_name from public.clubs, public.customers
    where public.clubs.id = v_club_id and public.customers.id = v_booking.customer_id;
  v_booking_ref := 'MB-' || upper(substring(p_booking_id::text, 1, 8));
  v_timezone_for_msg := v_timezone;

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.rescheduled', 'booking', p_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', v_booking.customer_id, 'start_at', p_new_start_at, 'end_at', p_new_end_at, 'old_start_at', v_old_start_at, 'old_end_at', v_old_end_at)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_booking.customer_id, 'booking-rescheduled', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport,
      'start_at', p_new_start_at, 'end_at', p_new_end_at,
      'old_start_at', v_old_start_at, 'old_end_at', v_old_end_at,
      'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone_for_msg,
      'booking_ref', v_booking_ref, 'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.rescheduled:' || p_booking_id::text
  );
  perform public.queue_email_notification(
    v_club_id, v_event_id, v_booking.customer_id, 'booking-rescheduled', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport,
      'start_at', p_new_start_at, 'end_at', p_new_end_at,
      'old_start_at', v_old_start_at, 'old_end_at', v_old_end_at,
      'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone_for_msg,
      'booking_ref', v_booking_ref, 'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.rescheduled:' || p_booking_id::text
  );

  return query select p_booking_id, (case when v_paid = 0 then v_new_total_price else v_booking.total_price end), v_price_changed;
end;
$$;
