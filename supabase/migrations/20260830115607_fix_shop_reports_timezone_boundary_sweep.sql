-- REPORTING ACCURACY & MANAGEMENT INSIGHT ACCEPTANCE (Stage B, B5,
-- systemic sweep, 2026-08-30): the entire Shop reports module was
-- never in scope of club_timezone_aware_report_boundaries /
-- apply_club_timezone_to_finance_reports -- it postdates those
-- migrations and was never retrofitted. Confirmed 6 Shop report RPCs
-- share the identical bug already fixed this same day in
-- get_field_occupancy_report() and get_customer_activity_report():
-- comparing a timestamptz column cast to ::date (implicit UTC session
-- timezone) against club-local date parameters, instead of using
-- club_local_day_bounds():
--   get_shop_sales_kpis            (shop_sales.created_at)  -- Sales Summary KPIs
--   get_shop_gross_profit          (shop_sales.created_at)  -- Gross Profit / Margin
--   get_shop_payment_method_mix    (shop_sales.created_at)  -- Payment Method Sales
--   get_shop_sales_by_category     (shop_sales.created_at)  -- Category Sales
--   get_shop_supplier_purchase_activity (shop_inventory_movements.created_at) -- Supplier Activity
--   get_shop_top_products          (shop_sales.created_at)  -- Product Sales
--
-- Same real consequence as the two Finance-side fixes already applied
-- today: a sale, return, or stock receipt near local midnight in a
-- positive-UTC-offset club timezone (e.g. Africa/Cairo) can be
-- attributed to the wrong report day, shifting revenue/COGS/units
-- between adjacent days on every one of these Shop reports.
--
-- All 6 parameters are nullable (p_start_date/p_end_date default
-- null, meaning "no date filter") in the ORIGINAL functions -- this
-- fix preserves that exactly: club_local_day_bounds() is only
-- computed and applied when the corresponding parameter is non-null,
-- so "no filter" behavior is completely unchanged. No other clause,
-- permission check, grant, or return shape changes in any of the 6
-- functions.
create or replace function public.get_shop_sales_kpis(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_branch_id uuid DEFAULT NULL::uuid, p_cashier_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_category_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_invoice_number text DEFAULT NULL::text, p_status text DEFAULT NULL::text)
 returns table(transaction_count bigint, gross_sales numeric, discount_total numeric, refund_total numeric, net_sales numeric, items_sold numeric, average_basket numeric)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
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
      and (v_range_start is null or s.created_at >= v_range_start)
      and (v_range_end is null or s.created_at < v_range_end)
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
$function$;

