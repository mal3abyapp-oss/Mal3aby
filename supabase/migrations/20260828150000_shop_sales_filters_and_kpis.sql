-- Commerce Pro C5: Sales page KPIs + filters (plan Section 5, Phase
-- C5). Read list_shop_sales' current live definition
-- (20260828083000_shop_read_rpcs_enforce_module_active.sql, confirmed
-- as latest via direct migration read) before writing this file --
-- every line of the existing body is preserved, only the WHERE clause
-- and SELECT list gain new, entirely optional filter predicates.
--
-- Server-side filtering per the plan's own performance section
-- (Shop sales history can grow large -- filtering must happen in the
-- RPC, not client-side on a full unfiltered fetch). Filters are
-- additive/append-only, matching this whole engagement's established
-- RPC-extension pattern (C1-C4): every new parameter has a default
-- (null), so every existing caller (ShopSalesPage's own current call
-- with only p_club_id/p_status/p_limit, fetchFullReport's print path)
-- continues to work identically with no filtering applied.
--
-- Filter set matches the plan's explicit list: date range, branch,
-- cashier, customer, payment method, category, product, invoice
-- number, sale status. Payment method / category / product require
-- joining down to shop_sale_items / payment_allocations / payments --
-- done with EXISTS subqueries so a sale with multiple items/payments
-- is still returned once, not duplicated.
--
-- Branch filter: shop_sales itself has no branch_id column (confirmed
-- via direct schema read of 20260826210846_shop_sales_schema.sql --
-- only location_id, which shop_inventory_locations.branch_id resolves
-- from). Joins location -> branch_id rather than adding a denormalized
-- column, matching this module's existing "shop_sales has location_id
-- only" shape.
create or replace function public.list_shop_sales(
  p_club_id uuid,
  p_status text default null,
  p_limit int default 50,
  p_offset int default 0,
  p_start_date date default null,
  p_end_date date default null,
  p_branch_id uuid default null,
  p_cashier_id uuid default null,
  p_customer_id uuid default null,
  p_payment_method text default null,
  p_category_id uuid default null,
  p_product_id uuid default null,
  p_invoice_number text default null
)
returns table(
  sale_id uuid, invoice_number text, customer_name text, sold_by_name text,
  status text, total numeric, created_at timestamptz,
  branch_id uuid, item_count numeric, discount_amount numeric, refund_amount numeric,
  sold_by uuid
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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    s.id, i.invoice_number, c.full_name, pr.full_name, s.status, i.total, s.created_at,
    l.branch_id,
    (select coalesce(sum(si.quantity), 0) from public.shop_sale_items si where si.sale_id = s.id),
    s.discount_amount,
    -- Real refund total, re-derived from the refunds ledger via this
    -- sale's own returns -- never a second independently-summed
    -- figure. A sale with no returns yields 0, not null.
    (select coalesce(sum(r.amount), 0)
     from public.shop_sale_returns sr
     join public.refunds r on r.id = sr.refund_payment_id
     where sr.sale_id = s.id and r.status = 'completed'),
    s.sold_by
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  join public.shop_inventory_locations l on l.id = s.location_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.club_id = p_club_id
    and (p_status is null or s.status = p_status)
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
    and (p_branch_id is null or l.branch_id = p_branch_id)
    and (p_cashier_id is null or s.sold_by = p_cashier_id)
    and (p_customer_id is null or s.customer_id = p_customer_id)
    and (p_invoice_number is null or p_invoice_number = '' or i.invoice_number ilike '%' || p_invoice_number || '%')
    and (p_payment_method is null or exists (
      select 1 from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      where pa.invoice_id = s.invoice_id and pay.method = p_payment_method
    ))
    and (p_category_id is null or exists (
      select 1 from public.shop_sale_items si
      join public.shop_products p on p.id = si.product_id
      where si.sale_id = s.id and p.category_id = p_category_id
    ))
    and (p_product_id is null or exists (
      select 1 from public.shop_sale_items si where si.sale_id = s.id and si.product_id = p_product_id
    ))
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_sales(uuid, text, int, int, date, date, uuid, uuid, uuid, text, uuid, uuid, text) from public;
revoke all on function public.list_shop_sales(uuid, text, int, int, date, date, uuid, uuid, uuid, text, uuid, uuid, text) from anon;
grant execute on function public.list_shop_sales(uuid, text, int, int, date, date, uuid, uuid, uuid, text, uuid, uuid, text) to authenticated;

-- Old 4-arg overload explicitly dropped -- matching the grant-leak-
-- prevention precedent this engagement has applied every time a Shop
-- RPC's parameter list changes (20260827003243_fix_create_shop_sale_grant_leak_and_drop_orphaned_overload.sql,
-- 20260826235307_drop_orphaned_return_shop_sale_overload.sql). Without
-- this, Postgres keeps the old 4-arg function around as a second,
-- separately-callable overload that never received the
-- _shop_module_active additions above it inherited by copy -- actually
-- here the old body is superseded entirely by CREATE OR REPLACE only
-- because the signature is unchanged in its first 4 params; but since
-- we are ADDING params (not changing existing ones), CREATE OR REPLACE
-- on a NEW parameter list creates a genuinely new overload rather than
-- replacing the old 4-arg one in place. Drop it so callers cannot
-- accidentally invoke the stale, unfiltered 4-arg version.
drop function if exists public.list_shop_sales(uuid, text, int, int);

-- get_shop_sales_kpis(): the Sales page KPI row (plan Section 1 --
-- Today Sales, Transactions, Average Basket, Items Sold, Refunds, Net
-- Sales). Deliberately a NEW, separate RPC rather than reusing
-- get_shop_top_products (that RPC is per-product, not a single
-- aggregate row) or get_shop_inventory_summary (that RPC is inventory-
-- only, explicitly documented as carrying no revenue figure by
-- design). Accepts the SAME filter set as list_shop_sales (minus
-- pagination) so the KPI row reflects exactly the filtered view the
-- staff member is looking at, not always "today" regardless of
-- filters -- the page wires "Today" as the default date range, not a
-- hardcoded server-side assumption.
--
-- Money re-derived from invoices.total / shop_sales.discount_amount /
-- the refunds ledger -- never a second independently-tracked figure,
-- matching COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 9's "structurally
-- only one place money is summed" mechanism (also followed by
-- get_shop_top_products above).
create or replace function public.get_shop_sales_kpis(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_branch_id uuid default null,
  p_cashier_id uuid default null,
  p_customer_id uuid default null,
  p_payment_method text default null,
  p_category_id uuid default null,
  p_product_id uuid default null,
  p_invoice_number text default null,
  p_status text default null
)
returns table(
  transaction_count bigint,
  gross_sales numeric,
  discount_total numeric,
  refund_total numeric,
  net_sales numeric,
  items_sold numeric,
  average_basket numeric
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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  with filtered as (
    select s.id, i.total, s.discount_amount
    from public.shop_sales s
    join public.invoices i on i.id = s.invoice_id
    join public.shop_inventory_locations l on l.id = s.location_id
    where s.club_id = p_club_id
      and s.status <> 'cancelled'
      and (p_status is null or s.status = p_status)
      and (p_start_date is null or s.created_at::date >= p_start_date)
      and (p_end_date is null or s.created_at::date <= p_end_date)
      and (p_branch_id is null or l.branch_id = p_branch_id)
      and (p_cashier_id is null or s.sold_by = p_cashier_id)
      and (p_customer_id is null or s.customer_id = p_customer_id)
      and (p_invoice_number is null or p_invoice_number = '' or i.invoice_number ilike '%' || p_invoice_number || '%')
      and (p_payment_method is null or exists (
        select 1 from public.payment_allocations pa
        join public.payments pay on pay.id = pa.payment_id
        where pa.invoice_id = s.invoice_id and pay.method = p_payment_method
      ))
      and (p_category_id is null or exists (
        select 1 from public.shop_sale_items si
        join public.shop_products p on p.id = si.product_id
        where si.sale_id = s.id and p.category_id = p_category_id
      ))
      and (p_product_id is null or exists (
        select 1 from public.shop_sale_items si where si.sale_id = s.id and si.product_id = p_product_id
      ))
  ),
  items as (
    select coalesce(sum(si.quantity), 0) as qty
    from public.shop_sale_items si
    where si.sale_id in (select id from filtered)
  ),
  refunds_agg as (
    select coalesce(sum(r.amount), 0) as refunded
    from public.shop_sale_returns sr
    join public.refunds r on r.id = sr.refund_payment_id
    where sr.sale_id in (select id from filtered) and r.status = 'completed'
  )
  select
    (select count(*) from filtered)::bigint,
    (select coalesce(sum(total), 0) from filtered),
    (select coalesce(sum(discount_amount), 0) from filtered),
    (select refunded from refunds_agg),
    (select coalesce(sum(total), 0) from filtered) - (select refunded from refunds_agg),
    (select qty from items),
    case when (select count(*) from filtered) = 0 then 0
         else (select coalesce(sum(total), 0) from filtered) / (select count(*) from filtered)
    end;
end;
$$;

revoke all on function public.get_shop_sales_kpis(uuid, date, date, uuid, uuid, uuid, text, uuid, uuid, text, text) from public;
revoke all on function public.get_shop_sales_kpis(uuid, date, date, uuid, uuid, uuid, text, uuid, uuid, text, text) from anon;
grant execute on function public.get_shop_sales_kpis(uuid, date, date, uuid, uuid, uuid, text, uuid, uuid, text, text) to authenticated;
