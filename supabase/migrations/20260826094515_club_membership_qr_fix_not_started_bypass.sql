-- FIX: qr_validate's club_membership branch incorrectly let a NOT_STARTED
-- (future-dated OR still-unpaid pending_payment) membership scan as a
-- plain SUCCESS -- discovered live during Club Memberships E2E closure
-- verification (a real customer's not-yet-active/unpaid membership QR
-- validated as a green "success" at qr_validate level, which the scanner
-- UI would have rendered as a valid entry). Root cause: the diagnostic-
-- downgrade condition `if v_subscription_status != 'ACTIVE' and
-- v_subscription_status != 'NOT_STARTED'` deliberately excluded
-- NOT_STARTED from being downgraded to 'invalid', apparently intending
-- to let a not-yet-started membership be shown for identity purposes --
-- but with no accompanying UI copy or scanner branch treating NOT_STARTED
-- as a non-entry outcome, this left a genuine "let them in early / let
-- an unpaid membership in" gap. The frontend (ScanPage.tsx) ALREADY has
-- MEMBERSHIP_NOT_STARTED wired to a distinct warning-toned "not started"
-- label (scanner.membershipOutcomes.notStarted) -- it only needed the
-- backend to actually EMIT that diagnostic code and result='invalid' for
-- this status, which it never did. This migration removes the
-- NOT_STARTED carve-out: only ACTIVE now passes through as a plain
-- success. Every other branch (ACTIVE/FROZEN/EXPIRED/CANCELLED/
-- NO_MEMBERSHIP/permission-denied/wrong-club/tenant-isolation) is
-- unchanged, byte-for-byte, from the live-captured original definition.
CREATE OR REPLACE FUNCTION public.qr_validate(p_token text)
 RETURNS TABLE(result text, credential_id uuid, reference_type text, reference_id uuid, club_id uuid, display_name text, display_photo_url text, display_subtitle text, subscription_status text, diagnostic_code text, amount_due numeric)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

      -- FIX: NOT_STARTED must be downgraded too -- an unpaid or
      -- future-dated membership must never validate as a plain SUCCESS.
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
