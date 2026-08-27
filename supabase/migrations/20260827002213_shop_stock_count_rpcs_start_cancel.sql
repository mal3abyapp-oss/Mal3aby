create or replace function public.start_shop_stock_count(
  p_club_id uuid, p_location_id uuid, p_notes text default null, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count_id uuid;
  v_existing_id uuid;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_id from public.shop_stock_counts
    where club_id = p_club_id and idempotency_key = p_idempotency_key;
    if v_existing_id is not null then
      return v_existing_id;
    end if;
  end if;

  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', p_club_id))
    and public.has_platform_support_access(p_club_id, true);
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', p_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  if not exists (select 1 from public.shop_inventory_locations where id = p_location_id and club_id = p_club_id) then
    raise exception 'inventory location not found in this club';
  end if;

  if exists (
    select 1 from public.shop_stock_counts
    where location_id = p_location_id and status in ('draft', 'in_progress')
  ) then
    raise exception 'a stock count is already open for this location -- complete or cancel it first';
  end if;

  insert into public.shop_stock_counts (club_id, location_id, status, started_by, started_at, notes, idempotency_key, created_by)
  values (p_club_id, p_location_id, 'in_progress', auth.uid(), now(), p_notes, p_idempotency_key, auth.uid())
  returning id into v_count_id;

  -- Snapshot the current system quantity for every product/variant that currently has a
  -- balance row (or an active product with no balance row yet -- treat as 0) at this location.
  insert into public.shop_stock_count_items (stock_count_id, product_id, variant_id, system_quantity)
  select v_count_id, b.product_id, b.variant_id, b.on_hand
  from public.shop_inventory_balances b
  where b.location_id = p_location_id;

  perform public.write_audit_log(
    p_club_id, 'inventory.stock_count.started', 'shop_stock_count', v_count_id, null,
    jsonb_build_object('location_id', p_location_id), p_notes
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id, 'inventory.stock_count.started', 'shop_stock_count', v_count_id, null,
      jsonb_build_object('location_id', p_location_id), p_notes
    );
  end if;

  return v_count_id;
end;
$function$;

revoke all on function public.start_shop_stock_count(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.start_shop_stock_count(uuid, uuid, text, uuid) to authenticated;

create or replace function public.cancel_shop_stock_count(p_stock_count_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_count public.shop_stock_counts;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_count from public.shop_stock_counts where id = p_stock_count_id;
  if v_count.id is null then
    raise exception 'stock count not found';
  end if;

  v_via_support := not (v_count.club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', v_count.club_id))
    and public.has_platform_support_access(v_count.club_id, true);
  if not (v_count.club_id in (select public.user_club_ids()) and public.has_permission('inventory.count', v_count.club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;

  if v_count.status = 'completed' then
    raise exception 'a completed stock count cannot be cancelled';
  end if;
  if v_count.status = 'cancelled' then
    return;
  end if;

  update public.shop_stock_counts
  set status = 'cancelled', cancelled_by = auth.uid(), cancelled_at = now(), updated_at = now(),
      notes = coalesce(v_count.notes, '') || case when p_reason is not null then E'\n[cancelled] ' || p_reason else '' end
  where id = p_stock_count_id;

  perform public.write_audit_log(
    v_count.club_id, 'inventory.stock_count.cancelled', 'shop_stock_count', p_stock_count_id, null,
    jsonb_build_object('location_id', v_count.location_id), p_reason
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_count.club_id, 'inventory.stock_count.cancelled', 'shop_stock_count', p_stock_count_id, null,
      jsonb_build_object('location_id', v_count.location_id), p_reason
    );
  end if;
end;
$function$;

revoke all on function public.cancel_shop_stock_count(uuid, text) from public, anon;
grant execute on function public.cancel_shop_stock_count(uuid, text) to authenticated;
