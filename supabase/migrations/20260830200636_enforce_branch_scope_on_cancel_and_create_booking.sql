-- BOOKINGS/FIELDS PRODUCTION ACCEPTANCE, D6: branch-scoping asymmetry
-- found by direct code comparison. `reschedule_booking` already calls
-- `user_has_branch_access(v_club_id, v_branch_id)` (added in an
-- earlier session) -- but `_create_booking_internal` (backing
-- create_booking / create_recurring_booking / create_public_booking's
-- staff-facing sibling) and `cancel_booking` never gained the same
-- check. Both currently authorize purely at `has_permission(...,
-- v_club_id)` -- club-wide, no branch dimension -- so a staff member
-- whose membership is branch-restricted (a real, live-configurable
-- product feature via membership_branches / StaffPage.tsx) can
-- currently create a booking at, or cancel a booking belonging to,
-- ANY branch in their club, not just their assigned branch(es).
--
-- Not reproduced with a second real branch this session (the QA club
-- has exactly one branch), but confirmed unambiguously by reading the
-- live function bodies (pg_get_functiondef) side by side --
-- reschedule_booking has the check, these two do not, for the exact
-- same "who may act on this field's booking" question. This mirrors
-- ADR-015 (membership_branches: zero rows = all branches, one or more
-- = restricted to exactly those) and the already-hardened, 18-call-
-- site user_has_branch_access() helper (see
-- 20260829230000_fix_user_has_branch_access_multi_membership_leak.sql)
-- -- reusing that same helper here, not inventing new branch-scope
-- logic.
--
-- _create_booking_internal: v_branch_id is already resolved (via the
-- existing `select club_id, branch_id into v_club_id, v_branch_id
-- from public.fields where id = p_field_id`) -- the check slots in
-- immediately after that select, mirroring exactly where
-- reschedule_booking places its own check (right after resolving the
-- target field's branch). No other line changed.
--
-- cancel_booking: branch_id was not previously selected from
-- `bookings` at all -- added to the existing SELECT list (the
-- `bookings` table already has this column), then the same
-- user_has_branch_access check added right after the existing
-- club/permission gate. No other line changed.
create or replace function public._create_booking_internal(p_field_id uuid, p_customer_id uuid, p_start_at timestamp with time zone, p_end_at timestamp with time zone, p_discount_amount numeric, p_notes text, p_record_payment boolean, p_payment_method text, p_payment_amount numeric, p_booking_series_id uuid, p_receipt_serial text DEFAULT NULL::text, p_receipt_date date DEFAULT NULL::date, p_receipt_book text DEFAULT NULL::text, p_receipt_series text DEFAULT NULL::text, p_receipt_image_path text DEFAULT NULL::text, p_receipt_notes text DEFAULT NULL::text)
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
  v_customer_user_id uuid;
  v_activation_token text;
  v_activation_secret text;
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

  -- D6 FIX: club-level permission alone does not enforce branch scope
  -- -- a branch-restricted membership must not be able to create a
  -- booking at a branch outside its assignment. Same helper/pattern
  -- reschedule_booking already uses.
  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  if not public._fields_module_active(v_club_id) then
    raise exception 'the fields module is not active for this club';
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

  if p_discount_amount < 0 then
    raise exception 'discount amount cannot be negative';
  end if;

  if p_discount_amount > 0 then
    if not public.has_permission('booking.discount.apply', v_club_id) then
      raise exception 'not authorized to apply a discount';
    end if;
    if p_discount_amount > v_total_price * 0.3 and not public.has_permission('booking.discount.override', v_club_id) then
      raise exception 'discount exceeds the standard limit -- requires override permission';
    end if;
    if p_discount_amount > v_total_price then
      raise exception 'discount amount (%) cannot exceed the booking total (%)', p_discount_amount, v_total_price;
    end if;
  end if;

  if p_record_payment and p_payment_amount is not null and p_payment_amount > 0
     and p_payment_amount > (v_total_price - p_discount_amount) then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_payment_amount, (v_total_price - p_discount_amount);
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

  select name into v_club_name from public.clubs where id = v_club_id;
  select full_name, user_id into v_customer_name, v_customer_user_id from public.customers where id = p_customer_id;
  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));

  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', auth.uid());

  if v_customer_user_id is null then
    select raw_token, raw_secret into v_activation_token, v_activation_secret
    from public._mint_portal_invite_internal(
      v_club_id, p_customer_id, v_booking_id, now() + interval '48 hours', auth.uid()
    );
  end if;

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
        'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at,
        'activation_token', v_activation_token, 'activation_secret', v_activation_secret
      ),
      'transactional', 'booking.created:' || v_booking_id::text
    );
    perform public.queue_email_notification(
      v_club_id, v_event_id, p_customer_id, 'booking-created', 'booking_confirmations',
      jsonb_build_object(
        'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
        'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
        'club_name', v_club_name, 'customer_name', v_customer_name, 'timezone', v_timezone, 'booking_ref', v_booking_ref,
        'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at,
        'activation_token', v_activation_token
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
        'receipt_date', case when v_receipt_required then p_receipt_date else null end,
        'activation_token', v_activation_token, 'activation_secret', v_activation_secret
      ),
      'transactional', 'booking.confirmed_paid:' || v_booking_id::text
    );
    perform public.queue_email_notification(
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
        'receipt_date', case when v_receipt_required then p_receipt_date else null end,
        'activation_token', v_activation_token
      ),
      'transactional', 'booking.confirmed_paid:' || v_booking_id::text
    );
  end if;

  return v_booking_id;
end;
$function$;

create or replace function public.cancel_booking(p_booking_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
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

  select club_id, branch_id, customer_id, field_id, start_at, invoice_id
    into v_club_id, v_branch_id, v_customer_id, v_field_id, v_start_at, v_invoice_id
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.cancel', club_id);

  if v_club_id is null then
    raise exception 'booking not found or you do not have permission to cancel it';
  end if;

  -- D6 FIX: same branch-scope gap as _create_booking_internal above --
  -- club-level permission alone let a branch-restricted membership
  -- cancel a booking belonging to any branch in the club.
  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
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

-- Same D6 gap, same fix, in mark_booking_no_show (also lacked any
-- branch check, club-level permission only).
create or replace function public.mark_booking_no_show(p_booking_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_branch_id uuid;
begin
  select club_id, branch_id into v_club_id, v_branch_id
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id);

  if v_club_id is null then
    raise exception 'booking not found or you do not have permission to update it';
  end if;

  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  update public.bookings
  set status = 'no_show', marked_by = auth.uid(), marked_at = now(), notes = coalesce(notes || E'\n', '') || coalesce(p_reason, '')
  where id = p_booking_id and status in ('confirmed', 'checked_in');

  if not found then
    raise exception 'booking not found or not in a markable state';
  end if;

  perform public.write_audit_log(
    v_club_id, 'mark_booking_no_show', 'bookings', p_booking_id, null,
    jsonb_build_object('status', 'no_show'), p_reason
  );
end;
$function$;
