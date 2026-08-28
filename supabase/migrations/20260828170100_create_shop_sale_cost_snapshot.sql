-- Commerce Pro C7: create_shop_sale gains cost-at-sale snapshot logic
-- (plan Section 5, item 1). This is create_shop_sale's 4th consecutive
-- extension in this engagement (partial payment, then discount, now
-- cost snapshot) -- same discipline as every prior one: the current
-- live body was read in full immediately before writing this file
-- (20260828120200_create_shop_sale_discount.sql, confirmed as latest
-- via direct migration read: `grep -rl "create or replace function
-- public.create_shop_sale" supabase/migrations/*.sql` and comparing
-- timestamps), and every existing line is preserved byte-for-byte.
--
-- Signature is UNCHANGED (still the same 10 params, same order) --
-- this migration only inserts new logic inside the existing per-item
-- loop that already builds shop_sale_items rows, computing and storing
-- v_unit_cost_snapshot alongside the existing v_unit_price/v_line_total
-- computation. create_shop_sale RETURNS uuid (a scalar), not
-- RETURNS TABLE, so invariant 8 (DROP FUNCTION before changing a
-- RETURNS TABLE row shape) does not apply here regardless -- a plain
-- CREATE OR REPLACE on an unchanged signature and unchanged return
-- type is safe, exactly as the plan's own invariant 8 text says for
-- this case ("an unchanged return shape... is a different function
-- identity to Postgres [only when parameters change]... CREATE OR
-- REPLACE... works fine there"). No DROP FUNCTION, no grant re-
-- statement needed since the signature never changes -- existing
-- grants on the 10-arg overload stay valid.
--
-- Derivation: for each sale line, before inserting into
-- shop_sale_items, look up the most recent purchase_receipt
-- unit_cost for (product_id, variant_id) across this club's own
-- inventory locations (correlated subquery, ordered by created_at
-- desc, limit 1) -- exact same "last cost, club-wide, not location-
-- scoped" method documented in the schema migration
-- (20260828170000_shop_cost_at_sale_snapshot.sql). Null when no such
-- movement exists yet for this unit -- never defaulted or inferred.
create or replace function public.create_shop_sale(
  p_club_id uuid, p_location_id uuid, p_customer_id uuid, p_items jsonb, p_payment_method text,
  p_payment_reference text default null, p_idempotency_key uuid default null, p_payment_amount numeric default null,
  p_discount_amount numeric default 0, p_discount_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item jsonb;
  v_product public.shop_products;
  v_variant public.shop_product_variants;
  v_unit_price numeric;
  v_line_total numeric;
  v_subtotal numeric := 0;
  v_discount_amount numeric;
  v_total numeric;
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
  v_payment_amount numeric;
  v_unit_cost_snapshot numeric;
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

  -- Discount gating: shop.discount.apply is required for ANY non-zero
  -- discount. No discount-limit concept exists anywhere in this
  -- codebase today (confirmed before writing this migration), so
  -- shop.discount.apply alone is sufficient -- shop.discount.override_limit
  -- is seeded (20260828120000_shop_discount_permissions_seed.sql) but
  -- deliberately not checked here; see that migration's comment for the
  -- full reasoning. This is a stated default, not an oversight.
  v_discount_amount := coalesce(p_discount_amount, 0);
  if v_discount_amount < 0 then
    raise exception 'discount amount cannot be negative';
  end if;
  if v_discount_amount > 0 and not (public.has_permission('shop.discount.apply', p_club_id) or v_via_support) then
    raise exception 'not authorized to apply a discount';
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
    -- Also cover the zero-payment edge case: a fully-unpaid sale created with this
    -- idempotency key would have no payment row at all to match on above.
    select s.id into v_existing_sale_id
    from public.shop_sales s
    where s.club_id = p_club_id and s.idempotency_key = p_idempotency_key;
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

  if v_discount_amount > v_subtotal then
    raise exception 'discount amount (%) cannot exceed the sale subtotal (%)', v_discount_amount, v_subtotal;
  end if;
  v_total := v_subtotal - v_discount_amount;

  -- Payment amount defaults to full total after discount (exact prior behavior,
  -- extended to discount-aware). A caller may pass a smaller amount to record a
  -- partial payment at the point of sale; the remaining balance is then collected
  -- later through the existing record_payment() RPC, which already enforces
  -- "cannot exceed outstanding balance" against this same invoice.
  v_payment_amount := coalesce(p_payment_amount, v_total);
  if v_payment_amount < 0 then
    raise exception 'payment amount cannot be negative';
  end if;
  if v_payment_amount > v_total then
    raise exception 'payment amount (%) cannot exceed the sale total after discount (%)', v_payment_amount, v_total;
  end if;

  if p_payment_method = 'cash' and v_payment_amount > 0 then
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

  insert into public.shop_sales (club_id, location_id, customer_id, sold_by, status, idempotency_key, discount_amount, discount_reason)
  values (p_club_id, p_location_id, p_customer_id, auth.uid(), 'completed', p_idempotency_key, v_discount_amount, nullif(btrim(p_discount_reason), ''))
  returning id into v_sale_id;

  v_invoice_number := public.issue_invoice_number(v_branch_id, p_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (p_club_id, v_branch_id, v_invoice_number, p_customer_id, 'issued', v_subtotal, v_discount_amount, v_total, now(), auth.uid())
  returning id into v_invoice_id;

  update public.shop_sales set invoice_id = v_invoice_id where id = v_sale_id;

  perform public.write_audit_log(
    p_club_id, 'invoice.issue', 'invoice', v_invoice_id, null,
    jsonb_build_object('invoice_number', v_invoice_number, 'subtotal', v_subtotal, 'discount', v_discount_amount, 'total', v_total, 'source', 'shop_sale'),
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

    -- Cost-at-sale snapshot (Commerce Pro C7): "last cost" -- the most
    -- recent purchase_receipt movement's unit_cost for this exact
    -- product/variant, club-wide (not scoped to p_location_id -- see
    -- this migration's own header comment for why). Null when this
    -- unit has never been received via receive_shop_stock -- never
    -- defaulted, never inferred from base_price.
    select m.unit_cost into v_unit_cost_snapshot
    from public.shop_inventory_movements m
    join public.shop_inventory_locations l on l.id = m.location_id
    where l.club_id = p_club_id
      and m.product_id = v_product.id
      and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        = coalesce(v_variant.id, '00000000-0000-0000-0000-000000000000'::uuid)
      and m.movement_type = 'purchase_receipt'
      and m.unit_cost is not null
    order by m.created_at desc
    limit 1;

    insert into public.shop_sale_items (sale_id, product_id, variant_id, quantity, unit_price, line_total, unit_cost_snapshot)
    values (v_sale_id, v_product.id, v_variant.id, (v_item->>'quantity')::numeric, v_unit_price, v_line_total, v_unit_cost_snapshot)
    returning id into v_sale_item_id;

    insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
    values (v_invoice_id, coalesce(v_product.name_ar, v_product.name_en), 'shop_sale_item', v_sale_item_id, (v_item->>'quantity')::numeric, v_unit_price, v_line_total)
    returning id into v_invoice_item_id;

    update public.shop_sale_items set invoice_item_id = v_invoice_item_id where id = v_sale_item_id;

    -- Stock is deducted here, at sale creation, regardless of v_payment_amount --
    -- see the function-level comment for the documented policy reasoning.
    perform public._apply_shop_inventory_movement_internal(
      p_location_id, v_product.id, v_variant.id, 'sale', (v_item->>'quantity')::numeric, 'out',
      auth.uid(), 'shop_sale', v_sale_id, null, null
    );
  end loop;

  if v_payment_amount > 0 then
    insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key, cash_shift_id)
    values (p_club_id, v_branch_id, p_customer_id, p_payment_method, v_payment_amount, p_payment_reference, auth.uid(), p_idempotency_key, v_active_shift_id)
    returning id into v_payment_id;

    perform public.write_audit_log(
      p_club_id, 'payment.record', 'payment', v_payment_id, null,
      jsonb_build_object('amount', v_payment_amount, 'method', p_payment_method, 'invoice_id', v_invoice_id, 'source', 'shop_sale'),
      null
    );

    insert into public.payment_allocations (payment_id, invoice_id, amount)
    values (v_payment_id, v_invoice_id, v_payment_amount);
  end if;

  perform public.write_audit_log(
    p_club_id, 'sale.completed', 'shop_sale', v_sale_id, null,
    jsonb_build_object(
      'location_id', p_location_id, 'customer_id', p_customer_id, 'subtotal', v_subtotal,
      'discount_amount', v_discount_amount, 'discount_reason', p_discount_reason, 'total', v_total,
      'paid_amount', v_payment_amount, 'invoice_id', v_invoice_id, 'payment_id', v_payment_id
    ),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id, 'sale.completed', 'shop_sale', v_sale_id, null,
      jsonb_build_object(
        'location_id', p_location_id, 'customer_id', p_customer_id, 'subtotal', v_subtotal,
        'discount_amount', v_discount_amount, 'discount_reason', p_discount_reason, 'total', v_total,
        'paid_amount', v_payment_amount, 'invoice_id', v_invoice_id, 'payment_id', v_payment_id
      ),
      null
    );
  end if;

  return v_sale_id;
end;
$function$;

-- No DROP FUNCTION needed: signature (10 params, same order/types) and
-- return type (uuid, scalar) are BOTH unchanged from the live version
-- this replaces -- Postgres treats this as the exact same function
-- identity, so CREATE OR REPLACE applies in place and existing grants
-- are preserved automatically. No re-statement needed, but re-stated
-- explicitly anyway (harmless, defense-in-depth, matches this
-- migration file being self-contained/re-runnable in isolation without
-- depending on a much earlier grant statement still being correct).
revoke all on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid, numeric, numeric, text) from public, anon;
grant execute on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid, numeric, numeric, text) to authenticated;
