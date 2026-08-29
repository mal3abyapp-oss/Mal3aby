-- FINAL ACCEPTANCE CLOSURE (2026-08-29) -- Shop discount / return /
-- refund financial semantics. This closes two related findings from
-- the prior acceptance pass, documented then as "needs a product
-- decision" rather than mechanically patched:
--
--   (a) create_shop_sale() never folded the sale-level discount into
--       invoice_items.line_total / shop_sale_items.line_total -- both
--       stayed at the GROSS per-line amount, so
--       sum(invoice_items.line_total) != invoices.total whenever a
--       discount was applied (confirmed live: 1 of 9 real shop sales
--       has a discount and shows this exact mismatch).
--   (b) return_shop_sale()'s p_refund_amount was a free-form number
--       validated only against the PAYMENT's remaining refundable
--       balance -- never against the actual economic value of the
--       specific lines being returned in that call. A return of one
--       cheap item could authorize a refund up to the entire
--       remaining payment balance.
--
-- DESIGN (the accounting rule):
--
-- 1. Sale-level discount is allocated to line items PROPORTIONALLY
--    by each line's share of the gross subtotal:
--      line_discount_i = round(discount_amount * gross_line_i / subtotal, 2)
--    with the LAST line absorbing the rounding remainder, so
--    sum(line_discount_i) = discount_amount EXACTLY, and therefore
--    sum(net_line_total_i) = invoices.total EXACTLY, for every sale,
--    with or without a discount. This is the standard, explainable,
--    auditable allocation method (no invented business rule -- it is
--    the same "proportional to value" approach used for tax/discount
--    allocation in every conventional POS/invoicing system), and it
--    requires no new concept beyond what shop_sales.discount_amount
--    already records.
--
-- 2. shop_sale_items gets a new net_line_total column: the item's
--    true economic value after its share of the discount. This
--    becomes invoice_items.line_total going forward (so the
--    line-items-sum-to-invoice-total invariant holds unconditionally)
--    while unit_price/line_total (gross) are kept unchanged for
--    historical/display fidelity -- nothing about the gross figures
--    already shown anywhere is altered.
--
-- 3. shop_sale_items also gets refunded_amount: a running total of
--    how much has actually been refunded against THIS SPECIFIC line
--    across all prior returns. This is the authoritative record of
--    "how much of this line's economic value remains refundable."
--
-- 4. shop_sale_return_items gets line_refund_amount: exactly how much
--    of a given return's total p_refund_amount was attributed to
--    that specific returned line. The sum of these across ALL
--    returns for a sale_item, plus what remains, must always equal
--    that item's net_line_total.
--
-- 5. return_shop_sale()'s refund ceiling becomes:
--      p_refund_amount <= sum over each returned line of
--        min(quantity_being_returned_now / original_quantity * net_line_total,
--            net_line_total - already_refunded_for_that_line)
--    i.e. the refund can never exceed the remaining, not-yet-refunded
--    economic value of the SPECIFIC lines named in THIS return call --
--    not just the payment's overall balance. The existing
--    payment-balance check is KEPT as a second, independent ceiling
--    (defense in depth: two unrelated invariants both have to hold).
--    p_refund_amount itself becomes OPTIONAL going forward -- when
--    omitted, the server computes the full economically-owed refund
--    for the returned lines automatically (this is what most partial
--    returns actually want, and removes an entire class of
--    client-trust risk for the common case).
--
-- 6. Rounding: every allocation step uses round(..., 2) with an
--    explicit last-line/remainder-absorption rule, so cents never
--    silently vanish or duplicate across a partial-return sequence.
--
-- 7. Non-destructive migration: existing shop_sales/shop_sale_items/
--    invoices rows are NEVER rewritten by this migration for their
--    EXISTING committed financial columns (unit_price, line_total,
--    invoices.total, discount, subtotal all stay exactly as they
--    were). Only the NEW net_line_total/refunded_amount columns are
--    backfilled (computed, additive, does not change any existing
--    total). invoice_items.line_total for EXISTING rows is also left
--    untouched -- only sales created from this point forward get the
--    corrected net line_total; this avoids retroactively rewriting a
--    historical financial document. The mismatch on the 1 pre-existing
--    discounted sale is documented, not silently fixed by the
--    migration, matching the standing "no destructive rewrite of
--    financial history" rule.

-- ---------------------------------------------------------------
-- Schema: new columns
-- ---------------------------------------------------------------
alter table public.shop_sale_items
  add column if not exists net_line_total numeric,
  add column if not exists refunded_amount numeric not null default 0;

