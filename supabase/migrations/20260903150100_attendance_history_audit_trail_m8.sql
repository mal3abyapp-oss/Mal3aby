-- SAAS ACCEPTANCE REVIEW finding M-8: mark_attendance() and
-- qr_mark_attendance() both write attendance via
--   insert ... on conflict (session_id, player_id) do update set
--     status = ..., method = ..., marked_by = ..., marked_at = ...
-- An override (e.g. a coach marks a player absent, a manager later flips
-- it to present) silently overwrites the prior row in place. There is no
-- history of the original status, who marked it, when, or by what method,
-- and neither RPC calls write_audit_log for the update-path. These are
-- the same two functions that had a live-exploited auth bypass fixed in
-- 20260829140000 -- attendance integrity is a proven-sensitive surface,
-- so overrides need a trace even when authorization is correct.
--
-- Fix shape: a BEFORE UPDATE trigger on public.attendance, rather than
-- editing both RPC bodies. Postgres fires row-level BEFORE UPDATE
-- triggers for the UPDATE performed by INSERT ... ON CONFLICT DO UPDATE
-- exactly as it would for a plain UPDATE statement -- the ON CONFLICT
-- DO UPDATE path is not a separate, trigger-invisible code path. A
-- trigger therefore:
--   * catches every override through both current RPCs without touching
--     either function body (and any future write path to this table,
--     direct or RPC, inherits the same guarantee automatically --
--     centralizes the invariant on the table rather than duplicating it
--     per caller, matching "fix defect classes, not isolated symptoms");
--   * can distinguish a genuine override from a no-op re-mark of the
--     same status/method by the caller (both RPCs re-send the same
--     status on a duplicate scan/click) by comparing OLD vs NEW and
--     only inserting a history row when something actually changed;
--   * runs inside the same transaction as the triggering write, so the
--     history row and the attendance update are atomic -- no
--     partial-write window a two-step RPC-body change would have to
--     guard separately.
-- The alternative (adding an explicit "capture prior row, then
-- write_audit_log" block to both mark_attendance and qr_mark_attendance)
-- was rejected: it duplicates the same logic twice today, silently stops
-- covering the table the moment a third write path is added later, and
-- reintroduces exactly the kind of "two RPCs, one invariant, drifted
-- copies" shape that produced the BUG 1 column-shadowing defect in
-- 20260829140000.

-- ============================================================
-- attendance_history
-- ============================================================
create table public.attendance_history (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  session_id uuid not null references public.training_sessions(id),
  player_id uuid not null references public.players(id),
  attendance_id uuid not null references public.attendance(id),
  previous_status text not null,
  previous_marked_by uuid references auth.users(id),
  previous_marked_at timestamptz not null,
  previous_method text not null,
  new_status text not null,
  new_marked_by uuid references auth.users(id),
  new_marked_at timestamptz not null,
  new_method text not null,
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);
comment on table public.attendance_history is 'Append-only override trail for public.attendance. Populated only by the attendance_record_override trigger (BEFORE UPDATE on public.attendance) -- never written directly by any RPC or client. One row per genuine override (a value actually changed); no-op re-marks of the same status/method/marked_by are not recorded.';

create index attendance_history_club_id_idx on public.attendance_history (club_id);
create index attendance_history_attendance_id_idx on public.attendance_history (attendance_id);
create index attendance_history_session_id_idx on public.attendance_history (session_id);
create index attendance_history_changed_at_idx on public.attendance_history (changed_at desc);

alter table public.attendance_history enable row level security;

-- Read access mirrors attendance_select's "attendance.view" branch only
-- (the coach-of-assigned-group self-service branch in attendance_select
-- is a current-state convenience for Coach role and is deliberately not
-- extended here -- viewing the override trail is an accountability
-- feature for whoever holds attendance.view, matching audit_logs'
-- narrower read surface rather than attendance's read surface).
-- Branch scope matches the rest of the branch-aware schema: joins
-- through training_sessions -> groups for the session's branch_id since
-- attendance/attendance_history do not store branch_id directly.
create policy "attendance_history_select" on public.attendance_history for select
  using (
    club_id in (select public.user_club_ids())
    and public.has_permission('attendance.view', club_id)
    and exists (
      select 1 from public.training_sessions ts
      join public.groups g on g.id = ts.group_id
      where ts.id = attendance_history.session_id
        and public.user_has_branch_access(attendance_history.club_id, g.branch_id)
    )
  );

-- No INSERT/UPDATE/DELETE policy for any role, ever -- writes happen
-- only inside the trigger function below, which runs as the triggering
-- statement's context and is not subject to RLS the way a direct client
-- write would be (same "no client write path" shape as qr_scan_events
-- and audit_logs).
alter table public.attendance_history force row level security;

-- ============================================================
-- attendance_record_override: BEFORE UPDATE trigger function on
-- public.attendance. Inserts one attendance_history row per genuine
-- override (status, marked_by, marked_at, or method actually changed);
-- a duplicate re-mark of the identical status/method by the same marker
-- is not an override and is not recorded (OLD.marked_at always differs
-- from NEW.marked_at in practice since both RPCs stamp now() on every
-- write, so the comparison below is anchored on status/marked_by/method,
-- the fields that carry the actual audit-worthy meaning; marked_at is
-- still captured into the history row for completeness either way).
-- ============================================================
create or replace function public.attendance_record_override()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status
     or new.marked_by is distinct from old.marked_by
     or new.method is distinct from old.method then
    insert into public.attendance_history (
      club_id, session_id, player_id, attendance_id,
      previous_status, previous_marked_by, previous_marked_at, previous_method,
      new_status, new_marked_by, new_marked_at, new_method,
      changed_by
    ) values (
      new.club_id, new.session_id, new.player_id, new.id,
      old.status, old.marked_by, old.marked_at, old.method,
      new.status, new.marked_by, new.marked_at, new.method,
      auth.uid()
    );
  end if;
  return new;
end;
$$;

revoke execute on function public.attendance_record_override() from public;
revoke execute on function public.attendance_record_override() from anon;
revoke execute on function public.attendance_record_override() from authenticated;

create trigger attendance_record_override_trigger
  before update on public.attendance
  for each row
  execute function public.attendance_record_override();
