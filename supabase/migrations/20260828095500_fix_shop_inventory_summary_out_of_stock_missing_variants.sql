-- get_shop_inventory_summary's out_of_stock_count counted rows in
-- shop_inventory_balances with on_hand = 0. But a balance row only exists
-- once a variant has seen an inventory movement (receive/transfer/adjust/
-- sale/count) at some location. A product variant that was created but has
-- NEVER been stocked anywhere (real production case found live: قميص رياضي
-- S/أحمر) has zero rows in shop_inventory_balances -- so it was silently
-- excluded from out_of_stock_count entirely, even though it is genuinely
-- unsellable/zero-stock. This undercounts true out-of-stock units and made
-- the Shop report's out-of-stock KPI wrong (showed 0 when a real
-- out-of-stock variant existed).
--
-- Fixed by enumerating every SELLABLE unit explicitly (each active variant
-- for a has_variants product, or the product itself for a non-variant
-- product) via a correlated subquery sum over shop_inventory_balances, so a
-- unit with no balance rows anywhere correctly sums to on_hand = 0 via
-- coalesce, instead of being invisible to the count.
--
-- NOTE: the same class of gap exists in get_shop_inventory_balances'
-- p_low_stock_only=true mode (used by the Inventory page's "low stock
-- only" filter/list) -- a never-stocked variant is invisible there too,
-- since that RPC inner-joins shop_inventory_locations and has no location
-- to attribute a synthetic zero row to for a variant with no balance rows
-- at any location. Left as a documented follow-up rather than fixed here:
-- that RPC's row shape is relied on by other callers (receive/transfer/
-- adjust dialogs also query it without p_low_stock_only), so synthesizing
-- a location-less row for never-stocked variants needs a deliberate
-- shape decision, not a narrow fix bundled into this KPI correction.
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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  with sellable_units as (
    -- One row per sellable unit: each active variant of a has_variants
    -- product, or the product itself when it has no variants.
    select p.id as product_id, v.id as variant_id, p.reorder_level
    from public.shop_products p
    left join public.shop_product_variants v
      on v.product_id = p.id and p.has_variants and v.status = 'active'
    where p.club_id = p_club_id and p.status = 'active'
      and (not p.has_variants or v.id is not null)
  ),
  unit_totals as (
    select
      su.product_id, su.variant_id, su.reorder_level,
      coalesce((
        select sum(b.on_hand) from public.shop_inventory_balances b
        where b.product_id = su.product_id
          and coalesce(b.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(su.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
      ), 0) as unit_on_hand
    from sellable_units su
  )
  select
    (select count(*) from public.shop_products where club_id = p_club_id and status = 'active'),
    (select coalesce(sum(on_hand), 0) from public.shop_inventory_balances where club_id = p_club_id),
    (select count(*) from unit_totals where reorder_level is not null and unit_on_hand > 0 and unit_on_hand <= reorder_level),
    (select count(*) from unit_totals where unit_on_hand = 0);
end;
$$;

revoke all on function public.get_shop_inventory_summary(uuid) from public, anon;
grant execute on function public.get_shop_inventory_summary(uuid) to authenticated;
