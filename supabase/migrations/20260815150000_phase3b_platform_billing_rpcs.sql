-- Phase 3b — Platform Billing RPCs
-- create_platform_subscription / renew_platform_subscription /
-- change_platform_plan / cancel_platform_subscription /
-- record_platform_payment / reverse_platform_payment /
-- extend_grace_period. All Platform-Owner-only (writes to
-- platform_subscriptions/platform_invoices/platform_payments, tables with
-- zero non-platform-owner write access).

-- ============================================================
-- create_platform_subscription: starts the first period for a club
-- (trial, paid, or complimentary). Trials never create an invoice
-- (ADR-036).
-- ============================================================
create or replace function public.create_platform_subscription(
  p_club_id uuid,
  p_subscription_kind text,
  p_plan_id uuid default null,
  p_trial_origin text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings record;
  v_plan record;
  v_start timestamptz := now();
  v_end timestamptz;
  v_grace_days int;
  v_subscription_id uuid;
  v_invoice_number bigint;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_subscription_kind not in ('trial', 'paid', 'complimentary') then
    raise exception 'invalid subscription_kind';
  end if;

  select * into v_settings from public.platform_settings where id = true;

  if p_subscription_kind = 'trial' then
    v_end := v_start + (v_settings.default_trial_days || ' days')::interval;
    v_grace_days := 0;

    insert into public.platform_subscriptions
      (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
       price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
       grace_period_days_snapshot, start_at, end_at, lifecycle_status)
    values
      (p_club_id, null, 'trial', coalesce(p_trial_origin, 'manual'), 'تجربة مجانية',
       0, 'EGP', null, null,
       0, v_start, v_end, 'trial')
    returning id into v_subscription_id;

    return v_subscription_id;
  end if;

  -- paid / complimentary: requires a real plan to snapshot terms from.
  if p_plan_id is null then
    raise exception 'plan_id is required for paid/complimentary subscriptions';
  end if;

  select * into v_plan from public.platform_plans where id = p_plan_id and status = 'active';
  if v_plan is null then
    raise exception 'plan not found or inactive';
  end if;

  v_end := v_start + (v_plan.billing_interval_count || ' ' || v_plan.billing_interval)::interval;
  v_grace_days := v_plan.default_grace_period_days;

  insert into public.platform_subscriptions
    (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
     price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
     grace_period_days_snapshot, start_at, end_at, lifecycle_status)
  values
    (p_club_id, v_plan.id, p_subscription_kind, null, v_plan.name_ar,
     case when p_subscription_kind = 'complimentary' then 0 else v_plan.price end,
     v_plan.currency, v_plan.billing_interval, v_plan.billing_interval_count,
     v_grace_days, v_start, v_end, 'active')
  returning id into v_subscription_id;

  if p_subscription_kind = 'paid' then
    v_invoice_number := nextval('public.platform_invoice_number_seq');
    insert into public.platform_invoices
      (club_id, platform_subscription_id, invoice_number, amount, due_date, status)
    values
      (p_club_id, v_subscription_id, v_invoice_number, v_plan.price, v_start::date, 'pending');
  end if;

  return v_subscription_id;
end;
$$;

revoke execute on function public.create_platform_subscription(uuid, text, uuid, text) from public;
revoke execute on function public.create_platform_subscription(uuid, text, uuid, text) from anon;
grant execute on function public.create_platform_subscription(uuid, text, uuid, text) to authenticated;

-- ============================================================
-- renew_platform_subscription: creates the next period, linked via
-- previous_subscription_id. Re-snapshots the given plan's CURRENT terms
-- (not the prior period's stale snapshot) -- a renewal always uses live
-- plan pricing at the moment of renewal, per plan intent ("editable at
-- any time... never retroactively changes an ALREADY-CREATED period" --
-- a renewal is a new period, so it legitimately picks up new pricing).
-- ============================================================
create or replace function public.renew_platform_subscription(
  p_previous_subscription_id uuid,
  p_plan_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prev record;
  v_plan record;
  v_start timestamptz;
  v_end timestamptz;
  v_subscription_id uuid;
  v_invoice_number bigint;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_prev from public.platform_subscriptions where id = p_previous_subscription_id;
  if v_prev is null then
    raise exception 'previous subscription not found';
  end if;

  select * into v_plan from public.platform_plans
    where id = coalesce(p_plan_id, v_prev.plan_id) and status = 'active';
  if v_plan is null then
    raise exception 'plan not found or inactive';
  end if;

  -- Adjacent, not overlapping: new period starts exactly where the prior
  -- one ends (or now(), whichever is later, in case of a late renewal).
  v_start := greatest(v_prev.end_at, now());
  v_end := v_start + (v_plan.billing_interval_count || ' ' || v_plan.billing_interval)::interval;

  insert into public.platform_subscriptions
    (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
     price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
     grace_period_days_snapshot, start_at, end_at, previous_subscription_id, lifecycle_status)
  values
    (v_prev.club_id, v_plan.id, 'paid', null, v_plan.name_ar,
     v_plan.price, v_plan.currency, v_plan.billing_interval, v_plan.billing_interval_count,
     v_plan.default_grace_period_days, v_start, v_end, v_prev.id, 'active')
  returning id into v_subscription_id;

  v_invoice_number := nextval('public.platform_invoice_number_seq');
  insert into public.platform_invoices
    (club_id, platform_subscription_id, invoice_number, amount, due_date, status)
  values
    (v_prev.club_id, v_subscription_id, v_invoice_number, v_plan.price, v_start::date, 'pending');

  return v_subscription_id;
end;
$$;

revoke execute on function public.renew_platform_subscription(uuid, uuid) from public;
revoke execute on function public.renew_platform_subscription(uuid, uuid) from anon;
grant execute on function public.renew_platform_subscription(uuid, uuid) to authenticated;

-- ============================================================
-- change_platform_plan: ends the current period early (cancels it) and
-- creates a new period on the new plan starting now -- recorded as an
-- explicit plan change, never a silent overwrite.
-- ============================================================
create or replace function public.change_platform_plan(
  p_current_subscription_id uuid,
  p_new_plan_id uuid,
  p_reason text default 'plan change'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current record;
  v_plan record;
  v_start timestamptz := now();
  v_end timestamptz;
  v_subscription_id uuid;
  v_invoice_number bigint;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select * into v_current from public.platform_subscriptions where id = p_current_subscription_id;
  if v_current is null or v_current.lifecycle_status = 'cancelled' then
    raise exception 'current subscription not found or already cancelled';
  end if;

  select * into v_plan from public.platform_plans where id = p_new_plan_id and status = 'active';
  if v_plan is null then
    raise exception 'plan not found or inactive';
  end if;

  update public.platform_subscriptions
  set lifecycle_status = 'cancelled',
      cancelled_at = v_start,
      cancelled_reason = p_reason,
      cancelled_by = auth.uid(),
      -- Shorten end_at to the cancellation moment so the exclusion
      -- constraint's `during` range doesn't overlap the new period.
      end_at = v_start
  where id = v_current.id;

  v_end := v_start + (v_plan.billing_interval_count || ' ' || v_plan.billing_interval)::interval;

  insert into public.platform_subscriptions
    (club_id, plan_id, subscription_kind, trial_origin, plan_name_snapshot,
     price_snapshot, currency_snapshot, interval_snapshot, interval_count_snapshot,
     grace_period_days_snapshot, start_at, end_at, previous_subscription_id, lifecycle_status)
  values
    (v_current.club_id, v_plan.id, 'paid', null, v_plan.name_ar,
     v_plan.price, v_plan.currency, v_plan.billing_interval, v_plan.billing_interval_count,
     v_plan.default_grace_period_days, v_start, v_end, v_current.id, 'active')
  returning id into v_subscription_id;

  v_invoice_number := nextval('public.platform_invoice_number_seq');
  insert into public.platform_invoices
    (club_id, platform_subscription_id, invoice_number, amount, due_date, status)
  values
    (v_current.club_id, v_subscription_id, v_invoice_number, v_plan.price, v_start::date, 'pending');

  return v_subscription_id;
end;
$$;

revoke execute on function public.change_platform_plan(uuid, uuid, text) from public;
revoke execute on function public.change_platform_plan(uuid, uuid, text) from anon;
grant execute on function public.change_platform_plan(uuid, uuid, text) to authenticated;

-- ============================================================
-- cancel_platform_subscription
-- ============================================================
create or replace function public.cancel_platform_subscription(
  p_subscription_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  update public.platform_subscriptions
  set lifecycle_status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      cancelled_by = auth.uid()
  where id = p_subscription_id and lifecycle_status != 'cancelled';

  if not found then
    raise exception 'subscription not found or already cancelled';
  end if;
end;
$$;

revoke execute on function public.cancel_platform_subscription(uuid, text) from public;
revoke execute on function public.cancel_platform_subscription(uuid, text) from anon;
grant execute on function public.cancel_platform_subscription(uuid, text) to authenticated;

-- ============================================================
-- record_platform_payment / reverse_platform_payment
-- ============================================================
create or replace function public.record_platform_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_payment_id uuid;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('bank_transfer', 'cash', 'other') then
    raise exception 'invalid method';
  end if;

  insert into public.platform_payments (platform_invoice_id, amount, method, reference, recorded_by)
  values (p_invoice_id, p_amount, p_method, p_reference, auth.uid())
  returning id into v_payment_id;

  update public.platform_invoices set status = 'paid' where id = p_invoice_id;

  return v_payment_id;
end;
$$;

revoke execute on function public.record_platform_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_platform_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_platform_payment(uuid, numeric, text, text) to authenticated;

create or replace function public.reverse_platform_payment(
  p_payment_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice_id uuid;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reversal reason is required';
  end if;

  select platform_invoice_id into v_invoice_id from public.platform_payments
    where id = p_payment_id and reversed_at is null;

  if v_invoice_id is null then
    raise exception 'payment not found or already reversed';
  end if;

  update public.platform_payments
  set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = p_reason
  where id = p_payment_id;

  update public.platform_invoices set status = 'pending' where id = v_invoice_id;
end;
$$;

revoke execute on function public.reverse_platform_payment(uuid, text) from public;
revoke execute on function public.reverse_platform_payment(uuid, text) from anon;
grant execute on function public.reverse_platform_payment(uuid, text) to authenticated;

-- ============================================================
-- extend_grace_period: per-subscription override
-- ============================================================
create or replace function public.extend_grace_period(
  p_subscription_id uuid,
  p_grace_period_days int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_grace_period_days < 0 then
    raise exception 'grace period days cannot be negative';
  end if;

  update public.platform_subscriptions
  set grace_period_days_snapshot = p_grace_period_days
  where id = p_subscription_id;

  if not found then
    raise exception 'subscription not found';
  end if;
end;
$$;

revoke execute on function public.extend_grace_period(uuid, int) from public;
revoke execute on function public.extend_grace_period(uuid, int) from anon;
grant execute on function public.extend_grace_period(uuid, int) to authenticated;
