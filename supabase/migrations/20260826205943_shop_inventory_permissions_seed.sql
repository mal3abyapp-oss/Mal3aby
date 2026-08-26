-- COMMERCIAL MODULE ARCHITECTURE, continued -- new permission keys for
-- the Shop/Inventory domain, following the confirmed existing
-- convention (singular-noun.verb, lowercase, e.g. booking.create,
-- payment.refund -- verified via direct catalog read, not guessed).
insert into public.permissions (key, description) values
  ('shop.view', 'View the shop: products, sales, returns'),
  ('shop.product.manage', 'Create, edit, and archive shop products and variants'),
  ('shop.sale.create', 'Sell products at the point of sale'),
  ('shop.sale.refund', 'Process returns and refunds for shop sales'),
  ('inventory.view', 'View inventory balances and movement history'),
  ('inventory.receive', 'Receive new stock into a location'),
  ('inventory.adjust', 'Record stock adjustments, damage, and loss'),
  ('inventory.transfer', 'Transfer stock between locations'),
  ('inventory.count', 'Run and confirm physical stock counts'),
  ('inventory.cost.view', 'View product cost/margin data')
on conflict (key) do nothing;

-- Default role matrix (directive Section 72 -- conservative defaults,
-- reasoned per role, not blindly copying the example given):
--   club_owner: everything (matches its existing "full superset"
--     pattern, confirmed via role_permissions read).
--   accountant: financial visibility (shop.view, inventory.view,
--     inventory.cost.view, shop.sale.refund -- mirrors its existing
--     payment.refund/payment.view-only financial posture) but NOT
--     product/inventory mutation (mirrors its existing lack of
--     booking.create/field.create -- it verifies money, it doesn't
--     operate the floor).
--   receptionist: can sell (shop.view, shop.sale.create -- mirrors its
--     existing booking.create/payment.create operational posture) but
--     NOT refund, NOT inventory mutation, NOT product management
--     (mirrors its existing lack of payment.refund/pricing.update).
--   branch_manager/club_manager/academy_manager/coach/scanner: none by
--     default -- shop is a new domain these existing roles were never
--     scoped for; a club owner grants explicitly (custom role or a
--     future role-permission edit) if their operating model needs it,
--     rather than this migration silently expanding what an existing
--     role can already do.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'club_owner'
  and p.key in ('shop.view', 'shop.product.manage', 'shop.sale.create', 'shop.sale.refund',
                'inventory.view', 'inventory.receive', 'inventory.adjust', 'inventory.transfer',
                'inventory.count', 'inventory.cost.view')
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'accountant'
  and p.key in ('shop.view', 'shop.sale.refund', 'inventory.view', 'inventory.cost.view')
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'receptionist'
  and p.key in ('shop.view', 'shop.sale.create')
on conflict (role_id, permission_id) do nothing;

-- Permission dependency wiring (directive Section 73), reusing the
-- existing permission_dependencies table (permission_key, requires_key
-- -- text FKs to permissions.key, confirmed via direct schema read).
insert into public.permission_dependencies (permission_key, requires_key) values
  ('shop.product.manage', 'shop.view'),
  ('shop.sale.create', 'shop.view'),
  ('shop.sale.refund', 'shop.view'),
  ('inventory.receive', 'inventory.view'),
  ('inventory.adjust', 'inventory.view'),
  ('inventory.transfer', 'inventory.view'),
  ('inventory.count', 'inventory.view')
on conflict (permission_key, requires_key) do nothing;
