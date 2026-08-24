-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch B (booking
-- lifecycle): cancel_booking, mark_booking_no_show, reschedule_booking.
-- Same class and fix shape as Batch A.
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   cancel_booking: 'not authorized' vs 'booking not found' -- DISTINGUISHABLE
--   mark_booking_no_show: 'not authorized' vs 'booking not found' -- DISTINGUISHABLE
--   reschedule_booking: 'not authorized' vs 'booking not found' -- DISTINGUISHABLE
--
-- FIX: collapse lookup + club/permission check into one WHERE clause
-- per function. All downstream business logic (cancellable-state
-- check, QR revocation, invoice-void-on-zero-payment, markable-state
-- check, reschedule's field/branch/operating-hours/blocked-time/
-- overlap/re-pricing logic, notification queueing) preserved verbatim
-- from the current live definitions (re-read via pg_get_functiondef
-- immediately before writing this migration).

create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_start_at timestamptz;
  v_event_id uuid;
  v_invoice_id uuid;
  v_paid numeric;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id, customer_id, field_id, start_at, invoice_id
    into v_club_id, v_customer_id, v_field_id, v_start_at, v_invoice_id
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.cancel', club_id);

  if v_club_id is null then
    raise exception 'booking not found or you do not have permission to cancel it';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_reason = p_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_booking_id and status in ('pending_payment', 'confirmed');

  if not found then
    raise exception 'booking not found or not in a cancellable state';
  end if;

  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  if v_invoice_id is not null then
    perform 1 from public.invoices where id = v_invoice_id for update;

    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa where pa.invoice_id = v_invoice_id;

    if v_paid = 0 then
      update public.invoices
      set status = 'void', updated_at = now()
      where id = v_invoice_id and status = 'issued';

      if found then
        perform public.write_audit_log(
          v_club_id, 'invoice.voided_on_booking_cancellation', 'invoices', v_invoice_id,
          jsonb_build_object('status', 'issued'), jsonb_build_object('status', 'void'),
          'booking cancelled: ' || p_reason
        );
      end if;
    end if;
  end if;

  perform public.write_audit_log(v_club_id, 'cancel_booking', 'bookings', p_booking_id, null, jsonb_build_object('status', 'cancelled'), p_reason);

  select name into v_field_name from public.fields where id = v_field_id;

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.cancelled', 'booking', p_booking_id,
    jsonb_build_object('customer_id', v_customer_id, 'reason', p_reason, 'start_at', v_start_at)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-cancelled', 'booking_confirmations',
    jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_start_at, 'reason', p_reason),
    'transactional', 'booking.cancelled:' || p_booking_id::text
  );
  perform public.queue_email_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-cancelled', 'booking_confirmations',
    jsonb_build_object('field_name', coalesce(v_field_name, ''), 'start_at', v_start_at, 'reason', p_reason),
    'transactional', 'booking.cancelled:' || p_booking_id::text
  );

  perform public.cancel_pending_whatsapp_for_booking(p_booking_id, v_event_id);
end;
$$;

create or replace function public.mark_booking_no_show(p_booking_id uuid, p_reason text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id);

  if v_club_id is null then
    raise exception 'booking not found or you do not have permission to update it';
  end if;

  update public.bookings
  set status = 'no_show', marked_by = auth.uid(), marked_at = now(), notes = coalesce(notes || E'\n', '') || coalesce(p_reason, '')
  where id = p_booking_id and status in ('confirmed', 'checked_in');

  if not found then
    raise exception 'booking not found or not in a markable state';
  end if;
end;
$$;

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
  v_price_per_hour numeric;
  v_hours numeric;
  v_new_total_price numeric;
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

  v_price_per_hour := public.resolve_field_price(v_target_field_id, v_local_date, v_local_start_time, v_local_end_time);
  v_hours := extract(epoch from (p_new_end_at - p_new_start_at)) / 3600.0;
  v_new_total_price := round(v_price_per_hour * v_hours, 2);

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
        unit_price = v_price_per_hour,
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

-- All 3 signatures unchanged -- in-place replace, grants untouched.
