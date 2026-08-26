-- MASTER ADMIN + SHOP INTEGRATION, continued -- same v_via_support
-- dual-audit fix applied to create_shop_sale/return_shop_sale.
create or replace function public.create_shop_sale(
  p_club_id uuid,
  p_location_id uuid,
  p_customer_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_payment_reference text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_item jsonb;
  v_product public.shop_products;
  v_variant public.shop_product_variants;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_sale_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_invoice_item_id uuid;
  v_sale_item_id uuid;
  v_branch_id uuid;
  v_has_custody boolean;
  v_active_shift_id uuid;
  v_payment_id uuid;
  v_existing_sale_id uuid;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_customer_id is null then
    raise exception 'a customer is required for this sale';
  end if;

  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id))
    and public.has_platform_support_access(p_club_id, true);
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if not public.club_write_allowed(p_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new sales';
  end if;

  if p_idempotency_key is not null then
    select s.id into v_existing_sale_id
    from public.payments pay
    join public.payment_allocations pa on pa.payment_id = pay.id
    join public.shop_sales s on s.invoice_id = pa.invoice_id
    where pay.idempotency_key = p_idempotency_key and pay.club_id = p_club_id
    limit 1;
    if v_existing_sale_id is not null then
      return v_existing_sale_id;
    end if;
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'a sale must have at least one item';
  end if;

  if not exists (
    select 1 from public.shop_inventory_locations where id = p_location_id and club_id = p_club_id
  ) then
    raise exception 'inventory location not found in this club';
  end if;
  select branch_id into v_branch_id from public.shop_inventory_locations where id = p_location_id;
  if v_branch_id is null then
    select id into v_branch_id from public.branches where club_id = p_club_id and status = 'active' order by created_at limit 1;
  end if;
  if v_branch_id is null then
    raise exception 'this club has no active branch to attribute the sale to';
  end if;

  if not exists (
    select 1 from public.customers where id = p_customer_id and club_id = p_club_id
  ) then
    raise exception 'customer not found in this club';
  end if;

  if p_payment_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid payment method';
  end if;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'quantity')::numeric <= 0 then
      raise exception 'quantity must be positive';
    end if;

    select * into v_product from public.shop_products
    where id = (v_item->>'product_id')::uuid and club_id = p_club_id and status = 'active';
    if v_product.id is null then
      raise exception 'product not found or inactive';
    end if;

    if v_item->>'variant_id' is not null then
      select * into v_variant from public.shop_product_variants
      where id = (v_item->>'variant_id')::uuid and product_id = v_product.id and status = 'active';
      if v_variant.id is null then
        raise exception 'variant not found or inactive for this product';
      end if;
      v_unit_price := coalesce(v_variant.price_override, v_product.base_price);
    else
      if v_product.has_variants then
        raise exception 'this product requires a variant to be selected';
      end if;
      v_unit_price := v_product.base_price;
    end if;

    v_line_total := round(v_unit_price * (v_item->>'quantity')::numeric, 2);
    v_subtotal := v_subtotal + v_line_total;
  end loop;

  if p_payment_method = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = p_club_id and status = 'active';

    if v_has_custody then
      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = v_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash collection requires an active cash shift -- open one before collecting cash';
      end if;
    end if;
  end if;

  insert into public.shop_sales (club_id, location_id, customer_id, sold_by, status)
  values (p_club_id, p_location_id, p_customer_id, auth.uid(), 'completed')
  returning id into v_sale_id;

  v_invoice_number := public.issue_invoice_number(v_branch_id, p_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (p_club_id, v_branch_id, v_invoice_number, p_customer_id, 'issued', v_subtotal, 0, v_subtotal, now(), auth.uid())
  returning id into v_invoice_id;

  update public.shop_sales set invoice_id = v_invoice_id where id = v_sale_id;

  perform public.write_audit_log(
    p_club_id, 'invoice.issue', 'invoice', v_invoice_id, null,
    jsonb_build_object('invoice_number', v_invoice_number, 'total', v_subtotal, 'source', 'shop_sale'),
    null
  );

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_product from public.shop_products where id = (v_item->>'product_id')::uuid;
    if v_item->>'variant_id' is not null then
      select * into v_variant from public.shop_product_variants where id = (v_item->>'variant_id')::uuid;
      v_unit_price := coalesce(v_variant.price_override, v_product.base_price);
    else
      v_variant := null;
      v_unit_price := v_product.base_price;
    end if;
    v_line_total := round(v_unit_price * (v_item->>'quantity')::numeric, 2);

    insert into public.shop_sale_items (sale_id, product_id, variant_id, quantity, unit_price, line_total)
    values (v_sale_id, v_product.id, v_variant.id, (v_item->>'quantity')::numeric, v_unit_price, v_line_total)
    returning id into v_sale_item_id;

    insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
    values (v_invoice_id, coalesce(v_product.name_ar, v_product.name_en), 'shop_sale_item', v_sale_item_id, (v_item->>'quantity')::numeric, v_unit_price, v_line_total)
    returning id into v_invoice_item_id;

    update public.shop_sale_items set invoice_item_id = v_invoice_item_id where id = v_sale_item_id;

    perform public._apply_shop_inventory_movement_internal(
      p_location_id, v_product.id, v_variant.id, 'sale', (v_item->>'quantity')::numeric, 'out',
      auth.uid(), 'shop_sale', v_sale_id, null, null
    );
  end loop;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key, cash_shift_id)
  values (p_club_id, v_branch_id, p_customer_id, p_payment_method, v_subtotal, p_payment_reference, auth.uid(), p_idempotency_key, v_active_shift_id)
  returning id into v_payment_id;

  perform public.write_audit_log(
    p_club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', v_subtotal, 'method', p_payment_method, 'invoice_id', v_invoice_id, 'source', 'shop_sale'),
    null
  );

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, v_invoice_id, v_subtotal);

  perform public.write_audit_log(
    p_club_id, 'sale.completed', 'shop_sale', v_sale_id, null,
    jsonb_build_object('location_id', p_location_id, 'customer_id', p_customer_id, 'subtotal', v_subtotal, 'invoice_id', v_invoice_id, 'payment_id', v_payment_id),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id, 'sale.completed', 'shop_sale', v_sale_id, null,
      jsonb_build_object('location_id', p_location_id, 'customer_id', p_customer_id, 'subtotal', v_subtotal, 'invoice_id', v_invoice_id, 'payment_id', v_payment_id),
      null
    );
  end if;

  return v_sale_id;
end;
$$;

create or replace function public.return_shop_sale(
  p_sale_id uuid,
  p_lines jsonb,
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
  v_via_support boolean;
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
  if v_sale.status not in ('completed', 'partially_returned') then
    raise exception 'this sale cannot be returned in its current status';
  end if;

  insert into public.shop_sale_returns (sale_id, club_id, processed_by, restock, reason)
  values (p_sale_id, v_sale.club_id, auth.uid(), p_restock, p_reason)
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
