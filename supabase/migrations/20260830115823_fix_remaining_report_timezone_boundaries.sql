-- REPORTING ACCURACY & MANAGEMENT INSIGHT ACCEPTANCE (Stage B, B5,
-- systemic sweep continued, 2026-08-30): a broader grep across every
-- function comparing a timestamptz column cast to ::date against a
-- date parameter (not just report RPCs already checked) surfaced 7
-- more real instances of the exact same bug fixed twice already today
-- in get_field_occupancy_report / get_customer_activity_report / the
-- 6 Shop report RPCs:
--
--   get_club_membership_report -- 3 instances (renewals_in_range,
--     new_memberships_in_range on club_membership_subscriptions.created_at;
--     cancellations_in_range on .cancelled_at). Note: this function's
--     OWN "today" resolution (v_today, used for effective-status
--     grouping) already correctly used club_local_day_bounds() --
--     only the range-filtered counts were missed.
--   list_shop_sales (Sales Detail report backing)
--   get_customer_shop_purchases (Customer 360 shop-purchase history)
--   list_shop_inventory_movements (Stock Movement Ledger)
--   list_shop_product_returns (per-product return history)
--   list_shop_product_sales_history (per-product sale history)
--   list_shop_sale_returns (Returns / Refunds report backing)
--
-- Same fix pattern as every prior fix in this batch:
-- club_local_day_bounds() computed only when the corresponding
-- nullable date param is non-null, preserving "no filter" behavior
-- exactly. No other clause, permission check, grant, or return shape
-- changes in any of these 7 functions.
create or replace function public.get_club_membership_report(p_club_id uuid, p_start_date date, p_end_date date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_today date;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  select jsonb_build_object(
    'counts_by_status', (
      select jsonb_object_agg(effective_status, cnt)
      from (
        select
          public.get_club_membership_effective_status(
            s.status, s.start_date,
            s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0),
            v_today
          ) as effective_status,
          count(*) as cnt
        from public.club_membership_subscriptions s
        where s.club_id = p_club_id
        group by 1
      ) grouped
    ),
    'expiring_within_range', coalesce((
      select jsonb_agg(jsonb_build_object(
        'membership_subscription_id', s.id,
        'membership_number', s.membership_number,
        'customer_name', c.full_name,
        'plan_name_ar', s.plan_name_ar_snapshot,
        'plan_name_en', s.plan_name_en_snapshot,
        'effective_end_date', s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)
      ) order by s.end_date)
      from public.club_membership_subscriptions s
      join public.customers c on c.id = s.customer_id
      where s.club_id = p_club_id
        and s.status in ('active', 'frozen')
        and (s.end_date + coalesce((select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f where f.membership_subscription_id = s.id), 0)) between p_start_date and p_end_date
    ), '[]'::jsonb),
    'renewals_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and s.created_at >= v_range_start and s.created_at < v_range_end
        and exists (
          select 1 from public.club_membership_subscriptions prior
          where prior.customer_id = s.customer_id and prior.club_id = s.club_id
            and prior.created_at < s.created_at
        )
    ),
    'new_memberships_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and s.created_at >= v_range_start and s.created_at < v_range_end
        and not exists (
          select 1 from public.club_membership_subscriptions prior
          where prior.customer_id = s.customer_id and prior.club_id = s.club_id
            and prior.created_at < s.created_at
        )
    ),
    'cancellations_in_range', (
      select count(*) from public.club_membership_subscriptions s
      where s.club_id = p_club_id
        and s.cancelled_at is not null
        and s.cancelled_at >= v_range_start and s.cancelled_at < v_range_end
    ),
    'by_plan', coalesce((
      select jsonb_agg(jsonb_build_object(
        'plan_id', p.id,
        'plan_name_ar', p.name_ar,
        'plan_name_en', p.name_en,
        'is_active', p.is_active,
        'active_membership_count', mc.active_count,
        'total_membership_count', mc.total_count
      ) order by p.sort_order, p.name_en)
      from public.club_membership_plans p
      left join (
        select plan_id,
          count(*) filter (where status in ('active', 'scheduled', 'frozen')) as active_count,
          count(*) as total_count
        from public.club_membership_subscriptions
        where club_id = p_club_id
        group by plan_id
      ) mc on mc.plan_id = p.id
      where p.club_id = p_club_id
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.list_shop_sales(p_club_id uuid, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_branch_id uuid DEFAULT NULL::uuid, p_cashier_id uuid DEFAULT NULL::uuid, p_customer_id uuid DEFAULT NULL::uuid, p_payment_method text DEFAULT NULL::text, p_category_id uuid DEFAULT NULL::uuid, p_product_id uuid DEFAULT NULL::uuid, p_invoice_number text DEFAULT NULL::text)
 returns table(sale_id uuid, invoice_number text, customer_name text, sold_by_name text, status text, total numeric, created_at timestamp with time zone, branch_id uuid, item_count numeric, discount_amount numeric, refund_amount numeric, sold_by uuid)
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
  select
    s.id, i.invoice_number, c.full_name, pr.full_name, s.status, i.total, s.created_at,
    l.branch_id,
    (select coalesce(sum(si.quantity), 0) from public.shop_sale_items si where si.sale_id = s.id),
    s.discount_amount,
    (select coalesce(sum(r.amount), 0)
     from public.shop_sale_returns sr
     join public.refunds r on r.id = sr.refund_payment_id
     where sr.sale_id = s.id and r.status = 'completed'),
    s.sold_by
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  join public.shop_inventory_locations l on l.id = s.location_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.club_id = p_club_id
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
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

create or replace function public.get_customer_shop_purchases(p_club_id uuid, p_customer_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0)
 returns table(sale_id uuid, invoice_id uuid, invoice_number text, sale_status text, product_name_ar text, variant_label text, quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric, created_at timestamp with time zone)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
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

  if p_start_date is not null then
    select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  end if;
  if p_end_date is not null then
    select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
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
    and (v_range_start is null or s.created_at >= v_range_start)
    and (v_range_end is null or s.created_at < v_range_end)
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

create or replace function public.list_shop_inventory_movements(p_club_id uuid, p_product_id uuid DEFAULT NULL::uuid, p_location_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_movement_type text DEFAULT NULL::text)
 returns table(movement_id uuid, location_name text, product_name_ar text, variant_label text, movement_type text, quantity numeric, unit_cost numeric, actor_id uuid, reference_type text, reference_id uuid, reason text, created_at timestamp with time zone)
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
    and (v_range_start is null or m.created_at >= v_range_start)
    and (v_range_end is null or m.created_at < v_range_end)
    and (p_movement_type is null or m.movement_type = p_movement_type)
  order by m.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

create or replace function public.list_shop_product_returns(p_club_id uuid, p_product_id uuid, p_variant_id uuid DEFAULT NULL::uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 returns table(return_id uuid, sale_id uuid, invoice_number text, customer_name text, processed_by_name text, variant_label text, quantity numeric, restock boolean, reason text, refund_amount numeric, refund_method text, created_at timestamp with time zone)
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
  if not exists (select 1 from public.shop_products where id = p_product_id and club_id = p_club_id) then
    raise exception 'product not found in this club';
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
    r.id, r.sale_id, i.invoice_number, coalesce(c.full_name, null), pr.full_name,
    nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
    rti.quantity, r.restock, r.reason, ref.amount, pay.method, r.created_at
  from public.shop_sale_return_items rti
  join public.shop_sale_items si on si.id = rti.sale_item_id
  join public.shop_sale_returns r on r.id = rti.return_id
  join public.shop_sales s on s.id = r.sale_id
  join public.invoices i on i.id = s.invoice_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = r.processed_by
  left join public.shop_product_variants v on v.id = si.variant_id
  left join public.refunds ref on ref.id = r.refund_payment_id and ref.status = 'completed'
  left join public.payments pay on pay.id = ref.payment_id
  where r.club_id = p_club_id
    and si.product_id = p_product_id
    and (p_variant_id is null or si.variant_id = p_variant_id)
    and (v_range_start is null or r.created_at >= v_range_start)
    and (v_range_end is null or r.created_at < v_range_end)
  order by r.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

create or replace function public.list_shop_product_sales_history(p_club_id uuid, p_product_id uuid, p_variant_id uuid DEFAULT NULL::uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 returns table(sale_id uuid, invoice_number text, customer_name text, sold_by_name text, variant_label text, quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric, sale_status text, created_at timestamp with time zone)
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
  if not exists (select 1 from public.shop_products where id = p_product_id and club_id = p_club_id) then
    raise exception 'product not found in this club';
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
    s.id, i.invoice_number, coalesce(c.full_name, null), pr.full_name,
    nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
    si.quantity, si.unit_price, si.line_total, si.returned_quantity, s.status, s.created_at
  from public.shop_sale_items si
  join public.shop_sales s on s.id = si.sale_id
  join public.invoices i on i.id = s.invoice_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  left join public.shop_product_variants v on v.id = si.variant_id
  where s.club_id = p_club_id
    and si.product_id = p_product_id
    and (p_variant_id is null or si.variant_id = p_variant_id)
    and (v_range_start is null or s.created_at >= v_range_start)
    and (v_range_end is null or s.created_at < v_range_end)
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$function$;

create or replace function public.list_shop_sale_returns(p_club_id uuid, p_start_date date DEFAULT NULL::date, p_end_date date DEFAULT NULL::date, p_restock_only boolean DEFAULT NULL::boolean, p_refunded_only boolean DEFAULT NULL::boolean, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 returns table(return_id uuid, sale_id uuid, invoice_number text, processed_by_name text, restock boolean, reason text, created_at timestamp with time zone, refund_amount numeric, refund_method text)
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
    and (v_range_start is null or r.created_at >= v_range_start)
    and (v_range_end is null or r.created_at < v_range_end)
    and (p_restock_only is null or r.restock = p_restock_only)
    and (p_refunded_only is null
         or (p_refunded_only and ref.id is not null)
         or (not p_refunded_only and ref.id is null))
  order by r.created_at desc
  limit p_limit offset p_offset;
end;
$function$;
