-- SHOP MODULE UX HARDENING (2026-08-28) -- real production acceptance
-- pass found every Shop READ rpc (list_shop_products, list_shop_categories,
-- list_shop_inventory_locations, get_shop_inventory_balances,
-- get_shop_inventory_summary, list_shop_inventory_movements,
-- list_shop_product_variants, list_shop_sales) checked ONLY
-- user_club_ids() + a permission key (shop.view / inventory.view) --
-- never public._shop_module_active(p_club_id). Every WRITE rpc in the
-- same module (create_shop_category, receive_shop_stock, etc.) already
-- enforces this. Confirmed live and exploitable: a plain club_owner
-- role holds shop.view=true by default regardless of whether the Shop
-- module was ever platform-entitled or club-activated (real test:
-- club c0b02979-a49e-4338-bcac-d789ca397aeb, shop.entitled=false,
-- has_permission('shop.view', ...) still returned true, and
-- list_shop_products() succeeded rather than raising). This is a real
-- violation of the two-level module model's own stated guarantee ("if
-- not entitled: Shop cannot be accessed") -- read-only, same-tenant
-- only (not a cross-tenant leak), but a genuine defect: any staff
-- holding shop.view/inventory.view (the common case for a club owner)
-- could read Shop data via direct RPC call even for a club that was
-- never entitled, independent of the client-side RequireShopModule
-- guard which only protects the rendered UI.
--
-- Fixed by adding the same _shop_module_active(p_club_id) check every
-- write RPC already has, to every read RPC. Uses CREATE OR REPLACE so
-- the function's return signature and every existing grant/permission
-- is preserved unchanged -- only the authorization body is amended.

create or replace function public.list_shop_products(p_club_id uuid, p_search text default null, p_category_id uuid default null, p_status text default 'active')
returns table(product_id uuid, name_ar text, name_en text, category_id uuid, category_name_ar text, description text, image_url text, has_variants boolean, base_price numeric, sku text, barcode text, reorder_level integer, status text, created_at timestamptz)
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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  return query select c.id, c.name_ar, c.name_en, c.status from public.shop_categories c where c.club_id = p_club_id and c.status = 'active' order by c.name_ar;
end;
$$;

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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  return query select l.id, l.kind, l.branch_id, l.name, l.status from public.shop_inventory_locations l where l.club_id = p_club_id and l.status = 'active' order by l.name;
end;
$$;

create or replace function public.get_shop_inventory_balances(p_club_id uuid, p_location_id uuid default null, p_low_stock_only boolean default false)
returns table(location_id uuid, location_name text, product_id uuid, product_name_ar text, variant_id uuid, variant_label text, on_hand numeric, reorder_level integer)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select b.location_id, l.name, b.product_id, p.name_ar, b.variant_id,
         nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         b.on_hand, p.reorder_level
  from public.shop_inventory_balances b
  join public.shop_inventory_locations l on l.id = b.location_id
  join public.shop_products p on p.id = b.product_id
  left join public.shop_product_variants v on v.id = b.variant_id
  where b.club_id = p_club_id
    and (p_location_id is null or b.location_id = p_location_id)
    and (not p_low_stock_only or (p.reorder_level is not null and b.on_hand <= p.reorder_level))
  order by p.name_ar, l.name;
end;
$$;

create or replace function public.get_shop_inventory_summary(p_club_id uuid)
returns table(active_products bigint, total_on_hand numeric, low_stock_count bigint, out_of_stock_count bigint)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    (select count(*) from public.shop_products where club_id = p_club_id and status = 'active'),
    (select coalesce(sum(on_hand), 0) from public.shop_inventory_balances where club_id = p_club_id),
    (select count(*) from public.shop_inventory_balances b join public.shop_products p on p.id = b.product_id
     where b.club_id = p_club_id and p.reorder_level is not null and b.on_hand > 0 and b.on_hand <= p.reorder_level),
    (select count(*) from public.shop_inventory_balances where club_id = p_club_id and on_hand = 0);
end;
$$;

create or replace function public.list_shop_inventory_movements(p_club_id uuid, p_product_id uuid default null, p_location_id uuid default null, p_limit integer default 50, p_offset integer default 0)
returns table(movement_id uuid, location_name text, product_name_ar text, variant_label text, movement_type text, quantity numeric, unit_cost numeric, actor_id uuid, reference_type text, reference_id uuid, reason text, created_at timestamptz)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select m.id, l.name, p.name_ar,
         nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         m.movement_type, m.quantity, m.unit_cost, m.actor_id, m.reference_type, m.reference_id, m.reason, m.created_at
  from public.shop_inventory_movements m
  join public.shop_inventory_locations l on l.id = m.location_id
  join public.shop_products p on p.id = m.product_id
  left join public.shop_product_variants v on v.id = m.variant_id
  where m.club_id = p_club_id
    and (p_product_id is null or m.product_id = p_product_id)
    and (p_location_id is null or m.location_id = p_location_id)
  order by m.created_at desc
  limit p_limit offset p_offset;
end;
$$;

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
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select v.id, v.size, v.color, v.sku, v.barcode, v.price_override, v.status
  from public.shop_product_variants v
  where v.product_id = p_product_id
  order by v.size, v.color;
end;
$$;

create or replace function public.list_shop_sales(p_club_id uuid, p_status text default null, p_limit integer default 50, p_offset integer default 0)
returns table(sale_id uuid, invoice_number text, customer_name text, sold_by_name text, status text, total numeric, created_at timestamptz)
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
  select s.id, i.invoice_number, c.full_name, pr.full_name, s.status, i.total, s.created_at
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.club_id = p_club_id
    and (p_status is null or s.status = p_status)
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$$;
