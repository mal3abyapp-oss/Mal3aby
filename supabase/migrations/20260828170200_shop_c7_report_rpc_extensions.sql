-- Commerce Pro C7: additive extensions to existing Shop read RPCs, for
-- the 16-report suite (plan Section 5, Phase C7, item 2). Every
-- function here is either (a) an unchanged-signature, unchanged-
-- return-shape CREATE OR REPLACE (safe in place, invariant 8 does not
-- apply), or (b) a signature change with an UNCHANGED return shape
-- (also safe in place per invariant 8's own carve-out: "an unchanged
-- return shape with only new/reordered input parameters is a
-- different function identity to Postgres and CREATE OR REPLACE...
-- works fine there, no drop needed" -- confirmed working in C5 for
-- list_shop_sales/get_shop_sales_kpis). Every body below is the real,
-- latest live definition read directly from its own migration file
-- immediately before writing this one, with only the documented
-- additive change applied -- no line silently altered.

-- =====================================================================
-- 1. get_shop_top_products: PRODUCT SALES report (item 3) needs real
--    pagination + a category filter to become a full report, not just
--    a "top 10" dashboard widget. Latest live body read from
--    20260828095000_shop_final_module_active_sweep.sql. Appends
--    p_offset (default 0) and p_category_id (default null) -- new
--    params only, return shape (product_id, product_name_ar,
--    units_sold, units_returned, revenue) is byte-identical, so this
--    is case (b) above: safe CREATE OR REPLACE on a new overload,
--    followed by an explicit drop of the old 4-arg overload (same
--    grant-leak-prevention precedent as every prior Shop RPC signature
--    change).
-- =====================================================================
create or replace function public.get_shop_top_products(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_limit integer default 10,
  p_offset integer default 0,
  p_category_id uuid default null
)
returns table(product_id uuid, product_name_ar text, units_sold numeric, units_returned numeric, revenue numeric)
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
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
    and (p_category_id is null or p.category_id = p_category_id)
  group by p.id, p.name_ar
  order by units_sold desc
  limit p_limit offset p_offset;
end;
$$;

drop function if exists public.get_shop_top_products(uuid, date, date, integer);

revoke all on function public.get_shop_top_products(uuid, date, date, integer, integer, uuid) from public, anon;
grant execute on function public.get_shop_top_products(uuid, date, date, integer, integer, uuid) to authenticated;

