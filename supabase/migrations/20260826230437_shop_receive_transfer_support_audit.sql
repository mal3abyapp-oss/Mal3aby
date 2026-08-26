-- MASTER ADMIN + SHOP INTEGRATION (2026-08-26) -- fixes a real gap
-- caught by live testing: every Shop write RPC's authorization check
-- already correctly allows a MANAGE support session
-- (has_platform_support_access(club_id, true)), and actor_id is always
-- the real platform owner (never spoofable) -- but the audit trail
-- never distinguished "genuine club-staff action" from "platform admin
-- acting through support mode", unlike every Master Admin core RPC
-- (update_club_role, set_staff_role, etc, all of which dual-write via
-- write_audit_log_as_support() when the support path is what actually
-- granted access). Live-verified: a MANAGE-mode product creation
-- produced acting_as_platform_admin=false, support_session_id=null --
-- correct actor attribution, but a silently incomplete audit trail.
--
-- Fixed by adding the same v_via_support-computed dual-audit-write
-- pattern to receive_shop_stock/transfer_shop_stock. Every other line
-- of each function body is byte-preserved from its own last-applied
-- version.
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
  v_via_support boolean;
begin
  select club_id into v_club_id from public.shop_inventory_locations where id = p_location_id;
  if v_club_id is null then
    raise exception 'inventory location not found';
  end if;
  v_via_support := not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', v_club_id))
    and public.has_platform_support_access(v_club_id, true);
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', v_club_id) or v_via_support) then
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
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_club_id, 'inventory.received', 'shop_inventory_movement', v_movement_id,
      null, jsonb_build_object('location_id', p_location_id, 'product_id', p_product_id, 'variant_id', p_variant_id, 'quantity', p_quantity, 'unit_cost', p_unit_cost),
      p_notes
    );
  end if;

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
  v_via_support boolean;
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

  v_via_support := not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.transfer', v_club_id))
    and public.has_platform_support_access(v_club_id, true);
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('inventory.transfer', v_club_id) or v_via_support) then
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
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_club_id, 'inventory.transferred', 'shop_transfer', v_transfer_id,
      null, jsonb_build_object('source_location_id', p_source_location_id, 'dest_location_id', p_dest_location_id, 'product_id', p_product_id, 'variant_id', p_variant_id, 'quantity', p_quantity),
      p_notes
    );
  end if;

  return v_transfer_id;
end;
$$;
