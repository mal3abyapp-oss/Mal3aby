-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch C1
-- (Academy subscriptions): freeze_subscription, unfreeze_subscription,
-- cancel_subscription, renew_academy_subscription. Same class and fix
-- shape as batches A/B.
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   cancel_subscription: 'not authorized' vs 'subscription not found' -- DISTINGUISHABLE
--   freeze_subscription: 'not authorized' vs 'subscription not found' -- DISTINGUISHABLE
--   unfreeze_subscription: 'not authorized' vs 'subscription not found' -- DISTINGUISHABLE
--   renew_academy_subscription: 'not authorized' vs 'enrollment not found' -- DISTINGUISHABLE
--
-- FIX: collapse lookup + club/permission check into one WHERE clause
-- per function. All downstream business logic (cancel/freeze/unfreeze
-- status-precondition checks, subscription_freezes lifecycle, the
-- app.allow_subscription_status_transition flag usage, renew's
-- enrollment-active/no-pending-subscription/billing-guardian
-- resolution/invoice-creation) preserved verbatim from the current
-- live definitions (re-read via pg_get_functiondef immediately before
-- writing this migration).

create or replace function public.cancel_subscription(p_subscription_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.update', club_id)
  for update;

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to cancel it';
  end if;

  if v_sub.status = 'cancelled' then
    raise exception 'subscription is already cancelled';
  end if;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'cancelled' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.cancel', 'subscription', p_subscription_id,
    jsonb_build_object('previous_status', v_sub.status), null,
    p_reason
  );
end;
$$;

create or replace function public.freeze_subscription(p_subscription_id uuid, p_start_date date, p_end_date date, p_reason text default null::text, p_extends_expiry boolean default true)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_freeze_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.freeze.create', club_id);

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to freeze it';
  end if;

  if v_sub.status not in ('active', 'frozen') then
    raise exception 'only an active subscription can be frozen';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  insert into public.subscription_freezes (club_id, subscription_id, start_date, end_date, reason, extends_expiry, created_by)
  values (v_sub.club_id, p_subscription_id, p_start_date, p_end_date, p_reason, p_extends_expiry, auth.uid())
  returning id into v_freeze_id;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'frozen' where id = p_subscription_id;

  perform public.write_audit_log(v_sub.club_id, 'subscription.freeze', 'subscription', p_subscription_id, null, jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'extends_expiry', p_extends_expiry), p_reason);

  return v_freeze_id;
end;
$$;

create or replace function public.unfreeze_subscription(p_subscription_id uuid, p_reason text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_open_freeze record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.freeze.create', club_id)
  for update;

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to unfreeze it';
  end if;

  if v_sub.status != 'frozen' then
    raise exception 'subscription is not currently frozen';
  end if;

  select * into v_open_freeze from public.subscription_freezes
  where subscription_id = p_subscription_id and end_date >= current_date
  order by start_date desc
  limit 1
  for update;

  if v_open_freeze.id is not null and v_open_freeze.end_date > current_date then
    if v_open_freeze.start_date > current_date then
      delete from public.subscription_freezes where id = v_open_freeze.id;
    else
      update public.subscription_freezes set end_date = current_date where id = v_open_freeze.id;
    end if;
  end if;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'active' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.unfreeze', 'subscription', p_subscription_id, null,
    jsonb_build_object('ended_freeze_id', v_open_freeze.id),
    p_reason
  );
end;
$$;

create or replace function public.renew_academy_subscription(p_enrollment_id uuid, p_start_date date, p_end_date date, p_price numeric, p_discount numeric default 0)
returns TABLE(subscription_id uuid, invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_enrollment record;
  v_club_id uuid;
  v_branch_id uuid;
  v_current_status text;
  v_net_price numeric;
  v_billing_customer_id uuid;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select e.* into v_enrollment
  from public.enrollments e
  where e.id = p_enrollment_id
    and e.club_id in (select public.user_club_ids())
    and public.has_permission('enrollment.create', e.club_id);

  if v_enrollment.id is null then
    raise exception 'enrollment not found or you do not have permission to renew it';
  end if;
  v_club_id := v_enrollment.club_id;

  select g.branch_id into v_branch_id from public.groups g where g.id = v_enrollment.group_id;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if v_enrollment.status != 'active' then
    raise exception 'cannot renew a subscription for an enrollment that is not active';
  end if;

  select status into v_current_status from public.subscriptions
  where enrollment_id = p_enrollment_id
  order by created_at desc limit 1;

  if v_current_status is not null and v_current_status in ('pending', 'active', 'frozen') then
    raise exception 'this enrollment already has an active or pending subscription -- it must reach expired/cancelled before renewing';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  v_net_price := round(greatest(p_price - p_discount, 0), 2);

  v_billing_customer_id := coalesce(
    v_enrollment.guardian_id,
    (select gl.customer_id from public.guardian_links gl where gl.player_id = v_enrollment.player_id and gl.is_primary limit 1)
  );
  if v_billing_customer_id is null then
    raise exception 'no billing guardian: link a primary guardian to this player first';
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_billing_customer_id, 'issued', p_price, p_discount, v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'تجديد اشتراك شهري', 'subscription', p_enrollment_id, 1, p_price, v_net_price);

  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, p_enrollment_id, 'monthly', p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

  perform public.write_audit_log(
    v_club_id, 'subscription.renew', 'subscription', v_subscription_id, null,
    jsonb_build_object('enrollment_id', p_enrollment_id, 'start_date', p_start_date, 'end_date', p_end_date, 'price', p_price),
    null
  );

  return query select v_subscription_id, v_invoice_id;
end;
$$;

-- All 4 signatures unchanged -- in-place replace, grants untouched.
