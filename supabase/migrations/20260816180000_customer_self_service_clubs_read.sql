-- Gate 3 continued: My Bookings joins bookings -> clubs (for name_ar +
-- timezone display) -- needed alongside the fields/branches
-- self-service read policies added just before this.
create policy "clubs_self_service_select" on public.clubs
  for select using (
    id in (select c.club_id from public.customers c where c.user_id = auth.uid())
  );
