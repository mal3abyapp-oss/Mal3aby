-- Phase 10 -- Academy Structure: programs, seasons, age_groups, groups,
-- group_schedule_slots. See docs/IMPLEMENTATION_PLAN.md Phase 10,
-- docs/DATABASE_BLUEPRINT.md #programs/#seasons/#age_groups/#groups/
-- #group_schedule_slots, docs/RLS_MATRIX.md.

create table public.programs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  name text not null,
  name_ar text not null,
  sport text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index programs_club_id_idx on public.programs (club_id);
alter table public.programs enable row level security;

create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  program_id uuid references public.programs(id),
  name text not null,
  start_date date not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint seasons_valid_period check (end_date > start_date)
);

create index seasons_club_id_idx on public.seasons (club_id);
create index seasons_program_id_idx on public.seasons (program_id);
alter table public.seasons enable row level security;

create table public.age_groups (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  name text not null,
  min_age int,
  max_age int,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index age_groups_club_id_idx on public.age_groups (club_id);
alter table public.age_groups enable row level security;

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  program_id uuid not null references public.programs(id),
  season_id uuid not null references public.seasons(id),
  age_group_id uuid references public.age_groups(id),
  coach_id uuid references auth.users(id),
  assistant_coach_id uuid references auth.users(id),
  field_id uuid references public.fields(id),
  name text not null,
  capacity int not null check (capacity > 0),
  status text not null default 'active' check (status in ('active', 'full', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index groups_club_id_idx on public.groups (club_id);
create index groups_coach_id_idx on public.groups (coach_id);
create index groups_program_id_idx on public.groups (program_id);
alter table public.groups enable row level security;

create table public.group_schedule_slots (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id),
  day_of_week int not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  constraint group_schedule_slots_valid_period check (end_time > start_time)
);

create index group_schedule_slots_group_id_idx on public.group_schedule_slots (group_id);
alter table public.group_schedule_slots enable row level security;

-- ============================================================
-- RLS -- club-scoped for staff, Coach restricted to assigned groups
-- (read-only) and no access at all to programs/seasons/age_groups per
-- RLS_MATRIX.md's `-` for Coach on that row.
-- ============================================================

-- SELECT on programs/seasons/age_groups: every club member except
-- Accountant/Scanner/Coach per the matrix (all three `-` on this row).
-- Expressed directly via role membership rather than piggybacking an
-- unrelated permission (e.g. booking.view) onto an academy table.
create policy "programs_select" on public.programs for select
  using (
    club_id in (select public.user_club_ids())
    and exists (
      select 1 from public.club_memberships cm
      join public.roles r on r.id = cm.role_id
      where cm.user_id = auth.uid() and cm.club_id = programs.club_id and cm.status = 'active'
        and r.key not in ('accountant', 'scanner', 'coach')
    )
  );
create policy "programs_insert" on public.programs for insert
  with check (club_id in (select public.user_club_ids()) and public.has_permission('academy.program.manage', club_id));
create policy "programs_update" on public.programs for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('academy.program.manage', club_id));
alter table public.programs force row level security;

create policy "seasons_select" on public.seasons for select
  using (
    club_id in (select public.user_club_ids())
    and exists (
      select 1 from public.club_memberships cm
      join public.roles r on r.id = cm.role_id
      where cm.user_id = auth.uid() and cm.club_id = seasons.club_id and cm.status = 'active'
        and r.key not in ('accountant', 'scanner', 'coach')
    )
  );
create policy "seasons_insert" on public.seasons for insert
  with check (club_id in (select public.user_club_ids()) and public.has_permission('academy.program.manage', club_id));
create policy "seasons_update" on public.seasons for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('academy.program.manage', club_id));
alter table public.seasons force row level security;

