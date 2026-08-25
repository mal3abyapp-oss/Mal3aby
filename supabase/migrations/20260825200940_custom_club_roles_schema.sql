-- STAFF ACCESS CONTROL & CUSTOM ROLES -- Stage 3: data model.
--
-- Adds club-scoped custom roles ALONGSIDE the existing global roles /
-- permissions / role_permissions catalogue (confirmed in
-- docs/CURRENT_AUTHORIZATION_MODEL.md to be global-by-design, ADR-014,
-- "reference/labeling only, never user-editable in V1" -- deliberately
-- NOT modified here). permissions stays the single global capability
-- catalog; a custom role is just a different, club-owned way to compose
-- the same capability keys.
--
-- club_memberships gets a second, nullable FK (custom_role_id) alongside
-- the existing role_id. Exactly one of the two must be set -- a
-- membership is either a system role or a custom role, never both,
-- never neither. This preserves 100% backward compatibility: every
-- existing membership keeps role_id set and custom_role_id NULL, and
-- nothing about its behavior changes.

-- ---------------------------------------------------------------------
-- New permission keys needed for this phase's own role-management UI.
-- Matches the existing seeding convention (see seed.sql / phase
-- migrations): insert into permissions, then wire into role_permissions
-- for whichever EXISTING system roles should have them. Only club_owner
-- and club_manager get role-management power among system roles --
-- matches the existing pattern where staff.create/staff.update are
-- club_owner/club_manager-only today.
-- ---------------------------------------------------------------------
insert into public.permissions (key, description) values
  ('roles.view', 'View custom roles and their permission sets'),
  ('roles.manage', 'Create, edit, copy, or delete custom roles')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_owner' and p.key in ('roles.view', 'roles.manage')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_manager' and p.key in ('roles.view', 'roles.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------
-- club_roles: one row per custom role, owned by exactly one club.
-- ---------------------------------------------------------------------
create table public.club_roles (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name_ar text not null,
  name_en text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint club_roles_name_ar_not_blank check (length(trim(name_ar)) > 0),
  constraint club_roles_name_en_not_blank check (length(trim(name_en)) > 0),
  -- Case-insensitive uniqueness of the Arabic name within a club, so a
  -- Club Owner can't accidentally create two roles that look identical
  -- in the UI. English name is not required to be unique (some clubs
  -- may not bother filling in a meaningful one).
  constraint club_roles_name_ar_unique_per_club unique (club_id, name_ar)
);

comment on table public.club_roles is
  'Club-owned custom roles (STAFF ACCESS CONTROL phase, 2026-08-25). '
  'Sits alongside the global roles table -- NOT a replacement. A '
  'membership references either roles.id (system role) or club_roles.id '
  '(custom role), never both. See docs/CURRENT_AUTHORIZATION_MODEL.md.';

create index club_roles_club_id_idx on public.club_roles(club_id);

create trigger club_roles_set_updated_at
  before update on public.club_roles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- club_role_permissions: many-to-many, reuses the existing global
-- `permissions` catalog -- a custom role is just a different bag of the
-- same capability keys every system role already draws from.
-- ---------------------------------------------------------------------
create table public.club_role_permissions (
  club_role_id uuid not null references public.club_roles(id) on delete cascade,
  permission_id uuid not null references public.permissions(id) on delete cascade,
  primary key (club_role_id, permission_id)
);

comment on table public.club_role_permissions is
  'Many-to-many: which global permission keys a given custom club_role '
  'grants. Mirrors role_permissions'' shape exactly, scoped to one club''s '
  'custom role instead of a global system role.';

-- ---------------------------------------------------------------------
-- club_memberships: add the second, nullable FK. Exactly one of
-- role_id / custom_role_id must be set at all times.
-- ---------------------------------------------------------------------
alter table public.club_memberships
  add column custom_role_id uuid references public.club_roles(id);

alter table public.club_memberships
  alter column role_id drop not null;

alter table public.club_memberships
  add constraint club_memberships_exactly_one_role check (
    (role_id is not null and custom_role_id is null)
    or (role_id is null and custom_role_id is not null)
  );

comment on column public.club_memberships.custom_role_id is
  'Club-owned custom role (see club_roles). Exactly one of role_id / '
  'custom_role_id is set -- enforced by club_memberships_exactly_one_role. '
  'Every pre-existing membership keeps role_id set and this NULL.';

-- Every existing row already satisfies the new CHECK constraint
-- (role_id was NOT NULL before this migration and remains set for
-- every existing membership; custom_role_id is new and NULL by
-- default) -- confirmed no backfill is required.
