-- Fix for a real bug this session's own migration
-- (20260818120000_whatsapp_secure_links.sql) introduced, of the exact
-- same class already fixed once before in
-- 20260817140226_fix_create_booking_internal_overload_regression.sql:
--
-- _create_booking_internal() has two parameter-order-sensitive
-- overloads for the payment-method/payment-amount arguments:
--   (..., p_record_payment boolean, p_payment_method text, p_payment_amount numeric, ...)  <- the REAL one, called by create_booking()
--   (..., p_record_payment boolean, p_payment_amount numeric, p_payment_method text, ...)  <- an orphaned overload, never called
--
-- 20260818120000_whatsapp_secure_links.sql wrote its "create or
-- replace function" using the WRONG (orphaned, numeric-then-text)
-- parameter order -- so the booking_qr_token/invoice_token minting
-- and enrichment it added went into the overload create_booking()
-- never calls. Confirmed live: a real booking created through
-- create_booking() after that migration produced booking-created/
-- booking-confirmed/payment-received queue rows with NO
-- booking_qr_token/invoice_token key at all, proving the security
-- link feature was never actually live for real bookings.
--
-- Fix: recreate _create_booking_internal with the CORRECT (text,
-- numeric) parameter order -- the one create_booking() actually
-- calls -- carrying over the full body from
-- 20260817140226_fix_create_booking_internal_overload_regression.sql
-- (including its club_write_allowed() entitlement check, which the
-- wrong-order overload in 20260818120000 also omitted) plus this
-- session's QR/invoice token additions. Then drop the orphaned
-- wrong-order overload outright so this class of bug cannot recur
-- silently a third time.
--
-- record_payment() (the standalone RPC used for payments against an
-- existing invoice, not at booking-creation time) has only ONE
-- overload and was not affected by this bug -- its invoice_token
-- minting is confirmed live separately.

create or replace function public._create_booking_internal(
  p_field_id uuid,
  p_customer_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
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
  v_event_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_qr_token text;
  v_invoice_token text;
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

  -- Directive rule 1/2: mint the booking QR token now (same lifecycle
  -- ensure_booking_qr() itself uses -- single_use, expires end_at + 2h)
  -- so the very first WhatsApp message already carries a working link,
  -- instead of only the customer's own later PortalQrPage visit
  -- minting one on demand.
  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', auth.uid());

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.created:' || v_booking_id::text
  );

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

    v_event_id := public.emit_notification_event(
      v_club_id, 'booking.confirmed', 'booking', v_booking_id,
      jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price,
        'invoice_number', v_invoice_number,
        'payment_status', case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end,
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token
      ),
      'transactional', 'booking.confirmed:' || v_booking_id::text
    );

    -- Directive rule 5/12: mint an invoice token for payment-received.
    v_invoice_token := public._mint_invoice_token_internal(v_invoice_id, v_club_id, auth.uid());

    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_payment_amount, 'invoice_number', v_invoice_number,
        'payment_status', case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end,
        'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token
      ),
      'transactional', 'payment.received:' || v_payment_id::text
    );
  end if;

  return v_booking_id;
end;
$$;

-- Drop the orphaned wrong-order overload this session's
-- 20260818120000_whatsapp_secure_links.sql migration accidentally
-- (re-)created. Never called by create_booking(), so this is pure
-- dead-code removal, not a behavior change for any real flow.
drop function if exists public._create_booking_internal(uuid, uuid, timestamptz, timestamptz, numeric, text, boolean, numeric, text, uuid);
