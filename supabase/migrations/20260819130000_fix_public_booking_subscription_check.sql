-- Real bug found via live adversarial testing (directive methodology:
-- REPRODUCE -> COLLECT EVIDENCE -> ISOLATE LAYER -> ROOT CAUSE -> FIX):
-- create_public_booking() called club_write_allowed(), which internally
-- calls get_club_platform_access(), which starts with:
--   if not (is_platform_owner() or p_club_id in (select user_club_ids()))
--     then return 'blocked';
-- Both is_platform_owner() and user_club_ids() key off auth.uid(),
-- which is NULL for an anonymous public-booking caller -- so
-- get_club_platform_access() returned 'blocked' UNCONDITIONALLY for
-- every anon call, regardless of the club's actual subscription
-- state. Reproduced live: an anon call against a club with a
-- genuinely active trial (ends 2026-08-22, tested on 2026-08-19) was
-- rejected with "this club is not currently accepting new bookings".
--
-- Fix: a new, narrower access check specifically for the public
-- booking path -- the SAME subscription-state logic
-- get_club_platform_access() uses (status not suspended/closed,
-- subscription full or within grace), but WITHOUT the
-- membership/platform-owner gate, since that gate's entire purpose
-- (limit which STAFF member can act on which club) doesn't apply to
-- an anonymous customer-facing booking at all -- the real access
-- control for the public path is already public_booking_enabled +
-- status='active', enforced separately in create_public_booking()'s
-- own club-resolution query.
create or replace function public.get_public_club_subscription_access(p_club_id uuid)
returns text
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_status text;
  v_sub record;
begin
  select status into v_club_status from public.clubs where id = p_club_id;
  if v_club_status is null or v_club_status in ('suspended', 'closed') then
    return 'blocked';
  end if;

  select * into v_sub from public.platform_subscriptions
    where club_id = p_club_id and lifecycle_status != 'cancelled'
    order by start_at desc limit 1;

  if v_sub is null then
    return 'blocked';
  elsif now() < v_sub.end_at then
    return 'full';
  elsif now() < v_sub.end_at + (v_sub.grace_period_days_snapshot || ' days')::interval then
    return 'grace';
  else
    return 'blocked';
  end if;
end;
$$;

revoke all on function public.get_public_club_subscription_access(uuid) from public, anon, authenticated;
grant execute on function public.get_public_club_subscription_access(uuid) to service_role;

comment on function public.get_public_club_subscription_access(uuid) is
  'Internal-only (service_role, called from within create_public_booking()) -- mirrors get_club_platform_access()''s subscription-state logic exactly (active/grace/blocked) but WITHOUT its membership/platform-owner gate, which does not apply to an anonymous public-booking caller. Root-cause fix for a real bug found via live testing: club_write_allowed()/get_club_platform_access() unconditionally returned ''blocked'' for any anon caller regardless of actual subscription state, since auth.uid() is null.';

create or replace function public.create_public_booking(
  p_club_slug text,
  p_field_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_customer_name text,
  p_customer_mobile text,
  p_notes text default null,
  p_source text default 'club_public_link'
)
returns table(booking_id uuid, booking_ref text)
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
  v_hours_row record;
  v_event_id uuid;
  v_club_name text;
  v_customer_id uuid;
  v_normalized_mobile text;
  v_booking_ref text;
  v_qr_token text;
  v_access text;
