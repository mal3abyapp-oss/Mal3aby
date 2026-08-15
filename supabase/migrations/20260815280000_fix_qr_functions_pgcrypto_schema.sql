-- Fix: ensure_booking_qr / qr_validate / qr_confirm_checkin call
-- gen_random_bytes()/digest() (pgcrypto), but pgcrypto is installed in the
-- `extensions` schema on this project while these functions pin
-- `search_path = public, pg_temp` (per RLS_SECURITY.md's mandatory pinned
-- search_path rule). Unqualified calls failed with
-- "function gen_random_bytes(integer) does not exist". Schema-qualify the
-- calls instead of widening search_path (widening search_path would
-- reintroduce the exact hijacking risk the pinned-search_path rule exists
-- to prevent).

create or replace function public.ensure_booking_qr(p_booking_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_status text;
  v_raw_token text;
  v_token_hash text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, status into v_club_id, v_status from public.bookings where id = p_booking_id;
  if v_club_id is null then
    raise exception 'booking not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('booking.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if v_status in ('cancelled', 'no_show') then
    raise exception 'cannot generate a QR for a cancelled or no-show booking';
  end if;

  update public.qr_credentials
  set status = 'revoked'
  where type = 'booking' and reference_id = p_booking_id and status = 'active';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.qr_credentials (club_id, type, reference_id, token_hash, status, single_use, expires_at, created_by)
  values (v_club_id, 'booking', p_booking_id, v_token_hash, 'active', true, (select end_at from public.bookings where id = p_booking_id) + interval '2 hours', auth.uid());

  return v_raw_token;
end;
$$;

create or replace function public.qr_validate(p_token text)
returns table(
  result text,
  credential_id uuid,
  reference_type text,
  reference_id uuid,
  club_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_cred record;
  v_result text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'validate', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.scan', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid, null::text, null::uuid, null::uuid;
    return;
  end if;

  if v_cred.status = 'consumed' then
    v_result := 'already_used';
  elsif v_cred.status = 'revoked' then
    v_result := 'invalid';
  elsif v_cred.expires_at is not null and v_cred.expires_at < now() then
    v_result := 'expired';
  else
    v_result := 'success';
  end if;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', v_result, v_cred.type, v_cred.reference_id);

  return query select v_result, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id;
end;
$$;

create or replace function public.qr_confirm_checkin(p_token text)
returns table(result text, booking_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_cred record;
  v_booking record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash for update;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'check_in', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.type != 'booking' then
    raise exception 'not a booking credential';
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.checkin.confirm', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if v_cred.status = 'consumed' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'already_used', v_cred.type, v_cred.reference_id);
    return query select 'already_used'::text, v_cred.reference_id;
    return;
  end if;

  if v_cred.status = 'revoked' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'expired', v_cred.type, v_cred.reference_id);
    return query select 'expired'::text, null::uuid;
    return;
  end if;

  select * into v_booking from public.bookings where id = v_cred.reference_id for update;

  if v_booking.id is null or v_booking.status not in ('pending_payment', 'confirmed') then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
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

  return query select 'success'::text, v_booking.id;
end;
$$;
