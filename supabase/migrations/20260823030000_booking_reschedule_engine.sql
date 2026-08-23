-- BOOKING ENGINE / AVAILABILITY / RESCHEDULING directive (2026-08-23).
--
-- ARCHITECTURE DECISION, confirmed by a live-DB audit before writing a
-- single line here (verified via pg_get_functiondef against every
-- function touched, not just migration-file reading): this codebase
-- ALREADY has a real, working DB-level concurrency guarantee --
-- `no_overlapping_field_bookings`, a Postgres GIST exclusion
-- constraint on bookings(field_id, during) WHERE status IN
-- ('pending_payment','confirmed','checked_in') -- and a real hold
-- mechanism (`hold_expires_at` + the same exclusion constraint +ini
-- the `expire_stale_booking_holds()` pg_cron reaper, confirmed
-- active). Both the staff path (_create_booking_internal) and the
-- public path (create_public_booking) already race-safely share that
-- one constraint. None of that is rebuilt here -- rebuilding it would
-- violate the directive's own "DO NOT REBUILD" rules and risk
-- reintroducing a bug in something already correct.
--
-- What was confirmed MISSING (not assumed -- confirmed by exhaustive
-- grep across src/ and every migration, plus a live pg_proc query for
-- any reschedule/edit/change_field/move_booking function -- zero
-- hits): there is no reschedule/change-field/change-duration
-- capability anywhere in this codebase today. This migration adds
-- exactly that, reusing the existing exclusion constraint as the
-- conflict guarantee (via a real UPDATE the constraint itself
-- enforces -- not a duplicated overlap SELECT), and closes two
-- related gaps the same audit found:
--   1. create_booking/_create_booking_internal never caught
--      exclusion_violation (unlike create_public_booking, which
--      already does) -- a losing concurrent staff request got a raw
--      Postgres error instead of a friendly conflict message.
--   2. qr_credentials rows are never invalidated on cancellation or
--      (now) reschedule -- the credential itself stayed status='active'
--      even though qr_confirm_checkin's own booking-status gate
--      already blocks actual check-in. Closed here as defense in
--      depth, not because check-in was actually exploitable.

-- ============================================================
-- 1. Composite index for the calendar day-range query
-- ============================================================
-- BookingsPage.tsx's fetchBookingsForDay runs
-- .eq('club_id',...).gte('start_at',...).lte('start_at',...) --
-- confirmed via audit there was no covering index for this (only
-- single-column idx_bookings_club_id / idx_bookings_field_id
-- existed). Adds the composite the query plan actually needs.
create index if not exists idx_bookings_club_field_start
  on public.bookings (club_id, field_id, start_at);

