-- Fixes 20260827002257_shop_stock_count_read_rpcs.sql: shop_inventory_locations
-- has a single `name` column (not name_ar/name_en), and shop_product_variants
-- has no name column at all (size/color/sku instead). Also updates
-- list_shop_stock_counts in place (return type unchanged, so a plain
-- CREATE OR REPLACE suffices there); get_shop_stock_count_detail's return
-- type changed (variant_name -> variant_label), which Postgres does not
-- allow via CREATE OR REPLACE for a RETURNS TABLE function -- dropped and
-- recreated instead.
create or replace function public.list_shop_stock_counts(
  p_club_id uuid, p_location_id uuid default null, p_status text default null,
  p_limit int default 50, p_offset int default 0
)
returns table (
  id uuid, location_id uuid, location_name text, status text,
  started_by uuid, started_at timestamptz, completed_by uuid, completed_at timestamptz,
  item_count bigint, variance_item_count bigint, notes text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (
    (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id))
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
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
$function$;

revoke all on function public.list_shop_stock_counts(uuid, uuid, text, int, int) from public, anon;
grant execute on function public.list_shop_stock_counts(uuid, uuid, text, int, int) to authenticated;

drop function if exists public.get_shop_stock_count_detail(uuid);

create function public.get_shop_stock_count_detail(p_stock_count_id uuid)
returns table (
  id uuid, club_id uuid, location_id uuid, location_name text, status text,
  started_by uuid, started_at timestamptz, completed_by uuid, completed_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz, notes text,
  item_id uuid, product_id uuid, product_name text, variant_id uuid, variant_label text,
  system_quantity numeric, counted_quantity numeric, variance numeric, movement_id uuid
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.shop_stock_counts where id = p_stock_count_id;
  if v_club_id is null then
    raise exception 'stock count not found';
  end if;
  if not (
    (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', v_club_id))
    or public.has_platform_support_access(v_club_id, false)
  ) then
    raise exception 'not authorized';
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
$function$;

revoke all on function public.get_shop_stock_count_detail(uuid) from public, anon;
grant execute on function public.get_shop_stock_count_detail(uuid) to authenticated;
