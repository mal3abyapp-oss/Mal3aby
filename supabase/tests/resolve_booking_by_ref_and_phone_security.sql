-- Integration regression for resolve_public_booking_by_ref_and_phone():
-- fixture and rate-limit writes are rolled back. Run against a database
-- with existing club/customer/field fixtures after the migration.
begin;
do $$
declare
  b record; test_id uuid; ref text;
  result jsonb; token_a text; token_b text;
begin
  select bk.*, cu.phone_e164 into b from public.bookings bk
    join public.customers cu on cu.id=bk.customer_id and cu.club_id=bk.club_id
    where cu.phone_e164 is not null and cu.duplicate_review_status='none' and bk.invoice_id is not null limit 1;
  if b.id is null then raise exception 'no fixture source'; end if;
  update public.clubs set public_booking_enabled=true,public_slug='qa-resolve-transaction-only',status='active' where id=b.club_id;
  insert into public.bookings(club_id,branch_id,field_id,customer_id,start_at,end_at,status,total_price,discount_amount,source,hold_expires_at,invoice_id)
  values(b.club_id,b.branch_id,b.field_id,b.customer_id,'2099-12-01 10:00Z','2099-12-01 11:00Z','pending_payment',100,0,'club_public_link',now()+interval '1 hour',b.invoice_id)
  returning id into test_id;
  ref := 'MB-' || upper(substring(test_id::text,1,8));

  -- Wrong phone: no token, no side effect.
  result := public.resolve_public_booking_by_ref_and_phone('qa-resolve-transaction-only', ref, '+19999999999');
  if result->>'result' <> 'invalid' or result ? 'token' then raise exception 'wrong phone leaked a token'; end if;
  if exists(select 1 from public.booking_link_requests where booking_id=test_id) then raise exception 'wrong phone wrote rate-limit state'; end if;

  -- Wrong ref (valid shape, no match): no token.
  result := public.resolve_public_booking_by_ref_and_phone('qa-resolve-transaction-only', 'MB-00000000', b.phone_e164);
  if result->>'result' <> 'invalid' or result ? 'token' then raise exception 'wrong ref leaked a token'; end if;

  -- Genuine match: real token returned, and it actually resolves via
  -- get_public_booking_context to the SAME booking (proves this isn't
  -- a bare opaque string but a real, functioning credential).
  result := public.resolve_public_booking_by_ref_and_phone('qa-resolve-transaction-only', ref, b.phone_e164);
  if result->>'result' <> 'valid' or not (result ? 'token') then raise exception 'matching request did not return a token'; end if;
  token_a := result->>'token';
  if (public.get_public_booking_context(token_a)->>'booking_id')::uuid <> test_id then
    raise exception 'returned token does not resolve to the requested booking';
  end if;
  if not exists(select 1 from public.booking_link_requests where booking_id=test_id and request_count=1) then
    raise exception 'rate-limit state not recorded on a real match';
  end if;

  -- Cooldown: an immediate second call for the SAME booking must not
  -- mint (and therefore not leak) a second token.
  result := public.resolve_public_booking_by_ref_and_phone('qa-resolve-transaction-only', ref, b.phone_e164);
  if result->>'result' <> 'invalid' or result ? 'token' then raise exception 'cooldown did not block a second resolve'; end if;

  -- Daily cap: force the window to already-maxed, confirm still blocked.
  update public.booking_link_requests set last_requested_at=now()-interval '11 minutes',request_count=3 where booking_id=test_id;
  result := public.resolve_public_booking_by_ref_and_phone('qa-resolve-transaction-only', ref, b.phone_e164);
  if result->>'result' <> 'invalid' or result ? 'token' then raise exception 'daily cap did not block a resolve'; end if;
end $$;
select 'matched resolve, wrong-phone/ref rejection (no leaked token), token actually resolves to the right booking, cooldown and daily cap passed; all writes rolled back' as verification;
rollback;