-- ============================================================
-- 2. Catch exclusion_violation in the staff booking path
-- ============================================================
-- Identical fix pattern already proven correct in
-- create_public_booking (confirmed via live pg_get_functiondef) --
-- applied here to the staff path for the first time. Every other
-- line of this function is byte-identical to the current live
-- definition (confirmed via pg_get_functiondef before this edit) --
-- only the INSERT is now wrapped in begin/exception.
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
  p_booking_series_id uuid,
  p_receipt_serial text default null::text,
  p_receipt_date date default null::date,
  p_receipt_book text default null::text,
  p_receipt_series text default null::text,
  p_receipt_image_path text default null::text,
  p_receipt_notes text default null::text
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
  v_hold_minutes int;
  v_hold_expires_at timestamptz;
  v_effective_policy public.government_collection_policies;
  v_receipt_required boolean := false;
  v_receipt_id uuid;
  v_has_custody boolean;
  v_active_shift_id uuid;
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

  if p_start_at <= now() then
    raise exception 'booking time must be in the future';
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

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0
     and coalesce(p_payment_method, 'cash') = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = v_club_id and status = 'active';

    if v_has_custody then
      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = v_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash collection requires an active cash shift -- open one before collecting cash';
      end if;
    end if;
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    v_effective_policy := public.get_effective_government_policy(v_club_id, v_branch_id, p_field_id);
    v_receipt_required := v_effective_policy.enabled
      and v_effective_policy.official_receipt_required
      and coalesce(p_payment_method, 'cash') = any(v_effective_policy.required_payment_methods);

    if v_receipt_required then
      if p_receipt_serial is null or length(trim(p_receipt_serial)) = 0 then
        raise exception 'official collection receipt required: this club/field requires an official government collection receipt for % payments', coalesce(p_payment_method, 'cash');
      end if;
      if p_receipt_date is null then
        raise exception 'receipt date is required';
      end if;
      if p_receipt_date > (current_date + interval '1 day')::date then
        raise exception 'receipt date cannot be in the future';
      end if;
      if v_effective_policy.receipt_image_required and p_receipt_image_path is null then
        raise exception 'a receipt image is required by this club/field''s compliance policy';
      end if;
    end if;
  end if;

  if not (p_record_payment and p_payment_amount is not null and p_payment_amount > 0) then
    select payment_hold_minutes into v_hold_minutes from public.get_public_club_booking_policy(v_club_id);
    v_hold_expires_at := now() + make_interval(mins => v_hold_minutes);
  end if;

  -- Directive section 6/7: the ONLY change in this whole function --
  -- the exclusion constraint IS the DB guarantee; this just gives a
  -- losing concurrent request a friendly message instead of a raw
  -- Postgres exclusion_violation error, matching the pattern
  -- create_public_booking already used successfully.
  begin
    insert into public.bookings (
      club_id, branch_id, field_id, customer_id, start_at, end_at,
      status, total_price, discount_amount, notes, booking_series_id, created_by, hold_expires_at
    ) values (
      v_club_id, v_branch_id, p_field_id, p_customer_id, p_start_at, p_end_at,
      'pending_payment', v_total_price, p_discount_amount, p_notes, p_booking_series_id, auth.uid(), v_hold_expires_at
    ) returning id into v_booking_id;
  exception when exclusion_violation then
    raise exception 'this time slot was just booked by someone else -- please choose another time';
  end;

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

  if not (p_record_payment and p_payment_amount is not null and p_payment_amount > 0) then
    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at
      ),
      'transactional', 'booking.created:' || v_booking_id::text
    );
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0 then
    if not public.has_permission('payment.create', v_club_id) then
      raise exception 'not authorized to record a payment';
    end if;

    insert into public.payments (club_id, branch_id, customer_id, method, amount, received_by, cash_shift_id)
    values (v_club_id, v_branch_id, p_customer_id, coalesce(p_payment_method, 'cash'), p_payment_amount, auth.uid(), v_active_shift_id)
    returning id into v_payment_id;

    if v_receipt_required then
      insert into public.official_collection_receipts (
        club_id, branch_id, field_id, payment_id, invoice_id, booking_id, customer_id, authority_type,
        receipt_book, receipt_series, receipt_serial,
        receipt_date, receipt_amount, payment_method,
        entered_by, receipt_image_path, notes
      ) values (
        v_club_id, v_branch_id, p_field_id, v_payment_id, v_invoice_id, v_booking_id, p_customer_id,
        v_effective_policy.authority_type,
        p_receipt_book, p_receipt_series, p_receipt_serial,
        p_receipt_date, p_payment_amount, coalesce(p_payment_method, 'cash'),
        auth.uid(), p_receipt_image_path, p_receipt_notes
      )
      returning id into v_receipt_id;

      perform public.write_audit_log(
        v_club_id, 'official_collection_receipt.created', 'official_collection_receipt', v_receipt_id,
        null,
        jsonb_build_object('payment_id', v_payment_id, 'receipt_serial', p_receipt_serial, 'amount', p_payment_amount),
        null
      );
    end if;

    perform public.write_audit_log(
      v_club_id, 'payment.record', 'payment', v_payment_id, null,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'invoice_id', v_invoice_id, 'official_receipt_id', v_receipt_id),
      null
    );

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, least(p_payment_amount, v_total_price - p_discount_amount));

    update public.bookings set status = 'confirmed' where id = v_booking_id;

    v_payment_status := case when p_payment_amount >= (v_total_price - p_discount_amount) then 'paid' else 'partially_paid' end;

    perform public.emit_notification_event(
      v_club_id, 'booking.confirmed', 'booking', v_booking_id,
      jsonb_build_object('field_name', v_field.name, 'customer_id', p_customer_id, 'start_at', p_start_at, 'end_at', p_end_at)
    );

    v_invoice_token := public._mint_invoice_token_internal(v_invoice_id, v_club_id, auth.uid());

    v_event_id := public.emit_notification_event(
      v_club_id, 'payment.received', 'payment', v_payment_id,
      jsonb_build_object('amount', p_payment_amount, 'method', coalesce(p_payment_method, 'cash'), 'customer_id', p_customer_id, 'invoice_id', v_invoice_id)
    );

    perform public.queue_whatsapp_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-confirmed-paid', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'amount_paid', p_payment_amount, 'invoice_number', v_invoice_number,
        'payment_status', v_payment_status, 'method', coalesce(p_payment_method, 'cash'),
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'invoice_token', v_invoice_token,
        'receipt_serial', case when v_receipt_required then p_receipt_serial else null end,
        'receipt_book', case when v_receipt_required then p_receipt_book else null end,
        'receipt_series', case when v_receipt_required then p_receipt_series else null end,
        'receipt_date', case when v_receipt_required then p_receipt_date else null end
      ),
      'transactional', 'booking.confirmed_paid:' || v_booking_id::text
    );
  end if;

  return v_booking_id;