-- =====================================================================
-- 2. list_shop_inventory_movements: STOCK MOVEMENT LEDGER (item 10)
--    "can grow large, server-side pagination is mandatory" -- already
--    has p_limit/p_offset (confirmed). Missing: date range and
--    movement_type filter, both real operational needs for a ledger
--    report (e.g. "show me only purchase_receipt movements this
--    month"). Latest live body read from
--    20260828083000_shop_read_rpcs_enforce_module_active.sql. Appends
--    p_start_date/p_end_date/p_movement_type (all default null) --
--    return shape (movement_id..created_at) byte-identical, case (b):
--    safe CREATE OR REPLACE + explicit drop of the old 5-arg overload.
-- =====================================================================
create or replace function public.list_shop_inventory_movements(
  p_club_id uuid,
  p_product_id uuid default null,
  p_location_id uuid default null,
  p_limit integer default 50,
  p_offset integer default 0,
  p_start_date date default null,
  p_end_date date default null,
  p_movement_type text default null
)
returns table(movement_id uuid, location_name text, product_name_ar text, variant_label text, movement_type text, quantity numeric, unit_cost numeric, actor_id uuid, reference_type text, reference_id uuid, reason text, created_at timestamptz)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select m.id, l.name, p.name_ar,
         nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         m.movement_type, m.quantity, m.unit_cost, m.actor_id, m.reference_type, m.reference_id, m.reason, m.created_at
  from public.shop_inventory_movements m
  join public.shop_inventory_locations l on l.id = m.location_id
  join public.shop_products p on p.id = m.product_id
  left join public.shop_product_variants v on v.id = m.variant_id
  where m.club_id = p_club_id
    and (p_product_id is null or m.product_id = p_product_id)
    and (p_location_id is null or m.location_id = p_location_id)
    and (p_start_date is null or m.created_at::date >= p_start_date)
    and (p_end_date is null or m.created_at::date <= p_end_date)
    and (p_movement_type is null or m.movement_type = p_movement_type)
  order by m.created_at desc
  limit p_limit offset p_offset;
end;
$$;

drop function if exists public.list_shop_inventory_movements(uuid, uuid, uuid, integer, integer);

revoke all on function public.list_shop_inventory_movements(uuid, uuid, uuid, integer, integer, date, date, text) from public, anon;
grant execute on function public.list_shop_inventory_movements(uuid, uuid, uuid, integer, integer, date, date, text) to authenticated;

-- =====================================================================
-- 3. get_customer_shop_purchases: CUSTOMER PURCHASES report (item 7)
--    "likely just needs a report-page wrapper with filters" -- the
--    existing RPC has no date range and no pagination, both real gaps
--    for a customer with a long purchase history. Latest live body
--    read from 20260828095000_shop_final_module_active_sweep.sql.
--    Appends p_start_date/p_end_date/p_limit/p_offset (all default
--    null/reasonable defaults) -- return shape byte-identical, case
--    (b): safe CREATE OR REPLACE + explicit drop of the old 2-arg
--    overload.
-- =====================================================================
create or replace function public.get_customer_shop_purchases(
  p_club_id uuid,
  p_customer_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(sale_id uuid, invoice_id uuid, invoice_number text, sale_status text, product_name_ar text, variant_label text, quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric, created_at timestamptz)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found in this club';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select s.id, i.id, i.invoice_number, s.status,
         p.name_ar, nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         si.quantity, si.unit_price, si.line_total, si.returned_quantity, s.created_at
  from public.shop_sale_items si
  join public.shop_sales s on s.id = si.sale_id
  join public.invoices i on i.id = s.invoice_id
  join public.shop_products p on p.id = si.product_id
  left join public.shop_product_variants v on v.id = si.variant_id
  where s.club_id = p_club_id and s.customer_id = p_customer_id
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$$;

drop function if exists public.get_customer_shop_purchases(uuid, uuid);

revoke all on function public.get_customer_shop_purchases(uuid, uuid, date, date, integer, integer) from public, anon;
grant execute on function public.get_customer_shop_purchases(uuid, uuid, date, date, integer, integer) to authenticated;

-- =====================================================================
-- 4. list_shop_sale_returns: RETURNS / REFUNDS report (item 8) -- a
--    genuine filterable/paginated report, not C6's "recent 10" list
--    (list_shop_recent_returns has no filters and a hard p_limit
--    default of 10 with no p_offset -- built deliberately narrow for a
--    dashboard card, per C6's own report). New RPC rather than
--    extending list_shop_recent_returns in place, because that
--    function's whole reason to exist (per C6's report) is "small,
--    fixed-size dashboard feed" -- turning it into a full paginated/
--    filtered report would be scope creep on a function another
--    screen already depends on for a specific narrow purpose. Same
--    join shape as list_shop_recent_returns, plus real filters
--    (date range, reason substring, restock-only, refunded-only) and
--    real p_limit/p_offset pagination.
-- =====================================================================
create or replace function public.list_shop_sale_returns(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_restock_only boolean default null,
  p_refunded_only boolean default null,
  p_limit int default 50,
  p_offset int default 0
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
    r.id, r.sale_id, i.invoice_number, pr.full_name, r.restock, r.reason, r.created_at,
    ref.amount, pay.method
  from public.shop_sale_returns r
  join public.shop_sales s on s.id = r.sale_id
  join public.invoices i on i.id = s.invoice_id
  left join public.profiles pr on pr.user_id = r.processed_by
  left join public.refunds ref on ref.id = r.refund_payment_id and ref.status = 'completed'
  left join public.payments pay on pay.id = ref.payment_id
  where r.club_id = p_club_id
    and (p_start_date is null or r.created_at::date >= p_start_date)
    and (p_end_date is null or r.created_at::date <= p_end_date)
    and (p_restock_only is null or r.restock = p_restock_only)
    and (p_refunded_only is null
         or (p_refunded_only and ref.id is not null)
         or (not p_refunded_only and ref.id is null))
  order by r.created_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_sale_returns(uuid, date, date, boolean, boolean, int, int) from public, anon;
grant execute on function public.list_shop_sale_returns(uuid, date, date, boolean, boolean, int, int) to authenticated;

-- =====================================================================
-- 5. get_shop_stock_valuation: STOCK VALUATION report (item 13) -- on-
--    hand quantity x cost. Uses the SAME "last purchase_receipt cost"
--    source as the cost-at-sale snapshot
--    (20260828170100_create_shop_sale_cost_snapshot.sql), for
--    consistency -- documented explicitly here per the task's own
--    instruction to state which cost source was used and why: a
--    point-in-time valuation of CURRENT on-hand stock is conceptually
--    closer to "what would it cost to replace what's on the shelf
--    right now" than to any specific sale's own historical cost, and
--    "most recent purchase cost, club-wide" is exactly that same
--    signal -- reusing it (rather than inventing a second costing
--    method) also means Stock Valuation and Gross Profit never
--    silently disagree about what "cost" means for the same product.
--    A unit never yet received via receive_shop_stock has no known
--    cost -- its valuation row still appears (on_hand is real) but
--    unit_cost/line_value are both null, never fabricated as 0 --
--    consumer renders "Cost unavailable" exactly like Gross Profit
--    does for pre-snapshot sales.
--
--    Gated on shop.reports.view_profit (plan Section 3: cost data is
--    commercially sensitive, gated separately from
--    shop.view/report.view/inventory.view) IN ADDITION TO
--    inventory.view -- both are required, since this is fundamentally
--    an inventory-shaped report exposing cost, not a general-audience
--    inventory report. Seeded in
--    20260828170150_shop_reports_view_profit_permission_seed.sql
--    (this migration must run after that one -- confirmed via
--    timestamp ordering).
-- =====================================================================
create or replace function public.get_shop_stock_valuation(
  p_club_id uuid,
  p_location_id uuid default null
)
returns table(
  location_id uuid,
  location_name text,
  product_id uuid,
  product_name_ar text,
  variant_id uuid,
  variant_label text,
  on_hand numeric,
  unit_cost numeric,
  line_value numeric
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          and public.has_permission('shop.reports.view_profit', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    b.location_id, l.name, b.product_id, p.name_ar, b.variant_id,
    nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
    b.on_hand,
    (
      select m.unit_cost from public.shop_inventory_movements m
      join public.shop_inventory_locations ml on ml.id = m.location_id
      where ml.club_id = p_club_id
        and m.product_id = b.product_id
        and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(b.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and m.movement_type = 'purchase_receipt'
        and m.unit_cost is not null
      order by m.created_at desc
      limit 1
    ) as unit_cost,
    b.on_hand * (
      select m.unit_cost from public.shop_inventory_movements m
      join public.shop_inventory_locations ml on ml.id = m.location_id
      where ml.club_id = p_club_id
        and m.product_id = b.product_id
        and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(b.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and m.movement_type = 'purchase_receipt'
        and m.unit_cost is not null
      order by m.created_at desc
      limit 1
    ) as line_value
  from public.shop_inventory_balances b
  join public.shop_inventory_locations l on l.id = b.location_id
  join public.shop_products p on p.id = b.product_id
  left join public.shop_product_variants v on v.id = b.variant_id
  where b.club_id = p_club_id
    and (p_location_id is null or b.location_id = p_location_id)
  order by p.name_ar, l.name;
end;
$$;

revoke all on function public.get_shop_stock_valuation(uuid, uuid) from public, anon;
grant execute on function public.get_shop_stock_valuation(uuid, uuid) to authenticated;

-- =====================================================================
-- 6. get_shop_gross_profit: GROSS PROFIT / MARGIN report (item 14) --
--    the single most important honesty requirement in this phase: any
--    sale line whose unit_cost_snapshot is null (a sale that happened
--    before this column existed, or whose unit had never been
--    received via receive_shop_stock at time of sale) MUST show "cost
--    unavailable", never a fabricated number. Achieved structurally,
--    not by a UI-side guess: this RPC returns cost_unavailable_lines
--    (count of lines with a null snapshot, excluded from every money
--    aggregate) alongside gross_profit/margin computed ONLY from lines
--    that actually have a real snapshot. A consumer summing
--    known-cost revenue + cost_unavailable_lines can render both "the
--    real profit figure for what we CAN measure" and "N lines are not
--    included" side by side, honestly, in one query -- never silently
--    dropping the gap or silently treating null as zero cost (which
--    would fabricate 100% margin on exactly the sales this feature
--    can least afford to be wrong about).
--
--    Gated on shop.reports.view_profit IN ADDITION TO report.view (see
--    get_shop_stock_valuation's own comment above for the full
--    reasoning -- same club_owner-only permission protects both of
--    this phase's two genuinely-cost-bearing reports).
-- =====================================================================
create or replace function public.get_shop_gross_profit(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_category_id uuid default null,
  p_product_id uuid default null
)
returns table(
  revenue_known_cost numeric,
  cost_of_goods numeric,
  gross_profit numeric,
  margin_pct numeric,
  known_cost_lines bigint,
  cost_unavailable_lines bigint,
  cost_unavailable_revenue numeric
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          and public.has_permission('shop.reports.view_profit', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  with lines as (
    select si.unit_cost_snapshot, si.quantity, si.line_total
    from public.shop_sale_items si
    join public.shop_sales s on s.id = si.sale_id
    join public.shop_products p on p.id = si.product_id
    where s.club_id = p_club_id
      and s.status in ('completed', 'partially_returned', 'returned')
      and (p_start_date is null or s.created_at::date >= p_start_date)
      and (p_end_date is null or s.created_at::date <= p_end_date)
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
    coalesce((select sum(line_total) from unknown), 0);
end;
$$;

revoke all on function public.get_shop_gross_profit(uuid, date, date, uuid, uuid) from public, anon;
grant execute on function public.get_shop_gross_profit(uuid, date, date, uuid, uuid) to authenticated;

-- =====================================================================
-- 7. get_shop_supplier_purchase_activity: SUPPLIER PURCHASE/RECEIPT
--    ACTIVITY report (item 15). Data check performed before writing
--    this (per the task's own instruction): shop_suppliers is a
--    minimal lookup table (name/phone/email/notes/is_active, confirmed
--    via direct schema read, 20260826210231_shop_catalog_schema.sql --
--    no procurement/accounts-payable engine, per that migration's own
--    comment). The only linkage from a purchase to a supplier is
--    receive_shop_stock() writing reference_type='shop_supplier',
--    reference_id=p_supplier_id onto the shop_inventory_movements row
--    it creates (confirmed via direct read of
--    20260826230437_shop_receive_transfer_support_audit.sql) -- and
--    p_supplier_id is OPTIONAL there (receive_shop_stock allows a
--    receipt with no supplier attached). This report is therefore
--    genuinely light, as the plan anticipated: one row per supplier,
--    aggregate receipt count/quantity/total cost value, plus a
--    separate "no supplier recorded" bucket (reference_id is null)
--    for receipts that were never attributed -- never silently
--    dropped from the total.
-- =====================================================================
create or replace function public.get_shop_supplier_purchase_activity(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_supplier_id uuid default null
)
returns table(
  supplier_id uuid,
  supplier_name text,
  receipt_count bigint,
  total_quantity numeric,
  total_cost_value numeric,
  last_receipt_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
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
    and (p_start_date is null or m.created_at::date >= p_start_date)
    and (p_end_date is null or m.created_at::date <= p_end_date)
    and (p_supplier_id is null or sup.id = p_supplier_id)
  group by sup.id, sup.name
  order by total_cost_value desc;
end;
$$;

revoke all on function public.get_shop_supplier_purchase_activity(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_shop_supplier_purchase_activity(uuid, date, date, uuid) to authenticated;

-- =====================================================================
-- 8. list_shop_stock_count_variance: STOCK COUNT VARIANCE report (item
--    16) -- a filterable summary/list ACROSS stock counts (not a
--    rebuild of the existing dedicated Stock Count UX). Reuses
--    shop_stock_counts/shop_stock_count_items exactly as they are
--    (confirmed via direct schema read,
--    20260827002151_shop_stock_count_schema.sql --
--    shop_stock_count_items.variance is already a GENERATED ALWAYS
--    STORED column, counted_quantity - system_quantity, so this report
--    never recomputes variance itself, it only surfaces the existing
--    authoritative value). One row per counted line, across every
--    completed count in range, so a manager can see "which specific
--    lines had the biggest variance this month" without opening each
--    count individually. Only counted lines (counted_quantity is not
--    null) are returned -- an in-progress count's un-counted lines
--    have variance = null by construction and are not meaningful here.
-- =====================================================================
create or replace function public.list_shop_stock_count_variance(
  p_club_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_location_id uuid default null,
  p_nonzero_only boolean default false,
  p_limit int default 100,
  p_offset int default 0
)
returns table(
  stock_count_id uuid,
  location_name text,
  completed_at timestamptz,
  product_name_ar text,
  variant_label text,
  system_quantity numeric,
  counted_quantity numeric,
  variance numeric,
  counted_by_name text
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    sc.id, l.name, sc.completed_at, p.name_ar,
    nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
    sci.system_quantity, sci.counted_quantity, sci.variance, pr.full_name
  from public.shop_stock_count_items sci
  join public.shop_stock_counts sc on sc.id = sci.stock_count_id
  join public.shop_inventory_locations l on l.id = sc.location_id
  join public.shop_products p on p.id = sci.product_id
  left join public.shop_product_variants v on v.id = sci.variant_id
  left join public.profiles pr on pr.user_id = sci.counted_by
  where sc.club_id = p_club_id
    and sci.counted_quantity is not null
    and (p_start_date is null or sc.completed_at::date >= p_start_date)
    and (p_end_date is null or sc.completed_at::date <= p_end_date)
    and (p_location_id is null or sc.location_id = p_location_id)
    and (not p_nonzero_only or sci.variance <> 0)
  order by sc.completed_at desc nulls last
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_stock_count_variance(uuid, date, date, uuid, boolean, int, int) from public, anon;
grant execute on function public.list_shop_stock_count_variance(uuid, date, date, uuid, boolean, int, int) to authenticated;
