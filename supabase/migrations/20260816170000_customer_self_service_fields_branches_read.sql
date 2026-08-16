-- Gate 3 continued: My Bookings needs to display the field/branch name
-- for each of a customer's own bookings. fields/branches SELECT
-- policies are staff-permission-gated only -- add narrow self-service
-- read access scoped to "this club actually has at least one of my own
-- bookings/enrollments" (not "any club I can name"), so a customer
-- can't browse an arbitrary club's field roster they have no
-- relationship with.
create policy "fields_self_service_select" on public.fields
  for select using (
    club_id in (select c.club_id from public.customers c where c.user_id = auth.uid())
  );

create policy "branches_self_service_select" on public.branches
  for select using (
    club_id in (select c.club_id from public.customers c where c.user_id = auth.uid())
  );
