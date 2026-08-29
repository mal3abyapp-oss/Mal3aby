-- SAAS ACCEPTANCE REVIEW -- lifecycle/expiry + cross-module audit
-- findings (2026-08-29). Two independent, live-reproduced bugs fixed
-- together since both are lifecycle/module-gate correctness gaps in
-- the booking/academy domain.

-- FINDING 1 (P1): qr_mark_attendance() trusted raw subscriptions.status
-- instead of a date-derived eligibility check. Live-reproduced: a
-- subscription with a real end_date 10 days in the past but
-- status still 'active' (the daily expiry cron, 17 3 * * *, hadn't
-- caught it yet) successfully checked in via QR -- a real attendance
-- row was committed for a lapsed subscription. Contrast: qr_validate()'s
-- club_membership branch already re-derives an effective end date from
-- freezes and compares to today, correctly downgrading expired
-- memberships -- the academy QR path never received the equivalent
-- fix. mark_attendance() (staff manual entry) is unaffected: it never
-- checks subscriptions at all, only enrollments.status.
--
-- Fix: replace the raw status check with the same freeze-aware
-- effective-end-date derivation used by get_subscription_effective_end_date()
-- (end_date + sum of freeze extensions with extends_expiry=true),
-- compared against the club's local today -- inlined here rather than
-- calling that function directly, since it additionally requires
-- subscription.view permission on the caller, which a scanning coach
-- legitimately holding only attendance.mark may not have; this is an
-- internal SECURITY DEFINER eligibility check, not a caller-facing
-- lookup, so it reads subscriptions/subscription_freezes directly.
create or replace function public.qr_mark_attendance(p_token text, p_session_id uuid)
 returns TABLE(result text, attendance_id uuid)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_cred record;
  v_session record;
  v_attendance_id uuid;
  v_enrollment_id uuid;
  v_subscription_id uuid;
  v_subscription_status text;
  v_effective_end_date date;
  v_club_timezone text;
  v_today date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'attendance_mark', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.type != 'player_membership' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select ts.*, g.coach_id as group_coach_id, g.assistant_coach_id as group_assistant_coach_id, g.branch_id as group_branch_id into v_session
  from public.training_sessions ts
  join public.groups g on g.id = ts.group_id
  where ts.id = p_session_id;

  if v_session.id is null or v_session.club_id != v_cred.club_id then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid;
    return;
  end if;

  if not (
    v_session.club_id in (select public.user_club_ids())
    and (
      public.has_permission('attendance.mark', v_session.club_id)
      or coalesce(v_session.group_coach_id = auth.uid(), false)
      or coalesce(v_session.group_assistant_coach_id = auth.uid(), false)
    )
  ) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if not public.user_has_branch_access(v_session.club_id, v_session.group_branch_id) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if not public._academy_module_active(v_session.club_id) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'module_inactive', v_cred.type, v_cred.reference_id);
    return query select 'module_inactive'::text, null::uuid;
    return;
  end if;

  select e.id into v_enrollment_id
  from public.enrollments e
  where e.player_id = v_cred.reference_id and e.group_id = v_session.group_id and e.status = 'active';

  if v_enrollment_id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select id, status into v_subscription_id, v_subscription_status
  from public.subscriptions
  where enrollment_id = v_enrollment_id
  order by created_at desc
  limit 1;

  select timezone into v_club_timezone from public.clubs where id = v_session.club_id;
  v_today := (now() at time zone coalesce(v_club_timezone, 'UTC'))::date;

  select s.end_date + coalesce(
    (select sum(f.end_date - f.start_date)::int from public.subscription_freezes f
     where f.subscription_id = v_subscription_id and f.extends_expiry = true),
    0
  ) into v_effective_end_date
  from public.subscriptions s
  where s.id = v_subscription_id;

  if v_subscription_status is distinct from 'active' or v_subscription_id is null
     or v_effective_end_date is null or v_effective_end_date < v_today then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'subscription_inactive', v_cred.type, v_cred.reference_id);
    return query select 'subscription_inactive'::text, null::uuid;
    return;
  end if;

  insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
  values (v_session.club_id, p_session_id, v_cred.reference_id, 'present', 'qr', auth.uid(), now())
  on conflict (session_id, player_id)
  do update set status = 'present', method = 'qr', marked_by = excluded.marked_by, marked_at = excluded.marked_at
  returning id into v_attendance_id;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'success', v_cred.type, v_cred.reference_id);

  return query select 'success'::text, v_attendance_id;
end;
$function$;

-- FINDING 2 (P1): reschedule_booking() had no Fields-module-active
-- gate. Live-reproduced: disabling the Fields module for a club, then
-- calling reschedule_booking() on an existing booking, succeeded --
-- moved the booking to a new field/time and repriced its invoice
-- while the club had no entitlement to use the Fields module at all.
-- Root cause: create_booking/create_recurring_booking are correctly
-- gated only because they delegate to _create_booking_internal, which
-- does check _fields_module_active() -- reschedule_booking is a
-- standalone implementation that never inherited the guard. Unlike
-- cancel_booking (a pure exit path, correctly ungated), reschedule
-- accepts a new field/time and is shaped like "create a booking"
-- wearing an "update" verb.
--
-- Fix: add the identical _fields_module_active() guard
-- _create_booking_internal already uses, placed right after the
-- existing row-lock + permission check.
create or replace function public.reschedule_booking(p_booking_id uuid, p_new_start_at timestamp with time zone, p_new_end_at timestamp with time zone, p_new_field_id uuid DEFAULT NULL::uuid, p_reason text DEFAULT NULL::text)
 returns TABLE(booking_id uuid, new_total_price numeric, price_changed boolean)
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
$function$;
