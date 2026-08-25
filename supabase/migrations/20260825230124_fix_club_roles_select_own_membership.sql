-- STAFF ACCESS CONTROL & CUSTOM ROLES -- critical defect found via live
-- visual QA: club_roles_select required has_permission('roles.view', ...)
-- to see ANY row in club_roles, including a member's own assigned
-- custom role. Since most custom roles will NOT include roles.view by
-- design (a "Booking Viewer" role only needs booking.view), this meant
-- a custom-role member could never resolve their own role's name via
-- the embedded club_memberships -> club_roles PostgREST relation --
-- confirmed live: the real REST response returned club_roles: null for
-- the member's own active membership row despite custom_role_id being
-- genuinely set, which AuthProvider.tsx's own filter then correctly
-- (given the bad data) dropped, hiding the club from the club switcher
-- entirely -- a member literally could not see or select their own club.
--
-- FIX: add a SELECT policy letting any active member read their OWN
-- assigned custom role row, independent of roles.view. This mirrors
-- roles/permissions/role_permissions' own existing pattern (global
-- SELECT to any authenticated user) for the one row a member
-- structurally needs to resolve their own identity -- roles.view stays
-- the real gate for browsing OTHER custom roles in Role Editor/list.
create policy club_roles_select_own_assignment on public.club_roles
  for select
  using (
    exists (
      select 1 from public.club_memberships cm
      where cm.custom_role_id = club_roles.id
        and cm.user_id = auth.uid()
        and cm.status = 'active'
    )
  );
