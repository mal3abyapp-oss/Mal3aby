-- Fix two stacked, live-exploited authorization defects in
-- mark_attendance() and qr_mark_attendance(), found during the
-- 2026-08-29 acceptance-gap-closure pass (academy attendance-marking
-- attack sub-item), plus a missing branch-scope check shared by both
-- functions.
--
-- BUG 1 -- column-name collision (root cause of the auth bypass):
--   select ts.*, g.coach_id, g.assistant_coach_id into v_session
--   from public.training_sessions ts join public.groups g on g.id = ts.group_id
-- `public.training_sessions` ALSO has its own `coach_id` column (a
-- per-session override that is never populated anywhere in this
-- codebase). Because `ts.*` is expanded first, `v_session.coach_id`
-- resolved to `ts.coach_id` (always NULL), permanently shadowing the
-- intended `g.coach_id` (the group's real assigned coach). This made the
-- coach/assistant-coach bypass branch permanently dead for legitimate
-- coaches (an availability bug, usually masked because Coach-role members
-- also hold has_permission('attendance.mark', ...) directly).
--
-- BUG 2 -- NULL-vs-boolean short circuit (the actual exploitable
-- bypass): with coach_id/assistant_coach_id both NULL (any group with no
-- assigned coach), `v_session.coach_id = auth.uid()` evaluates to SQL
-- NULL, not false. `has_permission(...) = false OR NULL OR NULL` is
-- NULL, and `session_in_club = true AND NULL` is NULL. PL/pgSQL's
-- `IF NOT (NULL) THEN raise exception ... END IF` treats NULL as
-- not-true and silently skips the branch -- so "not authorized" never
-- fires. Any staff member holding ANY active club_memberships row on the
-- club (any role, any permission set) could mark attendance for any
-- coachless group's sessions.
--
-- BUG 3 -- missing branch scope: neither function ever called
-- user_has_branch_access(club_id, branch_id), unlike groups' own RLS
-- INSERT/UPDATE policies and other branch-aware tables in this schema.
-- A staff membership scoped via membership_branches to one branch could
-- mark attendance for sessions belonging to groups in a DIFFERENT branch
-- of the same club.
--
-- All three were live-reproduced against project gxkrtlvpjwxhcqdisyob on
-- 2026-08-29 using a Scanner-role (no attendance.mark) and a
-- Branch-1-scoped Coach-role (has attendance.mark, but wrong branch)
-- fixture membership; both attacks committed real attendance rows before
-- this fix and were re-verified blocked after.
--
-- Fix: alias the joined group columns distinctly (group_coach_id /
-- group_assistant_coach_id / group_branch_id) so they can never be
-- shadowed by same-named columns from ts.*; wrap the coach/assistant
-- comparisons in coalesce(..., false) so a NULL can never collapse the
-- boolean expression to NULL; and add the same user_has_branch_access()
-- check the rest of the branch-aware schema already uses.

create or replace function public.mark_attendance(p_session_id uuid, p_player_id uuid, p_status text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_session record;
  v_attendance_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_status not in ('present', 'absent', 'excused', 'late') then
    raise exception 'invalid status';
  end if;

  select ts.*, g.coach_id as group_coach_id, g.assistant_coach_id as group_assistant_coach_id, g.branch_id as group_branch_id into v_session
  from public.training_sessions ts
  join public.groups g on g.id = ts.group_id
  where ts.id = p_session_id;

  if v_session.id is null then
    raise exception 'session not found';
  end if;

  if not (
    v_session.club_id in (select public.user_club_ids())
    and (
      public.has_permission('attendance.mark', v_session.club_id)
      or coalesce(v_session.group_coach_id = auth.uid(), false)
      or coalesce(v_session.group_assistant_coach_id = auth.uid(), false)
    )
  ) then
    raise exception 'not authorized for this session';
  end if;

  if not public.user_has_branch_access(v_session.club_id, v_session.group_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if not public._academy_module_active(v_session.club_id) then
    raise exception 'the academy module is not active for this club';
  end if;

  if not exists (
    select 1 from public.enrollments e
    where e.player_id = p_player_id and e.group_id = v_session.group_id and e.status = 'active'
  ) then
    raise exception 'player is not actively enrolled in this session''s group';
  end if;

  insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
  values (v_session.club_id, p_session_id, p_player_id, p_status, 'manual', auth.uid(), now())
  on conflict (session_id, player_id)
  do update set status = excluded.status, method = 'manual', marked_by = excluded.marked_by, marked_at = excluded.marked_at
  returning id into v_attendance_id;

  return v_attendance_id;
end;
$function$;

create or replace function public.qr_mark_attendance(p_token text, p_session_id uuid)
 returns table(result text, attendance_id uuid)
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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

  select ts.*, g.coach_id as group_coach_id, g.assistant_coach_id as group_assistant_coach_id, g.branch_id as group_branch_id into v_session
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
    and (
      public.has_permission('attendance.mark', v_session.club_id)
      or coalesce(v_session.group_coach_id = auth.uid(), false)
      or coalesce(v_session.group_assistant_coach_id = auth.uid(), false)
    )
  ) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if not public.user_has_branch_access(v_session.club_id, v_session.group_branch_id) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'permission_denied', v_cred.type, v_cred.reference_id);
    return query select 'permission_denied'::text, null::uuid;
    return;
  end if;

  if not public._academy_module_active(v_session.club_id) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'module_inactive', v_cred.type, v_cred.reference_id);
    return query select 'module_inactive'::text, null::uuid;
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
$function$;
