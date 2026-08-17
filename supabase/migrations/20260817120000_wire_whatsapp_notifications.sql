-- WhatsApp re-integration task #93: wire emit_notification_event() into
-- the business RPCs that don't call it yet, and -- for the first time
-- anywhere in this schema -- actually call enqueue_notification() so
-- an emitted event turns into a real queued WhatsApp message.
--
-- Confirmed via D-016's audit: emit_notification_event() was only ever
-- called from _create_booking_internal() (booking.created/confirmed).
-- enqueue_notification() was called from NOWHERE. This migration:
--   1. Adds a small reusable helper, queue_whatsapp_notification(),
--      that does the two gates Section 17/enqueue_notification()
--      itself doesn't already both do: (a) is this category enabled
--      for this club at all (notification_category_settings), then
--      (b) enqueue_notification()'s own per-customer consent check.
--      Resolves recipient_phone from customers.normalized_mobile
--      (reused, not reimplemented -- see D-016).
--   2. Wires emit_notification_event() + queue_whatsapp_notification()
--      into cancel_booking(), the standalone record_payment() RPC,
--      create_refund(), and void_invoice() -- the real gaps found in
--      D-016's audit.
--   3. Extends _create_booking_internal()'s existing booking.created/
--      booking.confirmed emissions to also queue a WhatsApp message
--      (it already emitted the event; it never queued anything).

-- ============================================================
-- queue_whatsapp_notification: the single call site every business RPC
-- below uses. Never called directly by a client (same internal-only
-- convention as emit_notification_event()/enqueue_notification()
-- themselves).
-- ============================================================
create or replace function public.queue_whatsapp_notification(
  p_club_id uuid,
  p_event_id uuid,
  p_customer_id uuid,
  p_template_key text,
  p_category text,
  p_variables jsonb,
  p_priority text default 'transactional',
  p_dedup_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category_enabled boolean;
  v_phone text;
  v_queue_id uuid;
begin
  -- Section 17 gate: has the CLUB turned this category off entirely?
  -- Missing row = enabled by default (never silently blocks existing
  -- behavior on migration -- this schema's standing convention).
  select enabled into v_category_enabled
  from public.notification_category_settings
  where club_id = p_club_id and channel = 'whatsapp' and category = p_category;

  if v_category_enabled is false then
    return null;
  end if;

  -- Only bother resolving a phone number / attempting to queue if the
  -- club's WhatsApp is actually connected -- Section 10/11's explicit
  -- rule that a disconnected WhatsApp must never fail the underlying
  -- business transaction, and there's no point creating a queue row
  -- doomed to sit in 'pending' forever with no connector to drain it.
  -- (A queue row IS still useful once reconnected, so this is an
  -- optimization, not a correctness requirement -- reconsider if a
  -- "queue everything regardless, drain later" model is ever wanted.)
  if not exists (select 1 from public.whatsapp_accounts where club_id = p_club_id and status = 'connected') then
    return null;
  end if;

  select normalized_mobile into v_phone from public.customers where id = p_customer_id;
  if v_phone is null or v_phone = '' then
    return null;
  end if;

  v_queue_id := public.enqueue_notification(
    p_club_id, p_event_id, 'whatsapp', p_customer_id, p_template_key,
    'ar', p_variables, p_priority, now(), null, p_dedup_key
  );

  return v_queue_id;
end;
$$;

revoke execute on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text) from public, anon, authenticated;

comment on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text) is
  'Task #93: single call site business RPCs use to turn an emitted event into an actual queued WhatsApp message. Checks notification_category_settings (club-level opt-out) and whether WhatsApp is connected before ever calling enqueue_notification() (which itself separately checks per-customer consent). Internal-only -- never granted to authenticated.';

-- ============================================================
-- Extend _create_booking_internal(): it already emits booking.created/
-- booking.confirmed -- now it also queues the WhatsApp message for
-- each. dedup_key = event-scoped so a retried/duplicate call can never
-- produce two queue rows for the same booking+event (Section 14).
-- ============================================================
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
  v_event_id uuid;
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

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid'
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
      jsonb_build_object('field_name', v_field.name, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price),
      'transactional', 'booking.confirmed:' || v_booking_id::text
    );

    -- Payment succeeded as part of the same transaction as the booking
    -- -- also queue the payment-received message per Section 10's
    -- explicit ordering rule (notification only AFTER the DB state is
    -- durably committed, which it is here since this all happens
    -- inside one function's transaction).
    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object('amount', p_payment_amount, 'invoice_number', v_invoice_number),
      'transactional', 'payment.received:' || v_payment_id::text
    );
  end if;

  return v_booking_id;
