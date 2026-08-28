-- Commerce Pro C3 (COMMERCE_PRO_UPGRADE_PLAN.md Section 3): new
-- permission keys gating POS discount application. Follows the exact
-- pattern established in 20260826205943_shop_inventory_permissions_seed.sql
-- (key/description insert, role grants, permission_dependencies row).
--
-- shop.discount.apply -- apply a discount (fixed amount or percentage)
--   at POS checkout. Mirrors the existing booking-domain precedent:
--   receptionist gets NO discount permission by default ("Receptionist
--   has no discount capability without an explicit grant" --
--   SECURITY_ANTI_FRAUD.md, see 20260815220000_phase6_booking_billing_rls.sql
--   comment) -- a club owner grants it explicitly per their own
--   operating model, exactly like booking.discount.apply today.
-- shop.discount.override_limit -- exceed a club-configured max-discount
--   threshold. Reserved for future use: this codebase has NO existing
--   discount-limit/max-discount-threshold concept anywhere (confirmed
--   via full grep of supabase/migrations and src/features/shop before
--   writing this migration) -- not on invoices, not on subscriptions,
--   not on bookings. Per the plan's own explicit instruction ("If a
--   club has no discount-limit concept configured anywhere, default to
--   'no limit enforced, shop.discount.apply alone is sufficient' and
--   document that as the deliberate default -- do not invent a limit
--   value from nothing"), this permission is seeded now (so the key
--   exists and role-composition can reference it once a limit concept
--   is built in a later phase) but is NOT checked anywhere in
--   create_shop_sale today -- shop.discount.apply alone is sufficient
--   to apply any discount amount up to the sale subtotal. This is a
--   deliberate default, not an oversight.
insert into public.permissions (key, description) values
  ('shop.discount.apply', 'Apply a discount (fixed amount or percentage) at POS checkout'),
  ('shop.discount.override_limit', 'Exceed a club-configured maximum discount threshold (reserved -- no discount-limit concept exists yet; unused until one is built)')
on conflict (key) do nothing;

-- club_owner: full control, matches its existing "full superset"
-- pattern across every other Shop permission.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'club_owner'
  and p.key in ('shop.discount.apply', 'shop.discount.override_limit')
on conflict (role_id, permission_id) do nothing;

-- receptionist: deliberately NOT granted, mirroring the booking
-- domain's own documented security gate (no discount capability
-- without an explicit grant). accountant: also not granted by default
-- -- it verifies money, it does not apply discounts at the point of
-- sale (mirrors its existing lack of shop.sale.create).

-- Permission dependency: shop.discount.apply requires shop.sale.create
-- (per the task's explicit instruction) -- a user cannot apply a
-- discount without also being able to create the sale it applies to.
-- shop.discount.override_limit requires shop.discount.apply (you can't
-- override a limit on a capability you don't have).
insert into public.permission_dependencies (permission_key, requires_key) values
  ('shop.discount.apply', 'shop.sale.create'),
  ('shop.discount.override_limit', 'shop.discount.apply')
on conflict (permission_key, requires_key) do nothing;
