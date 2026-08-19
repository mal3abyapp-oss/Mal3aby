-- Wires create_public_booking() to the canonical E.164 pipeline
-- (directive section 21). The frontend now runs normalizePhone()
-- before calling this RPC and passes the resulting E.164 string as
-- p_customer_phone_e164 -- this RPC re-validates the FORMAT (not full
-- parsing) as a server-side backstop, matching the same lightweight
-- check used by the phone_e164 CHECK constraint, then stores it on the
-- customer row and uses it (not normalized_mobile) for tenant-scoped
-- duplicate lookup (directive section 29).
--
-- normalized_mobile/mobile_display continue to be written unchanged
-- for display/legacy-search compatibility -- this is additive, not a
-- replacement of the existing columns (directive section 65).
create or replace function public.create_public_booking(
  p_club_slug text,
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_customer_name text,
  p_customer_mobile text,
  p_customer_phone_e164 text,
  p_notes text default null,
  p_source text default 'club_public_link'
)
returns table(booking_id uuid, booking_ref text, hold_expires_at timestamptz, total_price numeric, invoice_id uuid, invoice_number text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid; v_branch_id uuid; v_field record; v_timezone text;
  v_local_date date; v_local_start_time time; v_local_end_time time;
  v_price_per_hour numeric; v_hours numeric; v_total_price numeric;
  v_booking_id uuid; v_invoice_id uuid; v_invoice_number text; v_hours_row record;
  v_event_id uuid; v_club_name text; v_customer_id uuid; v_normalized_mobile text;
  v_booking_ref text; v_qr_token text; v_access text; v_is_new_customer boolean := false;
  v_policy record; v_today_local date; v_days_out int; v_hold_minutes int; v_hold_expires_at timestamptz;
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
  select c.id, c.name, c.timezone into v_club_id, v_club_name, v_timezone
    from public.clubs c join public.fields f on f.club_id = c.id
    where lower(c.public_slug) = lower(p_club_slug) and c.public_booking_enabled = true and c.status = 'active'
      and f.id = p_field_id and f.status = 'active';
  if v_club_id is null then raise exception 'this booking link is no longer available'; end if;
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
  if exists (select 1 from public.field_blocks where field_id = p_field_id
    and tstzrange(start_at, end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')) then
    raise exception 'field is blocked during this time';
  end if;
  v_price_per_hour := public.get_public_field_price(p_field_id, v_local_date, v_local_start_time, v_local_end_time);
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

  -- Directive section 29: tenant-scoped dedupe on canonical phone_e164
  -- (not the legacy normalized_mobile, which cannot distinguish
  -- "01116505553" from "00201116505553" from "+201116505553").
  select id into v_customer_id from public.customers
    where club_id = v_club_id and phone_e164 = p_customer_phone_e164 limit 1;
  if v_customer_id is null then
    insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, phone_e164)
    values (v_club_id, trim(p_customer_name), p_customer_mobile, v_normalized_mobile, p_customer_phone_e164)
    returning id into v_customer_id;
    v_is_new_customer := true;
  end if;

  if v_is_new_customer then
    insert into public.notification_consent (club_id, customer_id, channel, enabled, consent_source, consent_at, phone_display, normalized_phone)
    values (v_club_id, v_customer_id, 'whatsapp', true, 'public_booking_form', now(), p_customer_mobile, v_normalized_mobile)
    on conflict (customer_id, channel) do nothing;
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
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price);
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
    'transactional', 'booking.created:' || v_booking_id::text, 'image', 'booking_qr');
  return query select v_booking_id, v_booking_ref, v_hold_expires_at, v_total_price, v_invoice_id, v_invoice_number;
end;
$function$;

drop function if exists public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text);

revoke all on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text) from public;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text, text) to anon, authenticated;
