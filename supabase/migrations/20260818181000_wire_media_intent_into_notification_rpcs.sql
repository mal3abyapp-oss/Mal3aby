-- MAL3ABY WHATSAPP QR IMAGE + INVOICE DOCUMENT DELIVERY -- wiring.
--
-- Extends the queue-writing chain (queue_whatsapp_notification ->
-- enqueue_notification -> notification_queue insert) with the two new
-- media_type/media_intent columns from the schema migration, then
-- updates exactly the call sites that should carry media per this
-- task's own explicit scope:
--   - booking-created / booking-confirmed -> image / booking_qr
--     (directive rule 3: booking confirmation gets a QR image)
--   - payment-received -> document / invoice_pdf
--     (directive rule 12: payment/invoice gets a PDF document)
-- booking-cancelled explicitly stays text-only (directive rule 4: "لا
-- ترسل QR image في booking-cancelled") -- confirmed by omission below,
-- not touched. invoice-created is not called by any live RPC
-- (confirmed by reading every current call site) so nothing to wire
-- there; if it's ever wired up in the future, it should follow the
-- same invoice_pdf pattern as payment-received.

-- Postgres treats added trailing parameters as a NEW overload, not a
-- replacement of the existing 11/8-arg forms -- drop the old
-- signatures explicitly so nothing can still silently call the
-- media-blind version.
drop function if exists public.enqueue_notification(uuid, uuid, text, uuid, text, text, jsonb, text, timestamptz, timestamptz, text);
drop function if exists public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text);

