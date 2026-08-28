-- Commerce Pro C6: Shop Dashboard (plan Section 5, Phase C6). Read
-- ReportShopPage.tsx, get_shop_top_products/get_shop_inventory_summary's
-- LATEST live definitions (20260828095500_fix_shop_inventory_summary_out_of_stock_missing_variants.sql
-- confirmed as the current get_shop_inventory_summary body), and C5's
-- get_shop_sales_kpis/list_shop_sales (20260828150000) before writing
-- this file. All three new RPCs below are brand-new function names --
-- no existing RETURNS TABLE shape is being changed, so invariant 8
-- (DROP FUNCTION before changing an existing RETURNS TABLE shape) does
-- not apply to any of them; each is a plain new CREATE.
--
-- Dashboard KPIs, top products, and low-stock/out-of-stock counts are
-- deliberately NOT duplicated here -- the dashboard page reuses
-- get_shop_sales_kpis (C5), get_shop_top_products, and
-- get_shop_inventory_summary directly from the client, scoped to
-- "today" via the same p_start_date/p_end_date filters C5 already
-- wired. Only the two genuinely-missing rollups (category, payment
-- method) and the club-wide recent-returns list are new RPCs.

-- get_shop_sales_by_category(): category-level revenue/unit rollup for
-- the dashboard's "Sales by Category" section. No existing RPC exposes
-- this -- get_shop_top_products is per-product, list_shop_sales' own
-- p_category_id is a FILTER (narrows which sales come back), not an
-- aggregate BY category. Money re-derived from invoice_items.line_total
-- (never independently summed from shop_sale_items), matching every
-- other Shop revenue RPC's own established mechanism
-- (COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 9). Uncategorized products
-- (shop_products.category_id null) are grouped under a null
-- category_id/category_name row rather than silently dropped, so
-- category revenue always sums to the same total as get_shop_top_products
-- over the same date range.
create or replace function public.get_shop_sales_by_category(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null
)
returns table(
  category_id uuid,
  category_name text,
  units_sold numeric,
  revenue numeric
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    cat.id,
    cat.name_ar,
    coalesce(sum(si.quantity), 0) as units_sold,
    coalesce(sum(ii.line_total), 0) as revenue
  from public.shop_sale_items si
  join public.shop_sales s on s.id = si.sale_id
  join public.shop_products p on p.id = si.product_id
  join public.invoice_items ii on ii.id = si.invoice_item_id
  left join public.shop_categories cat on cat.id = p.category_id
  where s.club_id = p_club_id
    and s.status in ('completed', 'partially_returned', 'returned')
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
  group by cat.id, cat.name_ar
  order by revenue desc;
end;
$$;

revoke all on function public.get_shop_sales_by_category(uuid, date, date) from public, anon;
grant execute on function public.get_shop_sales_by_category(uuid, date, date) to authenticated;

-- get_shop_payment_method_mix(): per-payment-method totals for the
-- dashboard's "Payment Method Mix" section. Checked whether C5's
-- list_shop_sales/get_shop_sales_kpis already carry enough to derive
-- this client-side first -- they don't: p_payment_method is a FILTER
-- (an EXISTS subquery narrowing which sales are returned), never a
-- breakdown, and a sale can carry more than one payment (split-tender,
-- C3), so a client-side derivation from list_shop_sales rows would
-- either double count a sale under multiple methods or be unable to
-- attribute the right amount to each method at all. A genuinely new
-- aggregate is needed. Sums payments.amount directly (not
-- invoices.total) since a split-tender sale's per-method amount is a
-- property of the payment row itself, not the invoice -- payments are
-- the correct, singular source of truth for "how much of which method
-- was collected," matching payment_allocations/payments being the
-- house ledger for money received (as opposed to invoice_items being
-- the ledger for revenue by product/category above).
create or replace function public.get_shop_payment_method_mix(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null
)
returns table(
  method text,
  transaction_count bigint,
  total_amount numeric
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    pay.method,
    count(distinct s.id)::bigint as transaction_count,
    coalesce(sum(pa.amount), 0) as total_amount
  from public.shop_sales s
  join public.payment_allocations pa on pa.invoice_id = s.invoice_id
  join public.payments pay on pay.id = pa.payment_id
  where s.club_id = p_club_id
    and s.status in ('completed', 'partially_returned', 'returned')
    and pay.status = 'completed'
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
  group by pay.method
  order by total_amount desc;
end;
$$;

revoke all on function public.get_shop_payment_method_mix(uuid, date, date) from public, anon;
grant execute on function public.get_shop_payment_method_mix(uuid, date, date) to authenticated;

-- list_shop_recent_returns(): club-wide recent-returns list for the
-- dashboard's "Recent Returns" section. C5's get_shop_sale_returns_history
-- is deliberately per-sale (p_sale_id required) -- built for the Sale
-- Detail dialog, not a club-wide feed. A genuinely new, narrowly-scoped
-- list RPC, following the same shape (return-level rows, refund
-- amount/method joined in only when a refund actually happened) but
-- across the whole club and ordered by recency, capped by p_limit.
create or replace function public.list_shop_recent_returns(
  p_club_id uuid,
  p_limit int default 10
)
returns table(
  return_id uuid,
  sale_id uuid,
  invoice_number text,
  processed_by_name text,
  restock boolean,
  reason text,
  created_at timestamptz,
  refund_amount numeric,
  refund_method text
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
    r.id,
    r.sale_id,
    i.invoice_number,
    pr.full_name,
    r.restock,
    r.reason,
    r.created_at,
    ref.amount,
    pay.method
  from public.shop_sale_returns r
  join public.shop_sales s on s.id = r.sale_id
  join public.invoices i on i.id = s.invoice_id
  left join public.profiles pr on pr.user_id = r.processed_by
  left join public.refunds ref on ref.id = r.refund_payment_id and ref.status = 'completed'
  left join public.payments pay on pay.id = ref.payment_id
  where r.club_id = p_club_id
  order by r.created_at desc
  limit p_limit;
end;
$$;

revoke all on function public.list_shop_recent_returns(uuid, int) from public, anon;
grant execute on function public.list_shop_recent_returns(uuid, int) to authenticated;
