-- Integration regression for request_public_booking_links_by_phone(): fixture
-- and notification queue writes are rolled back. Run against a database with
-- existing club/customer/field fixtures after the migration.
begin;
do $$
declare
  b record; test_id_1 uuid; test_id_2 uuid;
  event_count_1 bigint; event_count_2 bigint;
  cred_before bigint; cred_after bigint;
begin
  select bk.*, cu.phone_e164 into b from public.bookings bk
    join public.customers cu on cu.id=bk.customer_id and cu.club_id=bk.club_id
    where cu.phone_e164 is not null and cu.duplicate_review_status='none' and bk.invoice_id is not null limit 1;
  if b.id is null then raise exception 'no fixture source'; end if;
  update public.clubs set public_booking_enabled=true,public_slug='qa-phone-recovery-transaction-only',status='active' where id=b.club_id;

  -- Two distinct active bookings for the SAME phone at this club -- the
  -- multi-booking-per-phone shape this entry point exists for.
  insert into public.bookings(club_id,branch_id,field_id,customer_id,start_at,end_at,status,total_price,discount_amount,source,hold_expires_at,invoice_id)
  values(b.club_id,b.branch_id,b.field_id,b.customer_id,'2099-12-01 10:00Z','2099-12-01 11:00Z','pending_payment',100,0,'club_public_link',now()+interval '1 hour',b.invoice_id)
  returning id into test_id_1;
  insert into public.bookings(club_id,branch_id,field_id,customer_id,start_at,end_at,status,total_price,discount_amount,source,hold_expires_at,invoice_id)
  values(b.club_id,b.branch_id,b.field_id,b.customer_id,'2099-12-02 10:00Z','2099-12-02 11:00Z','confirmed',150,0,'club_public_link',null,b.invoice_id)
  returning id into test_id_2;

  -- Wrong phone: no rows written for either booking, no event emitted.
  perform public.request_public_booking_links_by_phone('qa-phone-recovery-transaction-only','+19999999999');
  if exists(select 1 from public.booking_link_requests where booking_id in (test_id_1,test_id_2)) then
    raise exception 'wrong phone allowed';
  end if;

  -- Real phone: BOTH active bookings get a resend in one call.
  perform public.request_public_booking_links_by_phone('qa-phone-recovery-transaction-only',b.phone_e164);
  if not exists(select 1 from public.booking_link_requests where booking_id=test_id_1 and request_count=1) then
    raise exception 'first booking not resent';
  end if;
  if not exists(select 1 from public.booking_link_requests where booking_id=test_id_2 and request_count=1) then
    raise exception 'second booking not resent';
  end if;
  select count(*) into event_count_1 from public.notification_events where reference_id=test_id_1 and event_type='booking.link_requested';
  select count(*) into event_count_2 from public.notification_events where reference_id=test_id_2 and event_type='booking.link_requested';
  if event_count_1 <> 1 or event_count_2 <> 1 then raise exception 'notification event count wrong'; end if;
  if exists(select 1 from public.notification_queue where event_id in(
      select id from public.notification_events where reference_id in (test_id_1,test_id_2)
    ) and recipient_customer_id is distinct from b.customer_id) then
    raise exception 'incorrect notification recipient';
  end if;

  -- Per-phone cooldown: a second call within 10 minutes must not re-mint
  -- credentials for either booking, even though neither booking's OWN
  -- per-booking cooldown would otherwise block a manual retry this fast.
  select count(*) into cred_before from public.qr_credentials where reference_id in (test_id_1,test_id_2);
  perform public.request_public_booking_links_by_phone('qa-phone-recovery-transaction-only',b.phone_e164);
  select count(*) into cred_after from public.qr_credentials where reference_id in (test_id_1,test_id_2);
  if cred_before <> cred_after then raise exception 'per-phone cooldown did not prevent duplicate credentials'; end if;

  -- Per-phone daily cap: force the phone's own window to look already-maxed,
  -- confirm a further call still resends nothing.
  update public.booking_phone_recovery_requests
    set last_requested_at=now()-interval '11 minutes', request_count=3
    where club_id=b.club_id and phone_e164=b.phone_e164;
  perform public.request_public_booking_links_by_phone('qa-phone-recovery-transaction-only',b.phone_e164);
  select count(*) into cred_after from public.qr_credentials where reference_id in (test_id_1,test_id_2);
  if cred_before <> cred_after then raise exception 'per-phone daily cap failed'; end if;
end $$;
select 'multi-booking phone match, wrong-phone rejection, notification recipients, per-phone cooldown and daily cap passed; all writes rolled back' as verification;
rollback;