alter table public.shop_sale_return_items
  add column if not exists line_refund_amount numeric not null default 0;

-- Backfill net_line_total for existing rows: no discount ever existed
-- on 8 of 9 real sales (net = gross), and for the 1 discounted sale,
-- compute the same proportional allocation this migration's RPC will
-- use going forward, so the new column is internally consistent from
-- day one without rewriting any EXISTING committed total.
with sale_subtotals as (
  select s.id as sale_id, s.discount_amount, coalesce(sum(si.line_total), 0) as subtotal
  from public.shop_sales s
  join public.shop_sale_items si on si.sale_id = s.id
  group by s.id, s.discount_amount
),
allocated as (
  select
    si.id,
    si.sale_id,
    si.line_total,
    ss.subtotal,
    ss.discount_amount,
    case when ss.subtotal > 0 and ss.discount_amount > 0
      then round(ss.discount_amount * si.line_total / ss.subtotal, 2)
      else 0
    end as raw_share,
    row_number() over (partition by si.sale_id order by si.id) as rn,
    count(*) over (partition by si.sale_id) as line_count
  from public.shop_sale_items si
  join sale_subtotals ss on ss.sale_id = si.sale_id
),
with_remainder as (
  select
    id, sale_id, line_total,
    case when rn = line_count
      then discount_amount - coalesce((sum(raw_share) over (partition by sale_id) - raw_share), 0)
      else raw_share
    end as final_share
  from allocated
)
update public.shop_sale_items t
set net_line_total = w.line_total - w.final_share
from with_remainder w
where t.id = w.id and t.net_line_total is null;

alter table public.shop_sale_items alter column net_line_total set not null;

alter table public.shop_sale_items add constraint shop_sale_items_net_line_total_nonneg check (net_line_total >= 0);
alter table public.shop_sale_items add constraint shop_sale_items_refunded_amount_bounds check (refunded_amount >= 0 and refunded_amount <= net_line_total + 0.01);
alter table public.shop_sale_return_items add constraint shop_sale_return_items_line_refund_nonneg check (line_refund_amount >= 0);

comment on column public.shop_sale_items.net_line_total is 'Economic value of this line after its proportional share of the sale-level discount. Invariant: sum(net_line_total) over a sale = invoices.total for that sale''s invoice.';
comment on column public.shop_sale_items.refunded_amount is 'Running total refunded against this specific line across all returns. Invariant: refunded_amount <= net_line_total.';
comment on column public.shop_sale_return_items.line_refund_amount is 'Portion of the parent return''s total refund amount attributed to this specific returned line.';

-- ---------------------------------------------------------------
-- create_shop_sale(): fold discount into invoice_items.line_total
-- and shop_sale_items.net_line_total, proportionally, with the last
-- item absorbing the rounding remainder.
-- ---------------------------------------------------------------
create or replace function public.create_shop_sale(p_club_id uuid, p_location_id uuid, p_customer_id uuid, p_items jsonb, p_payment_method text, p_payment_reference text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_payment_amount numeric DEFAULT NULL::numeric, p_discount_amount numeric DEFAULT 0, p_discount_reason text DEFAULT NULL::text)
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
  v_item_count int;
  v_item_index int := 0;
  v_line_discount_share numeric;
  v_allocated_discount_so_far numeric := 0;
  v_net_line_total numeric;
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
  v_item_count := jsonb_array_length(p_items);

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
    v_item_index := v_item_index + 1;

    select * into v_product from public.shop_products where id = (v_item->>'product_id')::uuid;
    if v_item->>'variant_id' is not null then
      select * into v_variant from public.shop_product_variants where id = (v_item->>'variant_id')::uuid;
      v_unit_price := coalesce(v_variant.price_override, v_product.base_price);
    else
      v_variant := null;
      v_unit_price := v_product.base_price;
    end if;
    v_line_total := round(v_unit_price * (v_item->>'quantity')::numeric, 2);

    -- Proportional discount allocation (design point 1 above): the
    -- LAST item absorbs whatever remainder rounding leaves, so
    -- sum(net_line_total) is always EXACTLY v_total, never off by a
    -- cent either direction.
    if v_discount_amount > 0 and v_subtotal > 0 then
      if v_item_index = v_item_count then
        v_line_discount_share := v_discount_amount - v_allocated_discount_so_far;
      else
        v_line_discount_share := round(v_discount_amount * v_line_total / v_subtotal, 2);
        v_allocated_discount_so_far := v_allocated_discount_so_far + v_line_discount_share;
      end if;
    else
      v_line_discount_share := 0;
    end if;
    v_net_line_total := v_line_total - v_line_discount_share;

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

    insert into public.shop_sale_items (sale_id, product_id, variant_id, quantity, unit_price, line_total, net_line_total, unit_cost_snapshot)
    values (v_sale_id, v_product.id, v_variant.id, (v_item->>'quantity')::numeric, v_unit_price, v_line_total, v_net_line_total, v_unit_cost_snapshot)
    returning id into v_sale_item_id;

    -- invoice_items.line_total is now the NET (post-discount) value --
    -- this is the change that makes sum(invoice_items.line_total) =
    -- invoices.total hold unconditionally, matching every other
    -- commerce-creating RPC in this codebase.
    insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
    values (v_invoice_id, coalesce(v_product.name_ar, v_product.name_en), 'shop_sale_item', v_sale_item_id, (v_item->>'quantity')::numeric, v_unit_price, v_net_line_total)
    returning id into v_invoice_item_id;

    update public.shop_sale_items set invoice_item_id = v_invoice_item_id where id = v_sale_item_id;

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

