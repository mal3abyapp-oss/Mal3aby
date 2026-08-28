-- Commerce Pro (post-C10 additional QA finding, 2026-08-28):
-- get_shop_gross_profit reports GROSS figures only -- a fully (or
-- partially) refunded sale's original revenue/cost still counts in
-- full toward gross_profit/margin_pct, with no adjustment and no
-- parallel "net of returns" figure anywhere in the RPC's output. This
-- was found live: a real sale (250.00 revenue, 120 cost, at
-- unit_cost_snapshot=120) was created and then fully returned/refunded
-- in the same session -- get_shop_gross_profit still counted its full
-- revenue/cost as if the sale had never been reversed, inflating
-- gross_profit by the full 130.00 margin of a sale that generated
-- zero real profit.
--
-- This is not classified as a bug in the strict sense -- "gross"
-- profit conventionally does mean pre-return figures, and the RPC's
-- existing behavior is internally consistent with get_shop_top_products'
-- own identical status filter (both intentionally include 'returned'
-- sales, per the C7 migration's own comment). But the report gave no
-- way to see the return-adjusted figure at all, unlike
-- get_shop_sales_kpis (C5/C6), which already separates gross_sales
-- from net_sales/refund_total side by side. Fixed the same way: adds
-- NET-of-returns columns alongside the existing gross ones, rather
-- than replacing them -- a report literally named "Gross Profit"
-- should still show the gross figure, but a club owner needs the net
-- one visible in the same query to avoid being misled by a fully-
-- refunded sale's paper profit.
--
-- Refund-adjustment is computed from shop_sale_items.returned_quantity
-- directly (already a maintained running total, kept correct by
-- return_shop_sale under row-level locking) rather than re-joining
-- shop_sale_returns/shop_sale_return_items -- avoids any risk of
-- double-counting across multiple partial returns on the same line,
-- and matches the same quantity-proportion method already used
-- elsewhere in this module for partial-return math. The adjustment
-- applies ONLY to known-cost lines (the exact same honesty boundary as
-- the rest of this RPC) -- a cost-unavailable line's revenue was
-- already excluded from every profit figure, so there is nothing to
-- adjust for it here either.
--
-- RETURNS TABLE shape changes (net_* columns appended) -- per
-- COMMERCE_PRO_UPGRADE_PLAN.md Section 2 invariant 8, an explicit DROP
-- FUNCTION is required first; CREATE OR REPLACE alone would fail with
-- 42P13, exactly as it did three times earlier in this same directive.
drop function if exists public.get_shop_gross_profit(uuid, date, date, uuid, uuid);

create function public.get_shop_gross_profit(
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
  cost_unavailable_revenue numeric,
  net_revenue_known_cost numeric,
  net_cost_of_goods numeric,
  net_gross_profit numeric,
  net_margin_pct numeric
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
    select
      si.unit_cost_snapshot, si.quantity, si.line_total, si.returned_quantity,
      -- Proportional revenue/cost still attributable after returns --
      -- e.g. 2 sold, 1 returned, line_total 30.00 -> 15.00 still
      -- attributable. Uses quantity, not a separate refund-amount
      -- lookup, so it is correct even if a return's refund_amount
      -- (which staff enters manually, per plan Section 12) differs
      -- slightly from a strict pro-rata split -- this is a physical
      -- merchandise-returned adjustment, not a re-derivation of the
      -- financial refund ledger (that remains refunds/shop_sale_returns'
      -- own job, untouched by this migration).
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
$$;

revoke all on function public.get_shop_gross_profit(uuid, date, date, uuid, uuid) from public, anon;
grant execute on function public.get_shop_gross_profit(uuid, date, date, uuid, uuid) to authenticated;
