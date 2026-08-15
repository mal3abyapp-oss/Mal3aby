-- Phase 2 — Auth + Multi-Tenant Core + RLS
-- See docs/IMPLEMENTATION_PLAN.md Phase 2, docs/DATABASE_BLUEPRINT.md
-- "Identity & Access" + "Platform" sections, docs/RLS_MATRIX.md,
-- docs/RLS_SECURITY.md for the mandatory SECURITY DEFINER checklist.

-- ============================================================
-- TABLES
-- ============================================================

create table public.clubs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_ar text not null,
  name_en text,
  logo_url text,
  club_code text not null unique,
  currency text not null default 'EGP',
  timezone text not null default 'Africa/Cairo',
  tax_info jsonb,
  invoice_settings jsonb,
  subscription_activation_policy text not null default 'first_payment'
    check (subscription_activation_policy in ('manual', 'first_payment', 'full_payment')),
  -- Administrative only. NEVER 'grace_period' -- that is a derived platform
  -- subscription status, never a club status. See DECISIONS.md ADR-027.
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id)
);
comment on table public.clubs is 'Top-level tenant. No organizations layer above this in V1 (ADR-011). status is administrative only, never grace_period (ADR-027).';

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_code text not null,
  name text not null,
  address text,
  phone text,
  opening_hours jsonb,
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id),
  unique (club_id, branch_code)
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id),
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
comment on table public.profiles is '1:1 extension of auth.users. Auto-created via trigger on signup.';

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  name_ar text not null
);
comment on table public.roles is 'Seeded role catalogue -- reference/labeling only. Authorization decisions use permissions, never role keys (ADR-014).';

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  description text
);
comment on table public.permissions is 'The authorization source of truth.';

create table public.role_permissions (
  role_id uuid not null references public.roles(id),
  permission_id uuid not null references public.permissions(id),
  primary key (role_id, permission_id)
);

create table public.club_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  club_id uuid not null references public.clubs(id),
  role_id uuid not null references public.roles(id),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (user_id, club_id, role_id)
);
comment on table public.club_memberships is 'The RLS anchor table. No branch_id column -- see membership_branches (ADR-015).';

create table public.membership_branches (
  id uuid primary key default gen_random_uuid(),
  membership_id uuid not null references public.club_memberships(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  unique (membership_id, branch_id)
);
comment on table public.membership_branches is 'Zero rows = all branches of that club. One or more rows = restricted to exactly those branches (ADR-015).';

-- ============================================================
-- updated_at trigger (generic, reused across tables)
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_clubs_updated_at before update on public.clubs
  for each row execute function public.set_updated_at();
create trigger trg_branches_updated_at before update on public.branches
  for each row execute function public.set_updated_at();
create trigger trg_profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();
create trigger trg_club_memberships_updated_at before update on public.club_memberships
  for each row execute function public.set_updated_at();

-- ============================================================
-- profiles auto-creation trigger on auth.users insert
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (user_id, full_name)
  values (new.id, new.raw_user_meta_data->>'full_name');
  return new;
end;
$$;

create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- SECURITY DEFINER helper functions
-- Every function here follows docs/RLS_SECURITY.md's mandatory checklist:
-- pinned search_path, auth.uid()-only identity, no trusted client club_id.
-- ============================================================

create or replace function public.user_club_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select club_id from public.club_memberships
  where user_id = auth.uid() and status = 'active'
$$;

create or replace function public.has_permission(p_key text, p_club_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.club_memberships cm
    join public.role_permissions rp on rp.role_id = cm.role_id
    join public.permissions p on p.id = rp.permission_id
    where cm.user_id = auth.uid()
      and cm.club_id = p_club_id
      and cm.status = 'active'
      and p.key = p_key
  )
$$;

create or replace function public.has_branch_access(p_membership_id uuid, p_branch_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select
    not exists (select 1 from public.membership_branches where membership_id = p_membership_id)
    or exists (
      select 1 from public.membership_branches
      where membership_id = p_membership_id and branch_id = p_branch_id
    )
$$;

-- Restrict EXECUTE to the authenticated role only -- per RLS_SECURITY.md
-- rule 5, never leave a privileged function callable by PUBLIC/anon.
revoke execute on function public.user_club_ids() from public;
revoke execute on function public.has_permission(text, uuid) from public;
revoke execute on function public.has_branch_access(uuid, uuid) from public;
grant execute on function public.user_club_ids() to authenticated;
grant execute on function public.has_permission(text, uuid) to authenticated;
grant execute on function public.has_branch_access(uuid, uuid) to authenticated;

-- ============================================================
-- RLS: enable on every table
-- ============================================================

alter table public.clubs enable row level security;
alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.club_memberships enable row level security;
alter table public.membership_branches enable row level security;

-- ---- clubs ----
-- Any active member of the club can SELECT. Only platform_owner-permission
-- holders (checked via a platform-scoped membership row -- see seed data,
-- Platform Owner has a membership with club_id = NULL semantics handled
-- via a dedicated bypass below) can freely INSERT/UPDATE any club; a
-- Club Owner can UPDATE their own club's non-status fields.
create policy "clubs_select_own_club" on public.clubs
  for select using (id in (select public.user_club_ids()));

create policy "clubs_update_own_club_owner" on public.clubs
  for update using (
    id in (select public.user_club_ids())
    and public.has_permission('club.update', id)
  );

-- Platform Owner bypass: a permission held with NO club scoping requirement.
-- Modeled as a permission check against every club the platform_owner role
-- is a member of being irrelevant -- instead we grant platform_owner a
-- dedicated permission checked without club_id scoping.
create or replace function public.is_platform_owner()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.club_memberships cm
    join public.roles r on r.id = cm.role_id
    where cm.user_id = auth.uid()
      and cm.status = 'active'
      and r.key = 'platform_owner'
  )
$$;
revoke execute on function public.is_platform_owner() from public;
grant execute on function public.is_platform_owner() to authenticated;

create policy "clubs_platform_owner_full_access" on public.clubs
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

-- No DELETE policy on clubs -- clubs are closed (status='closed'), never deleted.

-- ---- branches ----
create policy "branches_select_own_club" on public.branches
  for select using (club_id in (select public.user_club_ids()));

create policy "branches_write_with_permission" on public.branches
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('branch.create', club_id)
  );

