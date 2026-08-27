-- LAUNCH READINESS AUDIT findings (LOW): platform_owner_pinned_clubs
-- and platform_owner_recent_clubs were added in a later migration
-- batch (platform_staff_roles_schema / platform_club_directory_schema)
-- that missed two hardening passes already applied project-wide
-- elsewhere: FORCE ROW LEVEL SECURITY (would let the table owner role
-- bypass RLS -- narrow blast radius, single-owner convenience tables,
-- but inconsistent with 102/104 other tables) and the auth.uid()
-- initplan wrapping (unwrapped auth.uid() is re-evaluated per row
-- instead of once via InitPlan caching -- a real, if minor,
-- performance issue on these tables).
alter table public.platform_owner_pinned_clubs force row level security;
alter table public.platform_owner_recent_clubs force row level security;

drop policy if exists platform_owner_pinned_clubs_own_all on public.platform_owner_pinned_clubs;
create policy platform_owner_pinned_clubs_own_all on public.platform_owner_pinned_clubs
  for all
  using (platform_admin_user_id = (select auth.uid()) and public.is_platform_owner())
  with check (platform_admin_user_id = (select auth.uid()) and public.is_platform_owner());

drop policy if exists platform_owner_recent_clubs_own_select on public.platform_owner_recent_clubs;
create policy platform_owner_recent_clubs_own_select on public.platform_owner_recent_clubs
  for select
  using (platform_admin_user_id = (select auth.uid()));
