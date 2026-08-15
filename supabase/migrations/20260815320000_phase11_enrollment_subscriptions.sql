-- Phase 11 -- Enrollment + Subscriptions + Installments.
-- See docs/IMPLEMENTATION_PLAN.md Phase 11, docs/DATABASE_BLUEPRINT.md
-- #enrollments/#subscriptions/#subscription_freezes, docs/DECISIONS.md
-- ADR-013/ADR-013b/ADR-008, docs/RLS_MATRIX.md.

-- ============================================================
-- Tables
-- ============================================================

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  player_id uuid not null references public.players(id),
  group_id uuid not null references public.groups(id),
  guardian_id uuid references public.customers(id),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  enrolled_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index enrollments_club_id_idx on public.enrollments (club_id);
create index enrollments_group_id_idx on public.enrollments (group_id);
create index enrollments_player_id_idx on public.enrollments (player_id);
-- Concurrency-safe capacity check reads this partial unique index's
-- backing set (active enrollments per group) inside the enrollment RPC's
-- transaction; the constraint itself also structurally prevents the same
-- player being enrolled twice (actively) in the same group.
create unique index enrollments_active_player_group_idx on public.enrollments (player_id, group_id) where status = 'active';

alter table public.enrollments enable row level security;

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  enrollment_id uuid not null unique references public.enrollments(id),
  plan_type text not null check (plan_type in ('monthly', 'quarterly', 'season', 'package')),
  start_date date not null,
  end_date date not null,
  price numeric(12,2) not null check (price >= 0),
  discount numeric(12,2) not null default 0 check (discount >= 0),
  status text not null default 'pending' check (status in ('pending', 'active', 'frozen', 'expired', 'cancelled')),
  invoice_id uuid references public.invoices(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint subscriptions_valid_period check (end_date > start_date)
);

create index subscriptions_club_id_idx on public.subscriptions (club_id);
alter table public.subscriptions enable row level security;

create table public.subscription_freezes (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  subscription_id uuid not null references public.subscriptions(id),
  start_date date not null,
  end_date date not null,
  reason text,
  extends_expiry boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint subscription_freezes_valid_period check (end_date > start_date)
);

create index subscription_freezes_subscription_id_idx on public.subscription_freezes (subscription_id);
alter table public.subscription_freezes enable row level security;

-- ============================================================
-- Permissions
-- ============================================================

insert into public.permissions (key, description) values
  ('enrollment.view', 'View enrollments'),
  ('enrollment.create', 'Enroll a player into a group'),
  ('enrollment.update', 'Update/withdraw an enrollment'),
  ('subscription.view', 'View subscriptions'),
  ('subscription.create', 'Create a subscription for an enrollment'),
  ('subscription.update', 'Update subscription status/activation'),
  ('subscription.freeze.create', 'Freeze a subscription')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_manager', 'academy_manager')
  and p.key in ('enrollment.view', 'enrollment.create', 'enrollment.update',
                'subscription.view', 'subscription.create', 'subscription.update',
                'subscription.freeze.create')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('platform_owner', 'club_owner', 'branch_manager', 'receptionist', 'accountant')
  and p.key in ('enrollment.view', 'subscription.view')
on conflict do nothing;

-- ============================================================
-- RLS
-- ============================================================

create policy "enrollments_select" on public.enrollments for select
  using (
    club_id in (select public.user_club_ids())
    and (
      public.has_permission('enrollment.view', club_id)
      or exists (
        select 1 from public.groups g
        where g.id = enrollments.group_id
          and (g.coach_id = auth.uid() or g.assistant_coach_id = auth.uid())
      )
    )
  );
create policy "enrollments_insert" on public.enrollments for insert
  with check (club_id in (select public.user_club_ids()) and public.has_permission('enrollment.create', club_id));
create policy "enrollments_update" on public.enrollments for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('enrollment.update', club_id));
alter table public.enrollments force row level security;

create policy "subscriptions_select" on public.subscriptions for select
  using (club_id in (select public.user_club_ids()) and public.has_permission('subscription.view', club_id));
-- No direct client INSERT policy -- subscriptions are created only via
-- create_enrollment_with_subscription (SECURITY DEFINER), which derives
-- club_id/enrollment_id/price server-side rather than trusting client input
-- for a financial record.
create policy "subscriptions_update" on public.subscriptions for update
  using (club_id in (select public.user_club_ids()) and public.has_permission('subscription.update', club_id));
alter table public.subscriptions force row level security;

create policy "subscription_freezes_select" on public.subscription_freezes for select
  using (club_id in (select public.user_club_ids()) and public.has_permission('subscription.view', club_id));
-- No direct client INSERT policy -- written only via freeze_subscription
-- RPC. No UPDATE/DELETE policy at all, for any role -- a freeze record is
-- historical once created, matching field_blocks' no-UPDATE/DELETE pattern.
alter table public.subscription_freezes force row level security;

-- ============================================================
-- get_subscription_effective_end_date: deterministic derived expiry.
-- effective_end_date = subscriptions.end_date + SUM(freeze durations
-- WHERE extends_expiry = true). subscriptions.end_date itself is never
-- mutated by a freeze.
-- ============================================================

create or replace function public.get_subscription_effective_end_date(p_subscription_id uuid)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.end_date + coalesce(
    (select sum(f.end_date - f.start_date)::int from public.subscription_freezes f
     where f.subscription_id = p_subscription_id and f.extends_expiry = true),
    0
  )
  from public.subscriptions s
  where s.id = p_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('subscription.view', s.club_id);
