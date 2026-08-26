-- COMMERCIAL MODULE ARCHITECTURE, continued -- public inventory write
-- RPCs: receive. Every one: entitlement gate (module must be
-- entitled+active) -> permission check -> tenant ownership validation
-- -> delegates the actual stock mutation to
-- _apply_shop_inventory_movement_internal() -> audit.

create or replace function public._shop_module_active(p_club_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(bool_and(entitled) and bool_and(active), false)
  from public.club_modules
  where club_id = p_club_id and module_key = 'shop'
$$;

revoke all on function public._shop_module_active(uuid) from public;
revoke all on function public._shop_module_active(uuid) from anon;
grant execute on function public._shop_module_active(uuid) to authenticated;

-- receive_shop_stock(): directive Section 20 -- atomic movement +
-- balance + audit. unit_cost captured for future costing use
-- (directive Section 49) but not surfaced as authoritative profit
-- anywhere yet.
create or replace function public.receive_shop_stock(
  p_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_quantity numeric,
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

revoke all on function public.receive_shop_stock(uuid, uuid, uuid, numeric, numeric, uuid, text) from public;
revoke all on function public.receive_shop_stock(uuid, uuid, uuid, numeric, numeric, uuid, text) from anon;
grant execute on function public.receive_shop_stock(uuid, uuid, uuid, numeric, numeric, uuid, text) to authenticated;