create or replace function public.enqueue_notification(
  p_club_id uuid, p_event_id uuid, p_channel text, p_recipient_customer_id uuid,
  p_template_key text, p_language text, p_variables jsonb,
  p_priority text default 'transactional', p_scheduled_at timestamptz default now(),
  p_expires_at timestamptz default null, p_dedup_key text default null,
  p_media_type text default null, p_media_intent text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_queue_id uuid;
  v_consent boolean;
begin
  select enabled into v_consent
  from public.notification_consent
  where customer_id = p_recipient_customer_id and channel = p_channel;

  if v_consent is not true then
    return null;
  end if;

  insert into public.notification_queue (
    club_id, event_id, channel, recipient_customer_id, template_key,
    language, variables, priority, scheduled_at, expires_at, dedup_key,
    media_type, media_intent
  )
  values (
    p_club_id, p_event_id, p_channel, p_recipient_customer_id, p_template_key,
    p_language, p_variables, p_priority, p_scheduled_at, p_expires_at, p_dedup_key,
    p_media_type, p_media_intent
  )
  on conflict (dedup_key) where dedup_key is not null and status in ('pending', 'scheduled', 'processing', 'retrying')
  do nothing
  returning id into v_queue_id;

  return v_queue_id;
end;
$$;

revoke execute on function public.enqueue_notification(uuid, uuid, text, uuid, text, text, jsonb, text, timestamptz, timestamptz, text, text, text) from public, anon, authenticated;

create or replace function public.queue_whatsapp_notification(
  p_club_id uuid, p_event_id uuid, p_customer_id uuid, p_template_key text,
  p_category text, p_variables jsonb, p_priority text default 'transactional',
  p_dedup_key text default null, p_media_type text default null, p_media_intent text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_category_enabled boolean;
  v_phone text;
  v_language text;
  v_scheduled_at timestamptz;
  v_expires_at timestamptz;
  v_queue_id uuid;
begin
  select enabled into v_category_enabled
  from public.notification_category_settings
  where club_id = p_club_id and channel = 'whatsapp' and category = p_category;
  if v_category_enabled is false then
    return null;
  end if;

  if not exists (select 1 from public.whatsapp_accounts where club_id = p_club_id and status = 'connected') then
    return null;
  end if;

  if exists (select 1 from public.notification_suppressions where customer_id = p_customer_id and channel = 'whatsapp') then
    return null;
  end if;

  select coalesce(nc.normalized_phone, c.normalized_mobile), coalesce(nc.preferred_language, 'ar')
  into v_phone, v_language
  from public.notification_consent nc
  join public.customers c on c.id = p_customer_id
  where nc.customer_id = p_customer_id and nc.channel = 'whatsapp' and nc.enabled = true;

  if v_phone is null then
    return null;
  end if;

  if not public.is_phone_plausible(v_phone) then
    insert into public.notification_suppressions (club_id, customer_id, channel, reason, detail)
    values (p_club_id, p_customer_id, 'whatsapp', 'invalid_recipient', 'normalized phone failed plausibility check at queue time')
    on conflict (customer_id, channel) do nothing;
    return null;
  end if;

  v_scheduled_at := public.next_eligible_send_time(p_club_id, now(), p_priority);

  if p_priority = 'reminder' then
    v_expires_at := now() + interval '2 hours';
  end if;

  v_queue_id := public.enqueue_notification(
    p_club_id, p_event_id, 'whatsapp', p_customer_id, p_template_key,
    v_language, p_variables, p_priority, v_scheduled_at, v_expires_at, p_dedup_key,
    p_media_type, p_media_intent
  );

  return v_queue_id;
end;
$$;

revoke execute on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text, text, text) from public, anon, authenticated;

-- Update _create_booking_internal: booking-created and
-- booking-confirmed both get a QR image; the payment-received call
-- inside the same function gets an invoice PDF document.
create or replace function public._create_booking_internal(
  p_field_id uuid, p_customer_id uuid, p_start_at timestamptz, p_end_at timestamptz,
  p_discount_amount numeric, p_notes text, p_record_payment boolean,
  p_payment_method text, p_payment_amount numeric, p_booking_series_id uuid
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

  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', auth.uid());

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price)
  );

  -- MEDIA: booking-created now carries the QR image (directive rule 3).
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

    -- MEDIA: booking-confirmed also carries the QR image (same token,
    -- same credential -- no second credential minted, directive rule 1).
    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price,
        'invoice_number', v_invoice_number,
        'payment_status', case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end,
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token
      ),
      'transactional', 'booking.confirmed:' || v_booking_id::text,
      'image', 'booking_qr'
    );

    v_invoice_token := public._mint_invoice_token_internal(v_invoice_id, v_club_id, auth.uid());

    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    -- MEDIA: payment-received carries the invoice PDF (directive rule 12).
    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_payment_amount, 'invoice_number', v_invoice_number,
        'payment_status', case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end,
        'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token, 'invoice_id', v_invoice_id
      ),
      'transactional', 'payment.received:' || v_payment_id::text,
      'document', 'invoice_pdf'
    );
  end if;

  return v_booking_id;
end;
$$;

-- Update record_payment: the payment-received call gets the invoice
-- PDF document (directive rule 12), same as the inline path above.
create or replace function public.record_payment(
  p_invoice_id uuid, p_amount numeric, p_method text, p_reference text default null, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_invoice record;
  v_payment_id uuid;
  v_existing_payment_id uuid;
  v_pending_subscription_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
  v_pending_booking_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_invoice_token text;
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

  if p_idempotency_key is not null then
    select id into v_existing_payment_id
    from public.payments
    where club_id = v_invoice.club_id and idempotency_key = p_idempotency_key;

    if v_existing_payment_id is not null then
      return v_existing_payment_id;
    end if;
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  perform 1 from public.invoices where id = p_invoice_id for update;

  select v_invoice.total
    - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
    + coalesce((select sum(r.amount) from public.payment_allocations pa
                join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                where pa.invoice_id = v_invoice.id), 0)
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid(), p_idempotency_key)
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

  v_new_outstanding := greatest(v_outstanding - p_amount, 0);

  if v_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id;

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', v_payment_id),
        null
      );
    end if;
  end if;

  select name into v_club_name from public.clubs where id = v_invoice.club_id;
  select full_name into v_customer_name from public.customers where id = v_invoice.customer_id;
  select 'MB-' || upper(substring(id::text, 1, 8)) into v_booking_ref
    from public.bookings where invoice_id = p_invoice_id limit 1;

  v_invoice_token := public._mint_invoice_token_internal(p_invoice_id, v_invoice.club_id, auth.uid());

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  -- MEDIA: payment-received carries the invoice PDF (directive rule 12).
  perform public.queue_whatsapp_notification(
    v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
    jsonb_build_object(
      'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
      'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
      'remaining_outstanding', v_new_outstanding, 'method', p_method,
      'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
      'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id
    ),
    'transactional', 'payment.received:' || v_payment_id::text,
    'document', 'invoice_pdf'
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text, uuid) from public;

