-- PERF-05 (production audit remediation, 2026-09-03): list_shop_products
-- had no .limit()/.range() at all -- genuinely unbounded, confirmed by
-- reading its current live definition
-- (20260828100200_shop_product_media_category_ux_rpcs.sql, the latest
-- migration that actually redefines this function). Every call site
-- (ShopProductsPage.tsx's catalog view, ShopInventoryPage.tsx's product
-- pickers) fetched the club's ENTIRE product catalog on every load with
-- no server-side bound, growing linearly with catalog size forever.
--
-- Fix: append p_limit/p_offset (DEFAULT 50/0, matching the exact
-- convention already used by list_shop_inventory_movements and
-- list_shop_sales in this same module -- see
-- 20260828083000_shop_read_rpcs_enforce_module_active.sql) plus a
-- total_count column (count(*) over (), matching the convention used by
-- search_platform_clubs -- see
-- 20260901090000_add_clubs_is_test_fixture_marker.sql) so a caller can
-- render a "Load more" control and know when it has reached the end.
--
-- Signature change (new params) means `create or replace function`
-- would normally suffice, EXCEPT the RETURNS TABLE row shape also
-- changes (new total_count column) -- Postgres rejects an in-place
-- replace when the row shape changes ("cannot change return type of
-- existing function... Row type defined by OUT parameters is
-- different"), the exact same issue already hit and documented in
-- 20260828100200_shop_product_media_category_ux_rpcs.sql. Explicit
-- drop + create, matching that established pattern. Grants are
-- re-stated after, since a dropped function loses its prior grants.
--
-- Defaults (p_limit 50, p_offset 0) keep any not-yet-redeployed caller
-- working unchanged and bounded (previously-unbounded callers now get
-- the first 50 rows instead of erroring), while updated frontend call
-- sites pass explicit p_limit/p_offset to page through the full catalog.

begin;

drop function if exists public.list_shop_products(uuid, text, uuid, text);

create function public.list_shop_products(
  p_club_id uuid,
  p_search text default null,
  p_category_id uuid default null,
  p_status text default 'active',
  p_limit integer default 50,
  p_offset integer default 0
)
returns table(
  product_id uuid, name_ar text, name_en text, category_id uuid, category_name_ar text,
  description text, image_url text, has_variants boolean, base_price numeric,
  sku text, barcode text, reorder_level integer, status text, created_at timestamptz,
  image_urls jsonb, total_count bigint
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select p.id, p.name_ar, p.name_en, p.category_id, c.name_ar,
         p.description, p.image_url, p.has_variants, p.base_price,
         p.sku, p.barcode, p.reorder_level, p.status, p.created_at,
         p.image_urls,
         count(*) over ()::bigint as total_count
  from public.shop_products p
  left join public.shop_categories c on c.id = p.category_id
  where p.club_id = p_club_id
    and (p_status is null or p.status = p_status)
    and (p_category_id is null or p.category_id = p_category_id)
    and (p_search is null or p_search = '' or p.name_ar ilike '%' || p_search || '%' or p.name_en ilike '%' || p_search || '%' or p.sku ilike '%' || p_search || '%' or p.barcode = p_search)
  order by p.name_ar
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_products(uuid, text, uuid, text, integer, integer) from public;
revoke all on function public.list_shop_products(uuid, text, uuid, text, integer, integer) from anon;
grant execute on function public.list_shop_products(uuid, text, uuid, text, integer, integer) to authenticated;

commit;
