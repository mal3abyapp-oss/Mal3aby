-- RENTALS MODULE (2026-10-07)
--
-- New product line: clubs lease out rentable spaces they own (a gym, a
-- wedding / events hall, a shop unit, an office, a warehouse, ... or any
-- custom-named space type) to a tenant (an ordinary club `customers` row)
-- under a lease contract billed on a rent cycle:
--   daily | monthly | quarterly | semi_annual | annual | custom
-- (custom = every N days / weeks / months).
--
-- Accounting design -- deliberately NO new money tables:
--   * A contract pre-computes its full installment schedule
--     (rental_installments). Installments are only a schedule; they are
--     NOT receivables until an invoice is issued for them, so future rent
--     never inflates "outstanding" on the dashboard / finance pages.
--   * Issuing an installment creates a normal `invoices` row (with
--     due_date = installment due date) + one `invoice_items` line per
--     installment, reference_type = 'rental', reference_id = installment.
--   * Collection goes through the SAME shared record_payment() /
--     record_payment_with_official_receipt() chokepoint as every other
--     module, so rental money automatically flows into payments, cash
--     shifts, official receipts, revenue / collections / payment-method /
--     reconciliation / executive / today reports, Customer 360 and the
--     customer portal with no parallel ledger.
--   * Paid / partial / overdue status is always DERIVED from
--     get_invoice_payment_summary() -- never stored -- so refunds and
--     voids are reflected automatically.
--
-- Module registration mirrors 20260828210000_club_membership_module_
-- registration.sql; existing clubs are entitled but NOT activated (opt-in,
-- same as Shop at onboarding), so nothing appears unexpectedly.
--
-- Hardcoded module-key lists inside existing functions are widened with
-- an asserted text patch of the LIVE function definition (same technique
-- as 20260821080000), so this migration never overwrites unrelated
-- production logic in those large functions with a stale local copy.

-- ============================================================
-- 0. Helper used only during this migration: asserted in-place patch
-- ============================================================
create or replace function public._rentals_migration_patch_function(
  p_function regprocedure, p_old text, p_new text
) returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_def text;
begin
  v_def := pg_get_functiondef(p_function);
  if position(p_new in v_def) > 0 then
    return; -- already patched (idempotent re-run)
  end if;
  if position(p_old in v_def) = 0 then
    raise exception 'rentals migration: anchor not found in %', p_function;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;

-- ============================================================
-- 1. Module registration
-- ============================================================
alter table public.club_modules drop constraint club_modules_module_key_check;
alter table public.club_modules add constraint club_modules_module_key_check
  check (module_key in ('fields', 'academy', 'shop', 'club_membership', 'rentals'));

insert into public.club_modules (club_id, module_key, entitled, active)
select c.id, 'rentals', true, false
from public.clubs c
on conflict (club_id, module_key) do nothing;

select public._rentals_migration_patch_function(
  'public.set_club_module_entitlement(uuid, text, boolean)'::regprocedure,
  $x$('fields', 'academy', 'shop', 'club_membership')$x$,
  $x$('fields', 'academy', 'shop', 'club_membership', 'rentals')$x$
);

select public._rentals_migration_patch_function(
  'public.set_club_module_active(uuid, text, boolean, text)'::regprocedure,
  $x$('fields', 'academy', 'shop', 'club_membership')$x$,
  $x$('fields', 'academy', 'shop', 'club_membership', 'rentals')$x$
);

select public._rentals_migration_patch_function(
  'public.create_platform_subscription(uuid, text, uuid, text, boolean, text)'::regprocedure,
  $x$('fields', 'academy', 'shop', 'club_membership')$x$,
  $x$('fields', 'academy', 'shop', 'club_membership', 'rentals')$x$
);

-- update_platform_plan validates default_modules against its own list;
-- without this, saving any plan (which now carries 'rentals') fails.
select public._rentals_migration_patch_function(
  'public.update_platform_plan(uuid, text, numeric, text, text[], integer, integer, integer)'::regprocedure,
  $x$('fields', 'academy', 'shop', 'club_membership')$x$,
  $x$('fields', 'academy', 'shop', 'club_membership', 'rentals')$x$
);

select public._rentals_migration_patch_function(
  'public.complete_new_club_onboarding(text, text, text, text, text, text, text, text, boolean, text, text)'::regprocedure,
  $x$(v_club_id, 'shop', true, false)$x$,
  $x$(v_club_id, 'shop', true, false),
    (v_club_id, 'rentals', true, false)$x$
);

-- Every existing platform plan that seeds modules also entitles rentals
-- (activation stays a per-club opt-in).
update public.platform_plans
set default_modules = array_append(default_modules, 'rentals'), updated_at = now()
where default_modules is not null and not ('rentals' = any(default_modules));

create or replace function public._rentals_module_active(p_club_id uuid)
returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(bool_and(entitled) and bool_and(active), false)
  from public.club_modules
  where club_id = p_club_id and module_key = 'rentals'
$$;

revoke all on function public._rentals_module_active(uuid) from public, anon, authenticated;
grant execute on function public._rentals_module_active(uuid) to service_role;

-- ============================================================
-- 2. Invoice line source
-- ============================================================
alter table public.invoice_items drop constraint invoice_items_reference_type_check;
alter table public.invoice_items add constraint invoice_items_reference_type_check
  check (reference_type = any (array['booking', 'subscription', 'registration_fee', 'club_membership', 'shop_sale_item', 'other', 'rental']));

-- ============================================================
-- 3. Tables
-- ============================================================
create table public.rental_spaces (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  name text not null check (length(trim(name)) between 1 and 120),
  space_type text not null default 'other' check (space_type in (
    'gym', 'wedding_hall', 'event_hall', 'shop', 'office', 'warehouse',
    'apartment', 'sports_facility', 'other', 'custom'
  )),
  custom_type_label text check (custom_type_label is null or length(trim(custom_type_label)) between 1 and 80),
  description text check (description is null or length(description) <= 2000),
  area_sqm numeric(10, 2) check (area_sqm is null or area_sqm > 0),
  capacity integer check (capacity is null or capacity > 0),
  default_rent_cycle text check (default_rent_cycle is null or default_rent_cycle in (
    'daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom'
  )),
  default_rent_amount numeric(12, 2) check (default_rent_amount is null or default_rent_amount >= 0),
  allow_overlapping_contracts boolean not null default false,
  status text not null default 'active' check (status in ('active', 'inactive', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id),
  constraint rental_spaces_custom_label_required
    check (space_type <> 'custom' or custom_type_label is not null)
);
comment on table public.rental_spaces is 'Rentable spaces a club leases out (gym, wedding hall, shop unit, ... or custom type). Writes only via SECURITY DEFINER RPCs. See 20261007100000_rentals_module.sql.';
create index rental_spaces_club_idx on public.rental_spaces (club_id, status);

create table public.rental_contract_counters (
  club_id uuid primary key references public.clubs(id),
  last_value integer not null default 0
);

create table public.rental_contracts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  space_id uuid not null references public.rental_spaces(id),
  customer_id uuid not null references public.customers(id),
  contract_number text not null,
  rent_cycle text not null check (rent_cycle in ('daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom')),
  custom_cycle_value integer check (custom_cycle_value is null or custom_cycle_value between 1 and 3650),
  custom_cycle_unit text check (custom_cycle_unit is null or custom_cycle_unit in ('day', 'week', 'month')),
  cycles_count integer not null check (cycles_count between 1 and 1000),
  cycle_amount numeric(12, 2) not null check (cycle_amount >= 0),
  total_rent numeric(14, 2) not null check (total_rent >= 0),
  security_deposit numeric(12, 2) not null default 0 check (security_deposit >= 0),
  start_date date not null,
  end_date date not null,
  status text not null default 'active' check (status in ('active', 'terminated', 'cancelled')),
  notes text check (notes is null or length(notes) <= 2000),
  termination_date date,
  terminated_at timestamptz,
  terminated_by uuid references auth.users(id),
  termination_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancel_reason text,
  idempotency_key uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id),
  constraint rental_contracts_number_unique unique (club_id, contract_number),
  constraint rental_contracts_idempotency_unique unique (club_id, idempotency_key),
  constraint rental_contracts_dates check (end_date >= start_date),
  constraint rental_contracts_custom_cycle
    check (rent_cycle <> 'custom' or (custom_cycle_value is not null and custom_cycle_unit is not null))
);
comment on table public.rental_contracts is 'Lease contract of one rental space to one customer. Money lives in invoices/payments (invoice_items.reference_type = rental). Writes only via SECURITY DEFINER RPCs.';
create index rental_contracts_club_idx on public.rental_contracts (club_id, status);
create index rental_contracts_space_idx on public.rental_contracts (space_id, start_date, end_date);
create index rental_contracts_customer_idx on public.rental_contracts (customer_id);

