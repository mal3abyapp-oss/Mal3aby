-- P0 SECURITY/FINANCIAL HOTFIX (2026-08-23): CHECK-IN FINANCIAL
-- ELIGIBILITY GAP.
--
-- INCIDENT: a real production booking (150 EGP total, 0 paid, 150
-- outstanding, status pending_payment) was physically scanned and
-- accepted for check-in -- Booking Details then showed "checked in"
-- despite the full amount being outstanding. Confirmed live: booking
-- 018f5d7d-6fdd-4983-817e-d02c153294b3 (club b9178c0f-...) is a real
-- affected record, plus two further historical affected bookings
-- found platform-wide via read-only audit (be3598d6-... and
-- 996213ea-...) -- see this migration's own audit query below,
-- reproduced at deploy time, not modified by this migration.
--
-- ROOT CAUSE: qr_confirm_checkin() (and qr_validate() before it)
-- treated QR CREDENTIAL VALIDITY as equivalent to CHECK-IN
-- ELIGIBILITY. Both functions only checked credential status
-- (consumed/revoked/expired) and booking.status (cancelled/no_show
-- excluded, but 'pending_payment' and 'confirmed' were BOTH accepted
-- as eligible) -- there was no financial lookup anywhere in either
-- function. A booking sits in 'pending_payment' status for its
-- entire unpaid lifetime by design (_create_booking_internal), so
-- this is not an edge case -- it is the default state of every
-- unpaid booking with a minted QR.
--
-- FIX: both functions now compute financial eligibility from the
-- canonical Finance source -- get_invoice_payment_summary(), the
-- same function already used by Customer 360 / booking detail
-- outstanding-balance displays -- never a payment_status string
-- comparison, never anything read from the QR payload itself (the QR
-- never carried payment data to begin with, so no QR
-- reissue/migration is needed here; the credential lifecycle is
-- completely unchanged).
--
-- Default-safe rule (no club policy currently exists for pay-at-
-- venue/cash-on-arrival -- confirmed via schema audit: no
-- require_payment_before_checkin-equivalent column exists anywhere
-- in clubs/branches/fields): amount_due > 0 ALWAYS denies check-in.
-- Zero-total bookings (free/fully-discounted) remain eligible, since
-- their outstanding is genuinely 0. A booking with no invoice_id at
-- all (should not happen post-_create_booking_internal, but the
-- column is nullable) is treated as NOT financially eligible --
-- fail closed, never fail open on missing data.
--
-- No manager-override mechanism is added -- no proven business
-- requirement for pay-at-venue exists in this codebase today
-- (confirmed via audit: record_payment/queue_whatsapp_notification/
-- club settings show no such policy anywhere). If that need is
-- proven later, add an explicit, audited, role-gated override RPC
-- then -- do not invent one speculatively now.
--
-- qr_scan_events.result carries a CHECK constraint enumerating known
-- outcome values -- 'payment_required' (the new distinct outcome
-- this hotfix introduces, directive rule 22: never collapsed into
-- 'invalid') must be added to it before either function below can
-- ever insert that result, or every denied scan attempt would itself
-- raise a constraint-violation error instead of cleanly denying.

alter table public.qr_scan_events drop constraint qr_scan_events_result_check;
alter table public.qr_scan_events add constraint qr_scan_events_result_check
  check (result = any (array['success'::text, 'already_used'::text, 'expired'::text, 'invalid'::text, 'wrong_club'::text, 'permission_denied'::text, 'subscription_inactive'::text, 'payment_required'::text]));

-- ============================================================
-- READ-ONLY AUDIT (run once at migration time, logged via RAISE
-- NOTICE, changes nothing) -- confirms exactly which historical
-- bookings were affected before the fix below takes effect. This
-- migration does NOT touch these rows; they are left for controlled
-- business review per the incident's own handling rules.
-- ============================================================
do $$
declare
  v_row record;
  v_count int := 0;
