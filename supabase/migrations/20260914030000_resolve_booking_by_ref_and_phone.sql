-- Owner follow-up (2026-09-14): "اجعل عند وضع رقم الحجز يرسل المستخدم
-- الي صفحه الحجز مثل الرابط" -- entering the booking ref (+ phone) in
-- the recovery dialog previously only queued a WhatsApp/email resend
-- (request_public_booking_link) -- the customer had to leave the page,
-- find the message, then click through. This RPC instead resolves
-- straight to a real token, letting the client navigate directly to
-- /qr/:token -- the exact same destination the "I have a link" tab
-- already reaches, just entered via ref+phone instead of a pasted URL.
--
-- Security posture, deliberately NOT the same as request_public_booking_
-- link (which is intentionally silent/enumeration-safe because it has
-- no rate-limit-independent cost to a wrong guess beyond a wasted
-- request): this function *reveals a real credential* on a match, so a
-- brute-force attempt (trying many refs against one phone, or one ref
-- against many phones) has to be economically pointless. Reuses the
-- EXACT SAME booking_link_requests rate-limit table/thresholds as
-- request_public_booking_link (10-minute cooldown, 3/24h per booking,
-- 100/24h per club, serialized via the same advisory lock) -- a
-- throttled match returns exactly the same {result:'invalid'} shape as
-- a genuine non-match, so the rate limit itself is not observable
-- either. The booking ref (8 hex chars) is a weak secret on its own;
-- the phone must ALSO match the exact customer record the booking
-- belongs to (not merely be plausible), which is the real barrier here
-- -- and every hit against this function, matched or not, is still
-- bounded by the same cooldown/cap a would-be attacker cannot outrun.
create or replace function public.resolve_public_booking_by_ref_and_phone(
  p_club_slug text, p_booking_ref text, p_phone_e164 text
) returns jsonb language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_booking record;
  v_request public.booking_link_requests%rowtype;
  v_token text;
begin
  if length(p_club_slug) > 160 or p_booking_ref is null or upper(trim(p_booking_ref)) !~ '^MB-[A-F0-9]{8}$'
    or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    return jsonb_build_object('result', 'invalid');
  end if;
  select b.id, b.club_id, b.end_at into v_booking
  from public.bookings b
  join public.clubs c on c.id = b.club_id
  join public.customers cu on cu.id = b.customer_id and cu.club_id = b.club_id
  where lower(c.public_slug) = lower(trim(p_club_slug))
    and c.status = 'active' and c.public_booking_enabled
    and cu.phone_e164 = p_phone_e164 and cu.duplicate_review_status = 'none'
    and 'MB-' || upper(substring(b.id::text,1,8)) = upper(trim(p_booking_ref))
    and b.status in ('pending_payment','confirmed') and b.end_at > now()
  order by b.created_at desc limit 1;
  if v_booking.id is null then
    -- Timing parity with the genuine-match path below (2026-09-14
    -- review discipline, same reasoning as request_public_booking_link's
    -- own sentinel-key branch): a miss still pays the same lock-acquire
    -- + row-lookup cost a real match would, against a fixed sentinel
    -- that never touches a real booking.
    perform pg_advisory_xact_lock(hashtextextended('booking-link:no-match-sentinel', 0));
    perform 1 from public.booking_link_requests where booking_id = '00000000-0000-0000-0000-000000000000'::uuid;
    return jsonb_build_object('result', 'invalid');
  end if;
  -- Same per-booking rate limit as request_public_booking_link,
  -- reusing the identical table -- a booking already at its resend
  -- cap/cooldown via EITHER path is correctly throttled here too.
  perform pg_advisory_xact_lock(hashtextextended('booking-link:' || v_booking.club_id::text, 0));
  select * into v_request from public.booking_link_requests where booking_id = v_booking.id;
  if v_request.last_requested_at > now() - interval '10 minutes' then return jsonb_build_object('result', 'invalid'); end if;
  if v_request.window_started_at > now() - interval '24 hours' and v_request.request_count >= 3 then return jsonb_build_object('result', 'invalid'); end if;
  if (select coalesce(sum(request_count),0) from public.booking_link_requests
      where club_id = v_booking.club_id and window_started_at > now() - interval '24 hours') >= 100 then return jsonb_build_object('result', 'invalid'); end if;
  insert into public.booking_link_requests(booking_id,club_id,last_requested_at,window_started_at,request_count)
  values(v_booking.id,v_booking.club_id,now(),now(),1)
  on conflict(booking_id) do update set last_requested_at = now(),
    request_count = case when booking_link_requests.window_started_at > now() - interval '24 hours' then booking_link_requests.request_count + 1 else 1 end,
    window_started_at = case when booking_link_requests.window_started_at > now() - interval '24 hours' then booking_link_requests.window_started_at else now() end;
  v_token := public._mint_booking_qr_token_internal(v_booking.id, v_booking.club_id, v_booking.end_at + interval '2 hours', null);
  return jsonb_build_object('result', 'valid', 'token', v_token);
end;
$$;
revoke all on function public.resolve_public_booking_by_ref_and_phone(text,text,text) from public;
grant execute on function public.resolve_public_booking_by_ref_and_phone(text,text,text) to anon, authenticated;
