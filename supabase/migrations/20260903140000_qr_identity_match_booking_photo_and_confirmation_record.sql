-- FIX M-9 (Secure QR / Identity Verification): "advisory-only, no system
-- record" gap. This project's own sourced design doc (quoted verbatim in
-- 20260816260000_qr_identity_verification_data.sql's header comment)
-- states the approval rule as: "Valid QR + Correct Account + Verified
-- Membership + Active Entitlement + Identity Match = Approved Check-in".
-- Identity Match is a required component of that rule, not optional. Two
-- concrete gaps existed against it:
--
--   (a) qr_validate()'s booking branch hardcoded display_photo_url := null
--       unconditionally, even though the customer's photo is already
--       reachable via the same bookings -> customers join already used
--       for display_name two lines above it -- so staff scanning a
--       booking QR (the primary revenue path -- Fields module) had
--       nothing to visually compare the presenting person against. The
--       club_membership branch a few lines below in this same function
--       already does this correctly (select c.photo_url alongside
--       c.full_name). A prior migration's comment rationalized the null
--       as "Doc 3 scopes verified-photo identity checks to academy
--       membership specifically" -- but Doc 3's own quoted rule above
--       does not carve out booking QRs, and nothing else in this
--       codebase implements or references such a carve-out; the
--       omission is the club membership branch's fix pattern never
--       having been applied to the booking branch it was clearly
--       copied from.
--
--   (b) Neither qr_confirm_checkin() nor qr_mark_attendance() required,
--       recorded, or verified that staff actually performed an identity
--       check -- "Identity Match" was purely a UI affordance (a photo
--       MAY have rendered) with zero persisted evidence it was ever
--       looked at. qr_scan_events already carries a comprehensive audit
--       trail for every scan action/result; it had no column at all for
--       this.
--
-- Fix (a): qr_validate's booking branch now also selects c.photo_url,
-- matching the existing club_membership branch's pattern exactly.
--
-- Fix (b): qr_scan_events gains a nullable identity_confirmed boolean
-- column (nullable/no default change to existing rows -- purely additive,
-- non-breaking for every historical row and every other insert site that
-- doesn't pass it). qr_confirm_checkin gains a new
-- p_identity_confirmed boolean default false parameter (safe default: an
-- old/unupdated caller that never passes it records identity_confirmed =
-- false rather than silently claiming a check happened) and persists it
-- onto the qr_scan_events row it writes for the check_in action, giving
-- this a queryable, per-check-in system record for the first time.
-- qr_mark_attendance (academy path) is intentionally NOT touched here --
-- out of scope for this fix, which targets the booking/Fields check-in
-- path M-9 called out specifically (booking QRs = "the primary revenue
-- path"); the academy path can receive the same treatment separately if
-- proven necessary.
--
-- Signature change note: qr_confirm_checkin's RETURNS TABLE is unchanged
-- (result, booking_id, diagnostic_code) but its parameter list changes
-- (new p_identity_confirmed), which is itself a signature change subject
-- to the same grant-reset behavior documented in
-- 20260824230500_regrant_staff_only_rpcs_after_signature_change.sql --
-- this migration re-applies the same REVOKE-from-public/anon,
-- GRANT-to-authenticated/service_role pattern for qr_confirm_checkin so
-- it does not regress back to an anon-visible grant.

alter table public.qr_scan_events
  add column if not exists identity_confirmed boolean;

comment on column public.qr_scan_events.identity_confirmed is
  'M-9 fix: whether staff explicitly attested (via the scanner UI''s photo-tap confirmation step) that they visually matched the presenting person against display_photo_url before this scan action completed. Null for historical rows predating this column and for actions where identity confirmation does not apply; true/false only meaningful on check_in action rows going forward.';

-- ============================================================
-- qr_validate: booking branch now also returns display_photo_url,
-- sourced from the same customers row already joined for display_name.
-- Every other branch/behavior in this function is unchanged, byte-for-
-- byte, from the live definition in
-- 20260826094515_club_membership_qr_fix_not_started_bypass.sql.
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
  v_membership record;
  v_today date;
  v_effective_end date;
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
    -- M-9 FIX: select the customer's photo alongside their name, exactly
    -- like the club_membership branch below already does. Booking QRs
    -- are the primary revenue path; identity match cannot be enforced
    -- against a photo that was never supplied to the scanner.
    select c.full_name, c.photo_url,
           f.name || ' — ' || to_char(b.start_at at time zone cl.timezone, 'HH24:MI')
      into v_display_name, v_display_photo_url, v_display_subtitle
    from public.bookings b
    join public.customers c on c.id = b.customer_id
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.id = v_cred.reference_id;

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

  elsif v_cred.type = 'club_membership' then
    if not public.has_permission('club_membership.verify', v_cred.club_id) then
      insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
      values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'permission_denied', v_cred.type, v_cred.reference_id);
      return query select 'permission_denied'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text, 'MEMBERSHIP_VERIFY_NOT_GRANTED'::text, null::numeric;
      return;
    end if;

    select s.id, s.status, s.start_date, s.end_date, s.branch_id, s.membership_number,
           s.plan_name_ar_snapshot, s.plan_name_en_snapshot
      into v_membership
    from public.club_membership_subscriptions s
    where s.customer_id = v_cred.reference_id and s.club_id = v_cred.club_id
    order by
      case s.status
        when 'active' then 1
        when 'frozen' then 2
        when 'scheduled' then 3
        when 'expired' then 4
        when 'cancelled' then 5
        else 6
      end,
      s.end_date desc
    limit 1;

    select c.full_name, c.photo_url into v_display_name, v_display_photo_url
    from public.customers c where c.id = v_cred.reference_id;

    if v_membership.id is null then
      v_subscription_status := 'NO_MEMBERSHIP';
      v_display_subtitle := null;
    else
      select (day_start at time zone (select timezone from public.clubs where id = v_cred.club_id))::date
        into v_today
        from public.club_local_day_bounds(v_cred.club_id, current_date);

      select v_membership.end_date + coalesce(
        (select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f
         where f.membership_subscription_id = v_membership.id),
        0
      ) into v_effective_end;

      v_subscription_status := case
        when v_membership.status = 'cancelled' then 'CANCELLED'
        when v_membership.status = 'frozen' then 'FROZEN'
        when coalesce(v_effective_end, v_membership.end_date) < v_today then 'EXPIRED'
        when v_membership.start_date > v_today then 'NOT_STARTED'
        when v_membership.status = 'pending_payment' then 'NOT_STARTED'
        else 'ACTIVE'
      end;

      v_display_subtitle := v_membership.plan_name_ar_snapshot || ' — ' || v_membership.membership_number;

      if v_subscription_status != 'ACTIVE' then
        v_result := 'invalid';
        v_diagnostic := 'MEMBERSHIP_' || v_subscription_status;
      end if;
    end if;
  end if;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', v_result, v_cred.type, v_cred.reference_id);

  return query select v_result, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id,
    v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status, v_diagnostic, 0::numeric;
end;
$function$;

-- ============================================================
-- qr_confirm_checkin: adds p_identity_confirmed boolean (default false
-- -- a caller that never updates to pass it records "not confirmed"
-- rather than silently claiming a check happened). Persists it onto the
-- qr_scan_events row for the action's outcome. Every existing check
-- (permission, credential status, booking status, financial eligibility)
-- is unchanged, byte-for-byte, from the live definition in
-- 20260823170000_checkin_financial_eligibility_hotfix.sql.
-- ============================================================
create or replace function public.qr_confirm_checkin(p_token text, p_identity_confirmed boolean default false)
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
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (null, null, auth.uid(), 'check_in', 'invalid', null, null, p_identity_confirmed);
    return query select 'invalid'::text, null::uuid, 'TOKEN_NOT_FOUND'::text;
    return;
  end if;

  if v_cred.type != 'booking' then
    raise exception 'not a booking credential';
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.checkin.confirm', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'permission_denied', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'permission_denied'::text, null::uuid, 'WRONG_TENANT'::text;
    return;
  end if;

  if v_cred.status = 'consumed' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'already_used', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'already_used'::text, null::uuid, 'TOKEN_CONSUMED'::text;
    return;
  end if;

  if v_cred.status = 'revoked' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'invalid'::text, null::uuid, 'TOKEN_REVOKED'::text;
    return;
  end if;

  if v_cred.expires_at is not null and v_cred.expires_at < now() then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'expired', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'expired'::text, null::uuid, 'TOKEN_EXPIRED'::text;
    return;
  end if;

  select * into v_booking from public.bookings where id = v_cred.reference_id for update;

  if v_booking.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'invalid'::text, null::uuid, 'TOKEN_NOT_FOUND'::text;
    return;
  end if;

  if v_booking.status in ('cancelled', 'no_show') then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'invalid'::text, null::uuid, 'BOOKING_CANCELLED'::text;
    return;
  end if;

  if v_booking.status = 'checked_in' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'invalid'::text, null::uuid, 'ALREADY_CHECKED_IN'::text;
    return;
  end if;

  if v_booking.status not in ('pending_payment', 'confirmed') then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'invalid', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'invalid'::text, null::uuid, 'BOOKING_NOT_ELIGIBLE'::text;
    return;
  end if;

  if v_booking.invoice_id is null then
    v_outstanding := null;
  else
    select s.outstanding into v_outstanding
    from public.get_invoice_payment_summary(array[v_booking.invoice_id]) s;
  end if;

  if v_outstanding is null or v_outstanding > 0.004 then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'payment_required', v_cred.type, v_cred.reference_id, p_identity_confirmed);
    return query select 'payment_required'::text, v_booking.id, 'PAYMENT_REQUIRED'::text;
    return;
  end if;

  update public.qr_credentials
  set status = 'consumed', used_at = now(), used_by = auth.uid()
  where id = v_cred.id;

  update public.bookings
  set status = 'checked_in', marked_by = auth.uid(), marked_at = now()
  where id = v_booking.id;

  -- M-9 fix: this is the persisted "Identity Match" system record --
  -- p_identity_confirmed reflects whether the scanning staff member
  -- explicitly attested (via the scanner UI's required photo-confirm
  -- step) that they visually matched the presenting person to
  -- display_photo_url before tapping Confirm Check-in.
  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id, identity_confirmed)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'check_in', 'success', v_cred.type, v_cred.reference_id, p_identity_confirmed);

  perform public.write_audit_log(v_cred.club_id, 'booking.check_in', 'booking', v_booking.id, jsonb_build_object('status', v_booking.status), jsonb_build_object('status', 'checked_in', 'identity_confirmed', p_identity_confirmed), null);

  return query select 'success'::text, v_booking.id, 'SUCCESS'::text;
end;
$function$;

-- Grant-layer backstop (see 20260824230500_regrant_staff_only_rpcs_after_
-- signature_change.sql for the documented mechanism): qr_confirm_checkin's
-- parameter list just changed (new p_identity_confirmed), which is a
-- signature change that resets its grant set to the Postgres default
-- (PUBLIC/anon EXECUTE), discarding the earlier explicit REVOKE. Re-apply
-- it here in the same migration that changes the signature, matching the
-- established pattern for every staff-only QR RPC in this codebase.
revoke all on function public.qr_confirm_checkin(text, boolean) from public;
revoke all on function public.qr_confirm_checkin(text, boolean) from anon;
grant execute on function public.qr_confirm_checkin(text, boolean) to authenticated;
grant execute on function public.qr_confirm_checkin(text, boolean) to service_role;
