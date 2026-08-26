-- COMMERCIAL MODULE ARCHITECTURE, continued -- inventory balance/
-- movement read RPCs.

create or replace function public.get_shop_inventory_balances(p_club_id uuid, p_location_id uuid default null, p_low_stock_only boolean default false)
returns table(
  location_id uuid, location_name text, product_id uuid, product_name_ar text,
  variant_id uuid, variant_label text, on_hand numeric, reorder_level integer
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
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

revoke all on function public.get_shop_inventory_balances(uuid, uuid, boolean) from public;
revoke all on function public.get_shop_inventory_balances(uuid, uuid, boolean) from anon;
grant execute on function public.get_shop_inventory_balances(uuid, uuid, boolean) to authenticated;

create or replace function public.list_shop_inventory_movements(p_club_id uuid, p_product_id uuid default null, p_location_id uuid default null, p_limit int default 50, p_offset int default 0)
returns table(
  movement_id uuid, location_name text, product_name_ar text, variant_label text,
  movement_type text, quantity numeric, unit_cost numeric, actor_id uuid,
  reference_type text, reference_id uuid, reason text, created_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
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

revoke all on function public.list_shop_inventory_movements(uuid, uuid, uuid, int, int) from public;
revoke all on function public.list_shop_inventory_movements(uuid, uuid, uuid, int, int) from anon;
grant execute on function public.list_shop_inventory_movements(uuid, uuid, uuid, int, int) to authenticated;
