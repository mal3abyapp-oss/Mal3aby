-- MASTER ADMIN + SHOP INTEGRATION, continued -- same v_via_support
-- dual-audit fix applied to adjust_shop_stock.
create or replace function public.adjust_shop_stock(
  p_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid default null,
  p_movement_type text default 'adjustment_in',
  p_quantity numeric default 0,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_direction text;
  v_movement_id uuid;
  v_via_support boolean;
begin
  if p_movement_type not in ('adjustment_in', 'adjustment_out', 'damage', 'loss') then
    raise exception 'invalid adjustment type';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required for this adjustment';
  end if;
  v_direction := case when p_movement_type = 'adjustment_in' then 'in' else 'out' end;

  select club_id into v_club_id from public.shop_inventory_locations where id = p_location_id;
  if v_club_id is null then
    raise exception 'inventory location not found';
  end if;
  v_via_support := not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.adjust', v_club_id))
    and public.has_platform_support_access(v_club_id, true);
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.adjust', v_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  v_movement_id := public._apply_shop_inventory_movement_internal(
    p_location_id, p_product_id, p_variant_id, p_movement_type, p_quantity, v_direction,
    auth.uid(), null, null, p_reason, null
  );

  perform public.write_audit_log(
    v_club_id, 'inventory.adjusted', 'shop_inventory_movement', v_movement_id,
    null, jsonb_build_object('location_id', p_location_id, 'product_id', p_product_id, 'variant_id', p_variant_id, 'movement_type', p_movement_type, 'quantity', p_quantity),
    p_reason
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_club_id, 'inventory.adjusted', 'shop_inventory_movement', v_movement_id,
      null, jsonb_build_object('location_id', p_location_id, 'product_id', p_product_id, 'variant_id', p_variant_id, 'movement_type', p_movement_type, 'quantity', p_quantity),
      p_reason
    );
  end if;

  return v_movement_id;
end;
$$;
