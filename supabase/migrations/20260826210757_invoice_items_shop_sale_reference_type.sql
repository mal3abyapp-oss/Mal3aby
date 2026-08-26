-- COMMERCIAL MODULE ARCHITECTURE, continued -- widens
-- invoice_items_reference_type_check (confirmed via discovery agent's
-- direct pg_get_constraintdef read: CHECK (reference_type = ANY
-- (ARRAY['booking','subscription','registration_fee','club_membership','other']))
-- to add 'shop_sale_item'. Every other invoice_items row/constraint
-- untouched.
alter table public.invoice_items drop constraint invoice_items_reference_type_check;
alter table public.invoice_items add constraint invoice_items_reference_type_check
  check (reference_type = any (array['booking', 'subscription', 'registration_fee', 'club_membership', 'shop_sale_item', 'other']));
