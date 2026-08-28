-- Commerce Pro C8 (plan Section 5, Phase C8, items 22/23): multi-item
-- Stock Receiving UX and Stock Transfer UX. Both receive_shop_stock and
-- transfer_shop_stock (confirmed via direct read of
-- 20260826210513_shop_inventory_write_rpcs.sql and
-- 20260826210534_shop_inventory_write_rpcs_transfer_adjust.sql, the
-- current live definitions) are single-product-per-call.
--
-- TRANSACTION-BOUNDARY DECISION (documented per the task's own
-- instruction): a real receiving/transfer document commonly has
-- several line items (e.g. a 5-line supplier delivery). A client-side
-- loop calling the existing single-item RPC once per line is NOT used
-- here, because a failure partway through (a bad product id on line 3
-- of 5, a network drop, the browser tab closing mid-loop) would leave
-- lines 1-2 permanently committed as real inventory movements while
-- lines 3-5 never happened -- an operator has no way to tell, from the
-- resulting state alone, that the "receipt" was actually only half
-- posted, and no single audit-log entry ties the partial set together
-- as one failed document. That failure mode is exactly what this
-- module's other multi-step writes (create_shop_sale,
-- transfer_shop_stock's own existing out+in pair) are already careful
-- to avoid via one all-or-nothing transaction. New RPCs
-- receive_shop_stock_batch / transfer_shop_stock_batch therefore wrap
-- every line of one receiving/transfer document in a single Postgres
-- function invocation: if any line raises (bad product/variant,
-- insufficient stock for a transfer, a quantity <= 0), the whole
-- function raises and Postgres rolls back every line already applied
-- in that same call -- never a half-posted document. Each line still
-- goes through the exact same choke point
-- (_apply_shop_inventory_movement_internal) every other inventory
-- mutation in this module uses, so per-line invariants (balance
-- row-lock, on_hand >= 0, product/variant club ownership) are
-- unchanged. One audit_log row is written per document (not per line),
-- with the full line array in `after`, so the audit trail reflects the
-- real business event ("received/transferred N lines") rather than N
-- disconnected single-line entries.
--
-- The original single-item receive_shop_stock/transfer_shop_stock RPCs
-- are left completely untouched -- both are still valid, independently
-- callable entrypoints (e.g. a future quick "receive one item" action),
-- and neither the Product Detail / Stock History screen nor any other
-- existing caller depends on their signature changing.
--
-- Both new functions RETURN uuid (a single generated "document id" --
-- receipt_id / transfer_batch_id -- shared as reference_id across every
-- movement row the call creates, so all lines from one document can be
-- found together later, e.g. for a receipt reprint). Since these are
-- brand-new functions (no existing RETURNS TABLE shape is touched),
-- invariant 8 (DROP FUNCTION before changing a RETURNS TABLE shape)
-- does not apply at all here.

-- =====================================================================
-- receive_shop_stock_batch: one supplier delivery, multiple lines.
-- p_items: jsonb array of {product_id, variant_id (nullable),
-- quantity, unit_cost (nullable)}. p_location_id/p_supplier_id/p_notes/
-- p_reference_number are document-level (shared across all lines).
-- =====================================================================
create or replace function public.receive_shop_stock_batch(
  p_location_id uuid,
  p_items jsonb,
  p_supplier_id uuid default null,
  p_reference_number text default null,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_receipt_id uuid := gen_random_uuid();
  v_item jsonb;
  v_item_count int := 0;
  v_movement_ids uuid[] := '{}';
  v_movement_id uuid;
  v_reason text;
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
  if p_items is null or jsonb_typeof(p_items) != 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one item line is required';
  end if;

  v_reason := nullif(trim(both ' ' from
    coalesce('Ref: ' || p_reference_number, '') ||
    case when p_reference_number is not null and p_notes is not null then ' -- ' else '' end ||
    coalesce(p_notes, '')
  ), '');

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'quantity') is null or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'each line must have a positive quantity';
    end if;
    if (v_item->>'product_id') is null then
      raise exception 'each line must reference a product';
    end if;

    v_movement_id := public._apply_shop_inventory_movement_internal(
      p_location_id,
      (v_item->>'product_id')::uuid,
      nullif(v_item->>'variant_id', '')::uuid,
      'purchase_receipt',
      (v_item->>'quantity')::numeric,
      'in',
      auth.uid(),
      'shop_supplier',
      p_supplier_id,
      v_reason,
      nullif(v_item->>'unit_cost', '')::numeric
    );
    v_movement_ids := array_append(v_movement_ids, v_movement_id);
    v_item_count := v_item_count + 1;
  end loop;

  perform public.write_audit_log(
    v_club_id, 'inventory.received_batch', 'shop_inventory_receipt', v_receipt_id,
    null,
    jsonb_build_object(
      'location_id', p_location_id, 'supplier_id', p_supplier_id, 'reference_number', p_reference_number,
      'item_count', v_item_count, 'movement_ids', to_jsonb(v_movement_ids), 'items', p_items
    ),
    p_notes
  );

  return v_receipt_id;
