-- Academy radical simplification directive section 24: "Attendance ...
-- reachable directly from the Academy nav for managers/receptionists
-- too, not only via the coach-only Today view."
--
-- Live QA E2E (2026-08-20) confirmed a real, pre-existing design
-- decision that now directly contradicts the directive: attendance.mark
-- was granted ONLY to the 'coach' role (see
-- 20260815390000_temp_grant_club_manager_for_academy_smoke_test.sql's
-- own comment: "attendance marking is Coach-only in this schema"), and
-- mark_attendance() additionally hard-required the caller to be the
-- session's own coach_id/assistant_coach_id. A club manager/academy
-- manager using the new manager-facing AttendanceSection (built this
-- same session, reachable from Academy > Attendance) got a silent
-- "not authorized for this session" on every mark -- silent because
-- the calling component (a real, separate bug also fixed this session)
-- had no onError handler, so the UI showed a false "success" highlight
-- with nothing actually written to the attendance table.
--
-- Fix:
--   1. Grant attendance.mark to the same roles that already hold
--      session.manage (academy_manager, club_owner, coach) -- the
--      people who can already create/manage a session should be able
--      to mark attendance against it, not just the literal assigned
--      coach.
--   2. Relax mark_attendance()'s authorization to accept anyone with
--      attendance.mark, not only the session's own coach/assistant --
--      the coach-identity check becomes one way to qualify, not the
--      only way. Coach self-service (CoachTodayView) is unaffected:
--      a coach who IS the session's coach still passes.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r, public.permissions p
where r.key in ('academy_manager', 'club_owner')
  and p.key = 'attendance.mark'
on conflict do nothing;

create or replace function public.mark_attendance(p_session_id uuid, p_player_id uuid, p_status text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

  select ts.*, g.coach_id, g.assistant_coach_id into v_session
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
      or v_session.coach_id = auth.uid()
      or v_session.assistant_coach_id = auth.uid()
    )
  ) then
    raise exception 'not authorized for this session';
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
$$;

revoke execute on function public.mark_attendance(uuid, uuid, text) from public;
revoke execute on function public.mark_attendance(uuid, uuid, text) from anon;
grant execute on function public.mark_attendance(uuid, uuid, text) to authenticated;
