-- CLUB MEMBERSHIPS domain -- core lifecycle RPCs (retry after an
-- earlier combined-migration attempt was blocked by the platform's
-- permission classifier; this migration excludes the record_payment()
-- and create_refund() widenings, which were split into their own
-- separate migrations immediately following this one).
--
-- Mirrors the proven academy subscriptions RPC patterns exactly
-- (protect-status-transitions bypass trigger, FOR UPDATE activation,
-- date-range-derived freeze, sequential non-overlapping renewal) with
-- the two deliberate deviations documented in CLUB_MEMBERSHIP_DISCOVERY.md:
-- (1) non-configurable "full payment required" activation rule, and
-- (2) early-renewal coexistence (current active + future scheduled).

-- 1) Status transition protection, exact mirror of
--    protect_subscription_status_transitions().
create or replace function public.protect_club_membership_status_transitions()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.status is distinct from old.status then
    if coalesce(current_setting('app.allow_club_membership_status_transition', true), 'false') != 'true' then
      new.status := old.status;
    end if;
  end if;
  return new;
end;
$$;

create trigger club_membership_subscriptions_protect_status
  before update on public.club_membership_subscriptions
  for each row execute function public.protect_club_membership_status_transitions();

-- Snapshot immutability, exact mirror of protect_subscription_price_immutable().
create or replace function public.protect_club_membership_subscription_snapshot()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.plan_name_ar_snapshot is distinct from old.plan_name_ar_snapshot then
    new.plan_name_ar_snapshot := old.plan_name_ar_snapshot;
  end if;
  if new.plan_name_en_snapshot is distinct from old.plan_name_en_snapshot then
    new.plan_name_en_snapshot := old.plan_name_en_snapshot;
  end if;
  if new.price_snapshot is distinct from old.price_snapshot then
    new.price_snapshot := old.price_snapshot;
  end if;
  if new.duration_value_snapshot is distinct from old.duration_value_snapshot then
    new.duration_value_snapshot := old.duration_value_snapshot;
  end if;
  if new.duration_unit_snapshot is distinct from old.duration_unit_snapshot then
    new.duration_unit_snapshot := old.duration_unit_snapshot;
  end if;
  if new.start_date is distinct from old.start_date then
    new.start_date := old.start_date;
  end if;
  if new.end_date is distinct from old.end_date then
    new.end_date := old.end_date;
  end if;
  if new.customer_id is distinct from old.customer_id then
    new.customer_id := old.customer_id;
  end if;
  if new.plan_id is distinct from old.plan_id then
    new.plan_id := old.plan_id;
  end if;
  return new;
end;
$$;

create trigger club_membership_subscriptions_protect_snapshot
  before update on public.club_membership_subscriptions
  for each row execute function public.protect_club_membership_subscription_snapshot();

-- 2) Effective end date -- base end_date is immutable; effective end is
--    derived by summing freeze durations, exact mirror of
--    get_subscription_effective_end_date().
create or replace function public.get_club_membership_effective_end_date(p_membership_subscription_id uuid)
returns date
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select s.end_date + coalesce(
    (select sum(f.end_date - f.start_date)::int from public.club_membership_freezes f
     where f.membership_subscription_id = p_membership_subscription_id),
    0
  )
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.view', s.club_id);
$$;

-- 3) Derived display status -- stored status wins for terminal/frozen
--    states; otherwise compared against today (club-local) and
--    start_date/effective_end_date. No cron dependency required.
create or replace function public.get_club_membership_effective_status(
  p_status text,
  p_start_date date,
  p_effective_end_date date,
  p_today date
)
returns text
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case
    when p_status in ('cancelled', 'frozen') then p_status
    when p_status = 'pending_payment' then 'pending_payment'
    when p_effective_end_date < p_today then 'expired'
    when p_start_date > p_today then 'scheduled'
    else 'active'
  end
$$;

