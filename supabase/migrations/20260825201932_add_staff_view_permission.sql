-- STAFF ACCESS CONTROL & CUSTOM ROLES -- Stage 2 gap closure.
--
-- The permission catalog had staff.create/staff.update but no read-only
-- staff.view -- meaning there was no way to grant "can see the staff
-- list, cannot invite/edit/suspend anyone" (an explicitly named example
-- in the phase directive's permission catalog). Reads of club_memberships
-- were never actually gated by a permission at all (RLS policy
-- club_memberships_select_same_club_staff = "any active member of the
-- club", confirmed live) -- this key exists for the Role Editor UI and
-- future tightening, not because a live read-path was ungated-then-fixed.
--
-- Granted to exactly the two system roles that already see the 'staff'
-- nav domain today (club_owner, club_manager) -- zero visibility change
-- for any existing role.
insert into public.permissions (key, description) values
  ('staff.view', 'View the staff list and employee details, without inviting/editing/suspending')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager') and p.key = 'staff.view'
on conflict do nothing;
