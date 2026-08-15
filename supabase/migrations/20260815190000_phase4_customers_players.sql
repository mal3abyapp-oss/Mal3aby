-- Phase 4 — Customers, Players, Guardians
-- See docs/IMPLEMENTATION_PLAN.md Phase 4, docs/DATABASE_BLUEPRINT.md
-- "People" section, docs/RLS_MATRIX.md role grants, docs/RLS_SECURITY.md
-- #sensitive-column-protection-medical_notes.

-- ============================================================
-- customers
-- ============================================================
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  full_name text not null,
  mobile_display text,
  normalized_mobile text,
  whatsapp text,
  email text,
  national_id text,
  date_of_birth date,
  gender text check (gender in ('male', 'female')),
  address text,
  notes text,
  photo_url text,
  emergency_contact jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id)
);
comment on table public.customers is 'Any person the club has a relationship with -- walk-in booker, guardian, or both. No hard unique constraint on mobile (ADR-012).';

create index idx_customers_club_id on public.customers (club_id);
create index idx_customers_club_normalized_mobile on public.customers (club_id, normalized_mobile) where normalized_mobile is not null;
create index idx_customers_club_full_name on public.customers (club_id, full_name);

create trigger trg_customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

-- ============================================================
-- players
-- ============================================================
create table public.players (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  full_name text not null,
  date_of_birth date,
  gender text check (gender in ('male', 'female')),
  photo_url text,
  medical_notes text,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id)
);
comment on table public.players is 'Academy participants, distinct from customers (ADR-002). medical_notes is sensitive, permission-gated (ADR-019) -- never in global search, protected via players_safe view.';

create index idx_players_club_id on public.players (club_id);
create index idx_players_club_full_name on public.players (club_id, full_name);

create trigger trg_players_updated_at before update on public.players
  for each row execute function public.set_updated_at();

-- players_safe: the column-restricted view every role without
-- player.medical_notes.view queries through (RLS_SECURITY.md's chosen
-- pattern -- restricted view, not column-level GRANT).
create view public.players_safe as
select id, club_id, full_name, date_of_birth, gender, photo_url, status, created_at, updated_at, created_by
from public.players;

alter view public.players_safe set (security_invoker = true);

-- ============================================================
-- guardian_links
-- ============================================================
create table public.guardian_links (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id),
  player_id uuid not null references public.players(id),
  relationship text not null check (relationship in ('father', 'mother', 'guardian', 'other')),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (customer_id, player_id)
);
comment on table public.guardian_links is 'Many-to-many between customers (as guardians) and players.';

-- Both sides must share the same club_id -- enforced via trigger since a
-- cross-table CHECK constraint can't reference two other tables directly.
create or replace function public.check_guardian_link_same_club()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_customer_club uuid;
  v_player_club uuid;
begin
  select club_id into v_customer_club from public.customers where id = new.customer_id;
  select club_id into v_player_club from public.players where id = new.player_id;

  if v_customer_club is null or v_player_club is null then
    raise exception 'customer or player not found';
  end if;

  if v_customer_club != v_player_club then
    raise exception 'customer and player must belong to the same club';
  end if;

  return new;
end;
$$;

create trigger trg_guardian_links_same_club before insert or update on public.guardian_links
  for each row execute function public.check_guardian_link_same_club();

create index idx_guardian_links_customer on public.guardian_links (customer_id);
create index idx_guardian_links_player on public.guardian_links (player_id);

-- ============================================================
-- New permissions (seeded below) + RLS
-- ============================================================
alter table public.customers enable row level security;
alter table public.players enable row level security;
alter table public.guardian_links enable row level security;

-- ---- customers ----
-- All roles below get SELECT except Coach/Scanner (per RLS_MATRIX.md).
create policy "customers_select_club_staff" on public.customers
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('customer.view', club_id)
  );

create policy "customers_insert_with_permission" on public.customers
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('customer.create', club_id)
  );

create policy "customers_update_with_permission" on public.customers
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('customer.update', club_id)
  );

create policy "customers_platform_owner_select" on public.customers
  for select using (public.is_platform_owner());

-- ---- players ----
create policy "players_select_club_staff" on public.players
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('player.view', club_id)
  );

create policy "players_insert_with_permission" on public.players
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('player.create', club_id)
  );

create policy "players_update_with_permission" on public.players
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('player.update', club_id)
  );

create policy "players_platform_owner_select" on public.players
  for select using (public.is_platform_owner());

grant select on public.players_safe to authenticated;

-- ---- guardian_links ----
create policy "guardian_links_select_club_staff" on public.guardian_links
  for select using (
    exists (
      select 1 from public.customers c
      where c.id = customer_id
        and c.club_id in (select public.user_club_ids())
        and public.has_permission('customer.view', c.club_id)
    )
  );

create policy "guardian_links_insert_with_permission" on public.guardian_links
  for insert with check (
    exists (
      select 1 from public.customers c
      where c.id = customer_id
        and c.club_id in (select public.user_club_ids())
        and public.has_permission('customer.update', c.club_id)
    )
  );

create policy "guardian_links_update_with_permission" on public.guardian_links
  for update using (
    exists (
      select 1 from public.customers c
      where c.id = customer_id
        and c.club_id in (select public.user_club_ids())
        and public.has_permission('customer.update', c.club_id)
    )
  );

create policy "guardian_links_platform_owner_select" on public.guardian_links
  for select using (public.is_platform_owner());

-- ============================================================
-- Seed new permissions + role grants
-- ============================================================
insert into public.permissions (key, description) values
  ('customer.view', 'View customers'),
  ('customer.create', 'Create a customer'),
  ('customer.update', 'Update a customer'),
  ('player.view', 'View players (excluding medical_notes)'),
  ('player.create', 'Create a player'),
  ('player.update', 'Update a player'),
  ('player.medical_notes.view', 'View a player''s medical notes'),
  ('player.medical_notes.update', 'Update a player''s medical notes')
on conflict (key) do nothing;

-- club_owner, club_manager: full customer+player CRUD + medical notes.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager')
  and p.key in ('customer.view', 'customer.create', 'customer.update',
                'player.view', 'player.create', 'player.update',
                'player.medical_notes.view', 'player.medical_notes.update')
on conflict do nothing;

-- branch_manager: same as club_manager per RLS_MATRIX (S,I,U on both,
-- no medical_notes access listed).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'branch_manager'
  and p.key in ('customer.view', 'customer.create', 'customer.update',
                'player.view', 'player.create', 'player.update')
on conflict do nothing;

-- receptionist: customers S,I,U; players S,I only (no update per matrix).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'receptionist'
  and p.key in ('customer.view', 'customer.create', 'customer.update',
                'player.view', 'player.create')
on conflict do nothing;

-- accountant: view only on both.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'accountant'
  and p.key in ('customer.view', 'player.view')
on conflict do nothing;

-- academy_manager: full customer+player CRUD + medical notes.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'academy_manager'
  and p.key in ('customer.view', 'customer.create', 'customer.update',
                'player.view', 'player.create', 'player.update',
                'player.medical_notes.view', 'player.medical_notes.update')
on conflict do nothing;

-- coach: player.view only (assigned groups -- group-scoping enforced in
-- Phase 10/12 when groups/sessions exist; club-level view for now).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'coach'
  and p.key in ('player.view')
on conflict do nothing;