create or replace function public.get_shop_gross_profit(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_category_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid)
 returns table(revenue_known_cost numeric, cost_of_goods numeric, gross_profit numeric, margin_pct numeric, known_cost_lines bigint, cost_unavailable_lines bigint, cost_unavailable_revenue numeric, net_revenue_known_cost numeric, net_cost_of_goods numeric, net_gross_profit numeric, net_margin_pct numeric)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          and public.has_permission('shop.reports.view_profit', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
  end if;

  return query
  with lines as (
    select
      si.unit_cost_snapshot, si.quantity, si.line_total, si.returned_quantity,
      case when si.quantity > 0
        then si.line_total * (si.quantity - si.returned_quantity) / si.quantity
        else si.line_total
      end as net_line_total,
      case when si.quantity > 0
        then si.unit_cost_snapshot * (si.quantity - si.returned_quantity)
        else 0
      end as net_line_cost
    from public.shop_sale_items si
    join public.shop_sales s on s.id = si.sale_id
    join public.shop_products p on p.id = si.product_id
    where s.club_id = p_club_id
      and s.status in ('completed', 'partially_returned', 'returned')
      and (v_range_start is null or s.created_at >= v_range_start)
      and (v_range_end is null or s.created_at < v_range_end)
      and (p_category_id is null or p.category_id = p_category_id)
      and (p_product_id is null or si.product_id = p_product_id)
  ),
  known as (select * from lines where unit_cost_snapshot is not null),
  unknown as (select * from lines where unit_cost_snapshot is null)
  select
    coalesce((select sum(line_total) from known), 0),
    coalesce((select sum(unit_cost_snapshot * quantity) from known), 0),
    coalesce((select sum(line_total) from known), 0) - coalesce((select sum(unit_cost_snapshot * quantity) from known), 0),
    case when coalesce((select sum(line_total) from known), 0) = 0 then 0
      else round(
        (coalesce((select sum(line_total) from known), 0) - coalesce((select sum(unit_cost_snapshot * quantity) from known), 0))
        / (select sum(line_total) from known) * 100, 2
      )
    end,
    (select count(*) from known)::bigint,
    (select count(*) from unknown)::bigint,
    coalesce((select sum(line_total) from unknown), 0),
    coalesce((select sum(net_line_total) from known), 0),
    coalesce((select sum(net_line_cost) from known), 0),
    coalesce((select sum(net_line_total) from known), 0) - coalesce((select sum(net_line_cost) from known), 0),
    case when coalesce((select sum(net_line_total) from known), 0) = 0 then 0
      else round(
        (coalesce((select sum(net_line_total) from known), 0) - coalesce((select sum(net_line_cost) from known), 0))
        / (select sum(net_line_total) from known) * 100, 2
      )
    end;
end;
$function$;

create or replace function public.get_shop_payment_method_mix(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 returns table(method text, transaction_count bigint, total_amount numeric)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
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
    and (v_range_start is null or s.created_at >= v_range_start)
    and (v_range_end is null or s.created_at < v_range_end)
  group by pay.method
  order by total_amount desc;
end;
$function$;

create or replace function public.get_shop_sales_by_category(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date)
 returns table(category_id uuid, category_name text, units_sold numeric, revenue numeric)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
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
    and (v_range_start is null or s.created_at >= v_range_start)
    and (v_range_end is null or s.created_at < v_range_end)
  group by cat.id, cat.name_ar
  order by revenue desc;
end;
$function$;

create or replace function public.get_shop_supplier_purchase_activity(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_supplier_id uuid DEFAULT NULL::uuid)
 returns table(supplier_id uuid, supplier_name text, receipt_count bigint, total_quantity numeric, total_cost_value numeric, last_receipt_at timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
  end if;

  return query
  select
    sup.id,
    coalesce(sup.name, '—'),
    count(*)::bigint,
    coalesce(sum(m.quantity), 0),
    coalesce(sum(m.quantity * coalesce(m.unit_cost, 0)), 0),
    max(m.created_at)
  from public.shop_inventory_movements m
  join public.shop_inventory_locations l on l.id = m.location_id
  left join public.shop_suppliers sup on sup.id = m.reference_id and m.reference_type = 'shop_supplier'
  where l.club_id = p_club_id
    and m.movement_type = 'purchase_receipt'
    and (v_range_start is null or m.created_at >= v_range_start)
    and (v_range_end is null or m.created_at < v_range_end)
    and (p_supplier_id is null or sup.id = p_supplier_id)
  group by sup.id, sup.name
  order by total_cost_value desc;
end;
$function$;

create or replace function public.get_shop_top_products(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_limit integer DEFAULT 10, p_offset integer DEFAULT 0, p_category_id uuid DEFAULT NULL::uuid)
 returns table(product_id uuid, product_name_ar text, units_sold numeric, units_returned numeric, revenue numeric)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
  end if;

  return query
  select
    p.id,
    p.name_ar,
    coalesce(sum(si.quantity), 0) as units_sold,
    coalesce(sum(si.returned_quantity), 0) as units_returned,
    coalesce(sum(ii.line_total), 0) as revenue
  from public.shop_products p
  join public.shop_sale_items si on si.product_id = p.id
  join public.shop_sales s on s.id = si.sale_id
  join public.invoice_items ii on ii.id = si.invoice_item_id
  where p.club_id = p_club_id
    and s.status in ('completed', 'partially_returned', 'returned')
    and (v_range_start is null or s.created_at >= v_range_start)
    and (v_range_end is null or s.created_at < v_range_end)
    and (p_category_id is null or p.category_id = p_category_id)
  group by p.id, p.name_ar
  order by units_sold desc
  limit p_limit offset p_offset;
end;
$function$;
