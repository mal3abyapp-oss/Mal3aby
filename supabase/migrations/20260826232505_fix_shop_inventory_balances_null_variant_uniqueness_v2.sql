-- CRITICAL LIVE DATA BUG (2026-08-26) -- found by adversarial security
-- testing, confirmed already corrupting real data before this fix.
--
-- shop_inventory_balances had a plain `UNIQUE (location_id, product_id,
-- variant_id)` constraint. Postgres unique constraints never treat two
-- NULLs as equal/conflicting -- so for every non-variant product
-- (variant_id IS NULL, which is the majority case: any product with
-- has_variants=false), `INSERT ... ON CONFLICT (location_id,
-- product_id, variant_id) DO NOTHING` in
-- _apply_shop_inventory_movement_internal never actually detected a
-- conflict and silently inserted a brand-new zero-balance row on
-- EVERY movement. The subsequent `SELECT ... WHERE variant_id IS NOT
-- DISTINCT FROM p_variant_id FOR UPDATE` (no deterministic ordering)
-- then locked and updated only one of the now-many matching rows,
-- non-deterministically -- confirmed live: two real products already
-- had 7 and 9 duplicate balance rows, with get_shop_inventory_balances()
-- returning multiple contradictory on_hand values for the same
-- product/location.
--
-- Fix, in order:
--   1. Consolidate every existing duplicate group into ONE row per
--      (location_id, product_id, variant_id), summing on_hand across
--      the duplicates (the true total was always correctly reflected
--      in aggregate -- movements were applied correctly in total, only
--      split across rows non-deterministically -- confirmed by the
--      audit's own reconciliation test: the movement-ledger SUM
--      matched the intended running total at every step). Delete the
--      now-redundant rows.
--   2. Drop the broken plain UNIQUE constraint.
--   3. Add a real unique index using COALESCE(variant_id, a fixed
--      sentinel uuid) -- this correctly treats "no variant" as ONE
--      consistent value for uniqueness purposes, closing the NULL
--      loophole.
--   4. Fix _apply_shop_inventory_movement_internal to look up/lock via
--      the exact same COALESCE expression, so it's guaranteed to find
--      (or correctly conflict-create) exactly one row.
do $$
declare
  v_dup record;
  v_keep_id uuid;
begin
  for v_dup in
    select location_id, product_id, variant_id, sum(on_hand) as total_on_hand, array_agg(id order by id) as all_ids
    from public.shop_inventory_balances
    group by location_id, product_id, variant_id
    having count(*) > 1
  loop
    v_keep_id := v_dup.all_ids[1];

    update public.shop_inventory_balances
    set on_hand = v_dup.total_on_hand, updated_at = now()
    where id = v_keep_id;

    delete from public.shop_inventory_balances
    where id = any(v_dup.all_ids) and id != v_keep_id;
  end loop;
end $$;

alter table public.shop_inventory_balances
  drop constraint shop_inventory_balances_location_id_product_id_variant_id_key;

create unique index shop_inventory_balances_location_product_variant_uniq
  on public.shop_inventory_balances (location_id, product_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));

create or replace function public._apply_shop_inventory_movement_internal(
  p_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_movement_type text,
  p_quantity numeric,
  p_direction text,
  p_actor_id uuid,
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_reason text default null,
  p_unit_cost numeric default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_balance_id uuid;
  v_current_on_hand numeric;
  v_movement_id uuid;
begin
  if p_quantity <= 0 then
    raise exception 'movement quantity must be positive';
  end if;
  if p_direction not in ('in', 'out') then
    raise exception 'invalid movement direction';
  end if;

  select club_id into v_club_id from public.shop_inventory_locations where id = p_location_id;
  if v_club_id is null then
    raise exception 'inventory location not found';
  end if;

  if not exists (select 1 from public.shop_products where id = p_product_id and club_id = v_club_id) then
    raise exception 'product does not belong to this club';
  end if;
  if p_variant_id is not null and not exists (
    select 1 from public.shop_product_variants where id = p_variant_id and club_id = v_club_id
  ) then
    raise exception 'variant does not belong to this club';
  end if;

  -- Lock (or create-then-lock) the balance row for this exact
  -- location+product+variant before reading/mutating it. Matches the
  -- unique index's own COALESCE expression exactly, so this correctly
  -- conflicts (and does nothing) on retry for both variant and
  -- non-variant products alike -- the bug this migration fixes.
  insert into public.shop_inventory_balances (club_id, location_id, product_id, variant_id, on_hand)
  values (v_club_id, p_location_id, p_product_id, p_variant_id, 0)
  on conflict (location_id, product_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))) do nothing;

  select id, on_hand into v_balance_id, v_current_on_hand
  from public.shop_inventory_balances
  where location_id = p_location_id and product_id = p_product_id
    and coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(p_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
  for update;

  if p_direction = 'out' and v_current_on_hand < p_quantity then
    raise exception 'insufficient stock: % available, % requested', v_current_on_hand, p_quantity;
  end if;

  update public.shop_inventory_balances
  set on_hand = on_hand + case when p_direction = 'in' then p_quantity else -p_quantity end,
      updated_at = now()
  where id = v_balance_id;

  insert into public.shop_inventory_movements (
    club_id, location_id, product_id, variant_id, movement_type, quantity,
    unit_cost, actor_id, reference_type, reference_id, reason
  ) values (
    v_club_id, p_location_id, p_product_id, p_variant_id, p_movement_type, p_quantity,
    p_unit_cost, p_actor_id, p_reference_type, p_reference_id, p_reason
  ) returning id into v_movement_id;

  return v_movement_id;
end;
$$;