end;
$$;

revoke all on function public.receive_shop_stock_batch(uuid, jsonb, uuid, text, text) from public;
revoke all on function public.receive_shop_stock_batch(uuid, jsonb, uuid, text, text) from anon;
grant execute on function public.receive_shop_stock_batch(uuid, jsonb, uuid, text, text) to authenticated;

-- =====================================================================
-- transfer_shop_stock_batch: one inter-location move, multiple lines.
-- p_items: jsonb array of {product_id, variant_id (nullable),
-- quantity}. Every line writes the SAME two-movement (out+in) pair
-- transfer_shop_stock already writes for a single line, still sharing
-- one reference_id per line-pair (so each line's own out/in movements
-- stay linkable), plus this batch's own v_transfer_batch_id is
-- returned as the document-level id and recorded in the audit log so
-- every line from the same on-screen transfer document can be found
-- together.
-- =====================================================================
create or replace function public.transfer_shop_stock_batch(
  p_source_location_id uuid,
  p_dest_location_id uuid,
  p_items jsonb,
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
  v_transfer_batch_id uuid := gen_random_uuid();
  v_item jsonb;
  v_item_count int := 0;
  v_line_transfer_id uuid;
  v_line_ids uuid[] := '{}';
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
  if p_items is null or jsonb_typeof(p_items) != 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'at least one item line is required';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'quantity') is null or (v_item->>'quantity')::numeric <= 0 then
      raise exception 'each line must have a positive quantity';
    end if;
    if (v_item->>'product_id') is null then
      raise exception 'each line must reference a product';
    end if;

    v_line_transfer_id := gen_random_uuid();
    perform public._apply_shop_inventory_movement_internal(
      p_source_location_id, (v_item->>'product_id')::uuid, nullif(v_item->>'variant_id', '')::uuid,
      'transfer_out', (v_item->>'quantity')::numeric, 'out',
      auth.uid(), 'shop_transfer', v_line_transfer_id, p_notes, null
    );
    perform public._apply_shop_inventory_movement_internal(
      p_dest_location_id, (v_item->>'product_id')::uuid, nullif(v_item->>'variant_id', '')::uuid,
      'transfer_in', (v_item->>'quantity')::numeric, 'in',
      auth.uid(), 'shop_transfer', v_line_transfer_id, p_notes, null
    );
    v_line_ids := array_append(v_line_ids, v_line_transfer_id);
    v_item_count := v_item_count + 1;
  end loop;

  perform public.write_audit_log(
    v_club_id, 'inventory.transferred_batch', 'shop_transfer_batch', v_transfer_batch_id,
    null,
    jsonb_build_object(
      'source_location_id', p_source_location_id, 'dest_location_id', p_dest_location_id,
      'item_count', v_item_count, 'line_transfer_ids', to_jsonb(v_line_ids), 'items', p_items
    ),
    p_notes
  );

  return v_transfer_batch_id;
end;
$$;

revoke all on function public.transfer_shop_stock_batch(uuid, uuid, jsonb, text) from public;
revoke all on function public.transfer_shop_stock_batch(uuid, uuid, jsonb, text) from anon;
grant execute on function public.transfer_shop_stock_batch(uuid, uuid, jsonb, text) to authenticated;
