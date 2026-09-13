-- Independent security review of PR #35 (booking-recovery hardening,
-- 2026-09-13's request_public_booking_link): confirmed the function's
-- own doc comment ("A match NEVER returns data or credentials...
-- Identical response for absent, quarantined, throttled and eligible
-- bookings") slightly overstates what the code actually delivered.
-- Every branch already returns the exact same thing (void, no
-- exception, no data) -- verified true -- but a genuine "no such
-- booking/wrong phone" miss returned after a single indexed SELECT,
-- while any genuine match (throttled or not) went on to acquire
-- pg_advisory_xact_lock and run 1-2 additional SELECTs first. That is
-- a real, network-measurable timing difference distinguishing "this
-- (club_slug, booking_ref, phone) triple resolves to a live booking"
-- from "it does not" -- low severity (leaks only whether A booking
-- exists, never its content, phone, or any credential), but a
-- reviewer explicitly asked for the comment's own claim to hold, and
-- the fix is cheap and behavior-neutral.
--
-- Fix: on a genuine miss, perform an equivalent-shaped lock+read
-- against a fixed, reserved sentinel advisory-lock key and a
-- deliberately-nonexistent booking_id, so the no-match path pays
-- roughly the same lock-acquisition + row-lookup cost as a match path
-- before returning -- without ever touching the real
-- booking_link_requests rows or resolving any real booking. Every
-- externally observable output (still void, still no exception,
-- still no data, still no side effect for a genuine miss) is
-- unchanged; only the internal work shape is equalized.
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
  -- Fixed sentinel used only to shape a miss's timing to resemble a
  -- match's -- never a real booking_id, never written to any table.
  v_dummy_lock_key constant text := 'booking-link:no-match-sentinel';
begin
  if length(p_club_slug) > 160 or p_booking_ref is null or upper(trim(p_booking_ref)) !~ '^MB-[A-F0-9]{8}$'
    or p_phone_e164 is null or p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    perform pg_advisory_xact_lock(hashtextextended(v_dummy_lock_key, 0));
    perform 1 from public.booking_link_requests where booking_id = '00000000-0000-0000-0000-000000000000'::uuid;
    return;
  end if;
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
  if v_booking.id is null then
    -- Same shape of work as a real match's lock-acquire + row-lookup,
    -- against the fixed sentinel key/id -- never a real club, never a
    -- real booking, never a write.
    perform pg_advisory_xact_lock(hashtextextended(v_dummy_lock_key, 0));
    perform 1 from public.booking_link_requests where booking_id = '00000000-0000-0000-0000-000000000000'::uuid;
    return;
  end if;
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

comment on function public.request_public_booking_link(text,text,text) is 'A match NEVER returns data or credentials. Links only go to the existing, consented customer destinations through the established notification queues. Identical VOID response for absent, quarantined, throttled and eligible bookings -- and, as of 2026-09-14 (independent security review, PR #35), an equalized lock+read timing shape on every miss path (malformed input or no booking match) so a genuine miss cannot be distinguished from a throttled real match by response latency alone.';
