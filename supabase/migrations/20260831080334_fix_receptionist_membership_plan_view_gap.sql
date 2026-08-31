-- STAFF OPERATIONS acceptance (2026-08-31): found live while exercising
-- the reception club-membership sale journey via RLS-impersonation as
-- the QA receptionist fixture. The receptionist built-in role has
-- club_membership.create (correctly, receptionists sell memberships at
-- the desk) but was missing club_membership.plan.view -- the permission
-- SellMembershipWizard's own plan picker (list_club_membership_plans)
-- actually requires. Result: the "Sell membership" button is rendered
-- unconditionally on MembersSection.tsx with no permission gate, so a
-- receptionist opening it hits list_club_membership_plans's "not
-- authorized" raise immediately and can never reach a plan to sell --
-- a real dead-end for a role explicitly granted the create permission.
--
-- Root cause: club_membership.create's own permission_dependencies row
-- only declares club_membership.view as a prerequisite (correct, but
-- incomplete) -- it never declared club_membership.plan.view, which is
-- the permission the actual UI flow needs. That dependency check is
-- also only enforced by create_club_role/update_club_role for CUSTOM
-- club roles (20260826004652_permission_dependency_enforcement.sql) --
-- built-in system roles are seeded directly via role_permissions
-- inserts in migrations and bypass it entirely, which is how this
-- specific gap shipped unnoticed. Confirmed every OTHER built-in role
-- holding club_membership.create (branch_manager, club_manager,
-- club_owner) already correctly also holds club_membership.plan.view --
-- receptionist was the sole outlier.
--
-- Fix, in the same two-part shape as every other permission-dependency
-- fix in this codebase (see shop.settings.manage -> shop.view):
--   1) Grant club_membership.plan.view to the receptionist role now,
--      unblocking the real runtime gap.
--   2) Add the missing permission_dependencies row so any FUTURE custom
--      role granting club_membership.create is correctly blocked from
--      omitting club_membership.plan.view by create_club_role/
--      update_club_role's existing enforcement.

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r, public.permissions p
where r.key = 'receptionist'
  and p.key = 'club_membership.plan.view'
on conflict do nothing;

insert into public.permission_dependencies (permission_key, requires_key) values
  ('club_membership.create', 'club_membership.plan.view')
on conflict (permission_key, requires_key) do nothing;
