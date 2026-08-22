-- QR CHECK-IN LIFECYCLE HARDENING (2026-08-23), directive item 9:
-- "replace generic internal failure diagnosis" -- qr_validate() and
-- qr_confirm_checkin() both collapsed several genuinely distinct
-- failure reasons into the single generic 'invalid' result (token not
-- found, token revoked, booking cancelled, booking in a non-eligible
-- status all read identically) -- correct for the CUSTOMER-facing
-- verify_booking_qr_public() page (which intentionally shows one
-- unified "not valid" state, per this directive's own rule not to
-- leak internal mechanics to customers), but wrong for the STAFF
-- scanner, which needs to know WHY a scan failed to actually act on
-- it (a revoked credential vs. a booking that was cancelled after the
-- QR was issued are operationally different situations).
--
-- Additive, backward-compatible fix: a new `diagnostic_code` output
-- column alongside the EXISTING `result` column -- every existing
-- `result` value (invalid/wrong_club/already_used/expired/success/
-- permission_denied) is completely unchanged, so ScanPage.tsx's
-- existing outcome-tone/label logic keeps working exactly as before
-- with zero changes required there. `diagnostic_code` is the new,
-- more specific signal a future staff-facing detail view can read
-- without changing any existing behavior today. Never exposed to the
-- public/customer-facing verify_booking_qr_public() (unchanged, still
-- returns only its existing unified states).
--
-- Codes: MALFORMED_QR (empty/malformed token before any DB lookup --
-- handled client-side, not server-side, since a client can detect an
-- empty decode result before ever calling this RPC; this migration
-- covers the codes a real DB lookup can distinguish), TOKEN_NOT_FOUND,
-- TOKEN_REVOKED, TOKEN_EXPIRED, TOKEN_CONSUMED, BOOKING_CANCELLED,
-- BOOKING_NOT_ELIGIBLE, WRONG_TENANT, WRONG_REFERENCE_TYPE (n/a for
-- qr_confirm_checkin, which already hard-rejects a non-booking
-- credential type before reaching any of these branches),
-- ALREADY_CHECKED_IN, SUCCESS.
drop function if exists public.qr_validate(text);

create function public.qr_validate(p_token text)
returns table(
  result text,
  credential_id uuid,
  reference_type text,
  reference_id uuid,
  club_id uuid,
  display_name text,
  display_photo_url text,
  display_subtitle text,
  subscription_status text,
  diagnostic_code text
)
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
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'validate', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'TOKEN_NOT_FOUND'::text;
    return;
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.scan', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'WRONG_TENANT'::text;
    return;
  end if;

  -- Directive rule 3: a booking-type credential for a cancelled/no-show
  -- booking is treated as invalid regardless of its own stored status
  -- -- cancel_booking() also actively revokes the row (see below), so
  -- this is a defense-in-depth check for any credential minted before
  -- that revocation logic existed, or any future code path that
  -- forgets to revoke explicitly.
  if v_cred.type = 'booking' then
    select status into v_booking_status from public.bookings where id = v_cred.reference_id;
    if v_booking_status in ('cancelled', 'no_show') then
      insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
      values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'invalid', v_cred.type, v_cred.reference_id);
      return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'BOOKING_CANCELLED'::text;
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
    v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status, v_diagnostic;
end;
$function$;

-- Lesson learned earlier in this engagement (migration 20260822100000)
-- -- and confirmed AGAIN here, more precisely, while applying this
-- exact migration live: a fresh CREATE auto-grants EXECUTE to anon
-- and authenticated DIRECTLY (not merely via inherited PUBLIC
-- membership, as the earlier migration's comment assumed) -- verified
-- live via information_schema.routine_privileges immediately after
-- applying this migration's first version, which included `REVOKE ALL
-- ... FROM PUBLIC` but NOT an explicit `REVOKE ... FROM anon`, and
-- anon still showed up with EXECUTE regardless. Fixed by revoking
-- from anon explicitly too (in addition to PUBLIC, for defense in
-- depth against whichever mechanism actually grants it), restoring
-- the confirmed pre-existing grant set (authenticated + service_role
-- only, no anon, no bare PUBLIC) exactly. This function requires real
-- auth (raises if auth.uid() is null) so the anon exposure window
-- itself was low-severity here -- unlike the PII-leaking function in
-- migration 20260822100000 -- but the grant state itself was still
-- wrong and is now corrected. Going forward: after ANY DROP+CREATE
-- migration, always re-run information_schema.routine_privileges (or
-- the Security Advisor) and diff against the pre-migration grant set
-- explicitly -- do not assume a REVOKE FROM PUBLIC alone is
-- sufficient.
revoke all on function public.qr_validate(text) from public;
revoke all on function public.qr_validate(text) from anon;
grant execute on function public.qr_validate(text) to authenticated;
grant execute on function public.qr_validate(text) to service_role;

-- Same additive diagnostic_code fix for qr_confirm_checkin() -- the
-- real staff scan/check-in-consume RPC. 'invalid' today covers TOKEN_
-- NOT_FOUND, TOKEN_REVOKED, and a booking that isn't in an eligible
-- status (cancelled/no_show/already checked in via some other path) --
-- all genuinely distinct situations for a staff member trying to
-- understand why a scan didn't work. ALREADY_CHECKED_IN specifically
-- means the BOOKING's own status is already 'checked_in' (distinct
-- from TOKEN_CONSUMED, which means this particular credential was
-- already used -- a booking can reach checked_in via any one of its
-- valid credentials, so a second credential scan afterward is
-- correctly BOOKING_NOT_ELIGIBLE, not TOKEN_CONSUMED, since that
-- specific credential row itself is still 'active').
drop function if exists public.qr_confirm_checkin(text);

create function public.qr_confirm_checkin(p_token text)
returns table(result text, booking_id uuid, diagnostic_code text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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

revoke all on function public.qr_confirm_checkin(text) from public;
revoke all on function public.qr_confirm_checkin(text) from anon;
grant execute on function public.qr_confirm_checkin(text) to authenticated;
grant execute on function public.qr_confirm_checkin(text) to service_role;
