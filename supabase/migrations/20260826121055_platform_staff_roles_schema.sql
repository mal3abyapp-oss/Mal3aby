-- PLATFORM STAFF + PLATFORM ROLES & PERMISSIONS (2026-08-26) -- a second,
-- deliberately SEPARATE authorization domain from club roles/permissions
-- (directive Section 1/23: "Do not route Platform permissions through
-- has_permission() if that helper is club-scoped. Keep the two
-- authorization domains conceptually separate."). This is additive on
-- top of the just-shipped Master Admin support-context feature -- the
-- existing roles.key='platform_owner' row and is_platform_owner() stay
-- completely unchanged and remain the ultimate authority (every existing
-- Master Admin RLS policy/RPC that already depends on is_platform_owner()
-- keeps working byte-for-byte); platform_staff_memberships is a NEW,
-- finer-grained tier for platform EMPLOYEES who are not themselves the
-- Platform Owner.
--
-- Mirrors the existing club-side roles/club_roles/role_permissions/
-- club_role_permissions/club_memberships schema shape exactly (same
-- column names/types/constraints), just without a club_id (platform
-- roles are global, not per-tenant).

create table public.platform_roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name_ar text not null,
  name_en text not null,
  is_system boolean not null default true
);

create table public.platform_permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  group_key text not null
);

create table public.platform_role_permissions (
  platform_role_id uuid not null references public.platform_roles(id) on delete cascade,
  platform_permission_id uuid not null references public.platform_permissions(id) on delete cascade,
  primary key (platform_role_id, platform_permission_id)
);

-- Custom platform roles (directive Section 6): Platform Owner can create
-- roles like "Customer Support Level 1" with their own permission set,
-- separate from the 6 seeded system roles below.
create table public.platform_custom_roles (
  id uuid primary key default gen_random_uuid(),
  name_ar text not null,
  name_en text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.platform_custom_role_permissions (
  platform_custom_role_id uuid not null references public.platform_custom_roles(id) on delete cascade,
  platform_permission_id uuid not null references public.platform_permissions(id) on delete cascade,
  primary key (platform_custom_role_id, platform_permission_id)
);

-- platform_staff_memberships: the identity link (directive Section 4 --
-- "reuse the existing auth.users identity architecture... platform staff
-- records should reference the real auth user"). Exactly one of
-- platform_role_id / platform_custom_role_id set, mirroring
-- club_memberships_exactly_one_role's own CHECK constraint exactly.
create table public.platform_staff_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  platform_role_id uuid references public.platform_roles(id),
  platform_custom_role_id uuid references public.platform_custom_roles(id),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_staff_memberships_exactly_one_role
    check (((platform_role_id is not null) and (platform_custom_role_id is null))
        or ((platform_role_id is null) and (platform_custom_role_id is not null)))
);

create unique index platform_staff_memberships_one_active_per_user
  on public.platform_staff_memberships (user_id)
  where status = 'active';

-- Seed the 6 system platform roles (directive Section 5). platform_owner
-- here is a SEPARATE catalog entry from roles.key='platform_owner' (the
-- existing club_memberships-based one is_platform_owner() reads) --
-- deliberately not unified, to avoid ANY change to the already-shipped,
-- already-verified is_platform_owner()/Master Admin dependency chain.
-- This platform_roles.key='platform_owner' row exists so the NEW
-- has_platform_permission() layer has a complete, consistent role
-- catalog to reason about -- see the next migration for how the two
-- concepts are bridged safely (a real is_platform_owner()=true account
-- is always treated as holding every platform permission, without
-- requiring a redundant platform_staff_memberships row).
insert into public.platform_roles (key, name_ar, name_en, is_system) values
  ('platform_owner', 'مالك المنصة', 'Platform Owner', true),
  ('platform_admin', 'مدير المنصة', 'Platform Admin', true),
  ('platform_support', 'دعم فني للمنصة', 'Platform Support', true),
  ('platform_finance', 'الشؤون المالية للمنصة', 'Platform Finance', true),
  ('platform_operations', 'العمليات التشغيلية للمنصة', 'Platform Operations', true),
  ('platform_viewer', 'مشاهد المنصة', 'Platform Viewer', true);

-- Seed the platform permission catalog (directive Section 7, using the
-- project's actual existing terminology where it already has an
-- equivalent -- e.g. "support" matches the just-shipped
-- platform_support_sessions feature's own naming).
insert into public.platform_permissions (key, group_key) values
  ('platform.club.view', 'clubs'),
  ('platform.club.manage', 'clubs'),
  ('platform.club.suspend', 'clubs'),
  ('platform.support.start_view', 'support'),
  ('platform.support.start_manage', 'support'),
  ('platform.staff.view', 'staff'),
  ('platform.staff.create', 'staff'),
  ('platform.staff.update', 'staff'),
  ('platform.staff.disable', 'staff'),
  ('platform.staff.role.assign', 'staff'),
  ('platform.role.view', 'roles'),
  ('platform.role.create', 'roles'),
  ('platform.role.update', 'roles'),
  ('platform.role.delete', 'roles'),
  ('platform.permission.manage', 'roles'),
  ('platform.finance.view', 'finance'),
  ('platform.finance.manage', 'finance'),
  ('platform.subscription.view', 'finance'),
  ('platform.subscription.manage', 'finance'),
  ('platform.audit.view', 'audit'),
  ('platform.settings.view', 'settings'),
  ('platform.settings.manage', 'settings');

-- Default matrix (directive Section 26's worked example). platform_owner
-- gets every permission (belt-and-suspenders alongside the
-- is_platform_owner()-is-always-full-access bridge in the next
-- migration -- explicit here too so the Role Editor's own read screens
-- show a complete, honest picture rather than an empty set for this row).
insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r cross join public.platform_permissions p
where r.key = 'platform_owner';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key in ('platform.club.view','platform.club.manage','platform.staff.view','platform.staff.create',
               'platform.staff.update','platform.staff.disable','platform.staff.role.assign',
               'platform.role.view','platform.role.create','platform.role.update','platform.role.delete',
               'platform.permission.manage','platform.support.start_view','platform.support.start_manage',
               'platform.audit.view','platform.settings.view')
where r.key = 'platform_admin';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key in ('platform.club.view','platform.support.start_view','platform.audit.view')
where r.key = 'platform_support';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key in ('platform.club.view','platform.finance.view','platform.finance.manage',
               'platform.subscription.view','platform.subscription.manage','platform.audit.view')
where r.key = 'platform_finance';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key in ('platform.club.view','platform.club.manage','platform.support.start_view',
               'platform.support.start_manage','platform.audit.view')
where r.key = 'platform_operations';

insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key in ('platform.club.view','platform.audit.view')
where r.key = 'platform_viewer';
