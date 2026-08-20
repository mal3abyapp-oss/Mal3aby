-- Academy radical simplification directive section 24: "do not make
-- attendance recording depend on building a complex Program/Season/
-- Group construction if that dependency can be safely simplified."
--
-- Live QA E2E (2026-08-20) surfaced two compounding gaps:
--   1. training_sessions rows previously only came from
--      generate_training_sessions(), which itself requires
--      group_schedule_slots -- the legacy weekly-schedule machinery
--      this directive demoted (never asked for by the new minimal
--      Create Membership flow). A membership created the simple way
--      could never have a session, so attendance could never be
--      recorded for it.
--   2. training_sessions has SELECT and UPDATE RLS policies but no
--      INSERT policy at all -- so even a client-side attempt to
--      create a schedule-free session directly would be silently
--      denied by RLS (confirmed via pg_policies).
--
-- Fix: a small SECURITY DEFINER RPC, following this codebase's
-- existing RPC-first write pattern (mark_attendance, qr_mark_attendance
-- alongside it) rather than opening a new INSERT policy on the table.
-- Finds-or-creates a single ad-hoc, schedule-free session for "today"
-- (or any given date) for a membership/group, using a fixed
-- placeholder time (00:00-23:59) since a simple membership has no time
-- concept -- matching the same permission check
-- (session.manage) generate_training_sessions() already uses.
create or replace function public.ensure_adhoc_attendance_session(
  p_group_id uuid,
  p_session_date date
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_group record;
  v_session_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_group from public.groups where id = p_group_id;
  if v_group.id is null then
    raise exception 'group not found';
  end if;

  if not (v_group.club_id in (select public.user_club_ids()) and public.has_permission('session.manage', v_group.club_id)) then
    raise exception 'not authorized';
  end if;

  select id into v_session_id
  from public.training_sessions
  where group_id = p_group_id and session_date = p_session_date and start_time = '00:00:00'
  limit 1;

  if v_session_id is not null then
    return v_session_id;
  end if;

  insert into public.training_sessions (club_id, group_id, field_id, coach_id, session_date, start_time, end_time)
  values (v_group.club_id, p_group_id, v_group.field_id, v_group.coach_id, p_session_date, '00:00:00', '23:59:00')
  on conflict (group_id, session_date, start_time) do nothing
  returning id into v_session_id;

  if v_session_id is null then
    -- Lost a race against a concurrent call for the same
    -- group/date/time -- the ON CONFLICT no-op means the row already
    -- exists; fetch its id instead of erroring.
    select id into v_session_id
    from public.training_sessions
    where group_id = p_group_id and session_date = p_session_date and start_time = '00:00:00'
    limit 1;
  end if;

  return v_session_id;
end;
$function$;

revoke execute on function public.ensure_adhoc_attendance_session(uuid, date) from public;
revoke execute on function public.ensure_adhoc_attendance_session(uuid, date) from anon;
grant execute on function public.ensure_adhoc_attendance_session(uuid, date) to authenticated;