create policy "branches_update_with_permission" on public.branches
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('branch.update', club_id)
  );

create policy "branches_platform_owner_full_access" on public.branches
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

-- ---- profiles ----
create policy "profiles_select_own" on public.profiles
  for select using (user_id = auth.uid());

create policy "profiles_update_own" on public.profiles
  for update using (user_id = auth.uid());

create policy "profiles_select_same_club_staff" on public.profiles
  for select using (
    exists (
      select 1 from public.club_memberships cm1
      join public.club_memberships cm2 on cm2.club_id = cm1.club_id
      where cm1.user_id = auth.uid()
        and cm1.status = 'active'
        and cm2.user_id = public.profiles.user_id
        and cm2.status = 'active'
    )
  );

create policy "profiles_platform_owner_read" on public.profiles
  for select using (public.is_platform_owner());

-- ---- roles / permissions / role_permissions ----
-- Reference/seed data: readable by any authenticated user, never
-- user-editable in V1 (no INSERT/UPDATE/DELETE policy exists).
create policy "roles_select_all_authenticated" on public.roles
  for select using (auth.uid() is not null);

create policy "permissions_select_all_authenticated" on public.permissions
  for select using (auth.uid() is not null);

create policy "role_permissions_select_all_authenticated" on public.role_permissions
  for select using (auth.uid() is not null);

-- ---- club_memberships ----
create policy "club_memberships_select_own" on public.club_memberships
  for select using (user_id = auth.uid());

create policy "club_memberships_select_same_club_staff" on public.club_memberships
  for select using (club_id in (select public.user_club_ids()));

create policy "club_memberships_write_with_permission" on public.club_memberships
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('staff.create', club_id)
  );

create policy "club_memberships_update_with_permission" on public.club_memberships
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('staff.update', club_id)
  );

create policy "club_memberships_platform_owner_full_access" on public.club_memberships
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

-- ---- membership_branches ----
create policy "membership_branches_select_same_club" on public.membership_branches
  for select using (
    exists (
      select 1 from public.club_memberships cm
      where cm.id = membership_id
        and cm.club_id in (select public.user_club_ids())
    )
  );

create policy "membership_branches_write_with_permission" on public.membership_branches
  for insert with check (
    exists (
      select 1 from public.club_memberships cm
      where cm.id = membership_id
        and cm.club_id in (select public.user_club_ids())
        and public.has_permission('staff.update', cm.club_id)
    )
  );

create policy "membership_branches_delete_with_permission" on public.membership_branches
  for delete using (
    exists (
      select 1 from public.club_memberships cm
      where cm.id = membership_id
        and cm.club_id in (select public.user_club_ids())
        and public.has_permission('staff.update', cm.club_id)
    )
  );

create policy "membership_branches_platform_owner_full_access" on public.membership_branches
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

-- ============================================================
-- Explicit anon lockdown (added post-apply per get_advisors security scan).
-- Schema-level default grants in `public` otherwise leave newly created
-- functions anon-callable even after `revoke ... from public`; anon must
-- never call RLS-helper RPCs directly, and handle_new_user must never be
-- directly callable by anyone (trigger-only).
-- ============================================================

revoke execute on function public.user_club_ids() from anon;
revoke execute on function public.has_permission(text, uuid) from anon;
revoke execute on function public.has_branch_access(uuid, uuid) from anon;
revoke execute on function public.is_platform_owner() from anon;

revoke execute on function public.handle_new_user() from anon;
revoke execute on function public.handle_new_user() from authenticated;
revoke execute on function public.handle_new_user() from public;
