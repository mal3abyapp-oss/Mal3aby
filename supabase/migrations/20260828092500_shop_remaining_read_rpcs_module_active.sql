-- SHOP MODULE UX HARDENING (2026-08-28) -- closes out the systematic
-- module-active sweep started this session. The last 3 Shop read RPCs
-- still missing the _shop_module_active(club_id) check that every
-- other read/write RPC in this module now has (list_shop_products,
-- list_shop_categories, list_shop_inventory_locations,
-- get_shop_inventory_balances, get_shop_inventory_summary,
-- list_shop_inventory_movements, list_shop_product_variants,
-- list_shop_sales, plus the write RPCs fixed earlier this session).
create or replace function public.get_shop_sale_detail(p_sale_id uuid)
returns table(item_id uuid, product_name_ar text, variant_label text, quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.shop_sales where id = p_sale_id;
  if v_club_id is null then
    raise exception 'sale not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', v_club_id)
          or public.has_platform_support_access(v_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select si.id, p.name_ar, nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         si.quantity, si.unit_price, si.line_total, si.returned_quantity
  from public.shop_sale_items si
  join public.shop_products p on p.id = si.product_id
  left join public.shop_product_variants v on v.id = si.variant_id
  where si.sale_id = p_sale_id;
end;
$$;

create or replace function public.get_shop_stock_count_detail(p_stock_count_id uuid)
returns table(id uuid, club_id uuid, location_id uuid, location_name text, status text, started_by uuid, started_at timestamptz, completed_by uuid, completed_at timestamptz, cancelled_by uuid, cancelled_at timestamptz, notes text, item_id uuid, product_id uuid, product_name text, variant_id uuid, variant_label text, system_quantity numeric, counted_quantity numeric, variance numeric, movement_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select sc.club_id into v_club_id from public.shop_stock_counts sc where sc.id = p_stock_count_id;
  if v_club_id is null then
    raise exception 'stock count not found';
  end if;
  if not (
    (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', v_club_id))
    or public.has_platform_support_access(v_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select sc.id, sc.club_id, sc.location_id, l.name, sc.status,
    sc.started_by, sc.started_at, sc.completed_by, sc.completed_at, sc.cancelled_by, sc.cancelled_at, sc.notes,
    i.id, i.product_id, coalesce(p.name_ar, p.name_en),
    i.variant_id, nullif(trim(both ' ' from coalesce(v.color, '') || ' ' || coalesce(v.size, '')), ''),
    i.system_quantity, i.counted_quantity, i.variance, i.movement_id
  from public.shop_stock_counts sc
  join public.shop_inventory_locations l on l.id = sc.location_id
  left join public.shop_stock_count_items i on i.stock_count_id = sc.id
  left join public.shop_products p on p.id = i.product_id
  left join public.shop_product_variants v on v.id = i.variant_id
  where sc.id = p_stock_count_id
  order by product_name, variant_label;
end;
$$;

create or replace function public.list_shop_stock_counts(p_club_id uuid, p_location_id uuid default null, p_status text default null, p_limit integer default 50, p_offset integer default 0)
returns table(id uuid, location_id uuid, location_name text, status text, started_by uuid, started_at timestamptz, completed_by uuid, completed_at timestamptz, item_count bigint, variance_item_count bigint, notes text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (
    (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id))
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select sc.id, sc.location_id, l.name, sc.status,
    sc.started_by, sc.started_at, sc.completed_by, sc.completed_at,
    (select count(*) from public.shop_stock_count_items i where i.stock_count_id = sc.id),
    (select count(*) from public.shop_stock_count_items i where i.stock_count_id = sc.id and i.counted_quantity is not null and i.counted_quantity <> i.system_quantity),
    sc.notes
  from public.shop_stock_counts sc
  join public.shop_inventory_locations l on l.id = sc.location_id
  where sc.club_id = p_club_id
    and (p_location_id is null or sc.location_id = p_location_id)
    and (p_status is null or sc.status = p_status)
  order by sc.created_at desc
  limit least(p_limit, 200) offset p_offset;
end;
$$;