end;
$$;

-- ============================================================
-- cancel_booking(): real gap found in D-016 -- never emitted an event
-- at all. customer_id resolved from the booking row itself.
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_customer_id uuid;
  v_field_id uuid;
  v_field_name text;
  v_start_at timestamptz;
  v_event_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select club_id, customer_id, field_id, start_at into v_club_id, v_customer_id, v_field_id, v_start_at
  from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.cancel', v_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.bookings
  set status = 'cancelled', cancelled_reason = p_reason, cancelled_by = auth.uid(), cancelled_at = now()
  where id = p_booking_id and status in ('pending_payment', 'confirmed');

  if not found then
    raise exception 'booking not found or not in a cancellable state';
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
end;
$$;

revoke execute on function public.cancel_booking(uuid, text) from public;
revoke execute on function public.cancel_booking(uuid, text) from anon;
grant execute on function public.cancel_booking(uuid, text) to authenticated;

-- ============================================================
-- record_payment(): the standalone RPC used for settling an existing
-- invoice's outstanding balance (used by BillingPage's manual payment
-- form AND task #83's verify_manual_payment_claim()) -- real gap
-- found in D-016, never emitted an event. Emits payment.received
-- always; ALSO emits invoice-fully-paid context in the message
-- variables when the invoice's outstanding balance reaches zero,
-- since that's the moment a customer actually cares about ("you're
-- all paid up") without inventing a whole separate event type for it.
-- ============================================================
create or replace function public.record_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid method';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid())
  returning id into v_payment_id;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id),
    null
  );

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  -- Section 10: notification only AFTER the DB state (payment +
  -- allocation, and any subscription activation) is durably committed
  -- as part of this same transaction -- never before.
  v_new_outstanding := greatest(v_outstanding - p_amount, 0);

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding
    ),
    'transactional', 'payment.received:' || v_payment_id::text
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;

-- ============================================================
-- create_refund(): real gap found in D-016, never emitted an event.
-- customer_id resolved from the payment row (payments.customer_id).
-- ============================================================
create or replace function public.create_refund(
  p_payment_id uuid,
  p_amount numeric,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment record;
  v_refunded_sum numeric;
  v_refund_id uuid;
  v_event_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'refund amount must be positive';
  end if;

  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required for a refund';
  end if;

  select * into v_payment from public.payments where id = p_payment_id for update;
  if v_payment.id is null then
    raise exception 'payment not found';
  end if;

  if not (v_payment.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_payment.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_payment.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  select coalesce(sum(amount), 0) into v_refunded_sum
  from public.refunds
  where payment_id = p_payment_id and status = 'completed';

  if p_amount > (v_payment.amount - v_refunded_sum) then
    raise exception 'refund amount exceeds refundable balance (refundable: %)', (v_payment.amount - v_refunded_sum);
  end if;

  insert into public.refunds (payment_id, amount, reason, status, refunded_by)
  values (p_payment_id, p_amount, p_reason, 'completed', auth.uid())
  returning id into v_refund_id;

  perform public.write_audit_log(
    v_payment.club_id, 'payment.refund', 'refund', v_refund_id, null,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount),
    p_reason
  );

  v_event_id := public.emit_notification_event(
    v_payment.club_id, 'payment.refunded', 'refund', v_refund_id,
    jsonb_build_object('payment_id', p_payment_id, 'amount', p_amount, 'customer_id', v_payment.customer_id, 'reason', p_reason)
  );

  perform public.queue_whatsapp_notification(
    v_payment.club_id, v_event_id, v_payment.customer_id, 'payment-refunded', 'payment_confirmations',
    jsonb_build_object('amount', p_amount, 'reason', p_reason),
    'transactional', 'payment.refunded:' || v_refund_id::text
  );

  return v_refund_id;
end;
$$;

revoke execute on function public.create_refund(uuid, numeric, text) from public;
revoke execute on function public.create_refund(uuid, numeric, text) from anon;
grant execute on function public.create_refund(uuid, numeric, text) to authenticated;
