-- MEDIUM FINDING (2026-08-26), found by the same adversarial testing
-- pass as the critical balance-duplication bug: return_shop_sale() had
-- no idempotency protection at all. Live-reproduced: sell 2, return 1
-- (succeeds), immediately retry returning 1 more of the SAME line
-- (also succeeds, since 1 was still within the remaining balance) --
-- producing two separate shop_sale_returns rows and two separate
-- restock movements for what a real double-click/network-retry would
-- intend as ONE action. The existing returned_quantity <= quantity
-- check only prevents OVER-return, not a legitimate-looking repeat of
-- an already-completed partial return.
--
-- Fixed by adding p_idempotency_key (uuid, optional -- callers that
-- don't pass one get the pre-fix behavior unchanged, matching how
-- create_shop_sale/record_payment's own idempotency_key is optional
-- too) and a dedicated unique index on shop_sale_returns, mirroring
-- payments.idempotency_key's own (club_id, idempotency_key) partial
-- unique pattern exactly.
alter table public.shop_sale_returns add column idempotency_key uuid;

create unique index shop_sale_returns_club_idempotency_key_unique
  on public.shop_sale_returns (club_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.return_shop_sale(
  p_sale_id uuid,
  p_lines jsonb,
  p_restock boolean,
  p_refund_amount numeric default null,
  p_reason text default null,
  p_idempotency_key uuid default null
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
  v_via_support boolean;
  v_existing_return_id uuid;
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
  v_via_support := not (v_sale.club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.refund', v_sale.club_id))
    and public.has_platform_support_access(v_sale.club_id, true);
  if not (v_sale.club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.refund', v_sale.club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;

  -- Idempotency: a retried request with the same key returns the
  -- original return instead of double-processing (directive Section
  -- 16/40 -- "no duplicate return" under double-click/network retry).
  if p_idempotency_key is not null then
    select id into v_existing_return_id
    from public.shop_sale_returns
    where club_id = v_sale.club_id and idempotency_key = p_idempotency_key;
    if v_existing_return_id is not null then
      return v_existing_return_id;
    end if;
  end if;

  if v_sale.status not in ('completed', 'partially_returned') then
    raise exception 'this sale cannot be returned in its current status';
  end if;

  insert into public.shop_sale_returns (sale_id, club_id, processed_by, restock, reason, idempotency_key)
  values (p_sale_id, v_sale.club_id, auth.uid(), p_restock, p_reason, p_idempotency_key)
  returning id into v_return_id;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
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
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_sale.club_id, 'return.completed', 'shop_sale_return', v_return_id,
      null,
      jsonb_build_object('sale_id', p_sale_id, 'restock', p_restock, 'refund_id', v_refund_id, 'refund_amount', p_refund_amount, 'lines', p_lines),
      p_reason
    );
  end if;

  return v_return_id;
end;
$$;