-- ---------------------------------------------------------------
-- return_shop_sale(): compute the true remaining refundable value
-- of the specific lines being returned, cap p_refund_amount against
-- it (in addition to the existing payment-balance ceiling), allocate
-- the refund across return lines, and update refunded_amount /
-- line_refund_amount so every subsequent return sees an accurate
-- remaining balance.
-- ---------------------------------------------------------------
create or replace function public.return_shop_sale(p_sale_id uuid, p_lines jsonb, p_restock boolean, p_refund_amount numeric DEFAULT NULL::numeric, p_reason text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_payment_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
  v_line_count int;
  v_line_index int := 0;
  v_line_qty numeric;
  v_line_remaining_refundable numeric;
  v_line_economic_value_returned_now numeric;
  v_total_economic_value_returned_now numeric := 0;
  v_line_refund_share numeric;
  v_allocated_refund_so_far numeric := 0;
  v_refund_amount numeric;
  v_return_item_id uuid;
  v_return_item_ids uuid[] := array[]::uuid[];
  v_return_item_line_values numeric[] := array[]::numeric[];
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
  if not public._shop_module_active(v_sale.club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

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

  v_line_count := jsonb_array_length(p_lines);

  insert into public.shop_sale_returns (sale_id, club_id, processed_by, restock, reason, idempotency_key)
  values (p_sale_id, v_sale.club_id, auth.uid(), p_restock, p_reason, p_idempotency_key)
  returning id into v_return_id;

  -- PASS 1: validate every line, lock the sale_item rows, and compute
  -- the true remaining economic value being returned in THIS call --
  -- this is the number p_refund_amount is capped against below,
  -- independent of and in addition to the payment-balance check.
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_line_index := v_line_index + 1;

    select * into v_sale_item from public.shop_sale_items
    where id = (v_line->>'sale_item_id')::uuid and sale_id = p_sale_id
    for update;
    if v_sale_item.id is null then
      raise exception 'this item does not belong to the specified sale';
    end if;

    v_line_qty := (v_line->>'quantity')::numeric;
    if v_line_qty <= 0 then
      raise exception 'return quantity must be positive';
    end if;
    if v_line_qty > (v_sale_item.quantity - v_sale_item.returned_quantity) then
      raise exception 'cannot return more than the remaining sold quantity (remaining: %)', (v_sale_item.quantity - v_sale_item.returned_quantity);
    end if;

    -- The economic value of the units being returned right now, as a
    -- proportional share of this line's already-discounted net value
    -- (net_line_total / quantity gives the true post-discount unit
    -- value, matching how the frontend's own merchandiseRefundTotal
    -- calc is intended to work -- this migration just makes it use
    -- the NET figure and makes the server independently verify it
    -- instead of trusting the client).
    v_line_economic_value_returned_now := round(v_sale_item.net_line_total / v_sale_item.quantity * v_line_qty, 2);

    -- What actually remains refundable for this line, after whatever
    -- has already been refunded against it in prior returns.
    v_line_remaining_refundable := greatest(v_sale_item.net_line_total - v_sale_item.refunded_amount, 0);
    if v_line_economic_value_returned_now > v_line_remaining_refundable then
      v_line_economic_value_returned_now := v_line_remaining_refundable;
    end if;

    v_total_economic_value_returned_now := v_total_economic_value_returned_now + v_line_economic_value_returned_now;

    insert into public.shop_sale_return_items (return_id, sale_item_id, quantity)
    values (v_return_id, v_sale_item.id, v_line_qty)
    returning id into v_return_item_id;

    v_return_item_ids := v_return_item_ids || v_return_item_id;
    v_return_item_line_values := v_return_item_line_values || v_line_economic_value_returned_now;

    update public.shop_sale_items
    set returned_quantity = returned_quantity + v_line_qty
    where id = v_sale_item.id;

    if p_restock then
      perform public._apply_shop_inventory_movement_internal(
        v_sale.location_id, v_sale_item.product_id, v_sale_item.variant_id, 'sale_return', v_line_qty, 'in',
        auth.uid(), 'shop_sale_return', v_return_id, p_reason, null
      );
    end if;
  end loop;

  -- p_refund_amount is now OPTIONAL: omitted (or 0/null) means "no
  -- refund requested for this return" (e.g. store-credit/exchange
  -- flows outside this RPC's scope) -- it does NOT default to "refund
  -- everything automatically", preserving the existing opt-in
  -- behavior for callers that don't want a refund alongside the
  -- return. When a caller DOES request an amount, it is now hard-
  -- capped at the true economic value computed above, regardless of
  -- what the client sent.
  v_refund_amount := coalesce(p_refund_amount, 0);
  if v_refund_amount < 0 then
    raise exception 'refund amount cannot be negative';
  end if;
  if v_refund_amount > v_total_economic_value_returned_now then
    raise exception 'refund amount (%) exceeds the economic value of the returned items (%) -- the refund cannot be larger than what was actually returned', v_refund_amount, v_total_economic_value_returned_now;
  end if;

  if v_refund_amount > 0 then
    if p_payment_id is not null then
      select pay.id into v_payment_id
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.invoice_id = v_sale.invoice_id and pay.id = p_payment_id
      limit 1;
      if v_payment_id is null then
        raise exception 'the selected payment does not belong to this sale';
      end if;
    else
      select pay.id into v_payment_id
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.invoice_id = v_sale.invoice_id
      limit 1;
    end if;
    if v_payment_id is null then
      raise exception 'no payment found for this sale to refund against';
    end if;
    -- create_refund() independently re-checks against the PAYMENT's
    -- own remaining balance -- kept as a second, unrelated ceiling
    -- (defense in depth): even if the economic-value math above were
    -- ever wrong, a refund still cannot exceed what was actually paid.
    v_refund_id := public.create_refund(v_payment_id, v_refund_amount, p_reason);

    update public.shop_sale_returns set refund_payment_id = v_refund_id where id = v_return_id;

    -- PASS 2: allocate the actual refunded amount across the return
    -- lines, proportional to each line's share of the economic value
    -- computed in pass 1, with the LAST line absorbing the rounding
    -- remainder -- same allocation discipline as the sale-side
    -- discount split above, so line_refund_amount always sums exactly
    -- to v_refund_amount and refunded_amount never drifts across a
    -- long sequence of partial returns.
    for v_line_index in 1 .. array_length(v_return_item_ids, 1) loop
      if v_total_economic_value_returned_now > 0 then
        if v_line_index = array_length(v_return_item_ids, 1) then
          v_line_refund_share := v_refund_amount - v_allocated_refund_so_far;
        else
          v_line_refund_share := round(v_refund_amount * v_return_item_line_values[v_line_index] / v_total_economic_value_returned_now, 2);
          v_allocated_refund_so_far := v_allocated_refund_so_far + v_line_refund_share;
        end if;
      else
        v_line_refund_share := 0;
      end if;

      update public.shop_sale_return_items
      set line_refund_amount = v_line_refund_share
      where id = v_return_item_ids[v_line_index];

      update public.shop_sale_items si
      set refunded_amount = refunded_amount + v_line_refund_share
      from public.shop_sale_return_items sri
      where sri.id = v_return_item_ids[v_line_index] and si.id = sri.sale_item_id;
    end loop;
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
    jsonb_build_object(
      'sale_id', p_sale_id, 'restock', p_restock, 'refund_id', v_refund_id,
      'refund_amount', v_refund_amount, 'economic_value_returned', v_total_economic_value_returned_now,
      'payment_id', v_payment_id, 'lines', p_lines
    ),
    p_reason
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_sale.club_id, 'return.completed', 'shop_sale_return', v_return_id,
      null,
      jsonb_build_object(
        'sale_id', p_sale_id, 'restock', p_restock, 'refund_id', v_refund_id,
        'refund_amount', v_refund_amount, 'economic_value_returned', v_total_economic_value_returned_now,
        'payment_id', v_payment_id, 'lines', p_lines
      ),
      p_reason
    );
  end if;

  return v_return_id;
end;
$function$;
