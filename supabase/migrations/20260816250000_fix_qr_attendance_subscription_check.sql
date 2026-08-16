-- Gate 6 (Secure QR / Identity / Attendance) -- real gap found via
-- direct code audit: qr_mark_attendance() verified the player has an
-- ACTIVE ENROLLMENT in the session's group, but never checked whether
-- their SUBSCRIPTION is actually active. Doc 3's core stated rule is
-- "Valid QR + Correct Account + Verified Membership + Active
-- Entitlement + Identity Match = Approved Check-in" -- the "Active
-- Entitlement" half was silently missing. A player whose subscription
-- is frozen, expired, or cancelled (but whose enrollment row is still
-- 'active' -- these are two separate concepts in this schema, per
-- create_enrollment_with_subscription's own design, and freezing a
-- subscription does NOT withdraw the enrollment) could still
-- successfully check into a session via QR.
--
-- Fix: qr_mark_attendance() now also requires the player's current
-- subscription (for the group they're checking into) to have
-- status = 'active'. A frozen/expired/cancelled/pending subscription
-- now correctly produces a distinct, actionable scan result
-- ('subscription_inactive') rather than silently succeeding.
create or replace function public.qr_mark_attendance(p_token text, p_session_id uuid)
returns table(result text, attendance_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_token_hash text;
  v_cred record;
  v_session record;
  v_attendance_id uuid;
  v_enrollment_id uuid;
  v_subscription_status text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_cred from public.qr_credentials where token_hash = v_token_hash;

  if v_cred.id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (null, null, auth.uid(), 'attendance_mark', 'invalid', null, null);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  if v_cred.type != 'player_membership' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  select ts.*, g.coach_id, g.assistant_coach_id into v_session
  from public.training_sessions ts
  join public.groups g on g.id = ts.group_id
  where ts.id = p_session_id;

  if v_session.id is null or v_session.club_id != v_cred.club_id then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'wrong_club', v_cred.type, v_cred.reference_id);
    return query select 'wrong_club'::text, null::uuid;
    return;
  end if;

  if not (
    v_session.club_id in (select public.user_club_ids())
    and public.has_permission('attendance.mark', v_session.club_id)
    and (v_session.coach_id = auth.uid() or v_session.assistant_coach_id = auth.uid())
  ) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  select e.id into v_enrollment_id
  from public.enrollments e
  where e.player_id = v_cred.reference_id and e.group_id = v_session.group_id and e.status = 'active';

  if v_enrollment_id is null then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  -- Doc 3's "Active Entitlement" check: the enrollment being 'active'
  -- is necessary but not sufficient -- the player's actual paid
  -- subscription for this enrollment must also currently be active.
  select status into v_subscription_status
  from public.subscriptions
  where enrollment_id = v_enrollment_id
  order by created_at desc
  limit 1;

  if v_subscription_status is distinct from 'active' then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'subscription_inactive', v_cred.type, v_cred.reference_id);
    return query select 'subscription_inactive'::text, null::uuid;
    return;
  end if;

  insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
  values (v_session.club_id, p_session_id, v_cred.reference_id, 'present', 'qr', auth.uid(), now())
  on conflict (session_id, player_id)
  do update set status = 'present', method = 'qr', marked_by = excluded.marked_by, marked_at = excluded.marked_at
  returning id into v_attendance_id;

  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'success', v_cred.type, v_cred.reference_id);

  return query select 'success'::text, v_attendance_id;
end;
$$;
