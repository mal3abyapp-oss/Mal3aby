create or replace function public.record_shop_stock_count_line(
  p_stock_count_id uuid, p_product_id uuid, p_variant_id uuid default null, p_counted_quantity numeric default 0
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count public.shop_stock_counts;
  v_item_id uuid;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_counted_quantity < 0 then
    raise exception 'counted quantity cannot be negative';
  end if;

  select * into v_count from public.shop_stock_counts where id = p_stock_count_id;
  if v_count.id is null then
    raise exception 'stock count not found';
  end if;

  v_via_support := not (v_count.club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', v_count.club_id))
    and public.has_platform_support_access(v_count.club_id, true);
  if not (v_count.club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', v_count.club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;

  if v_count.status <> 'in_progress' then
    raise exception 'this stock count is not in progress -- cannot record counts';
  end if;

  if not exists (select 1 from public.shop_products where id = p_product_id and club_id = v_count.club_id) then
    raise exception 'product does not belong to this club';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from public.shop_product_variants where id = p_variant_id and product_id = p_product_id
  ) then
    raise exception 'variant does not belong to this product';
  end if;

  -- Upsert the line: if a snapshot row already exists for this product/variant (the normal
  -- case -- it was pre-populated at start), update it; otherwise this is a product with no
  -- prior balance row at this location (system_quantity 0), insert fresh.
  update public.shop_stock_count_items
  set counted_quantity = p_counted_quantity, counted_by = auth.uid(), counted_at = now()
  where stock_count_id = p_stock_count_id and product_id = p_product_id
    and coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  returning id into v_item_id;

  if v_item_id is null then
    insert into public.shop_stock_count_items (stock_count_id, product_id, variant_id, system_quantity, counted_quantity, counted_by, counted_at)
    values (p_stock_count_id, p_product_id, p_variant_id, 0, p_counted_quantity, auth.uid(), now())
    returning id into v_item_id;
  end if;

  return v_item_id;
end;
$function$;

revoke all on function public.record_shop_stock_count_line(uuid, uuid, uuid, numeric) from public, anon;
grant execute on function public.record_shop_stock_count_line(uuid, uuid, uuid, numeric) to authenticated;

create or replace function public.complete_shop_stock_count(p_stock_count_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count public.shop_stock_counts;
  v_item record;
  v_delta numeric;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- Lock the count row first so two concurrent completion attempts serialize here,
  -- not inside the movement engine -- the second one sees status='completed' and returns early.
  select * into v_count from public.shop_stock_counts where id = p_stock_count_id for update;
  if v_count.id is null then
    raise exception 'stock count not found';
  end if;

  v_via_support := not (v_count.club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', v_count.club_id))
    and public.has_platform_support_access(v_count.club_id, true);
  if not (v_count.club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', v_count.club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;

  -- Idempotent completion: a completed count is a fully valid terminal state to "complete" again --
  -- return the same id, post nothing twice. This is what makes retry/double-click safe.
  if v_count.status = 'completed' then
    return p_stock_count_id;
  end if;
  if v_count.status = 'cancelled' then
    raise exception 'a cancelled stock count cannot be completed';
  end if;
  if v_count.status <> 'in_progress' then
    raise exception 'stock count must be in progress to complete';
  end if;

  if exists (select 1 from public.shop_stock_count_items where stock_count_id = p_stock_count_id and counted_quantity is null) then
    raise exception 'every line must have a counted quantity before completion';
  end if;

  for v_item in
    select * from public.shop_stock_count_items where stock_count_id = p_stock_count_id
  loop
    v_delta := v_item.counted_quantity - v_item.system_quantity;
    if v_delta <> 0 then
      declare
        v_movement_id uuid;
      begin
        v_movement_id := public._apply_shop_inventory_movement_internal(
          v_count.location_id, v_item.product_id, v_item.variant_id, 'stock_count_adjustment',
          abs(v_delta), case when v_delta > 0 then 'in' else 'out' end,
          auth.uid(), 'shop_stock_count', p_stock_count_id,
          'stock count variance (system ' || v_item.system_quantity || ' -> counted ' || v_item.counted_quantity || ')',
          null
        );
        update public.shop_stock_count_items set movement_id = v_movement_id where id = v_item.id;
      end;
    end if;
  end loop;

  update public.shop_stock_counts
  set status = 'completed', completed_by = auth.uid(), completed_at = now(), updated_at = now()
  where id = p_stock_count_id;

  perform public.write_audit_log(
    v_count.club_id, 'inventory.stock_count.completed', 'shop_stock_count', p_stock_count_id, null,
    jsonb_build_object('location_id', v_count.location_id), null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_count.club_id, 'inventory.stock_count.completed', 'shop_stock_count', p_stock_count_id, null,
      jsonb_build_object('location_id', v_count.location_id), null
    );
  end if;

  return p_stock_count_id;
end;
$function$;

revoke all on function public.complete_shop_stock_count(uuid) from public, anon;
grant execute on function public.complete_shop_stock_count(uuid) to authenticated;