-- 4) Activation gate -- non-configurable full-payment rule (deliberate
--    simplification vs. academy's per-club policy, per discovery doc).
create or replace function public._activate_club_membership_if_due_internal(p_membership_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_paid numeric;
  v_total numeric;
  v_today date;
  v_activated boolean := false;
  v_new_status text;
begin
  select * into v_sub from public.club_membership_subscriptions where id = p_membership_subscription_id for update;
  if v_sub.id is null then
    raise exception 'club membership not found';
  end if;

  if v_sub.status != 'pending_payment' then
    return false;
  end if;

  select i.total, coalesce(sum(pa.amount), 0) into v_total, v_paid
  from public.invoices i
  left join public.payment_allocations pa on pa.invoice_id = i.id
  where i.id = v_sub.invoice_id
  group by i.total;

  if v_paid < v_total then
    return false;
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_sub.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_sub.club_id, current_date);

  v_new_status := case when v_sub.start_date <= v_today then 'active' else 'scheduled' end;

  perform set_config('app.allow_club_membership_status_transition', 'true', true);
  update public.club_membership_subscriptions set status = v_new_status where id = p_membership_subscription_id;
  v_activated := true;

  perform public.write_audit_log(
    v_sub.club_id, 'club_membership.activated', 'club_membership_subscription', p_membership_subscription_id, null,
    jsonb_build_object('new_status', v_new_status),
    null
  );

  return v_activated;
end;
$$;

-- 5) Membership number generator -- per-club sequential, human-readable,
--    architecturally distinct from the QR token (never derived from it).
--    Uses a dedicated per-club counter table (mirrors
--    invoice_number_sequences' own atomic upsert-and-return pattern)
--    rather than max()+1, which would race under concurrent sells for
--    the same club.
create table if not exists public.club_membership_number_sequences (
  club_id uuid primary key references public.clubs(id),
  last_number bigint not null default 0
);

alter table public.club_membership_number_sequences enable row level security;
alter table public.club_membership_number_sequences force row level security;
-- No policies: pure server-side counter, never read directly by any client.

create or replace function public._next_club_membership_number_internal(p_club_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_next bigint;
begin
  insert into public.club_membership_number_sequences (club_id, last_number)
  values (p_club_id, 1)
  on conflict (club_id) do update set last_number = public.club_membership_number_sequences.last_number + 1
  returning last_number into v_next;

  return 'MEM-' || lpad(v_next::text, 6, '0');
end;
$$;

-- 6) Sell (staff) -- atomic: validate plan/branch/customer, compute
--    end_date server-side via verified calendar-interval arithmetic,
--    create invoice + invoice_items + subscription row (pending_payment).
--    Idempotency guarded via club_membership_sale_keys, mirroring
--    employee_cash_liability_settlement_keys.
create or replace function public.sell_club_membership(
  p_club_id uuid,
  p_customer_id uuid,
  p_plan_id uuid,
  p_branch_id uuid,
  p_start_date date,
  p_discount numeric default 0,
  p_idempotency_key uuid default null
)
returns table(membership_subscription_id uuid, invoice_id uuid, membership_number text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_plan record;
  v_existing_membership_id uuid;
  v_existing_invoice_id uuid;
  v_existing_number text;
  v_end_date date;
  v_net_price numeric;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
  v_membership_number text;
  v_branch_allowed boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club_membership.create', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(p_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if p_idempotency_key is not null then
    select membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys
    where idempotency_key = p_idempotency_key;

    if v_existing_membership_id is not null then
      select s.invoice_id, s.membership_number into v_existing_invoice_id, v_existing_number
      from public.club_membership_subscriptions s where s.id = v_existing_membership_id;
      return query select v_existing_membership_id, v_existing_invoice_id, v_existing_number;
      return;
    end if;
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found in this club';
  end if;

  if not public.user_has_branch_access(p_club_id, p_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  select * into v_plan from public.club_membership_plans
  where id = p_plan_id and club_id = p_club_id and archived_at is null
  for update;

  if v_plan.id is null then
    raise exception 'plan not found in this club';
  end if;

  if not v_plan.is_active then
    raise exception 'this plan is no longer available for purchase';
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

  v_net_price := round(greatest(v_plan.price - coalesce(p_discount, 0), 0), 2);
  v_membership_number := public._next_club_membership_number_internal(p_club_id);

  v_invoice_number := public.issue_invoice_number(p_branch_id, p_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (p_club_id, p_branch_id, v_invoice_number, p_customer_id, 'issued', v_plan.price, coalesce(p_discount, 0), v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.club_membership_subscriptions (
    club_id, branch_id, customer_id, plan_id, membership_number,
    plan_name_ar_snapshot, plan_name_en_snapshot, price_snapshot,
    duration_value_snapshot, duration_unit_snapshot,
    start_date, end_date, status, invoice_id, created_by
  )
  values (
    p_club_id, p_branch_id, p_customer_id, v_plan.id, v_membership_number,
    v_plan.name_ar, v_plan.name_en, v_net_price,
    v_plan.duration_value, v_plan.duration_unit,
    p_start_date, v_end_date, 'pending_payment', v_invoice_id, auth.uid()
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
    p_club_id, 'club_membership.created', 'club_membership_subscription', v_subscription_id, null,
    jsonb_build_object('plan_id', v_plan.id, 'customer_id', p_customer_id, 'start_date', p_start_date, 'end_date', v_end_date, 'price', v_net_price),
    null
  );

  return query select v_subscription_id, v_invoice_id, v_membership_number;
end;
$$;

-- 7) Renew -- always inserts a NEW row, never mutates the old one.
--    Early-renewal rule: if current period is still active/scheduled,
--    new start = current.end_date + 1 day (base end_date, not the
--    freeze-extended effective one -- an active period can't be frozen
--    simultaneously, and a scheduled period has no freezes yet, so base
--    == effective in both allowed source states). If current is
--    expired, default start = today (club-local); explicit
--    p_start_date override allowed for a future start.
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
    select membership_subscription_id into v_existing_membership_id
    from public.club_membership_sale_keys
    where idempotency_key = p_idempotency_key;

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

-- 8) Freeze -- date-range based, base end_date never mutated, gated on
--    plan.allow_freeze and (cumulative) max_freeze_days_per_period.
create or replace function public.freeze_club_membership(
  p_membership_subscription_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_plan record;
  v_freeze_id uuid;
  v_existing_freeze_days int;
  v_new_freeze_days int;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select s.* into v_sub
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.freeze', s.club_id)
  for update;

  if v_sub.id is null then
    raise exception 'club membership not found or you do not have permission to freeze it';
  end if;

  select * into v_plan from public.club_membership_plans where id = v_sub.plan_id;

  if not coalesce(v_plan.allow_freeze, false) then
    raise exception 'this plan does not allow freezing';
  end if;

  if v_sub.status != 'active' then
    raise exception 'only an active membership can be frozen';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  v_new_freeze_days := p_end_date - p_start_date;

  if v_plan.max_freeze_days_per_period is not null then
    select coalesce(sum(end_date - start_date), 0) into v_existing_freeze_days
    from public.club_membership_freezes
    where membership_subscription_id = p_membership_subscription_id;

    if v_existing_freeze_days + v_new_freeze_days > v_plan.max_freeze_days_per_period then
      raise exception 'this freeze would exceed the plan''s maximum freeze days per period (%)', v_plan.max_freeze_days_per_period;
    end if;
  end if;

  insert into public.club_membership_freezes (club_id, membership_subscription_id, start_date, end_date, reason, created_by)
  values (v_sub.club_id, p_membership_subscription_id, p_start_date, p_end_date, p_reason, auth.uid())
  returning id into v_freeze_id;

  perform set_config('app.allow_club_membership_status_transition', 'true', true);
  update public.club_membership_subscriptions set status = 'frozen' where id = p_membership_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'club_membership.frozen', 'club_membership_subscription', p_membership_subscription_id, null,
    jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'freeze_days', v_new_freeze_days),
    p_reason
  );

  return v_freeze_id;
end;
$$;

-- 9) Resume -- truncates/deletes the open freeze exactly like
--     unfreeze_subscription, but using club-local date instead of bare
--     current_date (fixes the known academy defect class from the start).
create or replace function public.resume_club_membership(
  p_membership_subscription_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_open_freeze record;
  v_today date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select s.* into v_sub
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.freeze', s.club_id)
  for update;

  if v_sub.id is null then
    raise exception 'club membership not found or you do not have permission to resume it';
  end if;

  if v_sub.status != 'frozen' then
    raise exception 'membership is not currently frozen';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_sub.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_sub.club_id, current_date);

  select * into v_open_freeze from public.club_membership_freezes
  where membership_subscription_id = p_membership_subscription_id and end_date >= v_today
  order by start_date desc
  limit 1
  for update;

  if v_open_freeze.id is not null then
    if v_open_freeze.start_date > v_today then
      delete from public.club_membership_freezes where id = v_open_freeze.id;
    else
      update public.club_membership_freezes set end_date = v_today where id = v_open_freeze.id;
    end if;
  end if;

  perform set_config('app.allow_club_membership_status_transition', 'true', true);
  update public.club_membership_subscriptions set status = 'active' where id = p_membership_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'club_membership.resumed', 'club_membership_subscription', p_membership_subscription_id, null,
    jsonb_build_object('ended_freeze_id', v_open_freeze.id),
    p_reason
  );
end;
$$;

-- 10) Cancel -- stops entitlement immediately, no auto-refund
--     (cancellation and refund are fully independent per directive).
create or replace function public.cancel_club_membership(
  p_membership_subscription_id uuid,
  p_reason text
)
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

  select s.* into v_sub
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.cancel', s.club_id)
  for update;

  if v_sub.id is null then
    raise exception 'club membership not found or you do not have permission to cancel it';
  end if;

  if v_sub.status = 'cancelled' then
    raise exception 'club membership is already cancelled';
  end if;

  perform set_config('app.allow_club_membership_status_transition', 'true', true);
  update public.club_membership_subscriptions
  set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = p_reason
  where id = p_membership_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'club_membership.cancelled', 'club_membership_subscription', p_membership_subscription_id,
    jsonb_build_object('previous_status', v_sub.status), null,
    p_reason
  );
end;
$$;
