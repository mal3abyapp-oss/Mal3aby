-- Commerce Pro C8 (plan Section 5, Phase C8, item "Product Detail /
-- Stock History", plan Section 21): Product Detail tabs are GENERAL,
-- STOCK, MOVEMENTS, SALES HISTORY, RETURNS, SUPPLIER.
--
-- GENERAL: client-derived from list_shop_products (already fetched by
-- the Inventory page). STOCK (location -> quantity): reuses
-- get_shop_inventory_balances(p_club_id) filtered client-side to one
-- product_id -- that RPC already returns exactly this shape, no new
-- RPC needed. MOVEMENTS: reuses list_shop_inventory_movements's
-- existing p_product_id filter (confirmed present since
-- 20260826213624_fix_shop_inventory_rpcs_optional_variant.sql, still
-- present in the C7-extended version) -- no new RPC needed.
-- SUPPLIER: no dedicated "default supplier per product" concept exists
-- anywhere in this schema (shop_products has no supplier_id column,
-- confirmed via direct schema read, 20260826210231_shop_catalog_schema.sql,
-- unchanged through C1-C7) -- supplier association is per-RECEIPT, not
-- per-product (directive's own confirmed design). The SUPPLIER tab is
-- therefore derived client-side from this phase's own
-- list_shop_product_sales_history-adjacent receipt data: the set of
-- distinct suppliers who have ever supplied this exact product, taken
-- from list_shop_inventory_movements(p_product_id, movement_type=
-- 'purchase_receipt') rows that already carry reference_type=
-- 'shop_supplier'/reference_id -- no new RPC needed for this tab
-- either, since list_shop_inventory_movements already returns
-- reference_type/reference_id per movement row.
--
-- Two tabs have a genuine gap, checked directly against every existing
-- RPC before writing anything new:
--
-- SALES HISTORY: "sales history for this specific product across all
-- customers" is NOT the same shape as get_customer_shop_purchases
-- (customer-scoped, requires a customer_id) and NOT the same as
-- get_shop_top_products (aggregate-only, one row per product, no
-- per-sale detail, no customer identity). No existing RPC returns a
-- per-sale-line list scoped to one product across every customer.
-- New RPC: list_shop_product_sales_history.
--
-- RETURNS: no existing RPC scopes returns to one product either --
-- list_shop_sale_returns (C7) is scoped to a whole SALE/return event,
-- not to individual product lines within it (a return can cover
-- multiple products; shop_sale_return_items is the per-product-line
-- table, and nothing joins that table down to one product_id before
-- this). New RPC: list_shop_product_returns.

-- =====================================================================
-- list_shop_product_sales_history: one row per sale-line for one
-- product (optionally one variant), across every customer, most recent
-- first. Same authorization posture as get_customer_shop_purchases
-- (shop.view is sufficient -- this is product-level sales detail, not
-- profitability data, so shop.reports.view_profit does not apply here;
-- unit_cost_snapshot is deliberately NOT exposed by this RPC to keep
-- that separation intact -- a manager without view_profit sees
-- quantities/revenue per sale, never cost/margin).
-- =====================================================================
create or replace function public.list_shop_product_sales_history(
  p_club_id uuid,
  p_product_id uuid,
  p_variant_id uuid default null,
  p_start_date date default null,
  p_end_date date default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table(
  sale_id uuid,
  invoice_number text,
  customer_name text,
  sold_by_name text,
  variant_label text,
  quantity numeric,
  unit_price numeric,
  line_total numeric,
  returned_quantity numeric,
  sale_status text,
  created_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.shop_products where id = p_product_id and club_id = p_club_id) then
    raise exception 'product not found in this club';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    s.id, i.invoice_number, coalesce(c.full_name, null), pr.full_name,
    nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
    si.quantity, si.unit_price, si.line_total, si.returned_quantity, s.status, s.created_at
  from public.shop_sale_items si
  join public.shop_sales s on s.id = si.sale_id
  join public.invoices i on i.id = s.invoice_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  left join public.shop_product_variants v on v.id = si.variant_id
  where s.club_id = p_club_id
    and si.product_id = p_product_id
    and (p_variant_id is null or si.variant_id = p_variant_id)
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_product_sales_history(uuid, uuid, uuid, date, date, int, int) from public, anon;
grant execute on function public.list_shop_product_sales_history(uuid, uuid, uuid, date, date, int, int) to authenticated;

-- =====================================================================
-- list_shop_product_returns: one row per RETURNED LINE (not per return
-- event) for one product, across every customer/sale, most recent
-- first. Joins down through shop_sale_return_items (the per-product-
-- line table) rather than list_shop_sale_returns's own sale-level
-- grain, since a return event can cover multiple products and this tab
-- needs only the lines that touched THIS product.
-- =====================================================================
create or replace function public.list_shop_product_returns(
  p_club_id uuid,
  p_product_id uuid,
  p_variant_id uuid default null,
  p_start_date date default null,
  p_end_date date default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table(
  return_id uuid,
  sale_id uuid,
  invoice_number text,
  customer_name text,
  processed_by_name text,
  variant_label text,
  quantity numeric,
  restock boolean,
  reason text,
  refund_amount numeric,
  refund_method text,
  created_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.shop_products where id = p_product_id and club_id = p_club_id) then
    raise exception 'product not found in this club';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    r.id, r.sale_id, i.invoice_number, coalesce(c.full_name, null), pr.full_name,
    nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
    rti.quantity, r.restock, r.reason, ref.amount, pay.method, r.created_at
  from public.shop_sale_return_items rti
  join public.shop_sale_items si on si.id = rti.sale_item_id
  join public.shop_sale_returns r on r.id = rti.return_id
  join public.shop_sales s on s.id = r.sale_id
  join public.invoices i on i.id = s.invoice_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = r.processed_by
  left join public.shop_product_variants v on v.id = si.variant_id
  left join public.refunds ref on ref.id = r.refund_payment_id and ref.status = 'completed'
  left join public.payments pay on pay.id = ref.payment_id
  where r.club_id = p_club_id
    and si.product_id = p_product_id
    and (p_variant_id is null or si.variant_id = p_variant_id)
    and (p_start_date is null or r.created_at::date >= p_start_date)
    and (p_end_date is null or r.created_at::date <= p_end_date)
  order by r.created_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_product_returns(uuid, uuid, uuid, date, date, int, int) from public, anon;
grant execute on function public.list_shop_product_returns(uuid, uuid, uuid, date, date, int, int) to authenticated;
