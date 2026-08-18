-- Duplicate WhatsApp booking messages fix (2026-08-18, directive
-- Sections 22-24, real user-reported problem: "creating one booking
-- sent the customer 4 WhatsApp messages").
--
-- ROOT CAUSE (proven by reading _create_booking_internal() directly
-- and confirmed live in notification_queue: booking 6bccfdc3-... and
-- 18465eec-... each produced 3 separate 'sent' rows --
-- booking.created, booking.confirmed, payment.received -- all queued
-- inside the SAME transaction, seconds apart): when a booking is
-- created WITH an immediate payment (p_record_payment = true), the old
-- function queued THREE separate customer-facing WhatsApp messages for
-- what is, from the customer's point of view, ONE event -- "I booked
-- and paid". The booking-confirmed message even re-sent the identical
-- QR image already sent by booking-created, using the same token.
--
-- FIX (minimal, preserves the templates/queue architecture): when a
-- payment is recorded in the same transaction as booking creation, the
-- three internal events (booking.created, booking.confirmed,
-- payment.received) still fire for audit/internal purposes via
-- emit_notification_event(), but only ONE customer-facing WhatsApp
-- message is queued -- the new 'booking-confirmed-paid' merged
-- template (whatsapp-connector/src/templates.ts), carrying booking
-- details, full payment summary, invoice number, the QR image, and the
-- invoice link. No booking-created message is queued at all in this
-- branch (there is nothing left to tell the customer that the merged
-- message doesn't already say, and directive Section 23 explicitly
-- describes one comprehensive message as the target shape).
--
-- The case where NO payment is recorded at booking time is UNCHANGED:
-- booking-created still fires alone, exactly as before -- there is no
-- payment event to merge it with, so no duplicate existed in that path.
-- A payment recorded LATER, as a genuinely independent event, still
-- goes through the separate 'payment-received' template elsewhere in
-- the app (not modified here) -- Section 24's "paid later = one
-- separate payment update message" rule.
--
-- Business idempotency (Section 26): the merged message uses dedup key
-- 'booking.confirmed_paid:<booking_id>', distinct from the old
-- 'booking.confirmed:<booking_id>'/'payment.received:<payment_id>' keys
-- -- a retry/reconnect/worker-restart replaying this same RPC call
-- cannot produce a second customer-facing message for the same booking
-- while the first is still active (pending/scheduled/processing/
-- retrying), per the existing notification_queue_dedup_active_idx
-- partial unique index (unchanged).

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
as $function$
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
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_qr_token text;
  v_invoice_token text;
  v_payment_status text;
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

  select timezone into v_timezone from public.clubs where id = v_club_id;
  if v_timezone is null then
    raise exception 'club has no timezone configured';
  end if;

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

  select name, full_name into v_club_name, v_customer_name from public.clubs, public.customers
    where public.clubs.id = v_club_id and public.customers.id = p_customer_id;
  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));

  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', auth.uid());

  -- Internal business event always fires (audit trail, other
  -- integrations may listen to it) -- what changed is which of these
  -- events actually queues a CUSTOMER-FACING WhatsApp message. See
  -- directive Section 22: "it's normal for a booking to produce
  -- multiple internal events; it is NOT normal to send every event to
  -- the customer as a separate message."
  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price)
  );

  if not (p_record_payment and p_payment_amount is not null and p_payment_amount > 0) then
    -- No payment in this transaction -- booking-created is the only
    -- customer-facing message, unchanged from before this fix.
    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token
      ),
      'transactional', 'booking.created:' || v_booking_id::text,
      'image', 'booking_qr'
    );
  end if;

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

    v_payment_status := case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end;

    -- Internal events still fire for audit/other-integration purposes
    -- (unchanged) -- only the customer-facing WhatsApp send is merged.
    perform public.emit_notification_event(
      v_club_id, 'booking.confirmed', 'booking', v_booking_id,
      jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at)
    );

    v_invoice_token := public._mint_invoice_token_internal(v_invoice_id, v_club_id, auth.uid());

    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    -- ONE merged customer-facing message: booking confirmed + payment
    -- summary + invoice + QR. Carries the QR image (booking_qr) --
    -- the invoice is linked as text (invoiceUrl), not attached as a
    -- second media item, since notification_queue only supports one
    -- media attachment per message (notification_queue_media_pairing_check).
    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed-paid', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'amount_paid', p_payment_amount, 'invoice_number', v_invoice_number,
        'payment_status', v_payment_status, 'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'invoice_token', v_invoice_token
      ),
      'transactional', 'booking.confirmed_paid:' || v_booking_id::text,
      'image', 'booking_qr'
    );
  end if;

  return v_booking_id;
end;
$function$;