begin
  for v_row in
    select b.id as booking_id, b.club_id, b.total_price, b.marked_at, s.outstanding, s.paid
    from public.bookings b
    join public.get_invoice_payment_summary(array[b.invoice_id]) s on true
    where b.status = 'checked_in' and s.outstanding > 0
  loop
    v_count := v_count + 1;
    raise notice 'AFFECTED BOOKING: id=%, club_id=%, total=%, outstanding=%, paid=%, marked_at=%',
      v_row.booking_id, v_row.club_id, v_row.total_price, v_row.outstanding, v_row.paid, v_row.marked_at;
  end loop;
  raise notice 'TOTAL AFFECTED BOOKINGS FOUND: %', v_count;
end $$;

-- ============================================================
-- qr_validate: add financial-eligibility awareness so the SCANNER UI
-- itself shows PAYMENT_REQUIRED at the validate step (before staff
-- ever taps "Confirm Check-in") -- not just a hard failure at
-- confirm time. This is UX, not the security boundary; the real
-- boundary is qr_confirm_checkin below.
-- ============================================================
create or replace function public.qr_validate(p_token text)
 returns table(result text, credential_id uuid, reference_type text, reference_id uuid, club_id uuid, display_name text, display_photo_url text, display_subtitle text, subscription_status text, diagnostic_code text, amount_due numeric)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_cred record;
  v_result text;
  v_diagnostic text;
  v_display_name text;
  v_display_photo_url text;
  v_display_subtitle text;
  v_subscription_status text;
  v_booking_status text;
  v_booking_invoice_id uuid;
  v_outstanding numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'validate', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'TOKEN_NOT_FOUND'::text, null::numeric;
    return;
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.scan', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'WRONG_TENANT'::text, null::numeric;
    return;
  end if;

  if v_cred.type = 'booking' then
    select status, invoice_id into v_booking_status, v_booking_invoice_id from public.bookings where id = v_cred.reference_id;
    if v_booking_status in ('cancelled', 'no_show') then
      insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
      values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'invalid', v_cred.type, v_cred.reference_id);
      return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'BOOKING_CANCELLED'::text, null::numeric;
      return;
    end if;

    -- CHECK-IN FINANCIAL ELIGIBILITY GATE (see this migration's own
    -- header comment). Canonical source only -- never a payment_status
    -- string, never QR payload data. A missing invoice fails closed.
    if v_booking_invoice_id is null then
      v_outstanding := null;
    else
      select s.outstanding into v_outstanding
      from public.get_invoice_payment_summary(array[v_booking_invoice_id]) s;
    end if;

    if v_outstanding is null or v_outstanding > 0.004 then
      insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
      values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'payment_required', v_cred.type, v_cred.reference_id);
      return query select 'payment_required'::text, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id,
        null::text, null::text, null::text, null::text, 'PAYMENT_REQUIRED'::text, coalesce(v_outstanding, 0::numeric);
      return;
    end if;
  end if;

  if v_cred.status = 'consumed' then
    v_result := 'already_used';
    v_diagnostic := 'TOKEN_CONSUMED';
  elsif v_cred.status = 'revoked' then
    v_result := 'invalid';
    v_diagnostic := 'TOKEN_REVOKED';
  elsif v_cred.expires_at is not null and v_cred.expires_at < now() then
    v_result := 'expired';
    v_diagnostic := 'TOKEN_EXPIRED';
  else
    v_result := 'success';
    v_diagnostic := 'SUCCESS';
  end if;

  if v_cred.type = 'booking' then
    select c.full_name,
           f.name || ' — ' || to_char(b.start_at at time zone cl.timezone, 'HH24:MI')
      into v_display_name, v_display_subtitle
    from public.bookings b
    join public.customers c on c.id = b.customer_id
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.id = v_cred.reference_id;
    v_display_photo_url := null;

  elsif v_cred.type = 'player_membership' then
    select p.full_name, p.photo_url,
           coalesce(g.name, 'بدون مجموعة'),
           s.status
      into v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status
    from public.players p
    left join public.enrollments e on e.player_id = p.id and e.status = 'active'
    left join public.groups g on g.id = e.group_id
    left join public.subscriptions s on s.enrollment_id = e.id
    where p.id = v_cred.reference_id;
  end if;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', v_result, v_cred.type, v_cred.reference_id);

  return query select v_result, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id,
    v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status, v_diagnostic, 0::numeric;
