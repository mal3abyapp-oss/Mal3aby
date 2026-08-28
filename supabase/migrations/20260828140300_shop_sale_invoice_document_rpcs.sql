-- Commerce Pro C4 -- real invoice/receipt document data for a Shop
-- sale. See COMMERCE_PRO_UPGRADE_PLAN.md Section 2/3/4.
--
-- get_shop_sale_detail: extended additively with a sku column (append-
-- only, matching every other RPC-extension pattern this engagement has
-- used -- e.g. list_shop_products/list_shop_categories in C1 appending
-- new return columns in-place without touching the input signature).
-- shop_products.sku / shop_product_variants.sku both exist (confirmed
-- via direct schema read of 20260826210231_shop_catalog_schema.sql
-- before writing this migration) -- a variant's own sku takes priority
-- over the parent product's when a variant is selected, matching how
-- unit_price already prefers variant.price_override over
-- product.base_price elsewhere in this module.
create or replace function public.get_shop_sale_detail(p_sale_id uuid)
returns table(
  item_id uuid, product_name_ar text, variant_label text, sku text, quantity numeric,
  unit_price numeric, line_total numeric, returned_quantity numeric
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.shop_sales where id = p_sale_id;
  if v_club_id is null then
    raise exception 'sale not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', v_club_id)
          or public.has_platform_support_access(v_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select si.id, p.name_ar, nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         coalesce(v.sku, p.sku), si.quantity, si.unit_price, si.line_total, si.returned_quantity
  from public.shop_sale_items si
  join public.shop_products p on p.id = si.product_id
  left join public.shop_product_variants v on v.id = si.variant_id
  where si.sale_id = p_sale_id;
end;
$$;

-- Same signature as before (uuid) -- CREATE OR REPLACE in place is safe
-- (only the return row shape changed by appending a column), no DROP or
-- grant-leak class issue since PostgREST identity is (name, arg types),
-- not the return type -- matching the same reasoning
-- 20260828100200_shop_product_media_category_ux_rpcs.sql documented for
-- list_shop_products/list_shop_categories' own in-place return-shape
-- extension.
revoke all on function public.get_shop_sale_detail(uuid) from public, anon;
grant execute on function public.get_shop_sale_detail(uuid) to authenticated;

-- get_shop_sale_invoice_data: the header/meta/payments data a printable
-- invoice/receipt needs that get_shop_sale_detail (items only) and
-- list_shop_sales (list-row shape) don't carry. Reads invoices/payments
-- directly rather than adding new columns to shop_sales -- matches
-- BillingPage.tsx's own established pattern (fetchInvoiceDetail/
-- fetchInvoicePayments read invoices/payment_allocations/payments
-- directly), reusing shop_sales.invoice_id (already exists) as the
-- join key rather than inventing a parallel data path. One RPC instead
-- of several round-trips because this is a single document render, not
-- a paginated list -- avoids an N+1 from the client for something that
-- opens as one dialog.
--
-- Payments returned as a jsonb array (one element per payments row
-- allocated to this invoice) since PL/pgSQL RETURNS TABLE cannot return
-- a variable-length nested row set as a typed sub-table cleanly without
-- a second round trip or a custom composite type -- jsonb array is the
-- same pattern get_shop_stock_count_detail's caller-side aggregation
-- would need anyway, done server-side instead. Each element:
-- {payment_id, amount, method, reference, received_at, received_by_name}.
create or replace function public.get_shop_sale_invoice_data(p_sale_id uuid)
returns table(
  sale_id uuid,
  club_id uuid,
  invoice_id uuid,
  invoice_number text,
  branch_id uuid,
  branch_name text,
  location_name text,
  customer_id uuid,
  customer_name text,
  customer_mobile text,
  sold_by_name text,
  created_at timestamptz,
  subtotal numeric,
  discount_amount numeric,
  discount_reason text,
  total numeric,
  invoice_status text,
  payments jsonb
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select s.club_id into v_club_id from public.shop_sales s where s.id = p_sale_id;
  if v_club_id is null then
    raise exception 'sale not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', v_club_id)
          or public.has_platform_support_access(v_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    s.id,
    s.club_id,
    i.id,
    i.invoice_number,
    i.branch_id,
    b.name,
    l.name,
    s.customer_id,
    c.full_name,
    c.mobile_display,
    pr.full_name,
    s.created_at,
    i.subtotal,
    s.discount_amount,
    s.discount_reason,
    i.total,
    i.status,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', pay.id,
        'amount', pay.amount,
        'method', pay.method,
        'reference', pay.reference,
        'received_at', pay.received_at,
        'received_by_name', rp.full_name
      ) order by pay.received_at)
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      left join public.profiles rp on rp.user_id = pay.received_by
      where pa.invoice_id = i.id
    ), '[]'::jsonb)
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  join public.branches b on b.id = i.branch_id
  join public.shop_inventory_locations l on l.id = s.location_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.id = p_sale_id;
end;
$$;

revoke all on function public.get_shop_sale_invoice_data(uuid) from public, anon;
grant execute on function public.get_shop_sale_invoice_data(uuid) to authenticated;