create policy "age_groups_select" on public.age_groups for select
  using (
    club_id in (select public.user_club_ids())
    and exists (
      select 1 from public.club_memberships cm
      join public.roles r on r.id = cm.role_id
      where cm.user_id = auth.uid() and cm.club_id = age_groups.club_id and cm.status = 'active'
        and r.key not in ('accountant', 'scanner', 'coach')
    )
  );
create policy "age_groups_insert" on public.age_groups for insert
  with check (club_id in (select public.user_club_ids()) and public.has_permission('academy.program.manage', club_id));
create policy "age_groups_update" on public.age_groups for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('academy.program.manage', club_id));
alter table public.age_groups force row level security;

-- groups: staff (except Accountant/Scanner) see all in-club groups; Coach
-- sees only assigned groups (coach_id or assistant_coach_id = self),
-- read-only -- no I/U policy for Coach at all, per the matrix.
create policy "groups_select" on public.groups for select
  using (
    club_id in (select public.user_club_ids())
    and (
      exists (
        select 1 from public.club_memberships cm
        join public.roles r on r.id = cm.role_id
        where cm.user_id = auth.uid() and cm.club_id = groups.club_id and cm.status = 'active'
          and r.key not in ('accountant', 'scanner', 'coach')
      )
      or coach_id = auth.uid()
      or assistant_coach_id = auth.uid()
    )
  );
create policy "groups_insert" on public.groups for insert
  with check (club_id in (select public.user_club_ids()) and public.has_permission('academy.group.manage', club_id));
create policy "groups_update" on public.groups for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('academy.group.manage', club_id));
alter table public.groups force row level security;

create policy "group_schedule_slots_select" on public.group_schedule_slots for select
  using (
    exists (
      select 1 from public.groups g
      where g.id = group_id
        and g.club_id in (select public.user_club_ids())
        and (
          exists (
            select 1 from public.club_memberships cm
            join public.roles r on r.id = cm.role_id
            where cm.user_id = auth.uid() and cm.club_id = g.club_id and cm.status = 'active'
              and r.key not in ('accountant', 'scanner', 'coach')
          )
          or g.coach_id = auth.uid()
          or g.assistant_coach_id = auth.uid()
        )
    )
  );
create policy "group_schedule_slots_insert" on public.group_schedule_slots for insert
  with check (
    exists (
      select 1 from public.groups g
      where g.id = group_id
        and g.club_id in (select public.user_club_ids())
        and public.has_permission('academy.group.manage', g.club_id)
    )
  );
create policy "group_schedule_slots_update" on public.group_schedule_slots for update
  using (
    exists (
      select 1 from public.groups g
      where g.id = group_id
        and g.club_id in (select public.user_club_ids())
        and public.has_permission('academy.group.manage', g.club_id)
    )
  );
alter table public.group_schedule_slots force row level security;

-- ============================================================
-- Permissions -- academy.program.manage (programs/seasons/age_groups CRUD)
-- and academy.group.manage (groups/schedule CRUD), matching RLS_MATRIX.md's
-- two grouped rows exactly. Per the matrix, Platform Owner and Club Owner
-- are S (view) only on these two rows -- unlike bookings/invoices/payments
-- where Club Owner has full S,I,U,D, academy structure here is written as
-- Club Manager/Branch Manager (S,I,U) and Academy Manager (S,I,U,D)
-- territory, with Club Owner retaining oversight visibility but not
-- direct-edit capability. Taken as written (not re-interpreted the way
-- the Phase 6 club_owner booking gap was, since that was a provable
-- functional break -- a club owner literally couldn't book -- while
-- "owner delegates academy structure to Club Manager/Academy Manager" is
-- a plausible deliberate design, not an obvious defect).
-- ============================================================

insert into public.permissions (key, description) values
  ('academy.program.manage', 'Create/update programs, seasons, age groups'),
  ('academy.group.manage', 'Create/update groups and their weekly schedule')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_manager', 'branch_manager', 'academy_manager')
  and p.key in ('academy.program.manage', 'academy.group.manage')
on conflict do nothing;
