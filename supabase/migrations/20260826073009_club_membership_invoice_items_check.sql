-- Widen invoice_items.reference_type CHECK to allow 'club_membership' (additive only).
alter table public.invoice_items drop constraint invoice_items_reference_type_check;
alter table public.invoice_items add constraint invoice_items_reference_type_check
  check (reference_type = any (array['booking'::text, 'subscription'::text, 'registration_fee'::text, 'club_membership'::text, 'other'::text]));
