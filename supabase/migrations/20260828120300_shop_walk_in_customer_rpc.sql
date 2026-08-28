-- Commerce Pro C3: lazy, idempotent per-club "Walk-in Customer" row.
--
-- Design decision (documented per the task's own instruction): C2/C1
-- confirmed create_shop_sale's p_customer_id is a hard, deliberately-
-- fixed NOT NULL requirement (20260826211221_fix_create_shop_sale_require_customer.sql
-- explicitly reversed an earlier "walk-in without a customer" design
-- after live testing, aligning Shop with every other invoice type in
-- this codebase -- bookings/academy/memberships all resolve a real
-- customer first, with zero exceptions). Weakening that recently-fixed,
-- deliberate invariant to accommodate walk-in POS sales would reopen
-- exactly the bug that migration closed. The safer choice is a real,
-- system-marked customers row per club, created lazily on first use --
-- never seeded eagerly for clubs that never touch Shop.
create or replace function public.get_or_create_shop_walk_in_customer(p_club_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_customer_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', p_club_id)
          or public.has_platform_support_access(p_club_id, true)) then
    raise exception 'not authorized';
  end if;

  select id into v_customer_id from public.customers
  where club_id = p_club_id and is_walk_in = true
  limit 1;

  if v_customer_id is not null then
    return v_customer_id;
  end if;

  -- Idempotent under concurrency: idx_customers_one_walk_in_per_club is a
  -- real partial unique index (club_id where is_walk_in = true), so a
  -- race between two cashiers both hitting the "no walk-in yet" branch
  -- at once resolves safely -- the losing INSERT raises unique_violation,
  -- caught below, and re-reads the winner's row rather than erroring out
  -- to the cashier.
  begin
    insert into public.customers (club_id, full_name, is_walk_in, created_by)
    values (p_club_id, 'Walk-in Customer', true, auth.uid())
    returning id into v_customer_id;
  exception when unique_violation then
    select id into v_customer_id from public.customers
    where club_id = p_club_id and is_walk_in = true
    limit 1;
  end;

  return v_customer_id;
end;
$function$;

revoke all on function public.get_or_create_shop_walk_in_customer(uuid) from public, anon;
grant execute on function public.get_or_create_shop_walk_in_customer(uuid) to authenticated;

comment on function public.get_or_create_shop_walk_in_customer(uuid) is
  'Commerce Pro C3: returns the club''s single system Walk-in Customer row (customers.is_walk_in = true), creating it on first use. Never weakens create_shop_sale''s NOT NULL customer requirement -- see migration comment.';
