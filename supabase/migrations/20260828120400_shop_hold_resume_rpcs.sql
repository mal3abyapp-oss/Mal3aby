-- Commerce Pro C3 (plan Section 5 / Non-negotiable Invariant #1):
-- Hold/Resume Sales. A held sale is a NON-CANONICAL DRAFT -- it never
-- touches invoices/payments/inventory movements. Resuming loads the
-- held cart back into the POS UI's client-side cart state and consumes
-- (deletes) the held-sale row; it does NOT itself create a shop_sales
-- row. The cashier still completes checkout normally afterward via the
-- unmodified create_shop_sale path.

-- ------------------------------------------------------------
-- hold_shop_sale: snapshot the current cart as a draft.
-- ------------------------------------------------------------
create or replace function public.hold_shop_sale(
  p_club_id uuid,
  p_items jsonb,
  p_customer_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_item jsonb;
  v_held_sale_id uuid;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id))
    and public.has_platform_support_access(p_club_id, true);
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if jsonb_array_length(p_items) = 0 then
    raise exception 'cannot hold an empty cart';
  end if;

  if p_customer_id is not null and not exists (
    select 1 from public.customers where id = p_customer_id and club_id = p_club_id
  ) then
    raise exception 'customer not found in this club';
  end if;

  -- Validate product/variant references exist and belong to this club
  -- (defense-in-depth -- a held sale with a dangling product_id would
  -- fail confusingly on resume rather than at hold time).
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    if (v_item->>'quantity')::numeric <= 0 then
      raise exception 'quantity must be positive';
    end if;
    if not exists (
      select 1 from public.shop_products where id = (v_item->>'product_id')::uuid and club_id = p_club_id
    ) then
      raise exception 'product not found in this club';
    end if;
    if v_item->>'variant_id' is not null and not exists (
      select 1 from public.shop_product_variants where id = (v_item->>'variant_id')::uuid and product_id = (v_item->>'product_id')::uuid
    ) then
      raise exception 'variant not found for this product';
    end if;
  end loop;

  insert into public.shop_held_sales (club_id, customer_id, held_by, note)
  values (p_club_id, p_customer_id, auth.uid(), nullif(btrim(p_note), ''))
  returning id into v_held_sale_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    insert into public.shop_held_sale_items (held_sale_id, product_id, variant_id, quantity)
    values (v_held_sale_id, (v_item->>'product_id')::uuid, (v_item->>'variant_id')::uuid, (v_item->>'quantity')::numeric);
  end loop;

  perform public.write_audit_log(
    p_club_id, 'shop_sale.held', 'shop_held_sale', v_held_sale_id, null,
    jsonb_build_object('item_count', jsonb_array_length(p_items), 'customer_id', p_customer_id),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id, 'shop_sale.held', 'shop_held_sale', v_held_sale_id, null,
      jsonb_build_object('item_count', jsonb_array_length(p_items), 'customer_id', p_customer_id),
      null
    );
  end if;

  return v_held_sale_id;
end;
$function$;

revoke all on function public.hold_shop_sale(uuid, jsonb, uuid, text) from public, anon;
grant execute on function public.hold_shop_sale(uuid, jsonb, uuid, text) to authenticated;

-- ------------------------------------------------------------
-- list_held_shop_sales: for the "Held Sales" drawer/list.
-- ------------------------------------------------------------
create or replace function public.list_held_shop_sales(p_club_id uuid)
returns table(
  held_sale_id uuid,
  customer_id uuid,
  customer_name text,
  held_by uuid,
  held_by_name text,
  held_at timestamptz,
  note text,
  item_count bigint,
  total_quantity numeric
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select h.id, h.customer_id, c.full_name, h.held_by, pr.full_name,
         h.held_at, h.note,
         count(i.id), coalesce(sum(i.quantity), 0)
  from public.shop_held_sales h
  left join public.customers c on c.id = h.customer_id
  left join public.profiles pr on pr.user_id = h.held_by
  left join public.shop_held_sale_items i on i.held_sale_id = h.id
  where h.club_id = p_club_id
  group by h.id, h.customer_id, c.full_name, h.held_by, pr.full_name, h.held_at, h.note
  order by h.held_at desc;
end;
$function$;

revoke all on function public.list_held_shop_sales(uuid) from public, anon;
grant execute on function public.list_held_shop_sales(uuid) to authenticated;

-- ------------------------------------------------------------
-- resume_shop_sale: return the full item list (with LIVE re-derived
-- product/variant data, never trusting anything cached at hold time)
-- and consume (delete) the held-sale row in the same transaction, so a
-- held sale can never be resumed twice or left as an orphaned draft
-- after the cashier has already loaded it back into their cart.
-- ------------------------------------------------------------
create or replace function public.resume_shop_sale(p_held_sale_id uuid)
returns table(
  customer_id uuid,
  product_id uuid,
  variant_id uuid,
  quantity numeric,
  product_name_ar text,
  product_name_en text,
  variant_size text,
  variant_color text,
  unit_price numeric,
  product_status text,
  variant_status text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_held public.shop_held_sales;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_held from public.shop_held_sales where id = p_held_sale_id;
  if v_held.id is null then
    raise exception 'held sale not found';
  end if;

  if not (v_held.club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', v_held.club_id)
          or public.has_platform_support_access(v_held.club_id, true)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_held.club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  -- RETURN QUERY executes and appends its results to the function's
  -- result set immediately (documented Postgres/PL_pgSQL behavior) --
  -- not lazily evaluated on function exit. The DELETE below therefore
  -- runs strictly after this query has already been executed and its
  -- rows captured, so the deletion cannot affect what is returned to
  -- the caller.
  return query
  select v_held.customer_id, i.product_id, i.variant_id, i.quantity,
         p.name_ar, p.name_en, v.size, v.color,
         coalesce(v.price_override, p.base_price), p.status, v.status
  from public.shop_held_sale_items i
  join public.shop_products p on p.id = i.product_id
  left join public.shop_product_variants v on v.id = i.variant_id
  where i.held_sale_id = p_held_sale_id;

  perform public.write_audit_log(
    v_held.club_id, 'shop_sale.resumed', 'shop_held_sale', p_held_sale_id, null,
    jsonb_build_object('customer_id', v_held.customer_id),
    null
  );

  -- Consume the draft -- resuming is a one-shot "load back into the
  -- active cart" operation, not a repeatable read. Items cascade-delete
  -- with the parent row (on delete cascade on shop_held_sale_items).
  delete from public.shop_held_sales where id = p_held_sale_id;
end;
$function$;

revoke all on function public.resume_shop_sale(uuid) from public, anon;
grant execute on function public.resume_shop_sale(uuid) to authenticated;

-- ------------------------------------------------------------
-- discard_held_shop_sale: cashier explicitly abandons a held sale
-- without resuming it.
-- ------------------------------------------------------------
create or replace function public.discard_held_shop_sale(p_held_sale_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_held public.shop_held_sales;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_held from public.shop_held_sales where id = p_held_sale_id;
  if v_held.id is null then
    raise exception 'held sale not found';
  end if;

  if not (v_held.club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', v_held.club_id)
          or public.has_platform_support_access(v_held.club_id, true)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_held.club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  perform public.write_audit_log(
    v_held.club_id, 'shop_sale.hold_discarded', 'shop_held_sale', p_held_sale_id, null,
    jsonb_build_object('customer_id', v_held.customer_id),
    null
  );

  delete from public.shop_held_sales where id = p_held_sale_id;
end;
$function$;

revoke all on function public.discard_held_shop_sale(uuid) from public, anon;
grant execute on function public.discard_held_shop_sale(uuid) to authenticated;
