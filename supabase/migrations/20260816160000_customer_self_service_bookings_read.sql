-- Gate 3 continued: give a self-service customer read-only visibility
-- into their OWN bookings -- the first real screen of the Unified User
-- Dashboard (My Bookings). Read-only: a customer can view but never
-- create/cancel/modify a booking directly through this policy --
-- booking mutations stay staff-mediated via create_booking()/the
-- BookingDetailSheet actions, matching how a real front-desk operation
-- works today. Self-service booking creation is a distinct, larger
-- follow-up (payment collection, deposit handling, etc. all need
-- design) and intentionally out of scope for this pass.
create policy "bookings_self_service_select" on public.bookings
  for select using (
    customer_id in (select id from public.customers where user_id = auth.uid())
  );
