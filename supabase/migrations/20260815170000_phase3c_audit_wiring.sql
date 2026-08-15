-- Phase 3c — wire audit_logs writes into the sensitive Phase 3b actions
-- exposed by the Actions panel: Cancel Subscription, Reverse Payment,
-- Extend Grace Period, Change Plan; plus a new set_plan_publish_status RPC
-- for Publish/Unpublish (Phase 3b left plan edits as raw platform-owner
-- table access -- this phase's Security work explicitly requires an audit
-- entry for publish/unpublish, so it needs to go through an RPC now).

create or replace function public.cancel_platform_subscription(
  p_subscription_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select * into v_before from public.platform_subscriptions where id = p_subscription_id;
  if v_before is null or v_before.lifecycle_status = 'cancelled' then
    raise exception 'subscription not found or already cancelled';
  end if;

  update public.platform_subscriptions
  set lifecycle_status = 'cancelled',
      cancelled_at = now(),
      cancelled_reason = p_reason,
      cancelled_by = auth.uid()
  where id = p_subscription_id;

  perform public.write_audit_log(
    v_before.club_id, 'cancel_platform_subscription', 'platform_subscriptions', p_subscription_id,
    to_jsonb(v_before), jsonb_build_object('lifecycle_status', 'cancelled'), p_reason
  );
end;
$$;

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
  v_before record;
  v_club_id uuid;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reversal reason is required';
  end if;

  select * into v_before from public.platform_payments where id = p_payment_id and reversed_at is null;
  if v_before is null then
    raise exception 'payment not found or already reversed';
  end if;

  select club_id into v_club_id from public.platform_invoices where id = v_before.platform_invoice_id;

  update public.platform_payments
  set reversed_at = now(), reversed_by = auth.uid(), reversal_reason = p_reason
  where id = p_payment_id;

  update public.platform_invoices set status = 'pending' where id = v_before.platform_invoice_id;

  perform public.write_audit_log(
    v_club_id, 'reverse_platform_payment', 'platform_payments', p_payment_id,
    to_jsonb(v_before), jsonb_build_object('reversed_at', now()), p_reason
  );
end;
$$;

create or replace function public.extend_grace_period(
  p_subscription_id uuid,
  p_grace_period_days int
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before record;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_grace_period_days < 0 then
    raise exception 'grace period days cannot be negative';
  end if;

  select * into v_before from public.platform_subscriptions where id = p_subscription_id;
  if v_before is null then
    raise exception 'subscription not found';
  end if;

  update public.platform_subscriptions
  set grace_period_days_snapshot = p_grace_period_days
  where id = p_subscription_id;

  perform public.write_audit_log(
    v_before.club_id, 'extend_grace_period', 'platform_subscriptions', p_subscription_id,
    jsonb_build_object('grace_period_days_snapshot', v_before.grace_period_days_snapshot),
    jsonb_build_object('grace_period_days_snapshot', p_grace_period_days),
    null
  );
end;
$$;

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

  perform public.write_audit_log(
    v_current.club_id, 'change_platform_plan', 'platform_subscriptions', v_subscription_id,
    jsonb_build_object('previous_subscription_id', v_current.id, 'previous_plan', v_current.plan_name_snapshot),
    jsonb_build_object('new_plan', v_plan.name_ar), p_reason
  );

  return v_subscription_id;
end;
$$;

-- ============================================================
-- set_plan_publish_status: replaces raw client UPDATE on platform_plans
-- for the publish/unpublish action specifically, so it can carry an audit
-- entry. Other plan field edits (price, name, etc.) remain direct table
-- access per Phase 3b (platform_plans_platform_owner_full_access policy) --
-- only publish state is treated as "sensitive" per this phase's Security
-- work list.
-- ============================================================
create or replace function public.set_plan_publish_status(
  p_plan_id uuid,
  p_is_public boolean
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before boolean;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select is_public into v_before from public.platform_plans where id = p_plan_id;
  if v_before is null then
    raise exception 'plan not found';
  end if;

  update public.platform_plans set is_public = p_is_public where id = p_plan_id;

  perform public.write_audit_log(
    null, case when p_is_public then 'publish_plan' else 'unpublish_plan' end,
    'platform_plans', p_plan_id,
    jsonb_build_object('is_public', v_before), jsonb_build_object('is_public', p_is_public), null
  );
end;
$$;

revoke execute on function public.set_plan_publish_status(uuid, boolean) from public;
revoke execute on function public.set_plan_publish_status(uuid, boolean) from anon;
grant execute on function public.set_plan_publish_status(uuid, boolean) to authenticated;
