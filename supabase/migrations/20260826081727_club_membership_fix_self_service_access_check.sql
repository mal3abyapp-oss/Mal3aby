-- Fix: purchase_club_membership_self_service and
-- renew_club_membership_self_service called club_write_allowed(), which
-- internally requires the caller to hold a STAFF club_memberships row
-- (via user_club_ids()) -- a genuine portal customer never has one, so
-- this made both self-service RPCs unconditionally fail with "club
-- subscription does not allow new commitments" for every real customer,
-- caught live before any real customer could hit it. Swapped to
-- get_public_club_subscription_access(), the exact same customer-safe
-- entitlement check create_public_booking already uses for its own
-- fully-unauthenticated purchase flow (checks club status + platform
-- subscription window only, no staff membership requirement).

create or replace function public.purchase_club_membership_self_service(
  p_club_id uuid,
  p_plan_id uuid,
  p_branch_id uuid,
  p_start_date date,
  p_idempotency_key uuid default null
)
returns table(membership_subscription_id uuid, invoice_id uuid, membership_number text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_customer_id uuid;
  v_plan record;
  v_existing_membership_id uuid;
  v_existing_invoice_id uuid;
  v_existing_number text;
  v_end_date date;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_membership_number text;
  v_branch_allowed boolean;
  v_today date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select id into v_customer_id from public.customers
  where club_id = p_club_id and user_id = auth.uid();

  if v_customer_id is null then
    raise exception 'no linked customer profile found for this club';
  end if;

  if public.get_public_club_subscription_access(p_club_id) = 'blocked' then
    raise exception 'this club is not currently accepting new membership purchases';
  end if;

  if p_idempotency_key is not null then
    select k.membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys k
    where k.idempotency_key = p_idempotency_key;

    if v_existing_membership_id is not null then
      select s.invoice_id, s.membership_number into v_existing_invoice_id, v_existing_number
      from public.club_membership_subscriptions s where s.id = v_existing_membership_id and s.customer_id = v_customer_id;
      if v_existing_invoice_id is not null then
        return query select v_existing_membership_id, v_existing_invoice_id, v_existing_number;
        return;
      end if;
    end if;
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = p_club_id))::date
    into v_today
    from public.club_local_day_bounds(p_club_id, current_date);

  if p_start_date < v_today then
    raise exception 'start date cannot be in the past';
  end if;

  select * into v_plan from public.club_membership_plans
  where id = p_plan_id and club_id = p_club_id and archived_at is null and is_active = true and is_public = true
  for update;

  if v_plan.id is null then
    raise exception 'plan not found or not currently available for purchase';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'branch not found in this club';
  end if;

  if v_plan.branch_scope = 'selected_branches' then
    select exists (
      select 1 from public.club_membership_plan_branches
      where plan_id = v_plan.id and branch_id = p_branch_id
    ) into v_branch_allowed;

    if not v_branch_allowed then
      raise exception 'this plan is not available at the selected branch';
    end if;
  end if;

  v_end_date := case v_plan.duration_unit
    when 'day' then (p_start_date + (v_plan.duration_value || ' days')::interval)::date
    when 'month' then (p_start_date + (v_plan.duration_value || ' months')::interval - interval '1 day')::date
    when 'year' then (p_start_date + (v_plan.duration_value || ' years')::interval - interval '1 day')::date
  end;

  if exists (
    select 1 from public.club_membership_subscriptions ex
    where ex.club_id = p_club_id
      and ex.customer_id = v_customer_id
      and ex.status in ('pending_payment', 'scheduled', 'active', 'frozen')
      and daterange(ex.start_date, ex.end_date, '[]') && daterange(p_start_date, v_end_date, '[]')
  ) then
    raise exception 'you already have a membership period that overlaps the selected dates';
  end if;

  v_membership_number := public._next_club_membership_number_internal(p_club_id);
  v_invoice_number := public.issue_invoice_number(p_branch_id, p_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (p_club_id, p_branch_id, v_invoice_number, v_customer_id, 'issued', v_plan.price, 0, v_plan.price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.club_membership_subscriptions (
    club_id, branch_id, customer_id, plan_id, membership_number,
    plan_name_ar_snapshot, plan_name_en_snapshot, price_snapshot,
    duration_value_snapshot, duration_unit_snapshot,
    start_date, end_date, status, invoice_id, created_by
  )
  values (
    p_club_id, p_branch_id, v_customer_id, v_plan.id, v_membership_number,
    v_plan.name_ar, v_plan.name_en, v_plan.price,
    v_plan.duration_value, v_plan.duration_unit,
    p_start_date, v_end_date, 'pending_payment', v_invoice_id, auth.uid()
  )
  returning id into v_subscription_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_plan.name_ar, 'club_membership', v_subscription_id, 1, v_plan.price, v_plan.price);

  if p_idempotency_key is not null then
    insert into public.club_membership_sale_keys (idempotency_key, membership_subscription_id)
    values (p_idempotency_key, v_subscription_id)
    on conflict (idempotency_key) do nothing;
  end if;

  perform public.write_audit_log(
    p_club_id, 'club_membership.created', 'club_membership_subscription', v_subscription_id, null,
    jsonb_build_object('plan_id', v_plan.id, 'customer_id', v_customer_id, 'start_date', p_start_date, 'end_date', v_end_date, 'price', v_plan.price, 'source', 'customer_portal'),
    null
  );

  return query select v_subscription_id, v_invoice_id, v_membership_number;
end;
$$;

create or replace function public.renew_club_membership_self_service(
  p_membership_subscription_id uuid,
  p_idempotency_key uuid default null
)
returns table(membership_subscription_id uuid, invoice_id uuid, membership_number text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current record;
  v_customer_id uuid;
  v_plan record;
  v_existing_membership_id uuid;
  v_existing_invoice_id uuid;
  v_existing_number text;
  v_effective_start date;
  v_end_date date;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_membership_number text;
  v_today date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select s.* into v_current
  from public.club_membership_subscriptions s
  join public.customers c on c.id = s.customer_id
  where s.id = p_membership_subscription_id and c.user_id = auth.uid()
  for update;

  if v_current.id is null then
    raise exception 'membership not found';
  end if;
  v_customer_id := v_current.customer_id;

  if public.get_public_club_subscription_access(v_current.club_id) = 'blocked' then
    raise exception 'this club is not currently accepting new membership purchases';
  end if;

  if v_current.status not in ('active', 'scheduled', 'expired') then
    raise exception 'only an active, scheduled, or expired membership can be renewed';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_current.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_current.club_id, current_date);

  v_effective_start := case
    when v_current.status in ('active', 'scheduled') then v_current.end_date + 1
    else v_today
  end;

  if p_idempotency_key is not null then
    select k.membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys k
    where k.idempotency_key = p_idempotency_key;

    if v_existing_membership_id is not null then
      select s.invoice_id, s.membership_number into v_existing_invoice_id, v_existing_number
      from public.club_membership_subscriptions s where s.id = v_existing_membership_id and s.customer_id = v_customer_id;
      if v_existing_invoice_id is not null then
        return query select v_existing_membership_id, v_existing_invoice_id, v_existing_number;
        return;
      end if;
    end if;
  end if;

  select * into v_plan from public.club_membership_plans
  where id = v_current.plan_id and club_id = v_current.club_id and archived_at is null and is_active = true
  for update;

  if v_plan.id is null then
    raise exception 'this plan is no longer available -- please contact the club to renew';
  end if;

  if not v_plan.allow_renewal then
    raise exception 'this plan does not allow renewal';
  end if;

  v_end_date := case v_plan.duration_unit
    when 'day' then (v_effective_start + (v_plan.duration_value || ' days')::interval)::date
    when 'month' then (v_effective_start + (v_plan.duration_value || ' months')::interval - interval '1 day')::date
    when 'year' then (v_effective_start + (v_plan.duration_value || ' years')::interval - interval '1 day')::date
  end;

  if exists (
    select 1 from public.club_membership_subscriptions ex
    where ex.club_id = v_current.club_id
      and ex.customer_id = v_customer_id
      and ex.id != v_current.id
      and ex.status in ('pending_payment', 'scheduled', 'active', 'frozen')
      and daterange(ex.start_date, ex.end_date, '[]') && daterange(v_effective_start, v_end_date, '[]')
  ) then
    raise exception 'you already have a membership period that overlaps the computed renewal dates';
  end if;

  v_membership_number := public._next_club_membership_number_internal(v_current.club_id);
  v_invoice_number := public.issue_invoice_number(v_current.branch_id, v_current.club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_current.club_id, v_current.branch_id, v_invoice_number, v_customer_id, 'issued', v_plan.price, 0, v_plan.price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.club_membership_subscriptions (
    club_id, branch_id, customer_id, plan_id, membership_number,
    plan_name_ar_snapshot, plan_name_en_snapshot, price_snapshot,
    duration_value_snapshot, duration_unit_snapshot,
    start_date, end_date, status, invoice_id, created_by
  )
  values (
    v_current.club_id, v_current.branch_id, v_customer_id, v_plan.id, v_membership_number,
    v_plan.name_ar, v_plan.name_en, v_plan.price,
    v_plan.duration_value, v_plan.duration_unit,
    v_effective_start, v_end_date, 'pending_payment', v_invoice_id, auth.uid()
  )
  returning id into v_subscription_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_plan.name_ar, 'club_membership', v_subscription_id, 1, v_plan.price, v_plan.price);

  if p_idempotency_key is not null then
    insert into public.club_membership_sale_keys (idempotency_key, membership_subscription_id)
    values (p_idempotency_key, v_subscription_id)
    on conflict (idempotency_key) do nothing;
  end if;

  perform public.write_audit_log(
    v_current.club_id, 'club_membership.renewed', 'club_membership_subscription', v_subscription_id,
    jsonb_build_object('previous_membership_subscription_id', v_current.id),
    jsonb_build_object('plan_id', v_plan.id, 'start_date', v_effective_start, 'end_date', v_end_date, 'price', v_plan.price, 'source', 'customer_portal'),
    null
  );

  return query select v_subscription_id, v_invoice_id, v_membership_number;
end;
$$;
