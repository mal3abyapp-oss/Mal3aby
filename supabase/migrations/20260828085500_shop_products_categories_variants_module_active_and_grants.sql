-- SHOP MODULE UX HARDENING (2026-08-28) -- same class of finding as
-- the two prior fixes this session (shop_suppliers, shop_inventory_locations),
-- found during a systematic sweep of every Shop table's RLS/grants
-- after those two fixes: shop_products, shop_product_variants, and
-- shop_categories each have real client-reachable INSERT/UPDATE RLS
-- policies gated on shop.product.manage, but none of the three checks
-- _shop_module_active(club_id) -- unlike every RPC that actually
-- writes to them today (create_shop_product, create_shop_category,
-- create_shop_product_variant, update_shop_product, etc., confirmed
-- by reading their definitions -- all already check the module-active
-- gate). Confirmed via a full grep of src/ that no current UI code
-- calls .from('shop_products'/'shop_categories'/'shop_product_variants')
-- directly (every write genuinely goes through the SECURITY DEFINER
-- RPCs, which write as table owner and are not subject to these
-- policies at all) -- so this is NOT currently reachable through the
-- app's own UI, same as the earlier-documented AR-1/whatsapp_accounts
-- "forced RLS + real policy but no live call path" pattern. Fixed
-- anyway for defense in depth and consistency: if a future UI change
-- (or a devtools-crafted direct PostgREST call against the broad
-- anon/authenticated grants also found and tightened here) ever wrote
-- to these tables directly, it must not be able to bypass the
-- module-active gate every RPC already enforces.
revoke all on public.shop_products from anon;
revoke all on public.shop_product_variants from anon;
revoke all on public.shop_categories from anon;
-- authenticated keeps select/insert/update (matching the existing real
-- policies' own cmd coverage -- no delete policy exists for any of the
-- three, matching the established soft-delete/archive convention).
revoke all on public.shop_products from authenticated;
revoke all on public.shop_product_variants from authenticated;
revoke all on public.shop_categories from authenticated;
grant select, insert, update on public.shop_products to authenticated;
grant select, insert, update on public.shop_product_variants to authenticated;
grant select, insert, update on public.shop_categories to authenticated;

drop policy if exists shop_products_insert on public.shop_products;
create policy shop_products_insert on public.shop_products
  for insert
  with check (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );

drop policy if exists shop_products_update on public.shop_products;
create policy shop_products_update on public.shop_products
  for update
  using (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );

drop policy if exists shop_product_variants_insert on public.shop_product_variants;
create policy shop_product_variants_insert on public.shop_product_variants
  for insert
  with check (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );

drop policy if exists shop_product_variants_update on public.shop_product_variants;
create policy shop_product_variants_update on public.shop_product_variants
  for update
  using (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );

drop policy if exists shop_categories_insert on public.shop_categories;
create policy shop_categories_insert on public.shop_categories
  for insert
  with check (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );

drop policy if exists shop_categories_update on public.shop_categories;
create policy shop_categories_update on public.shop_categories
  for update
  using (
    (
      (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
      or public.has_platform_support_access(club_id, true)
    )
    and public._shop_module_active(club_id)
  );
