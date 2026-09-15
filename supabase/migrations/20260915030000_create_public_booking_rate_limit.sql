-- AUDIT ROUND 3 FINDING (2026-09-15): create_public_booking() -- the
-- anon-callable RPC backing the public booking flow -- has no rate
-- limiting at all. Unlike a same-slot double-booking attempt (already
-- structurally blocked by the EXCLUDE constraint + advisory lock a
-- prior migration added), a script varying field/time can create an
-- UNLIMITED number of DISTINCT real bookings + invoices, each of which
-- mints a real QR token, writes an audit log, and queues a real
-- outbound WhatsApp message + email via queue_whatsapp_notification()/
-- queue_email_notification() -- real notification spend, and a
-- concrete harassment vector if someone else's real phone number is
-- supplied as p_customer_mobile (every such booking sends that number
-- an unsolicited WhatsApp booking confirmation).
--
-- Fix: reuse check_rpc_rate_limit() (added this same day for
-- record_payment_proof_upload's restored anon grant), keyed per
-- (club_id, normalized_mobile) -- the earliest point in the function
-- where both are known, well before any write. Phone-keyed (not IP --
-- not reliably available inside a Postgres function reached via
-- PostgREST without fragile request-header extraction) directly
-- targets the actual harassment vector: it bounds how many bookings
-- any one phone number can be booked under per club, regardless of
-- which specific field/time is targeted. Generous threshold (10
-- bookings per phone per club per 10 minutes) since a legitimate
-- customer or a club's own front-desk staff occasionally booking on a
-- customer's behalf via the public link is a real, normal pattern this
-- must not block.
create or replace function public.create_public_booking(
  p_club_slug text,
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_customer_name text,
  p_customer_mobile text,
  p_customer_phone_e164 text,
  p_notes text default null,
  p_source text default 'club_public_link',
  p_customer_email text default null
)
returns table(booking_id uuid, booking_ref text, hold_expires_at timestamptz, total_price numeric, invoice_id uuid, invoice_number text, booking_qr_token text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid; v_branch_id uuid; v_field record; v_timezone text;
  v_local_date date; v_local_start_time time; v_local_end_time time;
  v_hours numeric; v_total_price numeric; v_effective_unit_price numeric;
  v_booking_id uuid; v_invoice_id uuid; v_invoice_number text; v_hours_row record;
  v_event_id uuid; v_club_name text; v_customer_id uuid; v_normalized_mobile text;
  v_booking_ref text; v_qr_token text; v_access text; v_is_new_customer boolean := false;
  v_policy record; v_today_local date; v_days_out int; v_hold_minutes int; v_hold_expires_at timestamptz;
  v_existing_name text; v_name_mismatch boolean := false; v_email text;
  v_rate_check record;
begin
  if p_source not in ('club_public_link', 'club_qr') then raise exception 'invalid booking source'; end if;
  if p_customer_name is null or length(trim(p_customer_name)) = 0 then raise exception 'name is required'; end if;
  v_normalized_mobile := public.normalize_mobile(p_customer_mobile);
  if v_normalized_mobile is null or not public.is_phone_plausible(v_normalized_mobile) then
    raise exception 'a valid phone number is required';
  end if;
  if p_customer_phone_e164 is null or p_customer_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid phone number';
  end if;
  v_email := nullif(trim(p_customer_email), '');
  select c.id, c.name, c.timezone into v_club_id, v_club_name, v_timezone
    from public.clubs c join public.fields f on f.club_id = c.id
    where lower(c.public_slug) = lower(p_club_slug) and c.public_booking_enabled = true and c.status = 'active'
      and f.id = p_field_id and f.status = 'active';
  if v_club_id is null then raise exception 'this booking link is no longer available'; end if;

  -- AUDIT ROUND 3: rate-limit keyed per (club, phone) now that both are
  -- known, before any further validation/write work.
  select * into v_rate_check from public.check_rpc_rate_limit('create_public_booking:' || v_club_id::text || ':' || v_normalized_mobile, 10, 600);
  if not v_rate_check.allowed then
    raise exception 'too many booking attempts for this phone number -- please wait a few minutes and try again';
  end if;

  if not public._fields_module_active(v_club_id) then raise exception 'this club is not currently accepting new bookings'; end if;
  v_access := public.get_public_club_subscription_access(v_club_id);
  if v_access = 'blocked' then raise exception 'this club is not currently accepting new bookings'; end if;
  select * into v_field from public.fields where id = p_field_id;
  v_branch_id := v_field.branch_id;
  if p_end_at <= p_start_at then raise exception 'end time must be after start time'; end if;
  if p_start_at <= now() then raise exception 'booking time must be in the future'; end if;

  select * into v_policy from public.get_public_club_booking_policy(v_club_id);
  v_today_local := (now() at time zone v_timezone)::date;
  v_local_date := (p_start_at at time zone v_timezone)::date;
  v_days_out := v_local_date - v_today_local;

  if v_days_out = 0 and not v_policy.same_day_online_booking_enabled then
    raise exception 'same-day online booking is not available for this club -- please contact the club directly to book today';
  end if;
  if v_days_out < v_policy.online_booking_start_offset_days then
    raise exception 'this date is not yet open for online booking';
  end if;
  if v_days_out > v_policy.online_booking_start_offset_days + v_policy.online_booking_window_days - 1 then
    raise exception 'this date is outside the online booking window';
  end if;

  v_local_start_time := (p_start_at at time zone v_timezone)::time;
  v_local_end_time := (p_end_at at time zone v_timezone)::time;
  if v_local_date <> ((p_end_at - interval '1 second') at time zone v_timezone)::date then
    raise exception 'a booking cannot span more than one calendar day';
  end if;
  select * into v_hours_row from public.resolve_field_operating_hours(p_field_id, v_local_date);
  if v_hours_row.has_any_config and v_hours_row.open_time is null then raise exception 'field is closed on this day'; end if;
  if v_hours_row.has_any_config and (v_local_start_time < v_hours_row.open_time or v_local_end_time > v_hours_row.close_time) then
    raise exception 'booking time is outside the field''s operating hours (% - %)', v_hours_row.open_time, v_hours_row.close_time;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('field:' || p_field_id::text, 0));

  if public._field_has_conflicting_training_session(p_field_id, p_start_at, p_end_at) then
    raise exception 'this field has an academy training session scheduled during this time';
  end if;

  if exists (select 1 from public.field_blocks where field_id = p_field_id
    and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')) then
    raise exception 'field is blocked during this time';
  end if;

  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  select coalesce(sum(s.segment_total), 0) into v_total_price
  from public.get_public_field_price_total(p_field_id, v_local_date, v_local_start_time, v_local_end_time) s;
  v_effective_unit_price := round(v_total_price / v_hours, 4);

  select id, full_name into v_customer_id, v_existing_name from public.customers
    where club_id = v_club_id and phone_e164 = p_customer_phone_e164
      and duplicate_review_status = 'none'
    order by created_at asc
    limit 1;
  if v_customer_id is null then
    insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, phone_e164, email)
    values (v_club_id, trim(p_customer_name), p_customer_mobile, v_normalized_mobile, p_customer_phone_e164, v_email)
    returning id into v_customer_id;
    v_is_new_customer := true;
  elsif lower(trim(v_existing_name)) is distinct from lower(trim(p_customer_name)) then
    v_name_mismatch := true;

    update public.customers
    set duplicate_review_status = 'quarantined_pending_review'
    where id = v_customer_id and duplicate_review_status = 'none';

    perform public.write_audit_log(
      v_club_id, 'customer.public_booking_name_mismatch', 'customer', v_customer_id,
      jsonb_build_object('full_name', v_existing_name),
      jsonb_build_object('submitted_name', trim(p_customer_name), 'phone_e164', p_customer_phone_e164),
      'public booking phone matched an existing customer but the submitted name differed -- flagged for duplicate review, WhatsApp consent re-confirmed as a fresh decision'
    );
  else
    update public.customers set full_name = trim(p_customer_name), email = coalesce(email, v_email), updated_at = now()
    where id = v_customer_id;
  end if;

  if v_is_new_customer or v_name_mismatch then
    insert into public.notification_consent (club_id, customer_id, channel, enabled, consent_source, consent_at, revoked_at, phone_display, normalized_phone, phone_e164)
    values (v_club_id, v_customer_id, 'whatsapp', true, 'public_booking_form', now(), null, p_customer_mobile, v_normalized_mobile, p_customer_phone_e164)
    on conflict (customer_id, channel) do update set
      enabled = true,
      consent_source = 'public_booking_form',
      consent_at = now(),
      revoked_at = null,
      phone_display = p_customer_mobile,
      normalized_phone = v_normalized_mobile,
      phone_e164 = p_customer_phone_e164,
      updated_at = now();
  end if;

  v_hold_minutes := v_policy.payment_hold_minutes;
  v_hold_expires_at := now() + make_interval(mins => v_hold_minutes);

  begin
    insert into public.bookings (club_id, branch_id, field_id, customer_id, start_at, end_at, status, total_price, discount_amount, notes, source, created_by, hold_expires_at)
    values (v_club_id, v_branch_id, p_field_id, v_customer_id, p_start_at, p_end_at, 'pending_payment', v_total_price, 0, p_notes, p_source, null, v_hold_expires_at)
    returning id into v_booking_id;
  exception when exclusion_violation then
    raise exception 'this time slot was just booked by someone else -- please choose another time';
  end;
  perform public.write_audit_log(v_club_id, 'booking.create', 'booking', v_booking_id, null,
    jsonb_build_object('field_id', p_field_id, 'customer_id', v_customer_id, 'total_price', v_total_price, 'source', p_source, 'hold_expires_at', v_hold_expires_at), null);
  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_customer_id, 'issued', v_total_price, 0, v_total_price, now(), null)
  returning id into v_invoice_id;
  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_effective_unit_price, v_total_price);
  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;
  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));
  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', null);
  v_event_id := public.emit_notification_event(v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', v_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price, 'source', p_source));
  perform public.queue_whatsapp_notification(v_club_id, v_event_id, v_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object('field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', trim(p_customer_name), 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at),
    'transactional', 'booking.created:' || v_booking_id::text);
  perform public.queue_email_notification(v_club_id, v_event_id, v_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object('field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', trim(p_customer_name), 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token, 'hold_expires_at', v_hold_expires_at, 'customer_email', v_email),
    'transactional', 'booking.created:' || v_booking_id::text);
  return query select v_booking_id, v_booking_ref, v_hold_expires_at, v_total_price, v_invoice_id, v_invoice_number, v_qr_token;
end;
$function$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) from public;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) to anon;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) to authenticated;

comment on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text, text) is
  'Anon-callable public booking creation. Rate-limited per (club_id, normalized_mobile) via check_rpc_rate_limit() as of 2026-09-15 (audit round 3) -- bounds unlimited real-booking/invoice creation and real outbound WhatsApp/email notification spend from a scripted caller, and directly bounds the harassment vector of supplying someone else''s real phone number. Same-slot double-booking remains separately blocked by the EXCLUDE constraint + advisory lock (unchanged, pre-existing fix).';
