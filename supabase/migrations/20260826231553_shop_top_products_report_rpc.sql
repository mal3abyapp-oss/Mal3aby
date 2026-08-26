-- COMMERCIAL MODULE ARCHITECTURE, continued -- Phase H: operational
-- reporting (directive Section 10/53). get_shop_top_products() reports
-- UNITS ONLY (units_sold, units_returned) as the aggregate metric, plus
-- revenue re-derived by summing the real invoice_items.line_total for
-- that product's sale items (never independently summed from
-- shop_sale_items as if it were its own ledger -- the exact mechanism
-- documented in COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 9 that
-- prevents double-counting: there is structurally only one place money
-- is summed, invoice_items, joined back to for every monetary figure).
create or replace function public.get_shop_top_products(p_club_id uuid, p_start_date date default null, p_end_date date default null, p_limit int default 10)
returns table(
  product_id uuid, product_name_ar text, units_sold numeric, units_returned numeric, revenue numeric
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

  return query
  select
    p.id,
    p.name_ar,
    coalesce(sum(si.quantity), 0) as units_sold,
    coalesce(sum(si.returned_quantity), 0) as units_returned,
    -- Revenue re-derived from the REAL invoice_items line for this
    -- exact sale item -- never si.line_total summed independently.
    coalesce(sum(ii.line_total), 0) as revenue
  from public.shop_products p
  join public.shop_sale_items si on si.product_id = p.id
  join public.shop_sales s on s.id = si.sale_id
  join public.invoice_items ii on ii.id = si.invoice_item_id
  where p.club_id = p_club_id
    and s.status in ('completed', 'partially_returned', 'returned')
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
  group by p.id, p.name_ar
  order by units_sold desc
  limit p_limit;
end;
$$;

revoke all on function public.get_shop_top_products(uuid, date, date, int) from public;
revoke all on function public.get_shop_top_products(uuid, date, date, int) from anon;
grant execute on function public.get_shop_top_products(uuid, date, date, int) to authenticated;

-- get_shop_inventory_summary(): dashboard KPIs (directive Section 59)
-- -- active SKU count, on-hand total, low/out-of-stock counts. No
-- revenue card here at all (directive's own explicit warning against
-- "misleading revenue cards into inventory dashboard").
create or replace function public.get_shop_inventory_summary(p_club_id uuid)
returns table(active_products bigint, total_on_hand numeric, low_stock_count bigint, out_of_stock_count bigint)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;

  return query
  select
    (select count(*) from public.shop_products where club_id = p_club_id and status = 'active'),
    (select coalesce(sum(on_hand), 0) from public.shop_inventory_balances where club_id = p_club_id),
    (select count(*) from public.shop_inventory_balances b join public.shop_products p on p.id = b.product_id
     where b.club_id = p_club_id and p.reorder_level is not null and b.on_hand > 0 and b.on_hand <= p.reorder_level),
    (select count(*) from public.shop_inventory_balances where club_id = p_club_id and on_hand = 0);
end;
$$;

revoke all on function public.get_shop_inventory_summary(uuid) from public;
revoke all on function public.get_shop_inventory_summary(uuid) from anon;
grant execute on function public.get_shop_inventory_summary(uuid) to authenticated;
