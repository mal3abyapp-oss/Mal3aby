-- Enable + FORCE RLS on all 6 new tables. Read policies deliberately
-- allow ANY authenticated user to read platform_roles/platform_permissions
-- (the role/permission CATALOG itself -- names and keys, not who holds
-- them) -- mirrors the existing roles/permissions table convention
-- (role_permissions_select_all_authenticated etc., confirmed during this
-- session's earlier Roles & Permissions closure work) and is required for
-- the Role Editor UI to render group/permission labels at all. Everything
-- that reveals WHO holds WHAT (platform_role_permissions,
-- platform_custom_roles, platform_custom_role_permissions,
-- platform_staff_memberships) is gated on has_platform_permission()
-- (defined below) or is_platform_owner() -- default deny for every
-- ordinary club user (club_owner/club_manager/receptionist/customer),
-- confirmed by omission, same FORCE-RLS-plus-no-matching-policy
-- convention used throughout this project.

alter table public.platform_roles enable row level security;
alter table public.platform_roles force row level security;
create policy platform_roles_select_authenticated
  on public.platform_roles for select
  using (auth.uid() is not null);

alter table public.platform_permissions enable row level security;
alter table public.platform_permissions force row level security;
create policy platform_permissions_select_authenticated
  on public.platform_permissions for select
  using (auth.uid() is not null);

alter table public.platform_role_permissions enable row level security;
alter table public.platform_role_permissions force row level security;
create policy platform_role_permissions_select_authenticated
  on public.platform_role_permissions for select
  using (auth.uid() is not null);

alter table public.platform_custom_roles enable row level security;
alter table public.platform_custom_roles force row level security;

alter table public.platform_custom_role_permissions enable row level security;
alter table public.platform_custom_role_permissions force row level security;

alter table public.platform_staff_memberships enable row level security;
alter table public.platform_staff_memberships force row level security;

revoke all on public.platform_roles from anon;
revoke all on public.platform_permissions from anon;
revoke all on public.platform_role_permissions from anon;
revoke all on public.platform_custom_roles from anon;
revoke all on public.platform_custom_role_permissions from anon;
revoke all on public.platform_staff_memberships from anon;
grant select on public.platform_roles to authenticated;
grant select on public.platform_permissions to authenticated;
grant select on public.platform_role_permissions to authenticated;
grant select, insert, update, delete on public.platform_custom_roles to authenticated;
grant select, insert, update, delete on public.platform_custom_role_permissions to authenticated;
grant select, insert, update, delete on public.platform_staff_memberships to authenticated;

-- has_platform_permission(): the ONE central helper for the platform
-- authorization domain -- deliberately never routes through
-- has_permission() (club-scoped, directive Section 23). A genuine
-- is_platform_owner()=true account (the existing, already-shipped
-- authority) is ALWAYS treated as holding every platform permission --
-- this is the safe bridge between the two role systems: the Platform
-- Owner never needs a redundant platform_staff_memberships row to use
-- their own console, and this can never be a privilege-escalation path
-- (is_platform_owner() itself is unchanged, unwidened, and still
-- club_memberships-role-based exactly as before this migration).
-- Otherwise, resolves the caller's own ACTIVE platform_staff_memberships
-- row (if any) and checks its role's (system or custom) permission set.
create or replace function public.has_platform_permission(p_key text)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    public.is_platform_owner()
    or exists (
      select 1
      from public.platform_staff_memberships psm
      left join public.platform_role_permissions prp on prp.platform_role_id = psm.platform_role_id
      left join public.platform_custom_role_permissions pcrp on pcrp.platform_custom_role_id = psm.platform_custom_role_id
      join public.platform_permissions pp on pp.id = coalesce(prp.platform_permission_id, pcrp.platform_permission_id)
      where psm.user_id = auth.uid()
        and psm.status = 'active'
        and pp.key = p_key
    )
$$;

revoke all on function public.has_platform_permission(text) from public;
revoke all on function public.has_platform_permission(text) from anon;
grant execute on function public.has_platform_permission(text) to authenticated;

-- caller_platform_permission_keys(): the platform-domain analogue of the
-- existing caller_permission_keys() -- used the same way, for escalation
-- checks on platform custom-role CRUD (a platform admin must not be able
-- to grant a platform permission they don't themselves hold), and for the
-- frontend Role Editor's own live access-summary preview.
create or replace function public.caller_platform_permission_keys()
returns setof text
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select key from public.platform_permissions where public.is_platform_owner()
  union
  select pp.key
  from public.platform_staff_memberships psm
  left join public.platform_role_permissions prp on prp.platform_role_id = psm.platform_role_id
  left join public.platform_custom_role_permissions pcrp on pcrp.platform_custom_role_id = psm.platform_custom_role_id
  join public.platform_permissions pp on pp.id = coalesce(prp.platform_permission_id, pcrp.platform_permission_id)
  where psm.user_id = auth.uid() and psm.status = 'active'
$$;

revoke all on function public.caller_platform_permission_keys() from public;
revoke all on function public.caller_platform_permission_keys() from anon;
grant execute on function public.caller_platform_permission_keys() to authenticated;

-- RLS for the "who holds what" tables, now that has_platform_permission()
-- exists.
create policy platform_custom_roles_select
  on public.platform_custom_roles for select
  using (public.has_platform_permission('platform.role.view'));
create policy platform_custom_roles_write
  on public.platform_custom_roles for all
  using (public.has_platform_permission('platform.role.create') or public.has_platform_permission('platform.role.update') or public.has_platform_permission('platform.role.delete'))
  with check (public.has_platform_permission('platform.role.create') or public.has_platform_permission('platform.role.update') or public.has_platform_permission('platform.role.delete'));

create policy platform_custom_role_permissions_select
  on public.platform_custom_role_permissions for select
  using (public.has_platform_permission('platform.role.view'));
create policy platform_custom_role_permissions_write
  on public.platform_custom_role_permissions for all
  using (public.has_platform_permission('platform.role.create') or public.has_platform_permission('platform.role.update'))
  with check (public.has_platform_permission('platform.role.create') or public.has_platform_permission('platform.role.update'));

create policy platform_staff_memberships_select
  on public.platform_staff_memberships for select
  using (public.has_platform_permission('platform.staff.view') or user_id = auth.uid());
create policy platform_staff_memberships_write
  on public.platform_staff_memberships for all
  using (public.has_platform_permission('platform.staff.create') or public.has_platform_permission('platform.staff.update') or public.has_platform_permission('platform.staff.disable'))
  with check (public.has_platform_permission('platform.staff.create') or public.has_platform_permission('platform.staff.update') or public.has_platform_permission('platform.staff.disable'));