create table public.rental_installments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  contract_id uuid not null references public.rental_contracts(id),
  kind text not null default 'rent' check (kind in ('rent', 'deposit')),
  sequence integer not null check (sequence >= 0),
  period_start date not null,
  period_end date not null,
  due_date date not null,
  amount numeric(12, 2) not null check (amount >= 0),
  invoice_id uuid references public.invoices(id),
  status text not null default 'scheduled' check (status in ('scheduled', 'invoiced', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint rental_installments_unique unique (contract_id, kind, sequence),
  constraint rental_installments_period check (period_end >= period_start)
);
comment on table public.rental_installments is 'Installment schedule of a rental contract. scheduled = not yet a receivable; invoiced = has an invoice (payment status derived from get_invoice_payment_summary); cancelled = dropped by termination/cancellation.';
create index rental_installments_contract_idx on public.rental_installments (contract_id, sequence);
create index rental_installments_invoice_idx on public.rental_installments (invoice_id);
create index rental_installments_due_idx on public.rental_installments (club_id, status, due_date);

-- RLS: read-only policies; every write goes through the RPCs below.
alter table public.rental_spaces enable row level security;
alter table public.rental_spaces force row level security;
alter table public.rental_contract_counters enable row level security;
alter table public.rental_contract_counters force row level security;
alter table public.rental_contracts enable row level security;
alter table public.rental_contracts force row level security;
alter table public.rental_installments enable row level security;
alter table public.rental_installments force row level security;

create policy rental_spaces_staff_select on public.rental_spaces for select to authenticated
  using (club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', club_id)
    and public.user_has_branch_access(club_id, branch_id));

create policy rental_contracts_staff_select on public.rental_contracts for select to authenticated
  using (club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', club_id)
    and public.user_has_branch_access(club_id, branch_id));

create policy rental_contracts_customer_select on public.rental_contracts for select to authenticated
  using (customer_id in (select c.id from public.customers c where c.user_id = (select auth.uid())));

create policy rental_installments_staff_select on public.rental_installments for select to authenticated
  using (club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', club_id)
    and public.user_has_branch_access(club_id, branch_id));

create policy rental_installments_customer_select on public.rental_installments for select to authenticated
  using (contract_id in (
    select rc.id from public.rental_contracts rc
    join public.customers c on c.id = rc.customer_id
    where c.user_id = (select auth.uid())
  ));

revoke all on public.rental_spaces, public.rental_contracts, public.rental_installments, public.rental_contract_counters from anon;
revoke insert, update, delete, truncate on public.rental_spaces, public.rental_contracts, public.rental_installments from authenticated;
revoke all on public.rental_contract_counters from authenticated;
grant select on public.rental_spaces, public.rental_contracts, public.rental_installments to authenticated;
grant all on public.rental_spaces, public.rental_contracts, public.rental_installments, public.rental_contract_counters to service_role;

-- ============================================================
-- 4. Permissions
-- ============================================================
insert into public.permissions (key, description) values
  ('rental.view', 'View rental spaces, lease contracts and their installments'),
  ('rental.space.manage', 'Create, edit, deactivate and archive rental spaces'),
  ('rental.contract.create', 'Create lease contracts and issue rent invoices'),
  ('rental.contract.manage', 'Terminate or cancel lease contracts')
on conflict (key) do nothing;

insert into public.permission_dependencies (permission_key, requires_key) values
  ('rental.space.manage', 'rental.view'),
  ('rental.contract.create', 'rental.view'),
  ('rental.contract.manage', 'rental.view')
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key in ('club_owner', 'club_manager', 'branch_manager')
  and p.key in ('rental.view', 'rental.space.manage', 'rental.contract.create', 'rental.contract.manage')
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'receptionist' and p.key in ('rental.view', 'rental.contract.create')
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r cross join public.permissions p
where r.key = 'accountant' and p.key in ('rental.view')
on conflict (role_id, permission_id) do nothing;

-- ============================================================
-- 5. Internal helpers
-- ============================================================
create or replace function public._rental_club_today(p_club_id uuid)
returns date
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select (now() at time zone coalesce((select c.timezone from public.clubs c where c.id = p_club_id), 'Africa/Cairo'))::date
$$;

-- Start date of period number p_index (0-based). Always computed from the
-- contract start (never chained) so month-end dates do not drift.
create or replace function public._rental_period_start(
  p_start date, p_cycle text, p_index integer, p_custom_value integer, p_custom_unit text
) returns date
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case p_cycle
    when 'daily' then p_start + p_index
    when 'monthly' then (p_start + make_interval(months => p_index))::date
    when 'quarterly' then (p_start + make_interval(months => 3 * p_index))::date
    when 'semi_annual' then (p_start + make_interval(months => 6 * p_index))::date
    when 'annual' then (p_start + make_interval(years => p_index))::date
    when 'custom' then case p_custom_unit
      when 'day' then p_start + p_custom_value * p_index
      when 'week' then p_start + 7 * p_custom_value * p_index
      when 'month' then (p_start + make_interval(months => p_custom_value * p_index))::date
    end
  end
$$;

create or replace function public._rental_contract_occupancy_end(p_contract public.rental_contracts)
returns date
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case
    when p_contract.status = 'terminated' then least(p_contract.end_date, coalesce(p_contract.termination_date, p_contract.end_date))
    else p_contract.end_date
  end
$$;

create or replace function public._rental_issue_invoice_internal(
  p_contract_id uuid, p_installment_ids uuid[], p_discount numeric default 0
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contract public.rental_contracts;
  v_space public.rental_spaces;
  v_subtotal numeric;
  v_count integer;
  v_invoice_id uuid;
  v_invoice_number text;
  v_due date;
  v_inst record;
  v_description text;
begin
  select * into v_contract from public.rental_contracts where id = p_contract_id for update;
  if v_contract.id is null then
    raise exception 'rental contract not found';
  end if;
  if v_contract.status = 'cancelled' then
    raise exception 'this rental contract is cancelled';
  end if;
  select * into v_space from public.rental_spaces where id = v_contract.space_id;

  -- Lock the selected installments; an installment is invoiceable when it
  -- is scheduled, or "invoiced" against an invoice that was later voided.
  select count(*), coalesce(sum(ri.amount), 0), min(ri.due_date)
    into v_count, v_subtotal, v_due
  from public.rental_installments ri
  left join public.invoices i on i.id = ri.invoice_id
  where ri.id = any(p_installment_ids)
    and ri.contract_id = p_contract_id
    and (ri.status = 'scheduled' or (ri.status = 'invoiced' and i.status = 'void'));

  if v_count = 0 or v_count <> coalesce(array_length(p_installment_ids, 1), 0) then
    raise exception 'one or more installments are not available for invoicing';
  end if;

  if coalesce(p_discount, 0) < 0 or coalesce(p_discount, 0) > v_subtotal then
    raise exception 'invalid discount';
  end if;

  perform 1 from public.rental_installments where id = any(p_installment_ids) for update;

  v_invoice_number := public.issue_invoice_number(v_contract.branch_id, v_contract.club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, due_date, issued_at, created_by)
  values (v_contract.club_id, v_contract.branch_id, v_invoice_number, v_contract.customer_id, 'issued',
          v_subtotal, coalesce(p_discount, 0), round(v_subtotal - coalesce(p_discount, 0), 2), v_due, now(), auth.uid())
  returning id into v_invoice_id;

  for v_inst in
    select * from public.rental_installments where id = any(p_installment_ids) order by sequence
  loop
    if v_inst.kind = 'deposit' then
      v_description := 'تأمين إيجار ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || chr(8297);
    else
      v_description := 'إيجار ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || ' #' || v_inst.sequence
        || ' ' || to_char(v_inst.period_start, 'YYYY-MM-DD') || ' → ' || to_char(v_inst.period_end, 'YYYY-MM-DD') || chr(8297);
    end if;

    insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
    values (v_invoice_id, v_description, 'rental', v_inst.id, 1, v_inst.amount, v_inst.amount);

    update public.rental_installments
    set invoice_id = v_invoice_id, status = 'invoiced', updated_at = now()
    where id = v_inst.id;
  end loop;

  perform public.write_audit_log(
    v_contract.club_id, 'rental.invoice_issued', 'rental_contract', v_contract.id, null,
    jsonb_build_object('invoice_id', v_invoice_id, 'installment_ids', to_jsonb(p_installment_ids),
                       'subtotal', v_subtotal, 'discount', coalesce(p_discount, 0)),
    null
  );

  return v_invoice_id;
end;
$$;

revoke all on function public._rental_club_today(uuid) from public, anon, authenticated;
revoke all on function public._rental_period_start(date, text, integer, integer, text) from public, anon;
revoke all on function public._rental_contract_occupancy_end(public.rental_contracts) from public, anon;
revoke all on function public._rental_issue_invoice_internal(uuid, uuid[], numeric) from public, anon, authenticated;
grant execute on function public._rental_club_today(uuid) to service_role;
grant execute on function public._rental_issue_invoice_internal(uuid, uuid[], numeric) to service_role;
grant execute on function public._rental_period_start(date, text, integer, integer, text) to authenticated, service_role;
grant execute on function public._rental_contract_occupancy_end(public.rental_contracts) to authenticated, service_role;

-- ============================================================
-- 6. Spaces RPCs
-- ============================================================
create or replace function public.upsert_rental_space(
  p_club_id uuid,
  p_space_id uuid,
  p_branch_id uuid,
  p_name text,
  p_space_type text,
  p_custom_type_label text default null,
  p_description text default null,
  p_area_sqm numeric default null,
  p_capacity integer default null,
  p_default_rent_cycle text default null,
  p_default_rent_amount numeric default null,
  p_allow_overlapping_contracts boolean default false
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.rental_spaces;
  v_id uuid;
  v_label text := nullif(trim(coalesce(p_custom_type_label, '')), '');
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.space.manage', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if not public._rentals_module_active(p_club_id) then
    raise exception 'the rentals module is not active for this club';
  end if;
  if not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'branch not found in this club';
  end if;
  if not public.user_has_branch_access(p_club_id, p_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if p_space_type = 'custom' and v_label is null then
    raise exception 'a custom space type name is required';
  end if;

  if p_space_id is null then
    insert into public.rental_spaces (
      club_id, branch_id, name, space_type, custom_type_label, description, area_sqm, capacity,
      default_rent_cycle, default_rent_amount, allow_overlapping_contracts, created_by
    ) values (
      p_club_id, p_branch_id, trim(p_name), p_space_type,
      case when p_space_type = 'custom' then v_label else null end,
      nullif(trim(coalesce(p_description, '')), ''), p_area_sqm, p_capacity,
      p_default_rent_cycle, p_default_rent_amount, coalesce(p_allow_overlapping_contracts, false), auth.uid()
    ) returning id into v_id;

    perform public.write_audit_log(p_club_id, 'rental.space.created', 'rental_space', v_id, null,
      jsonb_build_object('name', trim(p_name), 'space_type', p_space_type, 'custom_type_label', v_label, 'branch_id', p_branch_id), null);
  else
    select * into v_before from public.rental_spaces where id = p_space_id and club_id = p_club_id for update;
    if v_before.id is null then
      raise exception 'rental space not found in this club';
    end if;
    if not public.user_has_branch_access(p_club_id, v_before.branch_id) then
      raise exception 'you do not have access to this branch';
    end if;
    if v_before.branch_id <> p_branch_id and exists (
      select 1 from public.rental_contracts where space_id = p_space_id and status <> 'cancelled'
    ) then
      raise exception 'cannot move a space with contracts to another branch';
    end if;

    update public.rental_spaces set
      branch_id = p_branch_id, name = trim(p_name), space_type = p_space_type,
      custom_type_label = case when p_space_type = 'custom' then v_label else null end,
      description = nullif(trim(coalesce(p_description, '')), ''),
      area_sqm = p_area_sqm, capacity = p_capacity,
      default_rent_cycle = p_default_rent_cycle, default_rent_amount = p_default_rent_amount,
      allow_overlapping_contracts = coalesce(p_allow_overlapping_contracts, false),
      updated_at = now()
    where id = p_space_id;
    v_id := p_space_id;

    perform public.write_audit_log(p_club_id, 'rental.space.updated', 'rental_space', v_id,
      to_jsonb(v_before) - 'created_at' - 'created_by',
      jsonb_build_object('name', trim(p_name), 'space_type', p_space_type, 'custom_type_label', v_label, 'branch_id', p_branch_id), null);
  end if;

  return v_id;
end;
$$;

create or replace function public.set_rental_space_status(p_space_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_space public.rental_spaces;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_status not in ('active', 'inactive', 'archived') then
    raise exception 'invalid status';
  end if;

  select * into v_space from public.rental_spaces
  where id = p_space_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('rental.space.manage', club_id)
  for update;
  if v_space.id is null then
    raise exception 'rental space not found or you do not have permission to manage it';
  end if;
  if not public.user_has_branch_access(v_space.club_id, v_space.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if p_status = 'archived' and exists (
    select 1 from public.rental_contracts rc
    where rc.space_id = p_space_id and rc.status = 'active'
      and rc.end_date >= public._rental_club_today(v_space.club_id)
  ) then
    raise exception 'cannot archive a space with an active contract';
  end if;

  update public.rental_spaces set status = p_status, updated_at = now() where id = p_space_id;

  perform public.write_audit_log(v_space.club_id, 'rental.space.status_changed', 'rental_space', p_space_id,
    jsonb_build_object('status', v_space.status), jsonb_build_object('status', p_status), null);
end;
$$;

create or replace function public.list_rental_spaces(p_club_id uuid, p_include_archived boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today date;
  v_rows jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  v_today := public._rental_club_today(p_club_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'branch_id', s.branch_id, 'branch_name', b.name,
    'name', s.name, 'space_type', s.space_type, 'custom_type_label', s.custom_type_label,
    'description', s.description, 'area_sqm', s.area_sqm, 'capacity', s.capacity,
    'default_rent_cycle', s.default_rent_cycle, 'default_rent_amount', s.default_rent_amount,
    'allow_overlapping_contracts', s.allow_overlapping_contracts, 'status', s.status,
    'created_at', s.created_at,
    'active_contracts_count', (
      select count(*) from public.rental_contracts rc
      where rc.space_id = s.id and rc.status in ('active', 'terminated')
        and v_today between rc.start_date and public._rental_contract_occupancy_end(rc)
    ),
    'current_contract', (
      select jsonb_build_object('id', rc.id, 'contract_number', rc.contract_number,
        'customer_name', c.full_name, 'end_date', public._rental_contract_occupancy_end(rc))
      from public.rental_contracts rc
      join public.customers c on c.id = rc.customer_id
      where rc.space_id = s.id and rc.status in ('active', 'terminated')
        and v_today between rc.start_date and public._rental_contract_occupancy_end(rc)
      order by rc.start_date desc
      limit 1
    ),
    'next_contract_start', (
      select min(rc.start_date) from public.rental_contracts rc
      where rc.space_id = s.id and rc.status = 'active' and rc.start_date > v_today
    )
  ) order by s.status, s.name), '[]'::jsonb)
  into v_rows
  from public.rental_spaces s
  join public.branches b on b.id = s.branch_id
  where s.club_id = p_club_id
    and (p_include_archived or s.status <> 'archived')
    and public.user_has_branch_access(p_club_id, s.branch_id);

  return v_rows;
end;
$$;

-- ============================================================
-- 7. Contracts RPCs
-- ============================================================
create or replace function public.create_rental_contract(
  p_club_id uuid,
  p_space_id uuid,
  p_customer_id uuid,
  p_start_date date,
  p_rent_cycle text,
  p_cycles_count integer,
  p_cycle_amount numeric,
  p_custom_cycle_value integer default null,
  p_custom_cycle_unit text default null,
  p_security_deposit numeric default 0,
  p_notes text default null,
  p_issue_first_invoice boolean default true,
  p_idempotency_key uuid default null
) returns table(contract_id uuid, contract_number text, invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
#variable_conflict use_column
declare
  v_space public.rental_spaces;
  v_existing public.rental_contracts;
  v_end date;
  v_number text;
  v_seq integer;
  v_contract_id uuid;
  v_invoice_id uuid;
  v_first_ids uuid[];
  v_i integer;
  v_ps date;
  v_pe date;
  v_inst_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.contract.create', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if not public._rentals_module_active(p_club_id) then
    raise exception 'the rentals module is not active for this club';
  end if;
  if not public.club_write_allowed(p_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if p_idempotency_key is not null then
    select * into v_existing from public.rental_contracts
    where club_id = p_club_id and idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      return query
        select v_existing.id, v_existing.contract_number,
          (select ri.invoice_id from public.rental_installments ri
           where ri.contract_id = v_existing.id and ri.invoice_id is not null
           order by ri.sequence limit 1);
      return;
    end if;
  end if;

  if p_rent_cycle not in ('daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom') then
    raise exception 'invalid rent cycle';
  end if;
  if p_rent_cycle = 'custom' and (p_custom_cycle_value is null or p_custom_cycle_value < 1
       or p_custom_cycle_unit not in ('day', 'week', 'month')) then
    raise exception 'a custom rent cycle requires a period length and unit';
  end if;
  if p_cycles_count is null or p_cycles_count < 1 or p_cycles_count > 1000 then
    raise exception 'number of periods must be between 1 and 1000';
  end if;
  if p_cycle_amount is null or p_cycle_amount < 0 then
    raise exception 'rent amount must not be negative';
  end if;
  if coalesce(p_security_deposit, 0) < 0 then
    raise exception 'security deposit must not be negative';
  end if;
  if p_start_date is null then
    raise exception 'start date is required';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found in this club';
  end if;

  select * into v_space from public.rental_spaces where id = p_space_id and club_id = p_club_id for update;
  if v_space.id is null then
    raise exception 'rental space not found in this club';
  end if;
  if v_space.status <> 'active' then
    raise exception 'this rental space is not available for new contracts';
  end if;
  if not public.user_has_branch_access(p_club_id, v_space.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  v_end := public._rental_period_start(p_start_date, p_rent_cycle, p_cycles_count,
                                       case when p_rent_cycle = 'custom' then p_custom_cycle_value end,
                                       case when p_rent_cycle = 'custom' then p_custom_cycle_unit end) - 1;

  if not v_space.allow_overlapping_contracts and exists (
    select 1 from public.rental_contracts rc
    where rc.space_id = p_space_id and rc.status in ('active', 'terminated')
      and daterange(rc.start_date, public._rental_contract_occupancy_end(rc), '[]') && daterange(p_start_date, v_end, '[]')
  ) then
    raise exception 'this space is already rented for overlapping dates';
  end if;

  insert into public.rental_contract_counters (club_id, last_value) values (p_club_id, 1)
  on conflict (club_id) do update set last_value = public.rental_contract_counters.last_value + 1
  returning last_value into v_seq;
  v_number := 'RC-' || lpad(v_seq::text, 5, '0');

  insert into public.rental_contracts (
    club_id, branch_id, space_id, customer_id, contract_number, rent_cycle,
    custom_cycle_value, custom_cycle_unit, cycles_count, cycle_amount, total_rent,
    security_deposit, start_date, end_date, status, notes, idempotency_key, created_by
  ) values (
    p_club_id, v_space.branch_id, p_space_id, p_customer_id, v_number, p_rent_cycle,
    case when p_rent_cycle = 'custom' then p_custom_cycle_value end,
    case when p_rent_cycle = 'custom' then p_custom_cycle_unit end,
    p_cycles_count, round(p_cycle_amount, 2), round(p_cycle_amount, 2) * p_cycles_count,
    round(coalesce(p_security_deposit, 0), 2), p_start_date, v_end, 'active',
    nullif(trim(coalesce(p_notes, '')), ''), p_idempotency_key, auth.uid()
  ) returning id into v_contract_id;

  if coalesce(p_security_deposit, 0) > 0 then
    insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
    values (p_club_id, v_space.branch_id, v_contract_id, 'deposit', 0, p_start_date, v_end, p_start_date, round(p_security_deposit, 2))
    returning id into v_inst_id;
    v_first_ids := array[v_inst_id];
  end if;

  for v_i in 0 .. p_cycles_count - 1 loop
    v_ps := public._rental_period_start(p_start_date, p_rent_cycle, v_i,
                                        case when p_rent_cycle = 'custom' then p_custom_cycle_value end,
                                        case when p_rent_cycle = 'custom' then p_custom_cycle_unit end);
    v_pe := public._rental_period_start(p_start_date, p_rent_cycle, v_i + 1,
                                        case when p_rent_cycle = 'custom' then p_custom_cycle_value end,
                                        case when p_rent_cycle = 'custom' then p_custom_cycle_unit end) - 1;
    insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
    values (p_club_id, v_space.branch_id, v_contract_id, 'rent', v_i + 1, v_ps, v_pe, v_ps, round(p_cycle_amount, 2))
    returning id into v_inst_id;
    if v_i = 0 then
      v_first_ids := coalesce(v_first_ids, array[]::uuid[]) || v_inst_id;
    end if;
  end loop;

  perform public.write_audit_log(
    p_club_id, 'rental.contract.created', 'rental_contract', v_contract_id, null,
    jsonb_build_object('contract_number', v_number, 'space_id', p_space_id, 'customer_id', p_customer_id,
      'start_date', p_start_date, 'end_date', v_end, 'rent_cycle', p_rent_cycle,
      'custom_cycle_value', p_custom_cycle_value, 'custom_cycle_unit', p_custom_cycle_unit,
      'cycles_count', p_cycles_count, 'cycle_amount', p_cycle_amount, 'security_deposit', coalesce(p_security_deposit, 0)),
    null
  );

  if coalesce(p_issue_first_invoice, true) then
    v_invoice_id := public._rental_issue_invoice_internal(v_contract_id, v_first_ids, 0);
  end if;

  return query select v_contract_id, v_number, v_invoice_id;
end;
$$;

create or replace function public.issue_rental_invoice(
  p_contract_id uuid, p_installment_ids uuid[], p_discount numeric default 0
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contract public.rental_contracts;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_contract from public.rental_contracts
  where id = p_contract_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.create', club_id);
  if v_contract.id is null then
    raise exception 'rental contract not found or you do not have permission to invoice it';
  end if;
  if not public.user_has_branch_access(v_contract.club_id, v_contract.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if not public.club_write_allowed(v_contract.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;
  if p_installment_ids is null or array_length(p_installment_ids, 1) is null then
    raise exception 'select at least one installment';
  end if;

  return public._rental_issue_invoice_internal(p_contract_id, p_installment_ids, p_discount);
end;
$$;

-- Bulk: one invoice per due, not-yet-invoiced installment of every active
-- contract, up to p_through_date (default: club today).
create or replace function public.issue_due_rental_invoices(p_club_id uuid, p_through_date date default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_through date;
  v_count integer := 0;
  v_inst record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.contract.create', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if not public.club_write_allowed(p_club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;
  v_through := coalesce(p_through_date, public._rental_club_today(p_club_id));
  if v_through > public._rental_club_today(p_club_id) + 366 then
    raise exception 'through date is too far in the future';
  end if;

  for v_inst in
    select ri.id, ri.contract_id
    from public.rental_installments ri
    join public.rental_contracts rc on rc.id = ri.contract_id
    where ri.club_id = p_club_id and ri.status = 'scheduled' and ri.due_date <= v_through
      and rc.status in ('active', 'terminated')
      and public.user_has_branch_access(p_club_id, rc.branch_id)
    order by ri.due_date, ri.sequence
  loop
    perform public._rental_issue_invoice_internal(v_inst.contract_id, array[v_inst.id], 0);
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

create or replace function public.terminate_rental_contract(p_contract_id uuid, p_termination_date date, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contract public.rental_contracts;
  v_cancelled integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required';
  end if;
  select * into v_contract from public.rental_contracts
  where id = p_contract_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.manage', club_id)
  for update;
  if v_contract.id is null then
    raise exception 'rental contract not found or you do not have permission to manage it';
  end if;
  if not public.user_has_branch_access(v_contract.club_id, v_contract.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if v_contract.status <> 'active' then
    raise exception 'only an active contract can be terminated';
  end if;
  if p_termination_date is null or p_termination_date < v_contract.start_date or p_termination_date > v_contract.end_date then
    raise exception 'termination date must fall within the contract period';
  end if;

  update public.rental_contracts set
    status = 'terminated', termination_date = p_termination_date, terminated_at = now(),
    terminated_by = auth.uid(), termination_reason = trim(p_reason), updated_at = now()
  where id = p_contract_id;

  -- Future, not-yet-invoiced rent is dropped. Already-issued invoices are
  -- left untouched (they may be partly paid); staff void/refund them
  -- explicitly through Finance if needed.
  update public.rental_installments set status = 'cancelled', updated_at = now()
  where contract_id = p_contract_id and kind = 'rent' and status = 'scheduled'
    and period_start > p_termination_date;
  get diagnostics v_cancelled = row_count;

  perform public.write_audit_log(v_contract.club_id, 'rental.contract.terminated', 'rental_contract', p_contract_id,
    jsonb_build_object('status', v_contract.status, 'end_date', v_contract.end_date),
    jsonb_build_object('status', 'terminated', 'termination_date', p_termination_date, 'cancelled_installments', v_cancelled),
    trim(p_reason));
end;
$$;

create or replace function public.cancel_rental_contract(p_contract_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contract public.rental_contracts;
  v_invoice record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required';
  end if;
  select * into v_contract from public.rental_contracts
  where id = p_contract_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.manage', club_id)
  for update;
  if v_contract.id is null then
    raise exception 'rental contract not found or you do not have permission to manage it';
  end if;
  if not public.user_has_branch_access(v_contract.club_id, v_contract.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if v_contract.status = 'cancelled' then
    raise exception 'this contract is already cancelled';
  end if;
  if exists (
    select 1 from public.rental_installments ri
    join public.payment_allocations pa on pa.invoice_id = ri.invoice_id
    where ri.contract_id = p_contract_id
  ) then
    raise exception 'cannot cancel a contract with recorded payments -- refund the payment(s) first, or terminate the contract instead';
  end if;

  for v_invoice in
    select distinct i.id from public.rental_installments ri
    join public.invoices i on i.id = ri.invoice_id
    where ri.contract_id = p_contract_id and i.status = 'issued'
  loop
    update public.invoices set status = 'void' where id = v_invoice.id and status = 'issued';
    perform public.write_audit_log(v_contract.club_id, 'void_invoice', 'invoices', v_invoice.id, null,
      jsonb_build_object('status', 'void', 'rental_contract_id', p_contract_id), trim(p_reason));
  end loop;

  update public.rental_installments set status = 'cancelled', updated_at = now()
  where contract_id = p_contract_id and status <> 'cancelled';

  update public.rental_contracts set
    status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), cancel_reason = trim(p_reason), updated_at = now()
  where id = p_contract_id;

  perform public.write_audit_log(v_contract.club_id, 'rental.contract.cancelled', 'rental_contract', p_contract_id,
    jsonb_build_object('status', v_contract.status), jsonb_build_object('status', 'cancelled'), trim(p_reason));
end;
$$;

-- Per-installment payment state, derived (never stored).
-- An invoice may cover several installments (e.g. "pay 3 months now").
-- Its discount is taken off the LAST installments first (net_amount),
-- then the cash actually received on it (total - outstanding, i.e. net
-- of refunds) is attributed to its installments in schedule order
-- (deposit first). Sum of per-installment outstanding therefore always
-- equals the invoice's own outstanding from get_invoice_payment_summary.
create or replace function public._rental_installment_rows(p_contract_ids uuid[])
returns table(
  installment_id uuid, contract_id uuid, kind text, sequence integer, period_start date, period_end date,
  due_date date, amount numeric, net_amount numeric, invoice_id uuid, invoice_number text, invoice_status text,
  status text, paid numeric
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  with inst as (
    select ri.*, i.invoice_number as inv_number, i.status as inv_status, coalesce(i.discount, 0) as inv_discount,
      (ri.status = 'invoiced' and i.status = 'issued') as is_live
    from public.rental_installments ri
    left join public.invoices i on i.id = ri.invoice_id
    where ri.contract_id = any(p_contract_ids)
  ),
  summ as (
    select * from public.get_invoice_payment_summary(
      (select coalesce(array_agg(distinct inst.invoice_id) filter (where inst.is_live), array[]::uuid[]) from inst)
    )
  ),
  netted as (
    select inst.*,
      case when inst.is_live then
        inst.amount - least(inst.amount, greatest(inst.inv_discount - coalesce(sum(inst.amount) over (
          partition by inst.invoice_id order by inst.sequence rows between 1 following and unbounded following), 0), 0))
      else inst.amount end as net_amt
    from inst
  ),
  ordered as (
    select netted.*,
      coalesce(sum(netted.net_amt) over (
        partition by netted.invoice_id order by netted.sequence rows between unbounded preceding and 1 preceding), 0) as net_before
    from netted
  )
  select o.id, o.contract_id, o.kind, o.sequence, o.period_start, o.period_end,
    o.due_date, o.amount, o.net_amt, o.invoice_id, o.inv_number, o.inv_status, o.status,
    case when o.is_live and s.invoice_id is not null then
      least(o.net_amt, greatest((s.total - s.outstanding) - o.net_before, 0))
    else 0 end
  from ordered o
  left join summ s on s.invoice_id = o.invoice_id
$$;

revoke all on function public._rental_installment_rows(uuid[]) from public, anon, authenticated;
grant execute on function public._rental_installment_rows(uuid[]) to service_role;

create or replace function public._rental_installment_state(p_contract_ids uuid[], p_today date)
returns table(
  installment_id uuid, contract_id uuid, kind text, sequence integer, period_start date, period_end date,
  due_date date, amount numeric, invoice_id uuid, invoice_number text, invoice_status text,
  status text, paid numeric, outstanding numeric, payment_state text
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select r.installment_id, r.contract_id, r.kind, r.sequence, r.period_start, r.period_end,
    r.due_date, r.amount, r.invoice_id, r.invoice_number, r.invoice_status, r.status,
    r.paid,
    case when r.status = 'invoiced' and r.invoice_status = 'issued' then greatest(r.net_amount - r.paid, 0) else 0 end,
    case
      when r.status = 'cancelled' then 'cancelled'
      when r.status = 'scheduled' or r.invoice_status = 'void' then
        case when r.due_date <= p_today then 'due_not_invoiced' else 'scheduled' end
      when r.paid >= r.net_amount then 'paid'
      when r.due_date < p_today then 'overdue'
      when r.paid > 0 then 'partial'
      else 'unpaid'
    end
  from public._rental_installment_rows(p_contract_ids) r
$$;

revoke all on function public._rental_installment_state(uuid[], date) from public, anon, authenticated;
grant execute on function public._rental_installment_state(uuid[], date) to service_role;

create or replace function public.list_rental_contracts(
  p_club_id uuid,
  p_status text default null,
  p_space_id uuid default null,
  p_customer_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today date;
  v_ids uuid[];
  v_rows jsonb;
begin
  if not (p_club_id in (select public.user_club_ids())
          and (public.has_permission('rental.view', p_club_id)
               or (p_customer_id is not null and public.has_permission('customer.view', p_club_id)))) then
    raise exception 'not authorized';
  end if;
  v_today := public._rental_club_today(p_club_id);

  select coalesce(array_agg(rc.id), array[]::uuid[]) into v_ids
  from public.rental_contracts rc
  where rc.club_id = p_club_id
    and public.user_has_branch_access(p_club_id, rc.branch_id)
    and (p_space_id is null or rc.space_id = p_space_id)
    and (p_customer_id is null or rc.customer_id = p_customer_id)
    and (p_status is null
         or (p_status = 'active' and rc.status = 'active' and rc.end_date >= v_today)
         or (p_status = 'expired' and rc.status = 'active' and rc.end_date < v_today)
         or (p_status in ('terminated', 'cancelled') and rc.status = p_status));

  with st as (
    select * from public._rental_installment_state(v_ids, v_today)
  ),
  agg as (
    select st.contract_id,
      coalesce(sum(st.amount) filter (where st.status = 'invoiced' and st.invoice_status = 'issued'), 0) as invoiced,
      coalesce(sum(st.paid), 0) as paid,
      coalesce(sum(st.outstanding), 0) as outstanding,
      coalesce(sum(st.outstanding) filter (where st.payment_state = 'overdue'), 0)
        + coalesce(sum(st.amount) filter (where st.payment_state = 'due_not_invoiced'), 0) as overdue_amount,
      count(*) filter (where st.payment_state in ('overdue', 'due_not_invoiced')) as overdue_count,
      min(st.due_date) filter (where st.payment_state in ('scheduled', 'unpaid', 'partial', 'due_not_invoiced', 'overdue')) as next_due_date
    from st group by st.contract_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rc.id, 'contract_number', rc.contract_number,
    'space_id', rc.space_id, 'space_name', s.name, 'space_type', s.space_type, 'custom_type_label', s.custom_type_label,
    'branch_id', rc.branch_id, 'branch_name', b.name,
    'customer_id', rc.customer_id, 'customer_name', c.full_name, 'customer_mobile', c.mobile_display,
    'rent_cycle', rc.rent_cycle, 'custom_cycle_value', rc.custom_cycle_value, 'custom_cycle_unit', rc.custom_cycle_unit,
    'cycles_count', rc.cycles_count, 'cycle_amount', rc.cycle_amount, 'total_rent', rc.total_rent,
    'security_deposit', rc.security_deposit,
    'start_date', rc.start_date, 'end_date', rc.end_date, 'termination_date', rc.termination_date,
    'status', rc.status,
    'display_status', case
      when rc.status = 'active' and rc.end_date < v_today then 'expired'
      when rc.status = 'active' and rc.start_date > v_today then 'upcoming'
      else rc.status end,
    'invoiced', coalesce(a.invoiced, 0), 'paid', coalesce(a.paid, 0),
    'outstanding', coalesce(a.outstanding, 0), 'overdue_amount', coalesce(a.overdue_amount, 0),
    'overdue_count', coalesce(a.overdue_count, 0), 'next_due_date', a.next_due_date,
    'created_at', rc.created_at
  ) order by rc.created_at desc), '[]'::jsonb)
  into v_rows
  from public.rental_contracts rc
  join public.rental_spaces s on s.id = rc.space_id
  join public.branches b on b.id = rc.branch_id
  join public.customers c on c.id = rc.customer_id
  left join agg a on a.contract_id = rc.id
  where rc.id = any(v_ids);

  return v_rows;
end;
$$;

create or replace function public.get_rental_contract_detail(p_contract_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_contract public.rental_contracts;
  v_today date;
  v_installments jsonb;
begin
  select * into v_contract from public.rental_contracts
  where id = p_contract_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', club_id);
  if v_contract.id is null or not public.user_has_branch_access(v_contract.club_id, v_contract.branch_id) then
    raise exception 'rental contract not found';
  end if;
  v_today := public._rental_club_today(v_contract.club_id);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', st.installment_id, 'kind', st.kind, 'sequence', st.sequence,
    'period_start', st.period_start, 'period_end', st.period_end, 'due_date', st.due_date,
    'amount', st.amount, 'invoice_id', st.invoice_id, 'invoice_number', st.invoice_number,
    'invoice_status', st.invoice_status, 'status', st.status, 'paid', st.paid,
    'outstanding', st.outstanding, 'payment_state', st.payment_state
  ) order by st.sequence), '[]'::jsonb)
  into v_installments
  from public._rental_installment_state(array[p_contract_id], v_today) st;

  return jsonb_build_object(
    'contract', to_jsonb(v_contract) - 'idempotency_key',
    'display_status', case
      when v_contract.status = 'active' and v_contract.end_date < v_today then 'expired'
      when v_contract.status = 'active' and v_contract.start_date > v_today then 'upcoming'
      else v_contract.status end,
    'space', (select jsonb_build_object('id', s.id, 'name', s.name, 'space_type', s.space_type,
                'custom_type_label', s.custom_type_label, 'branch_name', b.name)
              from public.rental_spaces s join public.branches b on b.id = s.branch_id where s.id = v_contract.space_id),
    'customer', (select jsonb_build_object('id', c.id, 'full_name', c.full_name, 'mobile_display', c.mobile_display)
                 from public.customers c where c.id = v_contract.customer_id),
    'installments', v_installments,
    'totals', (
      select jsonb_build_object(
        'scheduled_total', coalesce(sum(st.amount) filter (where st.status <> 'cancelled'), 0),
        'invoiced', coalesce(sum(st.amount) filter (where st.status = 'invoiced' and st.invoice_status = 'issued'), 0),
        'paid', coalesce(sum(st.paid), 0),
        'outstanding', coalesce(sum(st.outstanding), 0),
        'not_invoiced', coalesce(sum(st.amount) filter (where st.payment_state in ('scheduled', 'due_not_invoiced')), 0),
        'overdue', coalesce(sum(st.outstanding) filter (where st.payment_state = 'overdue'), 0)
          + coalesce(sum(st.amount) filter (where st.payment_state = 'due_not_invoiced'), 0)
      )
      from public._rental_installment_state(array[p_contract_id], v_today) st
    )
  );
end;
$$;

-- ============================================================
-- 8. Reports
-- ============================================================
create or replace function public.get_rental_report(
  p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible uuid[];
  v_today date;
  v_ids uuid[];
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids())
          and (public.has_permission('report.view', p_club_id) or public.has_permission('rental.view', p_club_id))) then
    raise exception 'not authorized';
  end if;
  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;
  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;
  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);
  v_today := public._rental_club_today(p_club_id);

  select coalesce(array_agg(rc.id), array[]::uuid[]) into v_ids
  from public.rental_contracts rc
  where rc.club_id = p_club_id and rc.status <> 'cancelled'
    and (case when p_branch_id is not null then rc.branch_id = p_branch_id
         else v_accessible is null or rc.branch_id = any(v_accessible) end);

  with spaces as (
    select s.* from public.rental_spaces s
    where s.club_id = p_club_id and s.status <> 'archived'
      and (case when p_branch_id is not null then s.branch_id = p_branch_id
           else v_accessible is null or s.branch_id = any(v_accessible) end)
  ),
  contracts as (
    select rc.* from public.rental_contracts rc where rc.id = any(v_ids)
  ),
  st as (
    select * from public._rental_installment_state(v_ids, v_today)
  ),
  collected as (
    -- Money actually received in range against rental invoice lines.
    -- An invoice can hold several rental lines; allocation is split
    -- pro-rata by line_total so by-space totals add up exactly.
    select ri.contract_id, sum(pa.amount * ii.line_total / nullif(inv.subtotal, 0)) as amount
    from public.payments p
    join public.payment_allocations pa on pa.payment_id = p.id
    join public.invoices inv on inv.id = pa.invoice_id
    join public.invoice_items ii on ii.invoice_id = inv.id and ii.reference_type = 'rental'
    join public.rental_installments ri on ri.id = ii.reference_id
    where p.club_id = p_club_id and p.status = 'completed'
      and p.received_at >= v_range_start and p.received_at < v_range_end
      and ri.contract_id = any(v_ids)
    group by ri.contract_id
  )
  select jsonb_build_object(
    'spaces_total', (select count(*) from spaces where status = 'active'),
    'spaces_occupied_today', (
      select count(distinct c.space_id) from contracts c join spaces s on s.id = c.space_id
      where c.status in ('active', 'terminated') and s.status = 'active'
        and v_today between c.start_date and public._rental_contract_occupancy_end(c)
    ),
    'active_contracts', (
      select count(*) from contracts c where c.status = 'active' and c.end_date >= v_today
    ),
    'new_contracts_in_range', (
      select count(*) from contracts c
      where c.created_at >= v_range_start and c.created_at < v_range_end
    ),
    'contract_value_in_range', (
      select coalesce(sum(c.total_rent), 0) from contracts c
      where c.created_at >= v_range_start and c.created_at < v_range_end
    ),
    'collected_in_range', (select coalesce(round(sum(amount), 2), 0) from collected),
    'due_in_range', (
      select coalesce(sum(st.amount), 0) from st
      where st.status <> 'cancelled' and st.due_date between p_start_date and p_end_date
    ),
    'outstanding_total', (select coalesce(sum(st.outstanding), 0) from st),
    'overdue_total', (
      select coalesce(sum(st.outstanding) filter (where st.payment_state = 'overdue'), 0)
        + coalesce(sum(st.amount) filter (where st.payment_state = 'due_not_invoiced'), 0) from st
    ),
    'overdue_count', (select count(*) from st where st.payment_state in ('overdue', 'due_not_invoiced')),
    'not_invoiced_due_count', (select count(*) from st where st.payment_state = 'due_not_invoiced'),
    'deposits_held', (select coalesce(sum(st.paid), 0) from st where st.kind = 'deposit'),
    'by_space', coalesce((
      select jsonb_agg(jsonb_build_object(
        'space_id', s.id, 'space_name', s.name, 'space_type', s.space_type, 'custom_type_label', s.custom_type_label,
        'occupied_today', exists (
          select 1 from contracts c where c.space_id = s.id and c.status in ('active', 'terminated')
            and v_today between c.start_date and public._rental_contract_occupancy_end(c)),
        'collected', coalesce((select round(sum(col.amount), 2) from collected col join contracts c on c.id = col.contract_id where c.space_id = s.id), 0),
        'outstanding', coalesce((select sum(st.outstanding) from st join contracts c on c.id = st.contract_id where c.space_id = s.id), 0)
      ) order by s.name)
      from spaces s
    ), '[]'::jsonb),
    'by_cycle', coalesce((
      select jsonb_agg(jsonb_build_object('rent_cycle', x.rent_cycle, 'contracts', x.cnt, 'value', x.val) order by x.cnt desc)
      from (select c.rent_cycle, count(*) as cnt, sum(c.total_rent) as val from contracts c
            where c.status = 'active' and c.end_date >= v_today group by c.rent_cycle) x
    ), '[]'::jsonb),
    'overdue_rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'installment_id', st.installment_id, 'contract_id', st.contract_id, 'contract_number', c.contract_number,
        'customer_name', cu.full_name, 'space_name', s.name, 'kind', st.kind, 'sequence', st.sequence,
        'due_date', st.due_date, 'amount', st.amount, 'outstanding',
        case when st.payment_state = 'due_not_invoiced' then st.amount else st.outstanding end,
        'payment_state', st.payment_state, 'invoice_id', st.invoice_id
      ) order by st.due_date)
      from st
      join contracts c on c.id = st.contract_id
      join public.rental_spaces s on s.id = c.space_id
      join public.customers cu on cu.id = c.customer_id
      where st.payment_state in ('overdue', 'due_not_invoiced')
    ), '[]'::jsonb),
    'expiring_soon', coalesce((
      select jsonb_agg(jsonb_build_object(
        'contract_id', c.id, 'contract_number', c.contract_number, 'customer_name', cu.full_name,
        'space_name', s.name, 'end_date', c.end_date
      ) order by c.end_date)
      from contracts c
      join public.rental_spaces s on s.id = c.space_id
      join public.customers cu on cu.id = c.customer_id
      where c.status = 'active' and c.end_date between v_today and v_today + 30
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- Revenue split by source (bookings / academy / memberships / shop /
-- rentals / other) for any date range -- the cross-module view that
-- did not exist before. Same auth/branch/timezone contract as
-- get_revenue_report().
create or replace function public.get_revenue_by_source_report(
  p_club_id uuid, p_start_date date, p_end_date date, p_branch_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_range_start timestamptz;
  v_range_end timestamptz;
  v_accessible uuid[];
  v_result jsonb;
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
  if p_branch_id is not null and not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'not authorized';
  end if;
  v_accessible := public.caller_accessible_branch_ids(p_club_id);
  if p_branch_id is not null and v_accessible is not null and not (p_branch_id = any(v_accessible)) then
    raise exception 'not authorized';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_start_date);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_end_date);

  with classified_payments as (
    select p.id as payment_id, p.amount,
      coalesce((
        select case ii.reference_type
          when 'booking' then 'booking'
          when 'subscription' then 'academy'
          when 'registration_fee' then 'academy'
          when 'club_membership' then 'club_membership'
          when 'shop_sale_item' then 'shop'
          when 'rental' then 'rental'
          else 'other' end
        from public.payment_allocations pa
        join public.invoice_items ii on ii.invoice_id = pa.invoice_id
        where pa.payment_id = p.id
        order by ii.reference_type = 'other', ii.id
        limit 1
      ), 'other') as source
    from public.payments p
    where p.club_id = p_club_id and p.status = 'completed'
      and p.received_at >= v_range_start and p.received_at < v_range_end
      and (case when p_branch_id is not null then p.branch_id = p_branch_id
           else v_accessible is null or p.branch_id = any(v_accessible) end)
  ),
  classified_refunds as (
    select r.amount,
      coalesce((
        select case ii.reference_type
          when 'booking' then 'booking'
          when 'subscription' then 'academy'
          when 'registration_fee' then 'academy'
          when 'club_membership' then 'club_membership'
          when 'shop_sale_item' then 'shop'
          when 'rental' then 'rental'
          else 'other' end
        from public.payment_allocations pa
        join public.invoice_items ii on ii.invoice_id = pa.invoice_id
        where pa.payment_id = p.id
        order by ii.reference_type = 'other', ii.id
        limit 1
      ), 'other') as source
    from public.refunds r
    join public.payments p on p.id = r.payment_id
    where p.club_id = p_club_id and r.status = 'completed'
      and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
      and (case when p_branch_id is not null then p.branch_id = p_branch_id
           else v_accessible is null or p.branch_id = any(v_accessible) end)
  ),
  sources as (
    select source from classified_payments union select source from classified_refunds
  )
  select jsonb_build_object(
    'total_collected', (select coalesce(sum(amount), 0) from classified_payments),
    'total_refunded', (select coalesce(sum(amount), 0) from classified_refunds),
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object(
        'source', s.source,
        'collected', coalesce((select sum(cp.amount) from classified_payments cp where cp.source = s.source), 0),
        'payment_count', (select count(*) from classified_payments cp where cp.source = s.source),
        'refunded', coalesce((select sum(cr.amount) from classified_refunds cr where cr.source = s.source), 0),
        'net', coalesce((select sum(cp.amount) from classified_payments cp where cp.source = s.source), 0)
             - coalesce((select sum(cr.amount) from classified_refunds cr where cr.source = s.source), 0)
      ) order by coalesce((select sum(cp.amount) from classified_payments cp where cp.source = s.source), 0) desc)
      from sources s
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

-- Small "needs attention today" summary for the dashboard.
create or replace function public.get_rental_attention_summary(p_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today date;
  v_ids uuid[];
  v_result jsonb;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if not public._rentals_module_active(p_club_id) then
    return jsonb_build_object('module_active', false);
  end if;
  v_today := public._rental_club_today(p_club_id);

  select coalesce(array_agg(rc.id), array[]::uuid[]) into v_ids
  from public.rental_contracts rc
  where rc.club_id = p_club_id and rc.status in ('active', 'terminated')
    and public.user_has_branch_access(p_club_id, rc.branch_id);

  with st as (select * from public._rental_installment_state(v_ids, v_today))
  select jsonb_build_object(
    'module_active', true,
    'overdue_count', (select count(*) from st where st.payment_state in ('overdue', 'due_not_invoiced')),
    'overdue_amount', (select coalesce(sum(case when st.payment_state = 'due_not_invoiced' then st.amount else st.outstanding end), 0)
                       from st where st.payment_state in ('overdue', 'due_not_invoiced')),
    'not_invoiced_due_count', (select count(*) from st where st.payment_state = 'due_not_invoiced'),
    'due_next_7_days_count', (select count(*) from st where st.payment_state in ('scheduled', 'unpaid', 'partial')
                                and st.due_date between v_today and v_today + 7),
    'expiring_30_days_count', (select count(*) from public.rental_contracts rc
                               where rc.id = any(v_ids) and rc.status = 'active'
                                 and rc.end_date between v_today and v_today + 30)
  ) into v_result;

  return v_result;
end;
$$;

-- ============================================================
-- 9. Grants for public RPCs
-- ============================================================
revoke all on function public.upsert_rental_space(uuid, uuid, uuid, text, text, text, text, numeric, integer, text, numeric, boolean) from public, anon;
revoke all on function public.set_rental_space_status(uuid, text) from public, anon;
revoke all on function public.list_rental_spaces(uuid, boolean) from public, anon;
revoke all on function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid) from public, anon;
revoke all on function public.issue_rental_invoice(uuid, uuid[], numeric) from public, anon;
revoke all on function public.issue_due_rental_invoices(uuid, date) from public, anon;
revoke all on function public.terminate_rental_contract(uuid, date, text) from public, anon;
revoke all on function public.cancel_rental_contract(uuid, text) from public, anon;
revoke all on function public.list_rental_contracts(uuid, text, uuid, uuid) from public, anon;
revoke all on function public.get_rental_contract_detail(uuid) from public, anon;
revoke all on function public.get_rental_report(uuid, date, date, uuid) from public, anon;
revoke all on function public.get_revenue_by_source_report(uuid, date, date, uuid) from public, anon;
revoke all on function public.get_rental_attention_summary(uuid) from public, anon;

grant execute on function public.upsert_rental_space(uuid, uuid, uuid, text, text, text, text, numeric, integer, text, numeric, boolean) to authenticated, service_role;
grant execute on function public.set_rental_space_status(uuid, text) to authenticated, service_role;
grant execute on function public.list_rental_spaces(uuid, boolean) to authenticated, service_role;
grant execute on function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid) to authenticated, service_role;
grant execute on function public.issue_rental_invoice(uuid, uuid[], numeric) to authenticated, service_role;
grant execute on function public.issue_due_rental_invoices(uuid, date) to authenticated, service_role;
grant execute on function public.terminate_rental_contract(uuid, date, text) to authenticated, service_role;
grant execute on function public.cancel_rental_contract(uuid, text) to authenticated, service_role;
grant execute on function public.list_rental_contracts(uuid, text, uuid, uuid) to authenticated, service_role;
grant execute on function public.get_rental_contract_detail(uuid) to authenticated, service_role;
grant execute on function public.get_rental_report(uuid, date, date, uuid) to authenticated, service_role;
grant execute on function public.get_revenue_by_source_report(uuid, date, date, uuid) to authenticated, service_role;
grant execute on function public.get_rental_attention_summary(uuid) to authenticated, service_role;

-- ============================================================
-- 10. Wire rentals into the shared money chokepoints
-- ============================================================
-- record_payment(): resolve the rental contract's branch so cash custody
-- / cash-shift and government-receipt policy behave exactly as for
-- bookings, academy and memberships.
select public._rentals_migration_patch_function(
  'public.record_payment(uuid, numeric, text, text, uuid, uuid)'::regprocedure,
  $x$    from public.club_membership_subscriptions cms
    where cms.invoice_id = p_invoice_id
    limit 1;
  end if;
$x$,
  $x$    from public.club_membership_subscriptions cms
    where cms.invoice_id = p_invoice_id
    limit 1;
  end if;

  if v_booking_branch_id is null then
    select ri.branch_id into v_booking_branch_id
    from public.rental_installments ri
    where ri.invoice_id = p_invoice_id
    limit 1;
  end if;
$x$
);

select public._rentals_migration_patch_function(
  'public.record_payment_with_official_receipt(uuid, numeric, text, text, date, text, text, text, text, text, uuid)'::regprocedure,
  $x$    where s.invoice_id = p_invoice_id
    limit 1;
  end if;

  v_effective_policy := public.get_effective_government_policy($x$,
  $x$    where s.invoice_id = p_invoice_id
    limit 1;
  end if;

  if v_booking_branch_id is null then
    select ri.branch_id into v_booking_branch_id
    from public.rental_installments ri
    where ri.invoice_id = p_invoice_id
    limit 1;
  end if;

  v_effective_policy := public.get_effective_government_policy($x$
);

-- Customer 360 ledger: classify rental invoices.
select public._rentals_migration_patch_function(
  'public.get_customer_financial_account(uuid, uuid, integer, integer)'::regprocedure,
  $x$        when exists (select 1 from public.club_membership_subscriptions cms where cms.invoice_id = pi.id) then 'club_membership'
$x$,
  $x$        when exists (select 1 from public.club_membership_subscriptions cms where cms.invoice_id = pi.id) then 'club_membership'
        when exists (select 1 from public.invoice_items rii where rii.invoice_id = pi.id and rii.reference_type = 'rental') then 'rental'
$x$
);

drop function public._rentals_migration_patch_function(regprocedure, text, text);