end;
$function$;

-- ============================================================
-- 3. Invalidate QR credentials on cancellation (closes the gap the
--    audit found: qr_credentials rows stayed status='active' forever
--    after a booking was cancelled -- defense in depth, since
--    qr_confirm_checkin's own booking-status gate already independently
--    blocks check-in on a cancelled booking; this closes the credential
--    itself too, matching directive item 44's "don't leave a stale
--    scannable QR" spirit).
-- ============================================================
create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- New: revoke every still-active QR credential minted for this
  -- booking. Never deletes the row (audit trail preserved, matching
  -- this session's own established "revoke, never delete" QR
  -- convention) -- just flips status so qr_validate()/
  -- qr_confirm_checkin() correctly report TOKEN_REVOKED instead of
  -- resolving to a now-cancelled booking.
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

  perform public.cancel_pending_whatsapp_for_booking(p_booking_id, v_event_id);
end;
$function$;

-- ============================================================
-- 4. reschedule_booking -- THE new capability. Atomic, single
--    transaction (this whole PL/pgSQL function body IS one
--    transaction), reuses every existing subsystem rather than
--    duplicating it:
--      - overlap/concurrency guarantee: the SAME no_overlapping_field_
--        bookings exclusion constraint every other booking path
--        already relies on -- enforced here by doing a REAL UPDATE of
--        start_at/end_at/field_id on the booking's own row, which
--        Postgres validates against the constraint exactly like an
--        INSERT would. No duplicated overlap SELECT logic exists in
--        this function -- if two reschedules race for the same target
--        interval, Postgres itself resolves it, matching directive
--        item 33 exactly ("Target interval في reschedule يجب أن يمر
--        بنفس hold/overlap/DB guarantee").
--      - operating hours / field_blocks / pricing: resolve_field_
--        operating_hours() and resolve_field_price() (unchanged),
--        same validation _create_booking_internal already performs.
--      - QR: old credential(s) revoked, a fresh one minted via the
--        SAME _mint_booking_qr_token_internal() primitive every other
--        booking surface uses -- never a second QR system.
--      - WhatsApp: ONE message, 'booking-rescheduled', reusing the
--        existing queue_whatsapp_notification() plumbing -- no new
--        transport code.
--      - Financial safety (directive items 36-39, the single most
--        important constraint on this function): a booking with ANY
--        payment already allocated (v_paid > 0) can still be
--        rescheduled to a different time/field, but its PRICE is
--        deliberately left unchanged (v_total_price stays the
--        original invoice total) rather than silently re-invoicing --
--        this directive explicitly forbids inventing a new accounting
--        model ("لا تخترع accounting model جديدًا قبل Audit") and this
--        pass did not audit a price-adjustment/credit-note workflow,
--        so the safe, honest behavior is: reschedule changes time/
--        field, never touches the existing invoice/payment/official-
--        receipt rows at all. An unpaid booking (v_paid = 0) is safe
--        to reprice, since no real money has moved yet -- so its
--        existing invoice's subtotal/total/invoice_items ARE updated
--        to the new interval's real price, exactly mirroring what
--        _create_booking_internal would have charged had this been a
--        fresh booking at the new time. This asymmetry is the
--        directive's own explicit financial-safety rule, not an
--        oversight.
create or replace function public.reschedule_booking(
  p_booking_id uuid,
  p_new_start_at timestamptz,
  p_new_end_at timestamptz,
  p_new_field_id uuid default null,
  p_reason text default null
)
returns table(booking_id uuid, new_total_price numeric, price_changed boolean)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

  -- Lock the booking row for the duration of this transaction --
  -- directive item 32: "lock current booking" is the first real step
  -- of the atomic transaction, before any other validation.
  select * into v_booking from public.bookings where id = p_booking_id for update;
  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  v_club_id := v_booking.club_id;
  v_target_field_id := coalesce(p_new_field_id, v_booking.field_id);
  v_old_start_at := v_booking.start_at;
  v_old_end_at := v_booking.end_at;
  v_old_field_id := v_booking.field_id;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  -- Directive item 82: past bookings are not arbitrarily editable.
  -- Only a booking that hasn't happened yet, and is still in a
  -- reschedulable status, may move. completed/cancelled/no_show
  -- bookings are historical record -- reschedule is a HARD FAIL, not
  -- a silent no-op, so staff get a clear reason.
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

  -- Directive item 34: branch access re-checked for the TARGET field
  -- specifically (not just the booking's original branch) -- a
  -- change-field reschedule into a branch the staff member cannot
  -- access must hard-fail here, same gate the RLS policy itself uses.
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

  -- Real money already moved on this booking? -- directive items
  -- 36-39: check BEFORE touching price/invoice, drives the repricing
  -- decision below.
  if v_booking.invoice_id is not null then
    select coalesce(sum(pa.amount), 0) into v_paid
    from public.payment_allocations pa where pa.invoice_id = v_booking.invoice_id;
  end if;

  v_price_per_hour := public.resolve_field_price(v_target_field_id, v_local_date, v_local_start_time, v_local_end_time);
  v_hours := extract(epoch from (p_new_end_at - p_new_start_at)) / 3600.0;
  v_new_total_price := round(v_price_per_hour * v_hours, 2);

  -- Directive item 33: the target interval goes through the SAME
  -- exclusion-constraint guarantee as every other booking path -- this
  -- UPDATE is what Postgres validates against
  -- no_overlapping_field_bookings. If another booking/reschedule wins
  -- the race for this exact interval first, this raises
  -- exclusion_violation and the ORIGINAL booking is left completely
  -- unchanged (the whole function is one transaction; nothing before
  -- this point wrote anything that survives a rollback).
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

  -- Directive item 37: unpaid booking -- safe to reprice for real,
  -- including its own invoice/invoice_items, since no payment has
  -- allocated against the old total yet. This mirrors exactly what
  -- _create_booking_internal would have charged had this been a fresh
  -- booking at the new time -- not a new pricing model.
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

  -- Directive item 48: full audit, before/after, for every field this
  -- reschedule actually changed.
  perform public.write_audit_log(
    v_club_id, 'booking.reschedule', 'bookings', p_booking_id,
    jsonb_build_object('field_id', v_old_field_id, 'start_at', v_old_start_at, 'end_at', v_old_end_at, 'total_price', v_booking.total_price),
    jsonb_build_object('field_id', v_target_field_id, 'start_at', p_new_start_at, 'end_at', p_new_end_at, 'total_price', case when v_paid = 0 then v_new_total_price else v_booking.total_price end),
    p_reason
  );

  -- Directive item 44: the old QR credential must not remain
  -- scannable for a booking that no longer happens at that
  -- time/field -- revoke, then mint a fresh one for the NEW interval
  -- via the exact same canonical primitive every other booking
  -- surface uses. No new QR system.
  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  v_qr_token := public._mint_booking_qr_token_internal(p_booking_id, v_club_id, p_new_end_at + interval '2 hours', auth.uid());

  -- Directive items 46-47: exactly ONE WhatsApp message for this
  -- event, reusing the existing queue plumbing -- no transport code
  -- touched.
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

  return query select p_booking_id, (case when v_paid = 0 then v_new_total_price else v_booking.total_price end), v_price_changed;
end;
$function$;

revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) from public;
revoke all on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) from anon;
grant execute on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.reschedule_booking(uuid, timestamptz, timestamptz, uuid, text) to service_role;
