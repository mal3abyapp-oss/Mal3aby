-- COMMERCIAL MODULE ARCHITECTURE, continued -- the SINGLE choke point
-- every inventory mutation goes through. Concurrency-safe by
-- construction: uses `select ... for update` to lock the balance row
-- (creating it first under an advisory-free UPSERT if it doesn't exist
-- yet) before checking/applying the delta, inside the caller's own
-- transaction -- two concurrent sales of the last unit will serialize
-- on this row lock, and the second one to acquire it sees the
-- already-decremented balance and fails the `on_hand >= 0` check
-- cleanly (never a negative balance, directive Section 18/26).
--
-- Never called directly by client code -- always through a specific
-- domain RPC (create_shop_sale, receive_shop_stock, etc, later
-- migrations) that has already checked the caller's permission for
-- THAT specific business action. This function itself re-derives
-- club_id from the location row (never trusts a caller-supplied
-- club_id) and does not re-check permissions -- callers are always
-- other SECURITY DEFINER functions in the same transaction, not a
-- public entrypoint (confirmed by the grant at the bottom: revoked
-- from authenticated, only callable from other SECURITY DEFINER
-- functions owned by the same role).
create or replace function public._apply_shop_inventory_movement_internal(
  p_location_id uuid,
  p_product_id uuid,
  p_variant_id uuid,
  p_movement_type text,
  p_quantity numeric,
  p_direction text, -- 'in' or 'out'
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
  -- location+product+variant before reading/mutating it -- this is
  -- what makes concurrent same-unit sales serialize safely.
  insert into public.shop_inventory_balances (club_id, location_id, product_id, variant_id, on_hand)
  values (v_club_id, p_location_id, p_product_id, p_variant_id, 0)
  on conflict (location_id, product_id, variant_id) do nothing;

  select id, on_hand into v_balance_id, v_current_on_hand
  from public.shop_inventory_balances
  where location_id = p_location_id and product_id = p_product_id
    and variant_id is not distinct from p_variant_id
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

revoke all on function public._apply_shop_inventory_movement_internal(uuid, uuid, uuid, text, numeric, text, uuid, text, uuid, text, numeric) from public;
revoke all on function public._apply_shop_inventory_movement_internal(uuid, uuid, uuid, text, numeric, text, uuid, text, uuid, text, numeric) from anon;
revoke all on function public._apply_shop_inventory_movement_internal(uuid, uuid, uuid, text, numeric, text, uuid, text, uuid, text, numeric) from authenticated;
