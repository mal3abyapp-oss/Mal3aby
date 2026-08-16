-- Gate 2 (Academy Enrollment Integrity) -- two real defects found and
-- fixed, per direct code+schema inspection (not assumed from the report
-- alone -- a prior session's academy-permission fix, already applied,
-- may account for some of what was originally reported as "enrollment
-- doesn't work"; these two are independent, newly confirmed defects).

-- ============================================================
-- Bug 1: no duplicate-active-enrollment protection.
--
-- create_enrollment_with_subscription() had no check preventing the
-- same player from being enrolled twice (status='active') in the same
-- group. A double-click, network retry, or two staff members enrolling
-- the same player concurrently would silently create two active
-- enrollment rows -> two subscriptions -> two invoices -> double-billing
-- a real customer. No existing data violates this (verified before
-- adding the index), so a partial unique index is safe to add and
-- enforces the invariant even under concurrent transactions (stronger
-- than an app-level/function-level check alone, which can still race).
-- ============================================================
create unique index if not exists enrollments_one_active_per_player_group
  on public.enrollments (player_id, group_id)
  where status = 'active';

-- Give create_enrollment_with_subscription() an explicit, human-readable
-- pre-check for the same condition -- the unique index above is the
-- real guarantee (holds even under concurrent transactions), but a
-- clear application-level error beats a raw "duplicate key value
-- violates unique constraint" surfacing to an employee.
create or replace function public.create_enrollment_with_subscription(
  p_player_id uuid,
  p_group_id uuid,
  p_guardian_id uuid,
  p_plan_type text,
  p_start_date date,
  p_end_date date,
  p_price numeric,
  p_discount numeric default 0
)
returns table(enrollment_id uuid, subscription_id uuid, invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_group record;
  v_active_count int;
  v_enrollment_id uuid;
  v_subscription_id uuid;
  v_invoice_id uuid;
  v_invoice_number text;
  v_net_price numeric;
  v_billing_customer_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, branch_id into v_club_id, v_branch_id from public.groups where id = p_group_id;
  if v_club_id is null then
    raise exception 'group not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('enrollment.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if not exists (select 1 from public.players where id = p_player_id and club_id = v_club_id) then
    raise exception 'player not found in this club';
  end if;

  if p_guardian_id is not null and not exists (select 1 from public.customers where id = p_guardian_id and club_id = v_club_id) then
    raise exception 'guardian not found in this club';
  end if;

  -- Row-lock the group for the duration of this transaction to serialize
  -- concurrent enrollment attempts against the same capacity.
  select * into v_group from public.groups where id = p_group_id for update;

  if v_group.status != 'active' then
    raise exception 'group is not accepting enrollments';
  end if;

  -- Bug fix (Gate 2): reject a duplicate active enrollment with a clear
  -- message before hitting the unique index -- avoids surfacing a raw
  -- constraint-violation error to an employee for what is actually an
  -- expected, human-meaningful case ("this player is already enrolled").
  if exists (
    select 1 from public.enrollments
    where player_id = p_player_id and group_id = p_group_id and status = 'active'
  ) then
    raise exception 'player is already actively enrolled in this group';
  end if;

  select count(*) into v_active_count from public.enrollments where group_id = p_group_id and status = 'active';

  if v_active_count >= v_group.capacity then
    raise exception 'group is at full capacity';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  insert into public.enrollments (club_id, player_id, group_id, guardian_id, status, created_by)
  values (v_club_id, p_player_id, p_group_id, p_guardian_id, 'active', auth.uid())
  returning id into v_enrollment_id;

  -- If this enrollment fills the group, reflect that immediately.
  if v_active_count + 1 >= v_group.capacity then
    update public.groups set status = 'full' where id = p_group_id;
  end if;

  v_net_price := round(greatest(p_price - p_discount, 0), 2);

  v_billing_customer_id := coalesce(
    p_guardian_id,
    (select gl.customer_id from public.guardian_links gl where gl.player_id = p_player_id and gl.is_primary limit 1)
  );
  if v_billing_customer_id is null then
    raise exception 'no billing guardian: provide p_guardian_id or link a primary guardian to this player first';
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_billing_customer_id, 'issued', p_price, p_discount, v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'اشتراك ' || p_plan_type, 'subscription', v_enrollment_id, 1, p_price, v_net_price);

  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, v_enrollment_id, p_plan_type, p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

  -- Activation policy branch happens in record_payment (first_payment/
  -- full_payment) or activate_subscription_if_due (manual, explicit staff
  -- action) -- newly created subscriptions always start 'pending' here,
  -- regardless of policy.

  return query select v_enrollment_id, v_subscription_id, v_invoice_id;
end;
$$;

-- ============================================================
-- Bug 2: record_payment() unconditionally activates a 'manual'-policy
-- subscription on ANY payment, defeating the purpose of "manual"
-- activation (which should require an explicit staff action via
-- activate_subscription_if_due(), not "any payment, of any amount").
--
-- _activate_subscription_if_due_internal() is called from two places:
--   1. record_payment() -- automatic, triggered by a payment.
--   2. activate_subscription_if_due() -- explicit staff RPC call.
-- The 'manual' policy branch inside it activated unconditionally
-- regardless of caller, so path (1) silently bypassed the manual gate.
-- Fix: add a p_explicit flag distinguishing an explicit staff-invoked
-- activation from an automatic payment-triggered one. 'manual' policy
-- now only activates on the explicit path; 'first_payment'/'full_payment'
-- policies are unaffected (they were already correctly payment-gated).
-- ============================================================
create or replace function public._activate_subscription_if_due_internal(
  p_subscription_id uuid,
  p_explicit boolean default false
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_policy text;
  v_paid numeric;
  v_total numeric;
  v_activated boolean := false;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if v_sub.status != 'pending' then
    return false;
  end if;

  select subscription_activation_policy into v_policy from public.clubs where id = v_sub.club_id;

  if v_policy = 'manual' then
    -- Manual policy means a staff member explicitly activates it --
    -- never as a side effect of recording a payment.
    if p_explicit then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    end if;
  else
    select i.total, coalesce(sum(pa.amount), 0) into v_total, v_paid
    from public.invoices i
    left join public.payment_allocations pa on pa.invoice_id = i.id
    where i.id = v_sub.invoice_id
    group by i.total;

    if v_policy = 'first_payment' and v_paid > 0 then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    elsif v_policy = 'full_payment' and v_paid >= v_total then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    end if;
  end if;

  if v_activated then
    perform public.write_audit_log(
      v_sub.club_id, 'subscription.activate', 'subscription', p_subscription_id, null,
      jsonb_build_object('policy', v_policy, 'explicit', p_explicit),
      null
    );
  end if;

  return v_activated;
end;
$$;

create or replace function public.activate_subscription_if_due(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id into v_club_id from public.subscriptions where id = p_subscription_id;
  if v_club_id is null then
    raise exception 'subscription not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('subscription.update', v_club_id)) then
    raise exception 'not authorized';
  end if;

  return public._activate_subscription_if_due_internal(p_subscription_id, true);
end;
$$;

-- record_payment()'s internal call stays implicit (p_explicit defaults
-- to false) -- no change needed to record_payment() itself, since the
-- default now correctly means "not an explicit manual activation".
