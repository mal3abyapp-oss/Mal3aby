-- Owner-reported gap (2026-09-14): a customer who never wrote down the
-- booking reference (MB-XXXXXXXX) -- and never saved the link, and never
-- gave an email -- had NO way back into request_public_booking_link(),
-- which requires the ref as a mandatory input. The only remaining paths
-- were "hope you gave an email" (portal claim) or "call the club and hope
-- staff can find you manually." This closes that gap with a phone-only
-- recovery path: request every active booking's link resend for a given
-- phone at a given club, with no reference number required at all.
--
-- Security posture matches request_public_booking_link() exactly and
-- deliberately: the response is ALWAYS void, no exception, no data,
-- regardless of whether the phone matches zero/one/many bookings, so a
-- caller can never use this to enumerate whether a given phone number has
-- ever booked at this club. Two independent rate limits apply: the
-- existing PER-BOOKING cooldown/cap (booking_link_requests, unchanged,
-- reused as-is) still bounds how often any single booking's link can be
-- resent, and a NEW PER-PHONE limit bounds how often this broader,
-- no-reference-required entry point itself can be invoked -- closing the
-- obvious abuse case of hammering one phone number to keep re-triggering
-- WhatsApp/email sends to its owner (a real annoyance/cost vector this
-- entry point uniquely opens, since it needs no correct secret at all
-- beyond a phone number itself).
create table public.booking_phone_recovery_requests (
  club_id uuid not null references public.clubs(id) on delete cascade,
  phone_e164 text not null,
  last_requested_at timestamptz not null,
  window_started_at timestamptz not null,
  request_count integer not null default 1,
  primary key (club_id, phone_e164)
);
alter table public.booking_phone_recovery_requests enable row level security;
revoke all on public.booking_phone_recovery_requests from public, anon, authenticated;
create index booking_phone_recovery_requests_club_window on public.booking_phone_recovery_requests(club_id, window_started_at);

create or replace function public.request_public_booking_links_by_phone(
  p_club_slug text, p_phone_e164 text
) returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_club record;
  v_phone_request public.booking_phone_recovery_requests%rowtype;
  v_booking record;
  v_request public.booking_link_requests%rowtype;
  v_token text;
  v_event uuid;
  v_variables jsonb;
  v_key text;
  v_sent_count integer := 0;
  -- Bounds how many distinct bookings a single phone-only recovery call
  -- can ever resend links for -- a real customer rarely has more than a
  -- couple of live bookings at one club; this is a hard ceiling against
  -- an unusually large match set turning one call into a large fan-out
  -- of notification sends, independent of the per-phone rate limit below.
  v_max_bookings_per_call constant integer := 5;
