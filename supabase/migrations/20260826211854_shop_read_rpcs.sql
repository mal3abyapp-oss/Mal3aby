-- COMMERCIAL MODULE ARCHITECTURE, continued -- read RPCs the frontend
-- needs: product/variant listing with computed on-hand-at-location,
-- sales listing, low-stock. All permission-gated identically to their
-- write-side counterparts' view permission.

create or replace function public.list_shop_products(p_club_id uuid, p_search text default null, p_category_id uuid default null, p_status text default 'active')
returns table(
  product_id uuid, name_ar text, name_en text, category_id uuid, category_name_ar text,
  description text, image_url text, has_variants boolean, base_price numeric,
  sku text, barcode text, reorder_level integer, status text, created_at timestamptz
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

  return query
  select p.id, p.name_ar, p.name_en, p.category_id, c.name_ar,
         p.description, p.image_url, p.has_variants, p.base_price,
         p.sku, p.barcode, p.reorder_level, p.status, p.created_at
  from public.shop_products p
  left join public.shop_categories c on c.id = p.category_id
  where p.club_id = p_club_id
    and (p_status is null or p.status = p_status)
    and (p_category_id is null or p.category_id = p_category_id)
    and (p_search is null or p_search = '' or p.name_ar ilike '%' || p_search || '%' or p.name_en ilike '%' || p_search || '%' or p.sku ilike '%' || p_search || '%' or p.barcode = p_search)
  order by p.name_ar;
end;
$$;

revoke all on function public.list_shop_products(uuid, text, uuid, text) from public;
revoke all on function public.list_shop_products(uuid, text, uuid, text) from anon;
grant execute on function public.list_shop_products(uuid, text, uuid, text) to authenticated;

create or replace function public.list_shop_product_variants(p_product_id uuid)
returns table(variant_id uuid, size text, color text, sku text, barcode text, price_override numeric, status text)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.shop_products where id = p_product_id;
  if v_club_id is null then
    raise exception 'product not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', v_club_id)
          or public.has_platform_support_access(v_club_id, false)) then
    raise exception 'not authorized';
  end if;

  return query
  select v.id, v.size, v.color, v.sku, v.barcode, v.price_override, v.status
  from public.shop_product_variants v
  where v.product_id = p_product_id
  order by v.size, v.color;
end;
$$;

revoke all on function public.list_shop_product_variants(uuid) from public;
revoke all on function public.list_shop_product_variants(uuid) from anon;
grant execute on function public.list_shop_product_variants(uuid) to authenticated;

create or replace function public.list_shop_categories(p_club_id uuid)
returns table(category_id uuid, name_ar text, name_en text, status text)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  return query select c.id, c.name_ar, c.name_en, c.status from public.shop_categories c where c.club_id = p_club_id and c.status = 'active' order by c.name_ar;
end;
$$;

revoke all on function public.list_shop_categories(uuid) from public;
revoke all on function public.list_shop_categories(uuid) from anon;
grant execute on function public.list_shop_categories(uuid) to authenticated;

create or replace function public.list_shop_inventory_locations(p_club_id uuid)
returns table(location_id uuid, kind text, branch_id uuid, name text, status text)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  return query select l.id, l.kind, l.branch_id, l.name, l.status from public.shop_inventory_locations l where l.club_id = p_club_id and l.status = 'active' order by l.name;
end;
$$;

revoke all on function public.list_shop_inventory_locations(uuid) from public;
revoke all on function public.list_shop_inventory_locations(uuid) from anon;
grant execute on function public.list_shop_inventory_locations(uuid) to authenticated;
