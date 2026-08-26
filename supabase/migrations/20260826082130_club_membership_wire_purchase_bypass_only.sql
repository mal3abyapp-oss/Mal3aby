-- Wire the app.allow_customer_self_service_write flag into
-- purchase_club_membership_self_service, set immediately before its
-- invoices/club_membership_subscriptions INSERTs, exactly mirroring the
-- set_config(...) placement convention already used for
-- app.allow_club_membership_status_transition throughout this domain.
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

  perform set_config('app.allow_customer_self_service_write', 'true', true);
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
  perform set_config('app.allow_customer_self_service_write', 'false', true);

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
