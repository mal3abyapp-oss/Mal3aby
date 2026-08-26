-- COMMERCIAL MODULE ARCHITECTURE, continued -- create_shop_sale(): the
-- POS entrypoint. Follows _create_booking_internal's own precedent
-- exactly (confirmed via its full pg_get_functiondef) rather than
-- calling record_payment() -- see COMMERCIAL_DOMAIN_ARCHITECTURE.md
-- Section 6/7 for the full reasoning on why record_payment() is not
-- safely reusable here (its branch-scope derivation is hard-coded to
-- bookings/subscriptions/club_membership_subscriptions and would
-- reject every cash shop sale from a custody-holding cashier).
--
-- Stock deduction timing (directive Section 38, decided explicitly in
-- COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 6): this phase only
-- creates ALREADY-PAID sales (p_payment_amount must cover the full
-- total) -- no draft/unpaid shop invoice ever exists, so there is no
-- "stock held for an abandoned unpaid invoice" scenario to guard
-- against. Every successful call is a single atomic transaction:
-- price/line-total recompute from the live product row (never trusted
-- from the client, directive Section 29/30/90) -> cash-shift gate ->
-- invoice+items -> stock deduction per line -> payment+allocation ->
-- audit.
create or replace function public.create_shop_sale(
  p_club_id uuid,
  p_location_id uuid,
  p_customer_id uuid,
  p_items jsonb, -- [{product_id, variant_id, quantity}, ...]
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
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id)
          or public.has_platform_support_access(p_club_id, true)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if not public.club_write_allowed(p_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new sales';
  end if;

  -- Idempotency (directive Section 40) -- mirrors payments.idempotency_key's
  -- own existing convention (unique per club, confirmed via schema
  -- read -- not globally unique, so scoping by club_id here is
  -- correct and sufficient, matching record_payment()'s own identical
  -- lookup shape). A retried request with the same key returns the
  -- original sale instead of creating a second one. Joins through
  -- payment_allocations -> invoices -> shop_sales (the real linkage
  -- chain) rather than matching on club_id alone, so a coincidental
  -- key reuse across two different original requests (which
  -- idempotency_key's uniqueness already prevents at the DB level
  -- anyway) can never resolve to the wrong sale.
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
  -- v_branch_id is the location's OWN branch_id when it's a
  -- branch-kind location, or NULL for a club-level warehouse.
  -- Payments/invoices require a real branch_id (invoices.branch_id is
  -- NOT NULL, confirmed via schema read) -- a warehouse-origin sale
  -- falls back to the club's first active branch, since a warehouse
  -- has no branch of its own but the invoice still needs one for
  -- numbering/branch-scoped reporting.
  select branch_id into v_branch_id from public.shop_inventory_locations where id = p_location_id;
  if v_branch_id is null then
    select id into v_branch_id from public.branches where club_id = p_club_id and status = 'active' order by created_at limit 1;
  end if;
  if v_branch_id is null then
    raise exception 'this club has no active branch to attribute the sale to';
  end if;

  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and club_id = p_club_id
  ) then
    raise exception 'customer not found in this club';
  end if;

  if p_payment_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid payment method';
  end if;

  -- Server-authoritative price/quantity pass (directive Section 29/30/90/91)
  -- -- every line's price is re-derived from the live shop_products/
  -- shop_product_variants row here; nothing from p_items beyond
  -- product_id/variant_id/quantity is trusted.
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

  -- Insert sale + invoice + items + stock deduction.
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

  -- Payment -- inline, mirroring _create_booking_internal's own
  -- pattern exactly (NOT record_payment(), see this migration's own
  -- header comment for why).
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

  return v_sale_id;
end;
$$;

revoke all on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid) from public;
revoke all on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid) from anon;
grant execute on function public.create_shop_sale(uuid, uuid, uuid, jsonb, text, text, uuid) to authenticated;