begin
  if length(p_club_slug) > 160 or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    -- Timing parity with every other branch below (2026-09-14 review
    -- discipline, same reasoning as request_public_booking_link's own
    -- sentinel-key branch): malformed input still pays the same
    -- lock-acquire + read cost a real phone lookup would.
    perform pg_advisory_xact_lock(hashtextextended('booking-phone-recovery:no-match-sentinel', 0));
    perform 1 from public.booking_phone_recovery_requests where club_id = '00000000-0000-0000-0000-000000000000'::uuid;
    return;
  end if;

  select id into v_club from public.clubs
  where lower(public_slug) = lower(trim(p_club_slug)) and status = 'active' and public_booking_enabled;
  if v_club.id is null then
    perform pg_advisory_xact_lock(hashtextextended('booking-phone-recovery:no-match-sentinel', 0));
    perform 1 from public.booking_phone_recovery_requests where club_id = '00000000-0000-0000-0000-000000000000'::uuid;
    return;
  end if;

  -- Per-phone throttle, serialized per (club, phone) -- independent of,
  -- and in addition to, the per-booking limits applied below for each
  -- individual booking this phone turns out to match.
  perform pg_advisory_xact_lock(hashtextextended('booking-phone-recovery:' || v_club.id::text || ':' || p_phone_e164, 0));
  select * into v_phone_request from public.booking_phone_recovery_requests
    where club_id = v_club.id and phone_e164 = p_phone_e164;
  if v_phone_request.last_requested_at > now() - interval '10 minutes' then return; end if;
  if v_phone_request.window_started_at > now() - interval '24 hours' and v_phone_request.request_count >= 3 then return; end if;
  if (select coalesce(sum(request_count),0) from public.booking_phone_recovery_requests
      where club_id = v_club.id and window_started_at > now() - interval '24 hours') >= 100 then return; end if;
  insert into public.booking_phone_recovery_requests(club_id,phone_e164,last_requested_at,window_started_at,request_count)
  values(v_club.id,p_phone_e164,now(),now(),1)
  on conflict(club_id,phone_e164) do update set last_requested_at = now(),
    request_count = case when booking_phone_recovery_requests.window_started_at > now() - interval '24 hours' then booking_phone_recovery_requests.request_count + 1 else 1 end,
    window_started_at = case when booking_phone_recovery_requests.window_started_at > now() - interval '24 hours' then booking_phone_recovery_requests.window_started_at else now() end;

  -- Every currently-active booking (pending payment or confirmed, not yet
  -- ended) for this exact canonical phone identity at this club -- same
  -- customer/consent/duplicate-review scoping as request_public_booking_link.
  for v_booking in
    select b.*, c.name as club_name, c.timezone, cu.full_name, cu.id as customer_id,
      f.name as field_name, f.sport, i.invoice_number
    from public.bookings b
    join public.clubs c on c.id = b.club_id
    join public.customers cu on cu.id = b.customer_id and cu.club_id = b.club_id
    join public.fields f on f.id = b.field_id
    left join public.invoices i on i.id = b.invoice_id
    where b.club_id = v_club.id
      and cu.phone_e164 = p_phone_e164 and cu.duplicate_review_status = 'none'
      and b.status in ('pending_payment','confirmed') and b.end_at > now()
    order by b.start_at asc
    limit v_max_bookings_per_call
  loop
    -- Same per-booking cooldown/cap discipline as request_public_booking_link,
    -- reusing the identical table -- a booking already resent recently via
    -- either entry point is still correctly throttled here.
    perform pg_advisory_xact_lock(hashtextextended('booking-link:' || v_booking.club_id::text, 0));
    select * into v_request from public.booking_link_requests where booking_id = v_booking.id;
    if v_request.last_requested_at > now() - interval '10 minutes' then continue; end if;
    if v_request.window_started_at > now() - interval '24 hours' and v_request.request_count >= 3 then continue; end if;
    if (select coalesce(sum(request_count),0) from public.booking_link_requests
        where club_id = v_booking.club_id and window_started_at > now() - interval '24 hours') >= 100 then continue; end if;
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
      'timezone',v_booking.timezone,'booking_ref','MB-' || upper(substring(v_booking.id::text,1,8)),
      'booking_qr_token',v_token,'hold_expires_at',v_booking.hold_expires_at);
    perform public.queue_whatsapp_notification(v_booking.club_id,v_event,v_booking.customer_id,
      'booking-link','booking_confirmations',v_variables,'transactional',v_key);
    perform public.queue_email_notification(v_booking.club_id,v_event,v_booking.customer_id,
      'booking-link','booking_confirmations',v_variables,'transactional',v_key);
    v_sent_count := v_sent_count + 1;
  end loop;
  -- v_sent_count is intentionally never returned or exposed -- the
  -- function's return type stays void regardless of 0, 1, or several
  -- bookings matched, preserving the same enumeration-safety guarantee
  -- as request_public_booking_link.
end;
$$;
revoke all on function public.request_public_booking_links_by_phone(text,text) from public;
grant execute on function public.request_public_booking_links_by_phone(text,text) to anon, authenticated;

comment on function public.request_public_booking_links_by_phone(text,text) is 'Phone-only booking recovery (2026-09-14, owner-reported gap: a customer with no booking reference number and no saved link had no way back in). Resends the link/QR for EVERY currently-active booking matching this phone at this club (capped at 5 per call) through the existing WhatsApp/email notification queues -- never returns which bookings matched or how many. Always void, same as request_public_booking_link, so this can never be used to learn whether a phone number has ever booked at this club. Independently rate-limited per (club, phone) in addition to each matched booking''s own existing per-booking cooldown/cap.';
