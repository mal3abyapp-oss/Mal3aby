-- Phase 12 -- Sessions + Attendance.
-- See docs/IMPLEMENTATION_PLAN.md Phase 12, docs/DATABASE_BLUEPRINT.md
-- #training_sessions/#attendance, docs/RLS_MATRIX.md, docs/RLS_SECURITY.md
-- (generate_training_sessions / qr_mark_attendance function inventory).

create table public.training_sessions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  group_id uuid not null references public.groups(id),
  field_id uuid references public.fields(id),
  coach_id uuid references auth.users(id),
  session_date date not null,
  start_time time not null,
  end_time time not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  constraint training_sessions_valid_period check (end_time > start_time)
);

create index training_sessions_club_id_idx on public.training_sessions (club_id);
create index training_sessions_group_id_idx on public.training_sessions (group_id);
create index training_sessions_coach_id_idx on public.training_sessions (coach_id);
-- Stronger identity than (group_id, session_date) alone -- session
-- generation is idempotent via ON CONFLICT DO NOTHING against this.
create unique index training_sessions_identity_idx on public.training_sessions (group_id, session_date, start_time);

alter table public.training_sessions enable row level security;

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  session_id uuid not null references public.training_sessions(id),
  player_id uuid not null references public.players(id),
  status text not null check (status in ('present', 'absent', 'excused', 'late')),
  method text not null default 'manual' check (method in ('manual', 'qr')),
  marked_by uuid references auth.users(id),
  marked_at timestamptz not null default now(),
  -- Marking again for the same player/session is always an UPDATE, never
  -- a second INSERT -- enforced at the database level, not just RPC logic.
  unique (session_id, player_id)
);

create index attendance_club_id_idx on public.attendance (club_id);
create index attendance_session_id_idx on public.attendance (session_id);
create index attendance_player_id_idx on public.attendance (player_id);

alter table public.attendance enable row level security;

-- ============================================================
-- Permissions
-- ============================================================

insert into public.permissions (key, description) values
  ('session.view', 'View training sessions'),
  ('session.manage', 'Generate/update training sessions'),
  ('attendance.view', 'View attendance records'),
  ('attendance.mark', 'Mark attendance for a session')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('platform_owner', 'club_owner', 'club_manager', 'branch_manager', 'receptionist')
  and p.key = 'session.view'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'academy_manager'
  and p.key in ('session.view', 'session.manage', 'attendance.view')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'coach'
  and p.key in ('session.view', 'session.manage', 'attendance.view', 'attendance.mark')
on conflict do nothing;

-- ============================================================
-- RLS
-- ============================================================

-- training_sessions: staff (with session.view) see all in-club sessions;
-- Coach sees/manages only sessions for their assigned groups.
create policy "training_sessions_select" on public.training_sessions for select
  using (
    club_id in (select public.user_club_ids())
    and (
      public.has_permission('session.view', club_id)
      or exists (
        select 1 from public.groups g
        where g.id = training_sessions.group_id
          and (g.coach_id = auth.uid() or g.assistant_coach_id = auth.uid())
      )
    )
  );
-- No direct client INSERT policy -- sessions are created only via
-- generate_training_sessions (SECURITY DEFINER, idempotent upsert).
-- UPDATE: academy_manager can update any in-club session (session.manage
-- + attendance.view, the two permissions unique to academy_manager among
-- session.manage holders); Coach (session.manage only, no attendance.view)
-- can update only sessions for their own assigned groups, per the
-- matrix's "S,I,U (assigned only)" for Coach on this row.
create policy "training_sessions_update" on public.training_sessions for update
  using (
    club_id in (select public.user_club_ids())
    and public.has_permission('session.manage', club_id)
    and (
      public.has_permission('attendance.view', club_id)
      or exists (
        select 1 from public.groups g
        where g.id = training_sessions.group_id
          and (g.coach_id = auth.uid() or g.assistant_coach_id = auth.uid())
      )
    )
  );
alter table public.training_sessions force row level security;

-- attendance: academy_manager view-only (per matrix -- S, not S,I,U);
-- Coach S,I,U but only for their own assigned sessions; Scanner S only
-- (QR check-in flow writes via SECURITY DEFINER, not a direct client
-- INSERT policy at all -- so Scanner's "S (QR check-in only)" cell is
-- satisfied by having no write path except the RPC, same pattern as
-- qr_scan_events).
create policy "attendance_select" on public.attendance for select
  using (
    club_id in (select public.user_club_ids())
    and (
      public.has_permission('attendance.view', club_id)
      or exists (
        select 1 from public.training_sessions ts
        join public.groups g on g.id = ts.group_id
        where ts.id = attendance.session_id
          and (g.coach_id = auth.uid() or g.assistant_coach_id = auth.uid())
      )
    )
  );
