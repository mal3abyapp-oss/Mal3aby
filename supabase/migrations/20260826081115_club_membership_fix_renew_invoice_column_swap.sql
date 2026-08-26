-- Fix: the previous idempotency-column-ambiguity fix migration
-- accidentally swapped v_invoice_number and v_current.customer_id in
-- renew_club_membership's invoice insert (positions 3/4 of the VALUES
-- list vs the column list club_id, branch_id, invoice_number,
-- customer_id, ...) -- caught by immediately re-reading the applied
-- function definition after the previous fix, before this ever reached
-- a real renewal with an idempotency key. Restored to the original,
-- correct column order.
create or replace function public.renew_club_membership(
  p_membership_subscription_id uuid,
  p_plan_id uuid default null,
  p_start_date date default null,
  p_discount numeric default 0,
  p_idempotency_key uuid default null
)
returns table(membership_subscription_id uuid, invoice_id uuid, membership_number text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current record;
  v_plan record;
  v_existing_membership_id uuid;
  v_existing_invoice_id uuid;
  v_existing_number text;
  v_effective_start date;
  v_end_date date;
  v_net_price numeric;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_membership_number text;
  v_today date;
  v_branch_allowed boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select s.* into v_current
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.renew', s.club_id)
  for update;

  if v_current.id is null then
    raise exception 'club membership not found or you do not have permission to renew it';
  end if;

  if not public.club_write_allowed(v_current.club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if v_current.status not in ('active', 'scheduled', 'expired') then
    raise exception 'only an active, scheduled, or expired membership can be renewed';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_current.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_current.club_id, current_date);

  if v_current.status in ('active', 'scheduled') then
    v_effective_start := v_current.end_date + 1;
  else
    v_effective_start := coalesce(p_start_date, v_today);
  end if;

  if p_start_date is not null and v_current.status = 'expired' then
    v_effective_start := p_start_date;
  end if;

  if p_idempotency_key is not null then
    select k.membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys k
    where k.idempotency_key = p_idempotency_key;

    if v_existing_membership_id is not null then
      select s.invoice_id, s.membership_number into v_existing_invoice_id, v_existing_number
      from public.club_membership_subscriptions s where s.id = v_existing_membership_id;
      return query select v_existing_membership_id, v_existing_invoice_id, v_existing_number;
      return;
    end if;
  end if;

  select * into v_plan from public.club_membership_plans
  where id = coalesce(p_plan_id, v_current.plan_id) and club_id = v_current.club_id and archived_at is null
  for update;

  if v_plan.id is null then
    raise exception 'plan not found in this club';
  end if;

  if not v_plan.is_active then
    raise exception 'this plan is no longer available for purchase';
  end if;

  if not v_plan.allow_renewal then
    raise exception 'this plan does not allow renewal';
  end if;

  if v_plan.branch_scope = 'selected_branches' then
    select exists (
      select 1 from public.club_membership_plan_branches
      where plan_id = v_plan.id and branch_id = v_current.branch_id
    ) into v_branch_allowed;

    if not v_branch_allowed then
      raise exception 'this plan is not available at the membership''s branch';
    end if;
  end if;

  v_end_date := case v_plan.duration_unit
    when 'day' then (v_effective_start + (v_plan.duration_value || ' days')::interval)::date
    when 'month' then (v_effective_start + (v_plan.duration_value || ' months')::interval - interval '1 day')::date
    when 'year' then (v_effective_start + (v_plan.duration_value || ' years')::interval - interval '1 day')::date
  end;

  if exists (
    select 1 from public.club_membership_subscriptions ex
    where ex.club_id = v_current.club_id
      and ex.customer_id = v_current.customer_id
      and ex.id != v_current.id
      and ex.status in ('pending_payment', 'scheduled', 'active', 'frozen')
      and daterange(ex.start_date, ex.end_date, '[]') && daterange(v_effective_start, v_end_date, '[]')
  ) then
    raise exception 'this customer already has a membership period that overlaps the computed renewal dates';
  end if;

  v_net_price := round(greatest(v_plan.price - coalesce(p_discount, 0), 0), 2);
  v_membership_number := public._next_club_membership_number_internal(v_current.club_id);

  v_invoice_number := public.issue_invoice_number(v_current.branch_id, v_current.club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_current.club_id, v_current.branch_id, v_invoice_number, v_current.customer_id, 'issued', v_plan.price, coalesce(p_discount, 0), v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.club_membership_subscriptions (
    club_id, branch_id, customer_id, plan_id, membership_number,
    plan_name_ar_snapshot, plan_name_en_snapshot, price_snapshot,
    duration_value_snapshot, duration_unit_snapshot,
    start_date, end_date, status, invoice_id, created_by
  )
  values (
    v_current.club_id, v_current.branch_id, v_current.customer_id, v_plan.id, v_membership_number,
    v_plan.name_ar, v_plan.name_en, v_net_price,
    v_plan.duration_value, v_plan.duration_unit,
    v_effective_start, v_end_date, 'pending_payment', v_invoice_id, auth.uid()
  )
  returning id into v_subscription_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, v_plan.name_ar, 'club_membership', v_subscription_id, 1, v_plan.price, v_net_price);

  if p_idempotency_key is not null then
    insert into public.club_membership_sale_keys (idempotency_key, membership_subscription_id)
    values (p_idempotency_key, v_subscription_id)
    on conflict (idempotency_key) do nothing;
  end if;

  perform public.write_audit_log(
    v_current.club_id, 'club_membership.renewed', 'club_membership_subscription', v_subscription_id,
    jsonb_build_object('previous_membership_subscription_id', v_current.id),
    jsonb_build_object('plan_id', v_plan.id, 'start_date', v_effective_start, 'end_date', v_end_date, 'price', v_net_price),
    null
  );

  return query select v_subscription_id, v_invoice_id, v_membership_number;
end;
$$;
