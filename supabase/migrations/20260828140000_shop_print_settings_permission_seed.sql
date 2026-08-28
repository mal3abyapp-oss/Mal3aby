-- Commerce Pro C4 (COMMERCE_PRO_UPGRADE_PLAN.md Section 3/14): new
-- permission key gating club branding / print-settings management.
-- Follows the exact pattern established in
-- 20260826205943_shop_inventory_permissions_seed.sql and
-- 20260828120000_shop_discount_permissions_seed.sql (key/description
-- insert, role grant, permission_dependencies row).
--
-- shop.settings.manage -- manage club branding fields used on printed
--   Shop documents (logo, trading name ar/en, address, phone, tax
--   number, commercial registration, footer note, return policy).
--   These live in the clubs.logo_url / clubs.tax_info / clubs.invoice_settings
--   columns (confirmed live via direct schema read -- see
--   20260815120000_phase2_identity_multitenant_rls.sql -- already exist,
--   confirmed unused anywhere in the app before this phase). This is a
--   NEW permission key, deliberately distinct from the existing
--   'club.update' permission that already gates the direct
--   clubs_update_own_club_owner RLS policy (club name/timezone/currency/
--   subscription-activation-policy etc.) -- the plan explicitly calls
--   for a dedicated key "for clarity", so writes to these specific
--   fields go through a new RPC (update_shop_print_settings, next
--   migration) gated on this permission rather than reusing the
--   broader club.update RLS policy, keeping "who can rebrand a club's
--   printed commercial documents" a separately grantable capability
--   from "who can change the club's core settings".
insert into public.permissions (key, description) values
  ('shop.settings.manage', 'Manage club branding and print settings used on Shop invoices/receipts (logo, trading name, address, tax/commercial-registration numbers, footer note, return policy)')
on conflict (key) do nothing;

-- club_owner: full control, matches its existing "full superset"
-- pattern across every other Shop permission (shop.discount.apply,
-- shop.product.manage, etc.). No other existing role is granted this
-- by default -- branding/print settings is an owner-level capability,
-- matching this codebase's existing posture on club.update itself
-- (only club_owner and Platform Owner can update a club's own record).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.key = 'club_owner'
  and p.key = 'shop.settings.manage'
on conflict (role_id, permission_id) do nothing;

-- Permission dependency: shop.settings.manage requires shop.view (you
-- must be able to see the shop module to manage its print settings) --
-- mirrors every other shop.* permission's dependency shape
-- (shop.product.manage -> shop.view, shop.discount.apply -> shop.sale.create).
insert into public.permission_dependencies (permission_key, requires_key) values
  ('shop.settings.manage', 'shop.view')
on conflict (permission_key, requires_key) do nothing;
