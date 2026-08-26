-- COMMERCIAL MODULE ARCHITECTURE, continued -- return_shop_sale():
-- Returns domain (directive Section 41-45, see
-- COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 8). Accepts a list of
-- {sale_item_id, quantity} lines, a restock flag, and an optional
-- refund amount. Enforces return_quantity <= remaining returnable
-- quantity per line (directive Section 41/43/92) and DENIES a
-- cross-sale/cross-club sale_item_id (directive Section 92).
-- restock=true creates a 'sale_return' inventory movement for each
-- line; refund_amount > 0 calls the existing create_refund() RPC
-- against the sale's own payment (directive Section 45 -- no parallel
-- refund engine). The two are independent (directive Section 42) --
-- restock without refund (goodwill exchange) and refund without
-- restock (damaged-on-return) are both valid combinations.
create or replace function public.return_shop_sale(
  p_sale_id uuid,
  p_lines jsonb, -- [{sale_item_id, quantity}, ...]
  p_restock boolean,
  p_refund_amount numeric default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sale public.shop_sales;
  v_line jsonb;
  v_sale_item public.shop_sale_items;
  v_return_id uuid;
  v_payment_id uuid;
  v_refund_id uuid;
  v_any_remaining_after boolean;
  v_all_returned boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'a reason is required for a return';
  end if;
  if jsonb_array_length(p_lines) = 0 then
    raise exception 'a return must have at least one line';
  end if;

  select * into v_sale from public.shop_sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception 'sale not found';
  end if;
  if not (v_sale.club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.refund', v_sale.club_id)
          or public.has_platform_support_access(v_sale.club_id, true)) then
    raise exception 'not authorized';
  end if;
  if v_sale.status not in ('completed', 'partially_returned') then
    raise exception 'this sale cannot be returned in its current status';
  end if;

  insert into public.shop_sale_returns (sale_id, club_id, processed_by, restock, reason)
  values (p_sale_id, v_sale.club_id, auth.uid(), p_restock, p_reason)
  returning id into v_return_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    -- Directive Section 92 -- server validates the sale_item genuinely
    -- belongs to THIS sale (and therefore this club) before touching
    -- anything; a tampered sale_item_id from a different sale/club is
    -- rejected here, not silently accepted.
    select * into v_sale_item from public.shop_sale_items
    where id = (v_line->>'sale_item_id')::uuid and sale_id = p_sale_id
    for update;
    if v_sale_item.id is null then
      raise exception 'this item does not belong to the specified sale';
    end if;

    if (v_line->>'quantity')::numeric <= 0 then
      raise exception 'return quantity must be positive';
    end if;
    if (v_line->>'quantity')::numeric > (v_sale_item.quantity - v_sale_item.returned_quantity) then
      raise exception 'cannot return more than the remaining sold quantity (remaining: %)', (v_sale_item.quantity - v_sale_item.returned_quantity);
    end if;

    insert into public.shop_sale_return_items (return_id, sale_item_id, quantity)
    values (v_return_id, v_sale_item.id, (v_line->>'quantity')::numeric);

    update public.shop_sale_items
    set returned_quantity = returned_quantity + (v_line->>'quantity')::numeric
    where id = v_sale_item.id;

    if p_restock then
      perform public._apply_shop_inventory_movement_internal(
        v_sale.location_id, v_sale_item.product_id, v_sale_item.variant_id, 'sale_return', (v_line->>'quantity')::numeric, 'in',
        auth.uid(), 'shop_sale_return', v_return_id, p_reason, null
      );
    end if;
  end loop;

  -- Refund -- reuses create_refund() unmodified against the sale's own
  -- payment (directive Section 45). create_refund() itself independently
  -- requires payment.refund (see COMMERCIAL_DOMAIN_ARCHITECTURE.md
  -- Section 6/9 -- both accountant and club_owner already hold it).
  if p_refund_amount is not null and p_refund_amount > 0 then
    select pay.id into v_payment_id
    from public.payment_allocations pa
    join public.payments pay on pay.id = pa.payment_id
    where pa.invoice_id = v_sale.invoice_id
    limit 1;
    if v_payment_id is null then
      raise exception 'no payment found for this sale to refund against';
    end if;
    v_refund_id := public.create_refund(v_payment_id, p_refund_amount, p_reason);

    update public.shop_sale_returns set refund_payment_id = v_refund_id where id = v_return_id;
  end if;

  -- Sale status transition (directive Section 39/43) -- 'returned'
  -- only when EVERY line's full quantity is now returned, else
  -- 'partially_returned'.
  select bool_or(quantity > returned_quantity), bool_and(quantity = returned_quantity)
  into v_any_remaining_after, v_all_returned
  from public.shop_sale_items where sale_id = p_sale_id;

  update public.shop_sales
  set status = case when v_all_returned then 'returned' else 'partially_returned' end
  where id = p_sale_id;

  perform public.write_audit_log(
    v_sale.club_id, 'return.completed', 'shop_sale_return', v_return_id,
    null,
    jsonb_build_object('sale_id', p_sale_id, 'restock', p_restock, 'refund_id', v_refund_id, 'refund_amount', p_refund_amount, 'lines', p_lines),
    p_reason
  );

  return v_return_id;
end;
$$;

revoke all on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text) from public;
revoke all on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text) from anon;
grant execute on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text) to authenticated;
