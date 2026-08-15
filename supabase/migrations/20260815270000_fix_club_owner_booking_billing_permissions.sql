-- Fix: club_owner was under-granted booking/invoice/payment permissions in
-- Phase 6 (20260815220000_phase6_booking_billing_rls.sql granted only
-- booking.view/invoice.view/payment.view to club_owner, contradicting
-- RLS_MATRIX.md's `bookings` row which gives Club Owner the same S,I,U,D
-- as Club Manager). Discovered during Phase 8 live-data testing: a
-- club_owner test account could not create a booking at all.
--
-- Bring club_owner up to the same grant set as club_manager (per
-- RLS_MATRIX.md, Club Owner and Club Manager have identical access on
-- every booking/billing/qr row in the matrix).

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'club_owner'
  and p.key in (
    'booking.create', 'booking.update', 'booking.cancel',
    'booking.discount.apply', 'booking.discount.override',
    'invoice.create', 'invoice.update',
    'payment.create'
  )
on conflict do nothing;