create policy "attendance_insert" on public.attendance for insert
  with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('attendance.mark', club_id)
    and exists (
      select 1 from public.training_sessions ts
      join public.groups g on g.id = ts.group_id
      where ts.id = attendance.session_id
        and (g.coach_id = auth.uid() or g.assistant_coach_id = auth.uid())
    )
  );
create policy "attendance_update" on public.attendance for update
  using (
    club_id in (select public.user_club_ids())
    and public.has_permission('attendance.mark', club_id)
    and exists (
      select 1 from public.training_sessions ts
      join public.groups g on g.id = ts.group_id
      where ts.id = attendance.session_id
        and (g.coach_id = auth.uid() or g.assistant_coach_id = auth.uid())
    )
  );
alter table public.attendance force row level security;

-- ============================================================
-- generate_training_sessions: idempotent on-demand generation from a
-- group's group_schedule_slots, for dates in [today, p_through_date].
-- INSERT ... ON CONFLICT (group_id, session_date, start_time) DO NOTHING
-- -- re-running for an already-covered range never duplicates.
-- ============================================================

create or replace function public.generate_training_sessions(p_group_id uuid, p_through_date date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group record;
  v_slot record;
  v_date date;
  v_created_count int := 0;
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

  if p_through_date < current_date then
    raise exception 'p_through_date must be today or later';
  end if;

  for v_slot in select * from public.group_schedule_slots where group_id = p_group_id loop
    v_date := current_date;
    while v_date <= p_through_date loop
      if extract(dow from v_date) = v_slot.day_of_week then
        insert into public.training_sessions (club_id, group_id, field_id, coach_id, session_date, start_time, end_time)
        values (v_group.club_id, p_group_id, v_group.field_id, v_group.coach_id, v_date, v_slot.start_time, v_slot.end_time)
        on conflict (group_id, session_date, start_time) do nothing;
        if found then
          v_created_count := v_created_count + 1;
        end if;
      end if;
      v_date := v_date + interval '1 day';
    end loop;
  end loop;

  return v_created_count;
end;
$$;

revoke execute on function public.generate_training_sessions(uuid, date) from public;
revoke execute on function public.generate_training_sessions(uuid, date) from anon;
grant execute on function public.generate_training_sessions(uuid, date) to authenticated;

-- ============================================================
-- mark_attendance: manual attendance marking by a coach. Marking again
-- for the same player/session is always an UPDATE (upsert), never a
-- second INSERT -- enforced by the unique(session_id, player_id)
-- constraint plus this RPC's ON CONFLICT clause.
-- ============================================================

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
    and public.has_permission('attendance.mark', v_session.club_id)
    and (v_session.coach_id = auth.uid() or v_session.assistant_coach_id = auth.uid())
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

-- ============================================================
-- qr_mark_attendance: validates a reusable player_membership QR and
-- atomically upserts the attendance row in one step -- does not consume
-- the credential (single_use = false for player_membership, per
-- ADR-011d). Every scan still logs to qr_scan_events regardless of
-- outcome, exactly like the booking QR flow.
-- ============================================================

create or replace function public.qr_mark_attendance(p_token text, p_session_id uuid)
returns table(result text, attendance_id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_cred record;
  v_session record;
  v_attendance_id uuid;
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

  if not exists (
    select 1 from public.enrollments e
    where e.player_id = v_cred.reference_id and e.group_id = v_session.group_id and e.status = 'active'
  ) then
    insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
    values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'invalid', v_cred.type, v_cred.reference_id);
    return query select 'invalid'::text, null::uuid;
    return;
  end if;

  insert into public.attendance (club_id, session_id, player_id, status, method, marked_by, marked_at)
  values (v_session.club_id, p_session_id, v_cred.reference_id, 'present', 'qr', auth.uid(), now())
  on conflict (session_id, player_id)
  do update set status = 'present', method = 'qr', marked_by = excluded.marked_by, marked_at = excluded.marked_at
  returning id into v_attendance_id;

  -- Reusable credential -- never consumed/mutated on scan.
  insert into public.qr_scan_events (club_id, credential_id, scanner_user_id, action, result, reference_type, reference_id)
  values (v_cred.club_id, v_cred.id, auth.uid(), 'attendance_mark', 'success', v_cred.type, v_cred.reference_id);

  return query select 'success'::text, v_attendance_id;
end;
$$;

revoke execute on function public.qr_mark_attendance(text, uuid) from public;
revoke execute on function public.qr_mark_attendance(text, uuid) from anon;
grant execute on function public.qr_mark_attendance(text, uuid) to authenticated;