begin
  if p_source not in ('club_public_link', 'club_qr') then
    raise exception 'invalid booking source';
  end if;

  if p_customer_name is null or length(trim(p_customer_name)) = 0 then
    raise exception 'name is required';
  end if;

  v_normalized_mobile := public.normalize_mobile(p_customer_mobile);
  if v_normalized_mobile is null or not public.is_phone_plausible(v_normalized_mobile) then
    raise exception 'a valid phone number is required';
  end if;

  select c.id, c.name, c.timezone into v_club_id, v_club_name, v_timezone
    from public.clubs c
    join public.fields f on f.club_id = c.id
    where lower(c.public_slug) = lower(p_club_slug)
      and c.public_booking_enabled = true
      and c.status = 'active'
      and f.id = p_field_id
      and f.status = 'active';

  if v_club_id is null then
    raise exception 'this booking link is no longer available';
  end if;

  -- Fixed: was club_write_allowed(), which is unconditionally
  -- 'blocked' for an anon caller (see this migration's own header
  -- comment for the full root-cause account).
  v_access := public.get_public_club_subscription_access(v_club_id);
  if v_access = 'blocked' then
    raise exception 'this club is not currently accepting new bookings';
  end if;

  select * into v_field from public.fields where id = p_field_id;
  v_branch_id := v_field.branch_id;

  if p_end_at <= p_start_at then
    raise exception 'end time must be after start time';
  end if;

  if p_start_at <= now() then
    raise exception 'booking time must be in the future';
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

  v_price_per_hour := public.get_public_field_price(p_field_id, v_local_date, v_local_start_time, v_local_end_time);
  v_hours := extract(epoch from (p_end_at - p_start_at)) / 3600.0;
  v_total_price := round(v_price_per_hour * v_hours, 2);

  select id into v_customer_id
    from public.customers
    where club_id = v_club_id and normalized_mobile = v_normalized_mobile
    limit 1;

  if v_customer_id is null then
    insert into public.customers (club_id, full_name, mobile_display, normalized_mobile)
    values (v_club_id, trim(p_customer_name), p_customer_mobile, v_normalized_mobile)
    returning id into v_customer_id;
  end if;

  begin
    insert into public.bookings (
      club_id, branch_id, field_id, customer_id, start_at, end_at,
      status, total_price, discount_amount, notes, source, created_by
    ) values (
      v_club_id, v_branch_id, p_field_id, v_customer_id, p_start_at, p_end_at,
      'pending_payment', v_total_price, 0, p_notes, p_source, null
    ) returning id into v_booking_id;
  exception
    when exclusion_violation then
      raise exception 'this time slot was just booked by someone else -- please choose another time';
  end;

  perform public.write_audit_log(
    v_club_id, 'booking.create', 'booking', v_booking_id, null,
    jsonb_build_object('field_id', p_field_id, 'customer_id', v_customer_id, 'total_price', v_total_price, 'source', p_source),
    null
  );

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_customer_id, 'issued', v_total_price, 0, v_total_price, now(), null)
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'حجز ' || v_field.name, 'booking', v_booking_id, v_hours, v_price_per_hour, v_total_price);

  update public.bookings set invoice_id = v_invoice_id where id = v_booking_id;

  v_booking_ref := 'MB-' || upper(substring(v_booking_id::text, 1, 8));

  v_qr_token := public._mint_booking_qr_token_internal(v_booking_id, v_club_id, p_end_at + interval '2 hours', null);

  v_event_id := public.emit_notification_event(
    v_club_id, 'booking.created', 'booking', v_booking_id,
    jsonb_build_object('field_name', v_field.name, 'customer_id', v_customer_id, 'start_at', p_start_at, 'end_at', p_end_at, 'total_price', v_total_price, 'source', p_source)
  );

  perform public.queue_whatsapp_notification(
    v_club_id, v_event_id, v_customer_id, 'booking-created', 'booking_confirmations',
    jsonb_build_object(
      'field_name', v_field.name, 'sport', v_field.sport, 'start_at', p_start_at, 'end_at', p_end_at,
      'total_price', v_total_price, 'invoice_number', v_invoice_number, 'payment_status', 'unpaid',
      'club_name', v_club_name, 'customer_name', trim(p_customer_name), 'timezone', v_timezone, 'booking_ref', v_booking_ref,
      'booking_qr_token', v_qr_token
    ),
    'transactional', 'booking.created:' || v_booking_id::text,
    'image', 'booking_qr'
  );

  return query select v_booking_id, v_booking_ref;
end;
$$;

revoke all on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text) from public;
grant execute on function public.create_public_booking(text, uuid, timestamptz, timestamptz, text, text, text, text) to anon, authenticated;
