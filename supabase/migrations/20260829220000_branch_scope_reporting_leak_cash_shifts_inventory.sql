-- SAAS ACCEPTANCE REVIEW -- stock/branch-scope correctness audit
-- finding (2026-08-29), P1, live-reproduced: get_open_cash_shifts()
-- and get_shop_inventory_balances() both gate solely on
-- has_permission(key, club_id) -- a club-level check -- and filter
-- rows only by club_id, never consulting membership_branches /
-- user_has_branch_access(), which is the actual branch-scoping
-- mechanism used everywhere else in this codebase (the
-- enforce_authenticated_branch_scope trigger, the RPC guards added in
-- the 2026-08-29 academy branch-scope sweep, etc).
--
-- Live repro: a real Branch-Manager-role membership restricted to
-- Branch A (via a real, pre-existing membership_branches row) called
-- get_open_cash_shifts() and received Branch B's open shift in full
-- (id, opened_by, opening_float, age_hours) -- data about a branch
-- they have no access to. This is a read-side data leak, not an auth
-- bypass: the employee is legitimately allowed to call the RPC (holds
-- payment.view), it just doesn't filter results to their assigned
-- branch(es).
--
-- Fix: add the same user_has_branch_access() filter this codebase's
-- write-path RPCs already use, applied here to reads. A membership
-- with no membership_branches rows at all continues to see every
-- branch (matching user_has_branch_access()'s own "empty = all
-- branches" convention, used consistently everywhere else).
create or replace function public.get_open_cash_shifts(p_club_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cs.id, 'branch_id', cs.branch_id, 'opened_by', cs.opened_by,
    'opened_by_name', p.full_name, 'opened_at', cs.opened_at,
    'opening_float', cs.opening_float,
    'age_hours', round(extract(epoch from (now() - cs.opened_at)) / 3600.0, 1)
  ) order by cs.opened_at asc), '[]'::jsonb) into v_result
  from public.cash_shifts cs
  left join public.profiles p on p.user_id = cs.opened_by
  where cs.club_id = p_club_id and cs.status = 'open'
    and public.user_has_branch_access(p_club_id, cs.branch_id);

  return v_result;
end;
$function$;

-- shop_inventory_locations has no branch_id column of its own --
-- confirmed via information_schema (id, club_id, kind, name, status,
-- created_at, created_by, no branch_id). Investigated further: the
-- 'branch' kind location model in this codebase associates a location
-- with a branch via name/kind convention, not a foreign key, so a
-- direct branch_id join is not available here. Given that, and to
-- close the confirmed live gap without inventing a data model change
-- outside this review's scope, gate the whole RPC behind an
-- all-branches check: an employee whose membership is restricted to
-- specific branches (has any membership_branches row at all) cannot
-- call this RPC and see a club-wide inventory view; an employee with
-- unrestricted branch access (the common case: owner/manager/no
-- membership_branches rows) is unaffected. This is a conservative
-- fix -- it removes the read entirely for scoped employees rather
-- than attempting a per-row filter this schema cannot express, which
-- is safer than leaving the leak in place.
create or replace function public.get_shop_inventory_balances(p_club_id uuid, p_location_id uuid DEFAULT NULL::uuid, p_low_stock_only boolean DEFAULT false)
 returns TABLE(location_id uuid, location_name text, product_id uuid, product_name_ar text, variant_id uuid, variant_label text, on_hand numeric, reorder_level integer)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if not public.user_has_branch_access(p_club_id, null) then
    raise exception 'branch-scoped staff cannot view club-wide inventory -- ask an owner or manager to run this report';
  end if;

  return query
  select b.location_id, l.name, b.product_id, p.name_ar, b.variant_id,
         nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         b.on_hand, p.reorder_level
  from public.shop_inventory_balances b
  join public.shop_inventory_locations l on l.id = b.location_id
  join public.shop_products p on p.id = b.product_id
  left join public.shop_product_variants v on v.id = b.variant_id
  where b.club_id = p_club_id
    and (p_location_id is null or b.location_id = p_location_id)
    and (not p_low_stock_only or (p.reorder_level is not null and b.on_hand <= p.reorder_level))
  order by p.name_ar, l.name;
end;
$function$;
