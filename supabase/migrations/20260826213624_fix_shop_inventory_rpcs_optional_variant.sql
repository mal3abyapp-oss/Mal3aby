-- Same class of fix as the previous migration: receive_shop_stock/
-- transfer_shop_stock/adjust_shop_stock all had p_variant_id uuid with
-- no `default null`, even though every body already treats it as
-- optional (passed straight through to
-- _apply_shop_inventory_movement_internal, which itself accepts a
-- nullable variant_id for non-variant products by design). Adding
-- `default null` -- bodies unchanged.
create or replace function public.receive_shop_stock(
  p_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid default null,
  p_quantity numeric default 0,
  p_unit_cost numeric default null,
  p_supplier_id uuid default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_movement_id uuid;
begin
  select club_id into v_club_id from public.shop_inventory_locations where id = p_location_id;
  if v_club_id is null then
    raise exception 'inventory location not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', v_club_id)
          or public.has_platform_support_access(v_club_id, true)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from public.shop_suppliers where id = p_supplier_id and club_id = v_club_id
  ) then
    raise exception 'supplier does not belong to this club';
  end if;

  v_movement_id := public._apply_shop_inventory_movement_internal(
    p_location_id, p_product_id, p_variant_id, 'purchase_receipt', p_quantity, 'in',
    auth.uid(), 'shop_supplier', p_supplier_id, p_notes, p_unit_cost
  );

  perform public.write_audit_log(
    v_club_id, 'inventory.received', 'shop_inventory_movement', v_movement_id,
    null, jsonb_build_object('location_id', p_location_id, 'product_id', p_product_id, 'variant_id', p_variant_id, 'quantity', p_quantity, 'unit_cost', p_unit_cost),
    p_notes
  );

  return v_movement_id;
end;
$$;

create or replace function public.transfer_shop_stock(
  p_source_location_id uuid,
  p_dest_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid default null,
  p_quantity numeric default 0,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_dest_club_id uuid;
  v_transfer_id uuid := gen_random_uuid();
begin
  if p_source_location_id = p_dest_location_id then
    raise exception 'source and destination must be different locations';
  end if;

  select club_id into v_club_id from public.shop_inventory_locations where id = p_source_location_id;
  select club_id into v_dest_club_id from public.shop_inventory_locations where id = p_dest_location_id;
  if v_club_id is null or v_dest_club_id is null then
    raise exception 'inventory location not found';
  end if;
  if v_club_id != v_dest_club_id then
    raise exception 'cannot transfer stock across clubs';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.transfer', v_club_id)
          or public.has_platform_support_access(v_club_id, true)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  perform public._apply_shop_inventory_movement_internal(
    p_source_location_id, p_product_id, p_variant_id, 'transfer_out', p_quantity, 'out',
    auth.uid(), 'shop_transfer', v_transfer_id, p_notes, null
  );
  perform public._apply_shop_inventory_movement_internal(
    p_dest_location_id, p_product_id, p_variant_id, 'transfer_in', p_quantity, 'in',
    auth.uid(), 'shop_transfer', v_transfer_id, p_notes, null
  );

  perform public.write_audit_log(
    v_club_id, 'inventory.transferred', 'shop_transfer', v_transfer_id,
    null, jsonb_build_object('source_location_id', p_source_location_id, 'dest_location_id', p_dest_location_id, 'product_id', p_product_id, 'variant_id', p_variant_id, 'quantity', p_quantity),
    p_notes
  );

  return v_transfer_id;
end;
$$;

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
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.adjust', v_club_id)
          or public.has_platform_support_access(v_club_id, true)) then
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

  return v_movement_id;
end;
$$;
