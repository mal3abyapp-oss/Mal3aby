-- Gate 6 (Secure QR / Identity / Attendance) -- the real, substantial
-- gap found via direct code audit: qr_validate() only ever returned
-- {result, credential_id, reference_type, reference_id, club_id} --
-- never any identity-verification data (name, photo, membership/
-- subscription status). Doc 3's stated rule -- "Valid QR + Correct
-- Account + Verified Membership + Active Entitlement + Identity Match
-- = Approved Check-in" -- requires staff to see enough to visually
-- compare the person presenting the QR to a verified photo, and to see
-- the membership/subscription state they're approving. A bare
-- valid/invalid result (which is all the scanner UI could ever show,
-- since that's all the RPC ever returned) cannot satisfy that.
--
-- Fix: qr_validate() now also returns a small, purpose-built JSON
-- payload (display_name, display_photo_url, display_subtitle,
-- subscription_status) branching on credential type -- booking
-- (customer name/mobile, field, time) or player_membership (player
-- name/photo, group, subscription status). This is intentionally the
-- MINIMUM necessary for staff to visually verify identity and current
-- standing, per Doc 3's own "minimal-necessary verification screen"
-- requirement -- never full financial/contact history.
create or replace function public.qr_validate(p_token text)
returns table(
  result text,
  credential_id uuid,
  reference_type text,
  reference_id uuid,
  club_id uuid,
  display_name text,
  display_photo_url text,
  display_subtitle text,
  subscription_status text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_token_hash text;
  v_cred record;
  v_result text;
  v_display_name text;
  v_display_photo_url text;
  v_display_subtitle text;
  v_subscription_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'validate', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  if not (v_cred.club_id in (select public.user_club_ids()) and public.has_permission('qr.scan', v_cred.club_id)) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid, null::text, null::uuid, null::uuid, null::text, null::text, null::text, null::text;
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

  -- Resolve minimal identity-verification display data regardless of
  -- the token's own status -- staff should still see WHO this QR
  -- belongs to even for an expired/used one (e.g. to recognize a member
  -- asking for a fresh QR), never just a bare "expired" with no name.
  if v_cred.type = 'booking' then
    select c.full_name,
           f.name || ' — ' || to_char(b.start_at at time zone cl.timezone, 'HH24:MI')
      into v_display_name, v_display_subtitle
    from public.bookings b
    join public.customers c on c.id = b.customer_id
    join public.fields f on f.id = b.field_id
    join public.clubs cl on cl.id = b.club_id
    where b.id = v_cred.reference_id;
    v_display_photo_url := null; -- customers.photo_url intentionally not surfaced for a field-booking check-in (Doc 3 scopes verified-photo identity checks to academy membership specifically).

  elsif v_cred.type = 'player_membership' then
    select p.full_name, p.photo_url,
           coalesce(g.name, 'بدون مجموعة'),
           s.status
      into v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status
    from public.players p
    left join public.enrollments e on e.player_id = p.id and e.status = 'active'
    left join public.groups g on g.id = e.group_id
    left join public.subscriptions s on s.enrollment_id = e.id
    where p.id = v_cred.reference_id
    order by s.created_at desc
    limit 1;
  end if;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'validate', v_result, v_cred.type, v_cred.reference_id);

  return query select v_result, v_cred.id, v_cred.type, v_cred.reference_id, v_cred.club_id,
    v_display_name, v_display_photo_url, v_display_subtitle, v_subscription_status;
end;
$$;
