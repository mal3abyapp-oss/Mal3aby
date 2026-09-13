-- Durable booking access: the URL carries an opaque credential, all values come
-- from the database. No booking/customer identifiers accepted as authorization.
create or replace function public.get_public_booking_context(p_token text)
returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_cred public.qr_credentials%rowtype;
  v_booking public.bookings%rowtype;
  v_club public.clubs%rowtype;
  v_context jsonb;
begin
  if p_token is null or length(p_token) > 256 then return jsonb_build_object('result','invalid'); end if;
  select * into v_cred from public.qr_credentials
    where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex') and type = 'booking';
  if v_cred.id is null or v_cred.status = 'revoked' then return jsonb_build_object('result','invalid'); end if;
  if v_cred.expires_at is not null and v_cred.expires_at <= now() then return jsonb_build_object('result','expired'); end if;
  select * into v_booking from public.bookings where id = v_cred.reference_id and club_id = v_cred.club_id;
  if v_booking.id is null then return jsonb_build_object('result','invalid'); end if;
  select * into v_club from public.clubs where id = v_booking.club_id;
  select to_jsonb(r) into v_context from public.verify_booking_qr_public(p_token) r;
  return v_context || jsonb_build_object(
    'booking_id', v_booking.id, 'club_id', v_booking.club_id,
    'currency', v_club.currency, 'club_slug', v_club.public_slug,
    'club_phone', coalesce(v_club.primary_phone, v_club.whatsapp_number),
    'hold_expires_at', v_booking.hold_expires_at,
    'can_pay', v_booking.status in ('pending_payment','confirmed')
      and (v_booking.status <> 'pending_payment' or v_booking.hold_expires_at > now())
      and v_booking.invoice_id is not null,
    'can_check_in', v_cred.status = 'active' and v_booking.status = 'confirmed'
  );
end;
$$;
revoke all on function public.get_public_booking_context(text) from public;
grant execute on function public.get_public_booking_context(text) to anon, authenticated;

-- Internal throttle state: never readable/writable via the public Data API.
create table public.booking_link_requests (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  last_requested_at timestamptz not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1
);
alter table public.booking_link_requests enable row level security;
revoke all on public.booking_link_requests from public, anon, authenticated;
create index booking_link_requests_club_window on public.booking_link_requests(club_id, window_started_at);

-- A match NEVER returns data or credentials. Links only go to the existing,
-- consented customer destinations through the established notification queues.
-- Identical response for absent, quarantined, throttled and eligible bookings.
create or replace function public.request_public_booking_link(
  p_club_slug text, p_booking_ref text, p_phone_e164 text
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_booking record;
  v_request public.booking_link_requests%rowtype;
  v_token text;
  v_event uuid;
  v_variables jsonb;
  v_key text;
begin
  if length(p_club_slug) > 160 or p_booking_ref is null or upper(trim(p_booking_ref)) !~ '^MB-[A-F0-9]{8}$'
    or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then return; end if;
  select b.*, c.name as club_name, c.timezone, cu.full_name, f.name as field_name,
    f.sport, i.invoice_number into v_booking
  from public.bookings b
  join public.clubs c on c.id = b.club_id
  join public.customers cu on cu.id = b.customer_id and cu.club_id = b.club_id
  join public.fields f on f.id = b.field_id
  left join public.invoices i on i.id = b.invoice_id
  where lower(c.public_slug) = lower(trim(p_club_slug))
    and c.status = 'active' and c.public_booking_enabled
    and cu.phone_e164 = p_phone_e164 and cu.duplicate_review_status = 'none'
    and 'MB-' || upper(substring(b.id::text,1,8)) = upper(trim(p_booking_ref))
    and b.status in ('pending_payment','confirmed') and b.end_at > now()
  order by b.created_at desc limit 1;
  if v_booking.id is null then return; end if;
  -- Serialize per club to keep both limits correct under concurrent requests.
  perform pg_advisory_xact_lock(hashtextextended('booking-link:' || v_booking.club_id::text, 0));
  select * into v_request from public.booking_link_requests where booking_id = v_booking.id;
  if v_request.last_requested_at > now() - interval '10 minutes' then return; end if;
  if v_request.window_started_at > now() - interval '24 hours' and v_request.request_count >= 3 then return; end if;
  if (select coalesce(sum(request_count),0) from public.booking_link_requests
      where club_id = v_booking.club_id and window_started_at > now() - interval '24 hours') >= 100 then return; end if;
  insert into public.booking_link_requests(booking_id,club_id,last_requested_at,window_started_at,request_count)
  values(v_booking.id,v_booking.club_id,now(),now(),1)
  on conflict(booking_id) do update set last_requested_at = now(),
    request_count = case when booking_link_requests.window_started_at > now() - interval '24 hours' then booking_link_requests.request_count + 1 else 1 end,
    window_started_at = case when booking_link_requests.window_started_at > now() - interval '24 hours' then booking_link_requests.window_started_at else now() end;
  v_token := public._mint_booking_qr_token_internal(v_booking.id,v_booking.club_id,v_booking.end_at + interval '2 hours',null);
  v_event := public.emit_notification_event(v_booking.club_id,'booking.link_requested','booking',v_booking.id,'{}'::jsonb);
  v_key := 'booking.link_requested:' || v_event::text;
  v_variables := jsonb_build_object('field_name',v_booking.field_name,'sport',v_booking.sport,
    'start_at',v_booking.start_at,'end_at',v_booking.end_at,'total_price',v_booking.total_price,
    'invoice_number',v_booking.invoice_number,'club_name',v_booking.club_name,'customer_name',v_booking.full_name,
    'timezone',v_booking.timezone,'booking_ref',upper(trim(p_booking_ref)),
    'booking_qr_token',v_token,'hold_expires_at',v_booking.hold_expires_at);
  perform public.queue_whatsapp_notification(v_booking.club_id,v_event,v_booking.customer_id,
    'booking-link','booking_confirmations',v_variables,'transactional',v_key);
  perform public.queue_email_notification(v_booking.club_id,v_event,v_booking.customer_id,
    'booking-link','booking_confirmations',v_variables,'transactional',v_key);
end;
$$;
revoke all on function public.request_public_booking_link(text,text,text) from public;
grant execute on function public.request_public_booking_link(text,text,text) to anon, authenticated;
