-- NOTE: this migration's list_shop_stock_counts/get_shop_stock_count_detail
-- bodies referenced l.name_ar/l.name_en and v.name -- columns that do not
-- exist on shop_inventory_locations (single `name` column) or
-- shop_product_variants (no name column; size/color/sku instead). Caught
-- before any live call (plpgsql validates column references lazily, at
-- first invocation, not at CREATE FUNCTION time) and corrected in the very
-- next migration, 20260827002346_fix_shop_stock_count_read_rpcs_column_names_v2.sql.
-- Reconstructed here for migration/history parity with what was actually
-- applied; superseded immediately, never exploited or exposed live.
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
  select sc.id, sc.location_id, coalesce(l.name_ar, l.name_en), sc.status,
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

create or replace function public.get_shop_stock_count_detail(p_stock_count_id uuid)
returns table (
  id uuid, club_id uuid, location_id uuid, location_name text, status text,
  started_by uuid, started_at timestamptz, completed_by uuid, completed_at timestamptz,
  cancelled_by uuid, cancelled_at timestamptz, notes text,
  item_id uuid, product_id uuid, product_name text, variant_id uuid, variant_name text,
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
  select sc.id, sc.club_id, sc.location_id, coalesce(l.name_ar, l.name_en), sc.status,
    sc.started_by, sc.started_at, sc.completed_by, sc.completed_at, sc.cancelled_by, sc.cancelled_at, sc.notes,
    i.id, i.product_id, coalesce(p.name_ar, p.name_en), i.variant_id, v.name,
    i.system_quantity, i.counted_quantity, i.variance, i.movement_id
  from public.shop_stock_counts sc
  join public.shop_inventory_locations l on l.id = sc.location_id
  left join public.shop_stock_count_items i on i.stock_count_id = sc.id
  left join public.shop_products p on p.id = i.product_id
  left join public.shop_product_variants v on v.id = i.variant_id
  where sc.id = p_stock_count_id
  order by product_name, variant_name;
end;
$function$;

revoke all on function public.get_shop_stock_count_detail(uuid) from public, anon;
grant execute on function public.get_shop_stock_count_detail(uuid) to authenticated;
