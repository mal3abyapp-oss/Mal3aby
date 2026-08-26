-- COMMERCIAL MODULE ARCHITECTURE, continued -- public inventory write
-- RPCs: transfer and adjust.

-- transfer_shop_stock(): ONE business event, two linked movements
-- (directive Section 22). Both movements share reference_type=
-- 'shop_transfer'/reference_id=<this transfer's own generated id> so
-- they can be found as a pair later. Atomic within the function's own
-- transaction -- if the 'out' half succeeds and the 'in' half then
-- fails for any reason, the whole function raises and Postgres rolls
-- back both (no half-transfer possible, directive Section 22).
create or replace function public.transfer_shop_stock(
  p_source_location_id uuid,
  p_dest_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_quantity numeric,
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

revoke all on function public.transfer_shop_stock(uuid, uuid, uuid, uuid, numeric, text) from public;
revoke all on function public.transfer_shop_stock(uuid, uuid, uuid, uuid, numeric, text) from anon;
grant execute on function public.transfer_shop_stock(uuid, uuid, uuid, uuid, numeric, text) to authenticated;

-- adjust_shop_stock(): covers increase/decrease/damage/loss (directive
-- Section 23/24) via an explicit p_movement_type param restricted to
-- exactly those four values -- reason is mandatory (enforced again
-- here even though the table CHECK already requires it, so the error
-- message is friendly rather than a raw constraint violation).
create or replace function public.adjust_shop_stock(
  p_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_movement_type text,
  p_quantity numeric,
  p_reason text
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

revoke all on function public.adjust_shop_stock(uuid, uuid, uuid, text, numeric, text) from public;
revoke all on function public.adjust_shop_stock(uuid, uuid, uuid, text, numeric, text) from anon;
grant execute on function public.adjust_shop_stock(uuid, uuid, uuid, text, numeric, text) to authenticated;