$$;

revoke execute on function public.get_subscription_effective_end_date(uuid) from public;
revoke execute on function public.get_subscription_effective_end_date(uuid) from anon;
grant execute on function public.get_subscription_effective_end_date(uuid) to authenticated;

-- ============================================================
-- create_enrollment_with_subscription: enrolls a player into a group and
-- creates the subscription + invoice in one transaction.
-- Capacity check is concurrency-safe: SELECT ... FOR UPDATE row-locks the
-- groups row, then counts active enrollments inside the same transaction,
-- serializing concurrent attempts for the same group's last spot.
-- ============================================================

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
set search_path = public, pg_temp
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

revoke execute on function public.create_enrollment_with_subscription(uuid, uuid, uuid, text, date, date, numeric, numeric) from public;
revoke execute on function public.create_enrollment_with_subscription(uuid, uuid, uuid, text, date, date, numeric, numeric) from anon;
grant execute on function public.create_enrollment_with_subscription(uuid, uuid, uuid, text, date, date, numeric, numeric) to authenticated;

-- ============================================================
-- _activate_subscription_if_due_internal: branches on clubs.
-- subscription_activation_policy. No permission check of its own -- it is
-- only ever called from within another SECURITY DEFINER function that has
-- already authorized the caller for the action actually being performed
-- (record_payment requires payment.create; the public
-- activate_subscription_if_due wrapper below requires subscription.update
-- for the direct/manual case). Zero EXECUTE grants to any client role --
-- unreachable directly, exactly like _create_booking_internal (Phase 6).
-- ============================================================

create or replace function public._activate_subscription_if_due_internal(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
  v_policy text;
  v_paid numeric;
  v_total numeric;
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
    update public.subscriptions set status = 'active' where id = p_subscription_id;
    return true;
  end if;

  select i.total, coalesce(sum(pa.amount), 0) into v_total, v_paid
  from public.invoices i
  left join public.payment_allocations pa on pa.invoice_id = i.id
  where i.id = v_sub.invoice_id
  group by i.total;

  if v_policy = 'first_payment' and v_paid > 0 then
    update public.subscriptions set status = 'active' where id = p_subscription_id;
    return true;
  elsif v_policy = 'full_payment' and v_paid >= v_total then
    update public.subscriptions set status = 'active' where id = p_subscription_id;
    return true;
  end if;

  return false;
end;
$$;

revoke execute on function public._activate_subscription_if_due_internal(uuid) from public;
revoke execute on function public._activate_subscription_if_due_internal(uuid) from anon;
revoke execute on function public._activate_subscription_if_due_internal(uuid) from authenticated;

-- Public wrapper: direct/manual activation, requires subscription.update
-- on the subscription's own club -- used for the 'manual' activation
-- policy, where a staff member explicitly activates a pending subscription.
create or replace function public.activate_subscription_if_due(p_subscription_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
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

  return public._activate_subscription_if_due_internal(p_subscription_id);
end;
$$;

revoke execute on function public.activate_subscription_if_due(uuid) from public;
revoke execute on function public.activate_subscription_if_due(uuid) from anon;
grant execute on function public.activate_subscription_if_due(uuid) to authenticated;

-- ============================================================
-- freeze_subscription: pauses a subscription. extends_expiry defaults
-- true per ADR-008. subscriptions.end_date is never mutated -- only the
-- derived effective_end_date (via get_subscription_effective_end_date)
-- reflects the extension.
-- ============================================================

create or replace function public.freeze_subscription(
  p_subscription_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text default null,
  p_extends_expiry boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sub record;
  v_freeze_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if not (v_sub.club_id in (select public.user_club_ids()) and public.has_permission('subscription.freeze.create', v_sub.club_id)) then
    raise exception 'not authorized';
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

  update public.subscriptions set status = 'frozen' where id = p_subscription_id;

  perform public.write_audit_log(v_sub.club_id, 'subscription.freeze', 'subscription', p_subscription_id, null, jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'extends_expiry', p_extends_expiry), p_reason);

  return v_freeze_id;
end;
$$;

revoke execute on function public.freeze_subscription(uuid, date, date, text, boolean) from public;
revoke execute on function public.freeze_subscription(uuid, date, date, text, boolean) from anon;
grant execute on function public.freeze_subscription(uuid, date, date, text, boolean) to authenticated;

-- ============================================================
-- record_payment redefined (Phase 7 -> Phase 11): identical body, plus a
-- trailing call to activate_subscription_if_due for any pending
-- subscription whose invoice this payment funds. Activation itself still
-- branches on the club's configured policy inside that function -- this
-- call is a no-op for a payment against a non-subscription invoice
-- (no matching pending subscription row) or once already active/non-pending.
-- ============================================================

create or replace function public.record_payment(
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
  v_invoice record;
  v_payment_id uuid;
  v_pending_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid method';
  end if;

  select * into v_invoice from public.invoices where id = p_invoice_id;
  if v_invoice is null then
    raise exception 'invoice not found';
  end if;

  if not (v_invoice.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_invoice.club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid())
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  return v_payment_id;
end;
$$;

revoke execute on function public.record_payment(uuid, numeric, text, text) from public;
revoke execute on function public.record_payment(uuid, numeric, text, text) from anon;
grant execute on function public.record_payment(uuid, numeric, text, text) to authenticated;
