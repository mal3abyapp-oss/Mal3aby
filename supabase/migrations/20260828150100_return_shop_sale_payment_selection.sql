-- Commerce Pro C5: return_shop_sale payment-selection fix (plan
-- Section 4, the payment-selection-ambiguity investigation).
--
-- INVESTIGATION FINDING (documented per explicit task instruction, not
-- silently resolved): return_shop_sale's refund branch (confirmed via
-- direct read of the live definition,
-- 20260828091500_shop_return_sale_module_active.sql) does
--
--   select pay.id from payment_allocations pa join payments pay ...
--   where pa.invoice_id = v_sale.invoice_id limit 1
--
-- with NO order by -- an arbitrary row when a sale has more than one
-- payment allocated to its invoice (a real, more common case now that
-- C3 shipped split-tender checkout). create_refund() itself (read in
-- full: 20260826073151_club_membership_create_refund_widen.sql, the
-- latest live definition) validates strictly against WHICHEVER payment
-- row it's given -- permission, subscription gate, refundable balance
-- (payment.amount - sum of its own prior completed refunds) -- so the
-- refund it creates is always financially correct FOR THE PAYMENT ROW
-- IT RECEIVES. The ambiguity is entirely about WHICH payment method a
-- refund lands against, which matters for real operational reasons:
-- cash-drawer reconciliation (a cash refund must come out of the cash
-- drawer, not silently debit a card payment's refundable balance),
-- per-method refund reporting, and a customer's real expectation of
-- getting a card refund back onto their card rather than as cash.
--
-- DECISION: (b), a real gap, not (a) "fine as-is" or (c) "defer". Adds
-- an ADDITIVE, OPTIONAL p_payment_id uuid default null. When provided,
-- it is validated (must actually be a payment allocated to this sale's
-- invoice) and used directly -- staff picks which payment to refund
-- against in the Returns UX whenever a sale has more than one. When
-- omitted (every existing caller, and a single-payment sale where
-- there is no real ambiguity to surface), behavior is BYTE-IDENTICAL
-- to today's arbitrary-first-row pick -- no existing caller breaks,
-- matching this engagement's append-only RPC-extension pattern used
-- throughout C1-C4.
--
-- Every other line of the function body is preserved verbatim from the
-- live definition confirmed above.
create or replace function public.return_shop_sale(
  p_sale_id uuid,
  p_lines jsonb,
  p_restock boolean,
  p_refund_amount numeric default null,
  p_reason text default null,
  p_idempotency_key uuid default null,
  p_payment_id uuid default null
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
    if p_payment_id is not null then
      -- Staff explicitly chose which payment to refund against (Shop
      -- Returns UX, C5). Validated: must actually be a payment
      -- allocated to THIS sale's invoice -- never trust a client-
      -- supplied payment id blindly, matching this codebase's
      -- established "never trust a client id, always re-verify the
      -- real relationship" posture (e.g. create_shop_sale's own
      -- location/customer existence checks).
      select pay.id into v_payment_id
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.invoice_id = v_sale.invoice_id and pay.id = p_payment_id
      limit 1;
      if v_payment_id is null then
        raise exception 'the selected payment does not belong to this sale';
      end if;
    else
      -- No explicit choice -- preserves today's exact behavior
      -- (arbitrary first row) for every existing caller and for the
      -- common single-payment-sale case, where there is no real
      -- ambiguity to surface.
      select pay.id into v_payment_id
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.invoice_id = v_sale.invoice_id
      limit 1;
    end if;
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
    jsonb_build_object('sale_id', p_sale_id, 'restock', p_restock, 'refund_id', v_refund_id, 'refund_amount', p_refund_amount, 'payment_id', v_payment_id, 'lines', p_lines),
    p_reason
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_sale.club_id, 'return.completed', 'shop_sale_return', v_return_id,
      null,
      jsonb_build_object('sale_id', p_sale_id, 'restock', p_restock, 'refund_id', v_refund_id, 'refund_amount', p_refund_amount, 'payment_id', v_payment_id, 'lines', p_lines),
      p_reason
    );
  end if;

  return v_return_id;
end;
$$;

revoke all on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid, uuid) from public;
revoke all on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid, uuid) from anon;
grant execute on function public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid, uuid) to authenticated;

-- Old 6-arg overload dropped -- same grant-leak-prevention precedent as
-- every prior Shop RPC signature change this engagement
-- (20260826235307_drop_orphaned_return_shop_sale_overload.sql already
-- did this once for an earlier signature change; doing it again here
-- since this is a genuinely new overload, not an in-place replace).
drop function if exists public.return_shop_sale(uuid, jsonb, boolean, numeric, text, uuid);