end;
$function$;

-- ============================================================
-- qr_confirm_checkin: the AUTHORITATIVE write path -- this is the
-- real security boundary. Re-checks financial eligibility at the
-- moment of the actual status-mutating write (directive rule 26/27
-- TOCTOU requirement: the row is already locked via
-- `for update` on both qr_credentials and bookings, so no separate
-- transaction/locking change is needed -- the existing lock scope
-- already covers this new check since it reads from the same locked
-- v_booking row's invoice_id, and payment_allocations/refunds are
-- read fresh inside this same transaction). A direct RPC call
-- bypassing the frontend entirely hits this same gate -- there is no
-- separate "trust the client" path.
-- ============================================================
create or replace function public.qr_confirm_checkin(p_token text)
 returns table(result text, booking_id uuid, diagnostic_code text)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_token_hash text;
  v_cred record;
  v_booking record;
  v_outstanding numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash for update;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'check_in', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, 'TOKEN_NOT_FOUND'::text;
    return;
  end if;

  if v_cred.type != 'booking' then
    raise exception 'not a booking credential';
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.checkin.confirm', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid, 'WRONG_TENANT'::text;
    return;
  end if;

  if v_cred.status = 'consumed' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'already_used', v_cred.type, v_cred.reference_id);
    return query select 'already_used'::text, null::uuid, 'TOKEN_CONSUMED'::text;
    return;
  end if;

  if v_cred.status = 'revoked' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid, 'TOKEN_REVOKED'::text;
    return;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'expired', v_cred.type, v_cred.reference_id);
    return query select 'expired'::text, null::uuid, 'TOKEN_EXPIRED'::text;
    return;
  end if;

  select * into v_booking from public.bookings where id = v_cred.reference_id for update;

  if v_booking.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid, 'TOKEN_NOT_FOUND'::text;
    return;
  end if;

  if v_booking.status in ('cancelled', 'no_show') then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid, 'BOOKING_CANCELLED'::text;
    return;
  end if;

  if v_booking.status = 'checked_in' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid, 'ALREADY_CHECKED_IN'::text;
    return;
  end if;

  if v_booking.status not in ('pending_payment', 'confirmed') then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid, 'BOOKING_NOT_ELIGIBLE'::text;
    return;
  end if;

  -- CHECK-IN FINANCIAL ELIGIBILITY GATE -- the actual security
  -- boundary. Re-reads the canonical Finance source fresh, inside
  -- this same transaction, with the booking row already locked
  -- above -- a concurrent payment/refund cannot race this decision
  -- (either it committed before this SELECT and is reflected, or it
  -- is blocked behind this transaction's lock and will see a
  -- consistent picture once it proceeds). Fail closed on a missing
  -- invoice.
  if v_booking.invoice_id is null then
    v_outstanding := null;
  else
    select s.outstanding into v_outstanding
    from public.get_invoice_payment_summary(array[v_booking.invoice_id]) s;
  end if;

  if v_outstanding is null or v_outstanding > 0.004 then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'payment_required', v_cred.type, v_cred.reference_id);
    return query select 'payment_required'::text, v_booking.id, 'PAYMENT_REQUIRED'::text;
    return;
  end if;

  update public.qr_credentials
  set status = 'consumed', used_at = now(), used_by = auth.uid()
  where id = v_cred.id;

  update public.bookings
  set status = 'checked_in', marked_by = auth.uid(), marked_at = now()
  where id = v_booking.id;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'success', v_cred.type, v_cred.reference_id);

  perform public.write_audit_log(v_cred.club_id, 'booking.check_in', 'booking', v_booking.id, jsonb_build_object('status', v_booking.status), jsonb_build_object('status', 'checked_in'), null);

  return query select 'success'::text, v_booking.id, 'SUCCESS'::text;
end;
$function$;
