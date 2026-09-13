-- Integration regression: fixture and notification queue writes are rolled back.
-- Run against a database with existing club/customer/field fixtures after the migration.
begin;
do $$
declare b record; test_id uuid; ref text; before_count bigint; after_count bigint; event_count bigint;
begin
  select bk.*, cu.phone_e164 into b from public.bookings bk
    join public.customers cu on cu.id=bk.customer_id and cu.club_id=bk.club_id
    where cu.phone_e164 is not null and cu.duplicate_review_status='none' and bk.invoice_id is not null limit 1;
  if b.id is null then raise exception 'no fixture source'; end if;
  update public.clubs set public_booking_enabled=true,public_slug='qa-recovery-transaction-only',status='active' where id=b.club_id;
  insert into public.bookings(club_id,branch_id,field_id,customer_id,start_at,end_at,status,total_price,discount_amount,source,hold_expires_at,invoice_id)
  values(b.club_id,b.branch_id,b.field_id,b.customer_id,'2099-12-01 10:00Z','2099-12-01 11:00Z','pending_payment',100,0,'club_public_link',now()+interval '1 hour',b.invoice_id)
  returning id into test_id;
  ref := 'MB-' || upper(substring(test_id::text,1,8));
  perform public.request_public_booking_link('qa-recovery-transaction-only',ref,'+19999999999');
  if exists(select 1 from public.booking_link_requests where booking_id=test_id) then raise exception 'wrong phone allowed'; end if;
  perform public.request_public_booking_link('qa-recovery-transaction-only',ref,b.phone_e164);
  if not exists(select 1 from public.booking_link_requests where booking_id=test_id and request_count=1) then raise exception 'matching request failed'; end if;
  select count(*) into before_count from public.qr_credentials where reference_id=test_id;
  perform public.request_public_booking_link('qa-recovery-transaction-only',ref,b.phone_e164);
  select count(*) into after_count from public.qr_credentials where reference_id=test_id;
  if before_count <> after_count then raise exception 'cooldown did not prevent duplicate credential'; end if;
  select count(*) into event_count from public.notification_events where reference_id=test_id and event_type='booking.link_requested';
  if event_count <> 1 then raise exception 'recovery event duplication'; end if;
  if exists(select 1 from public.notification_queue where event_id in(select id from public.notification_events where reference_id=test_id) and recipient_customer_id is distinct from b.customer_id) then raise exception 'incorrect notification recipient'; end if;
  update public.booking_link_requests set last_requested_at=now()-interval '11 minutes',request_count=3 where booking_id=test_id;
  perform public.request_public_booking_link('qa-recovery-transaction-only',ref,b.phone_e164);
  select count(*) into after_count from public.qr_credentials where reference_id=test_id;
  if before_count <> after_count then raise exception 'daily cap failed'; end if;
end $$;
select 'matched recovery, wrong-phone rejection, notification recipient, cooldown and daily cap passed; all writes rolled back' as verification;
rollback;