-- Extend whatsapp_connector_claim_next_batch to also return
-- media_type/media_intent so the connector knows whether (and what
-- kind of) media to generate for a claimed row. The arg list is
-- unchanged (still just p_limit) but the OUT/RETURNS TABLE column
-- list is changing -- Postgres requires an explicit DROP before a
-- CREATE OR REPLACE can change a function's result row shape.
drop function if exists public.whatsapp_connector_claim_next_batch(integer);

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(
  id uuid, club_id uuid, recipient_customer_id uuid, recipient_phone text,
  template_key text, language text, variables jsonb, attempts integer,
  media_type text, media_intent text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id, ne.event_type);

  return query
    with eligible_accounts as (
      select wa.club_id, mss.max_sends_per_minute_per_account, mss.max_sends_per_hour_per_account, mss.min_minutes_between_recipient_sends
      from public.whatsapp_accounts wa
      join public.messaging_safety_settings mss on mss.club_id = wa.club_id
      where wa.status = 'connected'
        and (wa.circuit_breaker_open_until is null or wa.circuit_breaker_open_until <= now())
    ),
    account_recent_activity as (
      select
        nq.club_id,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 minute') as sent_last_minute,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 hour') as sent_last_hour
      from public.notification_queue nq
      where nq.channel = 'whatsapp' and nq.status in ('processing', 'sent')
      group by nq.club_id
    ),
    accounts_under_rate_cap as (
      select ea.club_id, ea.min_minutes_between_recipient_sends
      from eligible_accounts ea
      left join account_recent_activity ara on ara.club_id = ea.club_id
      where coalesce(ara.sent_last_minute, 0) < ea.max_sends_per_minute_per_account
        and coalesce(ara.sent_last_hour, 0) < ea.max_sends_per_hour_per_account
    ),
    candidates as (
      select nq.id, nq.club_id, nq.recipient_customer_id, nq.scheduled_at, nq.event_id,
             aur.min_minutes_between_recipient_sends
      from public.notification_queue nq
      join accounts_under_rate_cap aur on aur.club_id = nq.club_id
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    filtered as (
      select c.id, c.club_id, c.recipient_customer_id, c.scheduled_at
      from candidates c
      where c.recipient_customer_id is null or not exists (
        select 1 from public.notification_queue nq2
        where nq2.channel = 'whatsapp'
          and nq2.recipient_customer_id = c.recipient_customer_id
          and nq2.status in ('processing', 'sent')
          and nq2.last_attempt_at > now() - make_interval(mins => c.min_minutes_between_recipient_sends)
      )
    ),
    claimed as (
      select f.id
      from filtered f
      join public.notification_queue nq3 on nq3.id = f.id
      order by f.scheduled_at
      limit greatest(p_limit, 0)
      for update of nq3 skip locked
    )
    update public.notification_queue nq
    set status = 'processing',
        last_attempt_at = now(),
        attempts = nq.attempts + 1
    from claimed
    where nq.id = claimed.id
    returning
      nq.id, nq.club_id, nq.recipient_customer_id,
      coalesce(nq.recipient_phone, (select c.normalized_mobile from public.customers c where c.id = nq.recipient_customer_id)),
      nq.template_key, nq.language, nq.variables, nq.attempts,
      nq.media_type, nq.media_intent;
end;
$$;

revoke execute on function public.whatsapp_connector_claim_next_batch(integer) from public, anon, authenticated;
