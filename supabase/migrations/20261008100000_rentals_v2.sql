-- RENTALS MODULE v2 (2026-10-08)
--
-- Builds on 20261007100000_rentals_module.sql:
--   1. Security deposits are a LIABILITY, not revenue: invoiced on their
--      own invoice with invoice_items.reference_type = 'rental_deposit',
--      reported separately, and settled (refunded in full or in part,
--      the kept part recorded) with settle_rental_deposit().
--   2. Per-club rental settings (rental_settings).
--   3. Daily automation (pg_cron, run_rental_daily_jobs): auto-issue due
--      rent invoices, add late fees after a grace period, and queue
--      WhatsApp due / overdue reminders (gated until the connector ships
--      the two new templates -- see _rental_whatsapp_templates_live()).
--   4. One-click renewal (renew_rental_contract) and an optional annual
--      price escalation (annual_increase_pct) applied to the schedule.
--   5. Hourly bookings (rent_cycle 'hourly' + start_time) for halls, with
--      time-aware overlap checks on the same day.
--   6. Editing an active contract (update_rental_contract): notes, rent
--      for future un-invoiced periods, extension by N periods.
--   7. Late fees (installment kind 'late_fee').
--   8. Customer portal: get_my_portal_rentals().
--   9. Space profitability: expenses.rental_space_id +
--      record_rental_space_expense(); report shows expenses and net.
--  10. Revenue report exposes deposits_collected; revenue-by-source and
--      Customer 360 classify deposit invoices.
--
-- No production rental data existed when this was written (verified),
-- so changed function signatures are dropped and recreated.

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
    return;
  end if;
  if position(p_old in v_def) = 0 then
    raise exception 'rentals migration: anchor not found in %', p_function;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;
revoke all on function public._rentals_migration_patch_function(regprocedure, text, text) from public, anon, authenticated;

-- ============================================================
-- 1. Schema
-- ============================================================
alter table public.rental_contracts drop constraint rental_contracts_rent_cycle_check;
alter table public.rental_contracts add constraint rental_contracts_rent_cycle_check
  check (rent_cycle in ('hourly', 'daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom'));
alter table public.rental_spaces drop constraint rental_spaces_default_rent_cycle_check;
alter table public.rental_spaces add constraint rental_spaces_default_rent_cycle_check
  check (default_rent_cycle is null or default_rent_cycle in ('hourly', 'daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom'));

alter table public.rental_contracts
  add column start_time time,
  add column end_time time,
  add column annual_increase_pct numeric(6, 2) not null default 0 check (annual_increase_pct >= 0 and annual_increase_pct <= 100),
  add column renewed_from_contract_id uuid references public.rental_contracts(id),
  add column deposit_refunded numeric(12, 2) not null default 0 check (deposit_refunded >= 0),
  add column deposit_kept numeric(12, 2) not null default 0 check (deposit_kept >= 0),
  add column deposit_settled_at timestamptz,
  add column deposit_settled_by uuid references auth.users(id),
  add column deposit_settlement_note text;
alter table public.rental_contracts add constraint rental_contracts_hourly_time
  check (rent_cycle <> 'hourly' or (start_time is not null and end_time is not null and start_date = end_date));
create index rental_contracts_renewed_from_idx on public.rental_contracts (renewed_from_contract_id);

alter table public.rental_installments drop constraint rental_installments_kind_check;
alter table public.rental_installments add constraint rental_installments_kind_check
  check (kind in ('rent', 'deposit', 'late_fee'));
alter table public.rental_installments add column source_installment_id uuid references public.rental_installments(id);

alter table public.invoice_items drop constraint invoice_items_reference_type_check;
alter table public.invoice_items add constraint invoice_items_reference_type_check
  check (reference_type = any (array['booking', 'subscription', 'registration_fee', 'club_membership', 'shop_sale_item', 'other', 'rental', 'rental_deposit']));

create table public.rental_settings (
  club_id uuid primary key references public.clubs(id),
  auto_issue_invoices boolean not null default true,
  issue_days_before integer not null default 0 check (issue_days_before between 0 and 60),
  late_fee_type text not null default 'none' check (late_fee_type in ('none', 'fixed', 'percent')),
  late_fee_value numeric(12, 2) not null default 0 check (late_fee_value >= 0),
  late_fee_grace_days integer not null default 5 check (late_fee_grace_days between 0 and 90),
  whatsapp_reminders_enabled boolean not null default true,
  reminder_days_before integer not null default 3 check (reminder_days_before between 0 and 30),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  constraint rental_settings_percent_range check (late_fee_type <> 'percent' or late_fee_value <= 100)
);
alter table public.rental_settings enable row level security;
alter table public.rental_settings force row level security;
create policy rental_settings_staff_select on public.rental_settings for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('rental.view', club_id));
revoke all on public.rental_settings from anon;
revoke insert, update, delete, truncate on public.rental_settings from authenticated;
grant select on public.rental_settings to authenticated;
grant all on public.rental_settings to service_role;

alter table public.expenses add column rental_space_id uuid references public.rental_spaces(id);
create index expenses_rental_space_idx on public.expenses (rental_space_id) where rental_space_id is not null;

-- ============================================================
-- 2. Helpers
-- ============================================================
-- Two bookings conflict when their date ranges overlap, except two
-- same-day timed (hourly) bookings whose time windows don't overlap.
create or replace function public._rental_ranges_conflict(
  a_start date, a_end date, a_st time, a_et time,
  b_start date, b_end date, b_st time, b_et time
) returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case
    when not (daterange(a_start, a_end, '[]') && daterange(b_start, b_end, '[]')) then false
    when a_st is not null and b_st is not null and a_start = a_end and b_start = b_end and a_start = b_start
      then a_st < b_et and b_st < a_et
    else true
  end
$$;

create or replace function public._rental_space_has_conflict(
  p_space_id uuid, p_start date, p_end date, p_st time, p_et time, p_exclude_contract uuid
) returns boolean
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select exists (
    select 1 from public.rental_contracts rc
    where rc.space_id = p_space_id and rc.status in ('active', 'terminated')
      and (p_exclude_contract is null or rc.id <> p_exclude_contract)
      and public._rental_ranges_conflict(rc.start_date, public._rental_contract_occupancy_end(rc), rc.start_time, rc.end_time,
                                         p_start, p_end, p_st, p_et)
  )
$$;

create or replace function public._rental_escalated_amount(
  p_base numeric, p_pct numeric, p_contract_start date, p_period_start date
) returns numeric
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select round(p_base * power(1 + coalesce(p_pct, 0) / 100.0,
               greatest(extract(year from age(p_period_start, p_contract_start)), 0)), 2)
$$;

-- Flipped to true by a follow-up migration once the WhatsApp connector
-- image that renders 'rental-payment-reminder' / 'rental-payment-overdue'
-- is deployed. Until then reminders are never queued, so no message can
-- fail on an unknown template.
create or replace function public._rental_whatsapp_templates_live()
returns boolean
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$ select false $$;

revoke all on function public._rental_ranges_conflict(date, date, time, time, date, date, time, time) from public, anon;
revoke all on function public._rental_space_has_conflict(uuid, date, date, time, time, uuid) from public, anon, authenticated;
revoke all on function public._rental_escalated_amount(numeric, numeric, date, date) from public, anon;
revoke all on function public._rental_whatsapp_templates_live() from public, anon, authenticated;
grant execute on function public._rental_ranges_conflict(date, date, time, time, date, date, time, time) to authenticated, service_role;
grant execute on function public._rental_space_has_conflict(uuid, date, date, time, time, uuid) to service_role;
grant execute on function public._rental_escalated_amount(numeric, numeric, date, date) to authenticated, service_role;
grant execute on function public._rental_whatsapp_templates_live() to service_role;

-- ============================================================
-- 3. Invoicing: deposit on its own invoice, late-fee lines
-- ============================================================
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
  v_has_deposit boolean;
  v_invoice_id uuid;
  v_invoice_number text;
  v_due date;
  v_inst record;
  v_description text;
  v_period text;
begin
  select * into v_contract from public.rental_contracts where id = p_contract_id for update;
  if v_contract.id is null then
    raise exception 'rental contract not found';
  end if;
  if v_contract.status = 'cancelled' then
    raise exception 'this rental contract is cancelled';
  end if;
  select * into v_space from public.rental_spaces where id = v_contract.space_id;

  select count(*), coalesce(sum(ri.amount), 0), min(ri.due_date), bool_or(ri.kind = 'deposit')
    into v_count, v_subtotal, v_due, v_has_deposit
  from public.rental_installments ri
  left join public.invoices i on i.id = ri.invoice_id
  where ri.id = any(p_installment_ids)
    and ri.contract_id = p_contract_id
    and (ri.status = 'scheduled' or (ri.status = 'invoiced' and i.status = 'void'));

  if v_count = 0 or v_count <> coalesce(array_length(p_installment_ids, 1), 0) then
    raise exception 'one or more installments are not available for invoicing';
  end if;
  if v_has_deposit and v_count > 1 then
    raise exception 'the security deposit is invoiced on its own invoice';
  end if;
  if coalesce(p_discount, 0) < 0 or coalesce(p_discount, 0) > v_subtotal then
    raise exception 'invalid discount';
  end if;
  if v_has_deposit and coalesce(p_discount, 0) > 0 then
    raise exception 'a discount cannot be applied to a security deposit';
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
    v_period := to_char(v_inst.period_start, 'YYYY-MM-DD')
      || case when v_inst.period_end <> v_inst.period_start then ' → ' || to_char(v_inst.period_end, 'YYYY-MM-DD') else '' end
      || case when v_contract.rent_cycle = 'hourly' and v_inst.kind = 'rent'
              then ' ' || to_char(v_contract.start_time, 'HH24:MI') || '-' || to_char(v_contract.end_time, 'HH24:MI') else '' end;
    if v_inst.kind = 'deposit' then
      v_description := 'تأمين إيجار (أمانة مستردة) ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || chr(8297);
    elsif v_inst.kind = 'late_fee' then
      v_description := 'غرامة تأخير إيجار ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || ' ' || v_period || chr(8297);
    else
      v_description := 'إيجار ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || ' #' || v_inst.sequence
        || ' ' || v_period || chr(8297);
    end if;

    insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
    values (v_invoice_id, v_description, case when v_inst.kind = 'deposit' then 'rental_deposit' else 'rental' end,
            v_inst.id, 1, v_inst.amount, v_inst.amount);

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

-- ============================================================
-- 4. Contract creation (shared by create + renew)
-- ============================================================
-- The v1 signature is retired by rename (not dropped) so this migration
-- applies identically through tooling that gates DROP statements.
alter function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid)
  rename to _retired_create_rental_contract_v1;
revoke all on function public._retired_create_rental_contract_v1(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid) from public, anon, authenticated;

create or replace function public._rental_create_contract_internal(
  p_club_id uuid,
  p_space_id uuid,
  p_customer_id uuid,
  p_start_date date,
  p_rent_cycle text,
  p_cycles_count integer,
  p_cycle_amount numeric,
  p_custom_cycle_value integer,
  p_custom_cycle_unit text,
  p_security_deposit numeric,
  p_notes text,
  p_issue_first_invoice boolean,
  p_idempotency_key uuid,
  p_annual_increase_pct numeric,
  p_start_time time,
  p_renewed_from uuid,
  out contract_id uuid,
  out contract_number text,
  out invoice_id uuid,
  out deposit_invoice_id uuid
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
#variable_conflict use_column
declare
  v_space public.rental_spaces;
  v_existing public.rental_contracts;
  v_end date;
  v_end_time time;
  v_minutes integer;
  v_seq integer;
  v_number text;
  v_contract_id uuid;
  v_first_rent uuid;
  v_deposit_inst uuid;
  v_i integer;
  v_ps date;
  v_pe date;
  v_amount numeric;
  v_total numeric := 0;
  v_inst_id uuid;
  v_pct numeric := coalesce(p_annual_increase_pct, 0);
  v_cv integer := case when p_rent_cycle = 'custom' then p_custom_cycle_value end;
  v_cu text := case when p_rent_cycle = 'custom' then p_custom_cycle_unit end;
begin
  if p_idempotency_key is not null then
    select * into v_existing from public.rental_contracts rc
    where rc.club_id = p_club_id and rc.idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      contract_id := v_existing.id;
      contract_number := v_existing.contract_number;
      select ri.invoice_id into invoice_id from public.rental_installments ri
        where ri.contract_id = v_existing.id and ri.kind = 'rent' and ri.invoice_id is not null order by ri.sequence limit 1;
      select ri.invoice_id into deposit_invoice_id from public.rental_installments ri
        where ri.contract_id = v_existing.id and ri.kind = 'deposit' and ri.invoice_id is not null limit 1;
      return;
    end if;
  end if;

  if p_rent_cycle not in ('hourly', 'daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom') then
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
  if v_pct < 0 or v_pct > 100 then
    raise exception 'annual increase must be between 0 and 100 percent';
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

  if p_rent_cycle = 'hourly' then
    if p_start_time is null then
      raise exception 'an hourly booking requires a start time';
    end if;
    if p_cycles_count > 24 then
      raise exception 'an hourly booking cannot exceed 24 hours';
    end if;
    v_minutes := (extract(epoch from p_start_time) / 60)::integer + 60 * p_cycles_count;
    if v_minutes > 1440 then
      raise exception 'an hourly booking must end on the same day';
    end if;
    v_end_time := case when v_minutes = 1440 then '24:00:00'::time
                       else (p_start_time + make_interval(hours => p_cycles_count))::time end;
    v_end := p_start_date;
  else
    v_end := public._rental_period_start(p_start_date, p_rent_cycle, p_cycles_count, v_cv, v_cu) - 1;
  end if;

  if not v_space.allow_overlapping_contracts
     and public._rental_space_has_conflict(p_space_id, p_start_date, v_end,
           case when p_rent_cycle = 'hourly' then p_start_time end, v_end_time, null) then
    raise exception 'this space is already rented for overlapping dates';
  end if;

  insert into public.rental_contract_counters as c (club_id, last_value) values (p_club_id, 1)
  on conflict (club_id) do update set last_value = c.last_value + 1
  returning last_value into v_seq;
  v_number := 'RC-' || lpad(v_seq::text, 5, '0');

  insert into public.rental_contracts (
    club_id, branch_id, space_id, customer_id, contract_number, rent_cycle,
    custom_cycle_value, custom_cycle_unit, cycles_count, cycle_amount, total_rent,
    security_deposit, start_date, end_date, start_time, end_time, annual_increase_pct,
    renewed_from_contract_id, status, notes, idempotency_key, created_by
  ) values (
    p_club_id, v_space.branch_id, p_space_id, p_customer_id, v_number, p_rent_cycle,
    v_cv, v_cu, p_cycles_count, round(p_cycle_amount, 2), 0,
    round(coalesce(p_security_deposit, 0), 2), p_start_date, v_end,
    case when p_rent_cycle = 'hourly' then p_start_time end, v_end_time,
    case when p_rent_cycle = 'hourly' then 0 else v_pct end,
    p_renewed_from, 'active', nullif(trim(coalesce(p_notes, '')), ''), p_idempotency_key, auth.uid()
  ) returning id into v_contract_id;

  if coalesce(p_security_deposit, 0) > 0 then
    insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
    values (p_club_id, v_space.branch_id, v_contract_id, 'deposit', 0, p_start_date, v_end, p_start_date, round(p_security_deposit, 2))
    returning id into v_deposit_inst;
  end if;

  if p_rent_cycle = 'hourly' then
    v_amount := round(p_cycle_amount * p_cycles_count, 2);
    insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
    values (p_club_id, v_space.branch_id, v_contract_id, 'rent', 1, p_start_date, p_start_date, p_start_date, v_amount)
    returning id into v_first_rent;
    v_total := v_amount;
  else
    for v_i in 0 .. p_cycles_count - 1 loop
      v_ps := public._rental_period_start(p_start_date, p_rent_cycle, v_i, v_cv, v_cu);
      v_pe := public._rental_period_start(p_start_date, p_rent_cycle, v_i + 1, v_cv, v_cu) - 1;
      v_amount := public._rental_escalated_amount(p_cycle_amount, v_pct, p_start_date, v_ps);
      insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
      values (p_club_id, v_space.branch_id, v_contract_id, 'rent', v_i + 1, v_ps, v_pe, v_ps, v_amount)
      returning id into v_inst_id;
      if v_i = 0 then
        v_first_rent := v_inst_id;
      end if;
      v_total := v_total + v_amount;
    end loop;
  end if;

  update public.rental_contracts set total_rent = v_total where id = v_contract_id;

  perform public.write_audit_log(
    p_club_id, case when p_renewed_from is null then 'rental.contract.created' else 'rental.contract.renewed' end,
    'rental_contract', v_contract_id, null,
    jsonb_build_object('contract_number', v_number, 'space_id', p_space_id, 'customer_id', p_customer_id,
      'start_date', p_start_date, 'end_date', v_end, 'start_time', p_start_time, 'rent_cycle', p_rent_cycle,
      'custom_cycle_value', v_cv, 'custom_cycle_unit', v_cu, 'cycles_count', p_cycles_count,
      'cycle_amount', p_cycle_amount, 'annual_increase_pct', v_pct, 'total_rent', v_total,
      'security_deposit', coalesce(p_security_deposit, 0), 'renewed_from', p_renewed_from),
    null
  );

  contract_id := v_contract_id;
  contract_number := v_number;
  if coalesce(p_issue_first_invoice, true) then
    invoice_id := public._rental_issue_invoice_internal(v_contract_id, array[v_first_rent], 0);
    if v_deposit_inst is not null then
      deposit_invoice_id := public._rental_issue_invoice_internal(v_contract_id, array[v_deposit_inst], 0);
    end if;
  end if;
end;
$$;

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
  p_idempotency_key uuid default null,
  p_annual_increase_pct numeric default 0,
  p_start_time time default null
) returns table(contract_id uuid, contract_number text, invoice_id uuid, deposit_invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
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

  return query
    select r.contract_id, r.contract_number, r.invoice_id, r.deposit_invoice_id
    from public._rental_create_contract_internal(
      p_club_id, p_space_id, p_customer_id, p_start_date, p_rent_cycle, p_cycles_count, p_cycle_amount,
      p_custom_cycle_value, p_custom_cycle_unit, p_security_deposit, p_notes, p_issue_first_invoice,
      p_idempotency_key, p_annual_increase_pct, p_start_time, null) r;
end;
$$;

-- ============================================================
-- 5. Renewal and editing
-- ============================================================
create or replace function public.renew_rental_contract(
  p_contract_id uuid,
  p_cycles_count integer default null,
  p_cycle_amount numeric default null,
  p_annual_increase_pct numeric default null,
  p_issue_first_invoice boolean default false,
  p_idempotency_key uuid default null
) returns table(contract_id uuid, contract_number text, invoice_id uuid, deposit_invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_src public.rental_contracts;
  v_last_amount numeric;
  v_pct numeric;
  v_amount numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_src from public.rental_contracts rc
  where rc.id = p_contract_id
    and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.create', rc.club_id);
  if v_src.id is null then
    raise exception 'rental contract not found or you do not have permission to renew it';
  end if;
  if not public.user_has_branch_access(v_src.club_id, v_src.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if not public._rentals_module_active(v_src.club_id) then
    raise exception 'the rentals module is not active for this club';
  end if;
  if not public.club_write_allowed(v_src.club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;
  if v_src.status <> 'active' then
    raise exception 'only an active or ended (not terminated or cancelled) contract can be renewed';
  end if;
  if v_src.rent_cycle = 'hourly' then
    raise exception 'hourly bookings cannot be renewed -- create a new booking';
  end if;
  if exists (select 1 from public.rental_contracts rc where rc.renewed_from_contract_id = v_src.id and rc.status <> 'cancelled')
     and not exists (select 1 from public.rental_contracts rc
                     where rc.club_id = v_src.club_id and p_idempotency_key is not null and rc.idempotency_key = p_idempotency_key) then
    raise exception 'this contract has already been renewed';
  end if;

  v_pct := coalesce(p_annual_increase_pct, v_src.annual_increase_pct);
  select ri.amount into v_last_amount from public.rental_installments ri
    where ri.contract_id = v_src.id and ri.kind = 'rent' and ri.status <> 'cancelled'
    order by ri.sequence desc limit 1;
  -- Default renewal rent: last period's rent, raised once by the
  -- contract's yearly increase (the renewal starts a new contract year).
  v_amount := coalesce(p_cycle_amount, round(coalesce(v_last_amount, v_src.cycle_amount) * (1 + v_pct / 100.0), 2));

  return query
    select r.contract_id, r.contract_number, r.invoice_id, r.deposit_invoice_id
    from public._rental_create_contract_internal(
      v_src.club_id, v_src.space_id, v_src.customer_id, v_src.end_date + 1, v_src.rent_cycle,
      coalesce(p_cycles_count, v_src.cycles_count), v_amount, v_src.custom_cycle_value, v_src.custom_cycle_unit,
      0, v_src.notes, p_issue_first_invoice, p_idempotency_key, v_pct, null, v_src.id) r;
end;
$$;

create or replace function public.update_rental_contract(
  p_contract_id uuid,
  p_notes text default null,
  p_new_cycle_amount numeric default null,
  p_effective_from date default null,
  p_extend_cycles integer default 0
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c public.rental_contracts;
  v_space public.rental_spaces;
  v_from date;
  v_changed integer := 0;
  v_i integer;
  v_ps date;
  v_pe date;
  v_new_end date;
  v_base numeric;
  v_total numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_c from public.rental_contracts rc
  where rc.id = p_contract_id
    and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.manage', rc.club_id)
  for update;
  if v_c.id is null then
    raise exception 'rental contract not found or you do not have permission to manage it';
  end if;
  if not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if v_c.status <> 'active' then
    raise exception 'only an active contract can be edited';
  end if;
  if p_new_cycle_amount is not null and p_new_cycle_amount < 0 then
    raise exception 'rent amount must not be negative';
  end if;
  if coalesce(p_extend_cycles, 0) < 0 or coalesce(p_extend_cycles, 0) > 1000 then
    raise exception 'extension must be between 0 and 1000 periods';
  end if;
  if coalesce(p_extend_cycles, 0) > 0 and v_c.rent_cycle = 'hourly' then
    raise exception 'hourly bookings cannot be extended';
  end if;

  if p_new_cycle_amount is not null then
    v_from := coalesce(p_effective_from, public._rental_club_today(v_c.club_id));
    update public.rental_installments ri
    set amount = case when v_c.rent_cycle = 'hourly'
                      then round(p_new_cycle_amount * v_c.cycles_count, 2)
                      else public._rental_escalated_amount(p_new_cycle_amount, v_c.annual_increase_pct, v_from, ri.period_start) end,
        updated_at = now()
    where ri.contract_id = v_c.id and ri.kind = 'rent' and ri.status = 'scheduled' and ri.period_start >= v_from;
    get diagnostics v_changed = row_count;
  end if;

  if coalesce(p_extend_cycles, 0) > 0 then
    v_new_end := public._rental_period_start(v_c.start_date, v_c.rent_cycle, v_c.cycles_count + p_extend_cycles,
                                             v_c.custom_cycle_value, v_c.custom_cycle_unit) - 1;
    select * into v_space from public.rental_spaces where id = v_c.space_id;
    if not v_space.allow_overlapping_contracts
       and public._rental_space_has_conflict(v_c.space_id, v_c.end_date + 1, v_new_end, null, null, v_c.id) then
      raise exception 'this space is already rented for overlapping dates';
    end if;
    v_base := coalesce(p_new_cycle_amount, v_c.cycle_amount);
    for v_i in v_c.cycles_count .. v_c.cycles_count + p_extend_cycles - 1 loop
      v_ps := public._rental_period_start(v_c.start_date, v_c.rent_cycle, v_i, v_c.custom_cycle_value, v_c.custom_cycle_unit);
      v_pe := public._rental_period_start(v_c.start_date, v_c.rent_cycle, v_i + 1, v_c.custom_cycle_value, v_c.custom_cycle_unit) - 1;
      insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
      values (v_c.club_id, v_c.branch_id, v_c.id, 'rent', v_i + 1, v_ps, v_pe, v_ps,
              case when p_new_cycle_amount is not null
                   then public._rental_escalated_amount(v_base, v_c.annual_increase_pct, coalesce(p_effective_from, v_c.start_date), v_ps)
                   else public._rental_escalated_amount(v_base, v_c.annual_increase_pct, v_c.start_date, v_ps) end);
    end loop;
  end if;

  select coalesce(sum(amount), 0) into v_total from public.rental_installments
  where contract_id = v_c.id and kind = 'rent' and status <> 'cancelled';

  update public.rental_contracts set
    notes = case when p_notes is null then notes else nullif(trim(p_notes), '') end,
    cycle_amount = coalesce(round(p_new_cycle_amount, 2), cycle_amount),
    cycles_count = cycles_count + coalesce(p_extend_cycles, 0),
    end_date = coalesce(v_new_end, end_date),
    total_rent = v_total,
    updated_at = now()
  where id = v_c.id;

  perform public.write_audit_log(v_c.club_id, 'rental.contract.updated', 'rental_contract', v_c.id,
    jsonb_build_object('notes', v_c.notes, 'cycle_amount', v_c.cycle_amount, 'end_date', v_c.end_date, 'cycles_count', v_c.cycles_count),
    jsonb_build_object('notes', p_notes, 'new_cycle_amount', p_new_cycle_amount, 'effective_from', v_from,
                       'repriced_installments', v_changed, 'extend_cycles', coalesce(p_extend_cycles, 0), 'end_date', coalesce(v_new_end, v_c.end_date)),
    null);
end;
$$;

-- ============================================================
-- 6. Deposit settlement (refund in full or in part; the rest is kept)
-- ============================================================
create or replace function public.settle_rental_deposit(
  p_contract_id uuid, p_refund_amount numeric, p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c public.rental_contracts;
  v_inst public.rental_installments;
  v_inv public.invoices;
  v_paid numeric;
  v_unpaid numeric;
  v_remaining numeric;
  v_pay record;
  v_part numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_c from public.rental_contracts rc
  where rc.id = p_contract_id
    and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.manage', rc.club_id)
  for update;
  if v_c.id is null then
    raise exception 'rental contract not found or you do not have permission to manage it';
  end if;
  if not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if v_c.deposit_settled_at is not null then
    raise exception 'the security deposit of this contract is already settled';
  end if;
  if coalesce(p_refund_amount, -1) < 0 then
    raise exception 'refund amount must not be negative';
  end if;

  select * into v_inst from public.rental_installments
  where contract_id = v_c.id and kind = 'deposit' and status = 'invoiced' for update;
  if v_inst.id is null then
    raise exception 'this contract has no invoiced security deposit';
  end if;
  select * into v_inv from public.invoices where id = v_inst.invoice_id for update;
  if v_inv.status <> 'issued' then
    raise exception 'this contract has no invoiced security deposit';
  end if;

  select s.total - s.outstanding into v_paid from public.get_invoice_payment_summary(array[v_inv.id]) s;
  v_paid := coalesce(v_paid, 0);
  if p_refund_amount > v_paid then
    raise exception 'refund amount (%) exceeds the deposit actually collected (%)', p_refund_amount, v_paid;
  end if;
  v_unpaid := greatest(v_inv.total - v_paid, 0);

  v_remaining := p_refund_amount;
  for v_pay in
    select p.id, p.amount - coalesce((select sum(r.amount) from public.refunds r where r.payment_id = p.id and r.status = 'completed'), 0) as refundable
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id and p.status = 'completed'
    where pa.invoice_id = v_inv.id
    order by p.received_at desc
  loop
    exit when v_remaining <= 0;
    v_part := least(v_remaining, v_pay.refundable);
    if v_part > 0 then
      perform public.create_refund(v_pay.id, v_part,
        'رد تأمين إيجار ' || v_c.contract_number || coalesce(' -- ' || nullif(trim(p_note), ''), ''), gen_random_uuid());
      v_remaining := v_remaining - v_part;
    end if;
  end loop;
  if v_remaining > 0 then
    raise exception 'could not refund the full amount from the deposit payments';
  end if;

  -- The deposit invoice now represents only what the club keeps: the
  -- refunded part and any never-collected part leave it, so it neither
  -- reopens as "outstanding" nor stays a liability.
  update public.invoices
  set discount = discount + p_refund_amount + v_unpaid,
      total = greatest(total - p_refund_amount - v_unpaid, 0)
  where id = v_inv.id;

  update public.rental_contracts set
    deposit_refunded = p_refund_amount,
    deposit_kept = v_paid - p_refund_amount,
    deposit_settled_at = now(),
    deposit_settled_by = auth.uid(),
    deposit_settlement_note = nullif(trim(coalesce(p_note, '')), ''),
    updated_at = now()
  where id = v_c.id;

  perform public.write_audit_log(v_c.club_id, 'rental.deposit.settled', 'rental_contract', v_c.id, null,
    jsonb_build_object('collected', v_paid, 'refunded', p_refund_amount, 'kept', v_paid - p_refund_amount,
                       'written_off_unpaid', v_unpaid, 'invoice_id', v_inv.id),
    nullif(trim(coalesce(p_note, '')), ''));

  return jsonb_build_object('collected', v_paid, 'refunded', p_refund_amount, 'kept', v_paid - p_refund_amount);
end;
$$;

-- ============================================================
-- 7. Derived installment state (deposit settlement aware)
-- ============================================================
alter function public._rental_installment_state(uuid[], date) rename to _retired_rental_installment_state_v1;
alter function public._rental_installment_rows(uuid[]) rename to _retired_rental_installment_rows_v1;
revoke all on function public._retired_rental_installment_state_v1(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public._retired_rental_installment_rows_v1(uuid[]) from public, anon, authenticated, service_role;

create or replace function public._rental_installment_rows(p_contract_ids uuid[])
returns table(
  installment_id uuid, contract_id uuid, kind text, sequence integer, period_start date, period_end date,
  due_date date, amount numeric, net_amount numeric, invoice_id uuid, invoice_number text, invoice_status text,
  status text, paid numeric, deposit_settled boolean
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  with inst as (
    select ri.*, i.invoice_number as inv_number, i.status as inv_status, coalesce(i.discount, 0) as inv_discount,
      (ri.status = 'invoiced' and i.status = 'issued') as is_live,
      (ri.kind = 'deposit' and rc.deposit_settled_at is not null) as dep_settled
    from public.rental_installments ri
    join public.rental_contracts rc on rc.id = ri.contract_id
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
    else 0 end,
    o.dep_settled
  from ordered o
  left join summ s on s.invoice_id = o.invoice_id
$$;

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
    case when r.deposit_settled then 0
         when r.status = 'invoiced' and r.invoice_status = 'issued' then greatest(r.net_amount - r.paid, 0) else 0 end,
    case
      when r.status = 'cancelled' then 'cancelled'
      when r.deposit_settled then 'settled'
      when r.status = 'scheduled' or r.invoice_status = 'void' then
        case when r.due_date <= p_today then 'due_not_invoiced' else 'scheduled' end
      when r.paid >= r.net_amount then 'paid'
      when r.due_date < p_today then 'overdue'
      when r.paid > 0 then 'partial'
      else 'unpaid'
    end
  from public._rental_installment_rows(p_contract_ids) r
$$;

revoke all on function public._rental_installment_rows(uuid[]) from public, anon, authenticated;
revoke all on function public._rental_installment_state(uuid[], date) from public, anon, authenticated;
grant execute on function public._rental_installment_rows(uuid[]) to service_role;
grant execute on function public._rental_installment_state(uuid[], date) to service_role;

-- ============================================================
-- 8. Read RPCs (new fields)
-- ============================================================
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
      coalesce(sum(st.amount) filter (where st.kind <> 'deposit' and st.status = 'invoiced' and st.invoice_status = 'issued'), 0) as invoiced,
      coalesce(sum(st.paid) filter (where st.kind <> 'deposit'), 0) as paid,
      coalesce(sum(st.paid) filter (where st.kind = 'deposit' and st.payment_state <> 'settled'), 0) as deposit_held,
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
    'annual_increase_pct', rc.annual_increase_pct,
    'security_deposit', rc.security_deposit, 'deposit_held', coalesce(a.deposit_held, 0),
    'deposit_settled', rc.deposit_settled_at is not null,
    'start_date', rc.start_date, 'end_date', rc.end_date, 'termination_date', rc.termination_date,
    'start_time', rc.start_time, 'end_time', rc.end_time,
    'renewed_from_contract_id', rc.renewed_from_contract_id,
    'renewed', exists (select 1 from public.rental_contracts nx where nx.renewed_from_contract_id = rc.id and nx.status <> 'cancelled'),
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
  ) order by case st.kind when 'deposit' then 0 when 'rent' then 1 else 2 end, st.sequence), '[]'::jsonb)
  into v_installments
  from public._rental_installment_state(array[p_contract_id], v_today) st;

  return jsonb_build_object(
    'contract', to_jsonb(v_contract) - 'idempotency_key',
    'display_status', case
      when v_contract.status = 'active' and v_contract.end_date < v_today then 'expired'
      when v_contract.status = 'active' and v_contract.start_date > v_today then 'upcoming'
      else v_contract.status end,
    'today', v_today,
    'club', (select jsonb_build_object('name', cl.name, 'name_ar', cl.name_ar, 'logo_url', cl.logo_url)
             from public.clubs cl where cl.id = v_contract.club_id),
    'space', (select jsonb_build_object('id', s.id, 'name', s.name, 'space_type', s.space_type,
                'custom_type_label', s.custom_type_label, 'branch_name', b.name, 'branch_address', b.address,
                'area_sqm', s.area_sqm, 'capacity', s.capacity)
              from public.rental_spaces s join public.branches b on b.id = s.branch_id where s.id = v_contract.space_id),
    'customer', (select jsonb_build_object('id', c.id, 'full_name', c.full_name, 'mobile_display', c.mobile_display,
                   'national_id', c.national_id, 'address', c.address)
                 from public.customers c where c.id = v_contract.customer_id),
    'renewed_from', (select jsonb_build_object('id', p.id, 'contract_number', p.contract_number)
                     from public.rental_contracts p where p.id = v_contract.renewed_from_contract_id),
    'renewed_to', (select jsonb_build_object('id', n.id, 'contract_number', n.contract_number)
                   from public.rental_contracts n where n.renewed_from_contract_id = v_contract.id and n.status <> 'cancelled'
                   order by n.created_at desc limit 1),
    'installments', v_installments,
    'totals', (
      select jsonb_build_object(
        'scheduled_total', coalesce(sum(st.amount) filter (where st.status <> 'cancelled' and st.kind <> 'deposit'), 0),
        'invoiced', coalesce(sum(st.amount) filter (where st.kind <> 'deposit' and st.status = 'invoiced' and st.invoice_status = 'issued'), 0),
        'paid', coalesce(sum(st.paid) filter (where st.kind <> 'deposit'), 0),
        'outstanding', coalesce(sum(st.outstanding), 0),
        'not_invoiced', coalesce(sum(st.amount) filter (where st.payment_state in ('scheduled', 'due_not_invoiced')), 0),
        'overdue', coalesce(sum(st.outstanding) filter (where st.payment_state = 'overdue'), 0)
          + coalesce(sum(st.amount) filter (where st.payment_state = 'due_not_invoiced'), 0),
        'late_fees', coalesce(sum(st.amount) filter (where st.kind = 'late_fee' and st.status <> 'cancelled'), 0),
        'deposit_collected', coalesce(sum(st.paid) filter (where st.kind = 'deposit' and st.payment_state <> 'settled'), 0)
          + coalesce(v_contract.deposit_refunded, 0) + coalesce(v_contract.deposit_kept, 0),
        'deposit_held', coalesce(sum(st.paid) filter (where st.kind = 'deposit' and st.payment_state <> 'settled'), 0),
        'deposit_refunded', v_contract.deposit_refunded,
        'deposit_kept', v_contract.deposit_kept
      )
      from public._rental_installment_state(array[p_contract_id], v_today) st
    )
  );
end;
$$;

-- ============================================================
-- 9. Settings
-- ============================================================
create or replace function public.get_rental_settings(p_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_s public.rental_settings;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  select * into v_s from public.rental_settings where club_id = p_club_id;
  return jsonb_build_object(
    'auto_issue_invoices', coalesce(v_s.auto_issue_invoices, true),
    'issue_days_before', coalesce(v_s.issue_days_before, 0),
    'late_fee_type', coalesce(v_s.late_fee_type, 'none'),
    'late_fee_value', coalesce(v_s.late_fee_value, 0),
    'late_fee_grace_days', coalesce(v_s.late_fee_grace_days, 5),
    'whatsapp_reminders_enabled', coalesce(v_s.whatsapp_reminders_enabled, true),
    'reminder_days_before', coalesce(v_s.reminder_days_before, 3),
    'whatsapp_templates_live', public._rental_whatsapp_templates_live()
  );
end;
$$;

create or replace function public.update_rental_settings(
  p_club_id uuid,
  p_auto_issue_invoices boolean,
  p_issue_days_before integer,
  p_late_fee_type text,
  p_late_fee_value numeric,
  p_late_fee_grace_days integer,
  p_whatsapp_reminders_enabled boolean,
  p_reminder_days_before integer
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.rental_settings;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids())
          and (public.has_permission('rental.contract.manage', p_club_id) or public.has_permission('club.update', p_club_id))) then
    raise exception 'not authorized';
  end if;
  select * into v_before from public.rental_settings where club_id = p_club_id;
  insert into public.rental_settings as s (
    club_id, auto_issue_invoices, issue_days_before, late_fee_type, late_fee_value, late_fee_grace_days,
    whatsapp_reminders_enabled, reminder_days_before, updated_at, updated_by
  ) values (
    p_club_id, p_auto_issue_invoices, p_issue_days_before, p_late_fee_type, coalesce(p_late_fee_value, 0),
    p_late_fee_grace_days, p_whatsapp_reminders_enabled, p_reminder_days_before, now(), auth.uid()
  )
  on conflict (club_id) do update set
    auto_issue_invoices = excluded.auto_issue_invoices,
    issue_days_before = excluded.issue_days_before,
    late_fee_type = excluded.late_fee_type,
    late_fee_value = excluded.late_fee_value,
    late_fee_grace_days = excluded.late_fee_grace_days,
    whatsapp_reminders_enabled = excluded.whatsapp_reminders_enabled,
    reminder_days_before = excluded.reminder_days_before,
    updated_at = now(),
    updated_by = auth.uid();

  perform public.write_audit_log(p_club_id, 'rental.settings.updated', 'rental_settings', null,
    to_jsonb(v_before),
    jsonb_build_object('auto_issue_invoices', p_auto_issue_invoices, 'issue_days_before', p_issue_days_before,
      'late_fee_type', p_late_fee_type, 'late_fee_value', p_late_fee_value, 'late_fee_grace_days', p_late_fee_grace_days,
      'whatsapp_reminders_enabled', p_whatsapp_reminders_enabled, 'reminder_days_before', p_reminder_days_before),
    null);
end;
$$;

-- ============================================================
-- 10. Daily automation
-- ============================================================
create or replace function public._rental_daily_jobs_for_club(p_club_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_s public.rental_settings;
  v_today date := public._rental_club_today(p_club_id);
  v_ids uuid[];
  v_inst record;
  v_fee numeric;
  v_fee_id uuid;
  v_issued integer := 0;
  v_fees integer := 0;
  v_reminders integer := 0;
  v_event uuid;
  v_q uuid;
  v_club_name text;
begin
  select * into v_s from public.rental_settings where club_id = p_club_id;
  select name into v_club_name from public.clubs where id = p_club_id;

  -- a) auto-issue due rent invoices
  if coalesce(v_s.auto_issue_invoices, true) then
    for v_inst in
      select ri.id, ri.contract_id
      from public.rental_installments ri
      join public.rental_contracts rc on rc.id = ri.contract_id
      where ri.club_id = p_club_id and ri.kind = 'rent' and ri.status = 'scheduled'
        and ri.due_date <= v_today + coalesce(v_s.issue_days_before, 0)
        and rc.status in ('active', 'terminated')
      order by ri.due_date, ri.sequence
    loop
      perform public._rental_issue_invoice_internal(v_inst.contract_id, array[v_inst.id], 0);
      v_issued := v_issued + 1;
    end loop;
  end if;

  select coalesce(array_agg(rc.id), array[]::uuid[]) into v_ids
  from public.rental_contracts rc where rc.club_id = p_club_id and rc.status in ('active', 'terminated');

  -- b) late fees: one per overdue rent installment, after the grace period
  if coalesce(v_s.late_fee_type, 'none') <> 'none' and coalesce(v_s.late_fee_value, 0) > 0 then
    for v_inst in
      select st.*, ri.club_id as inst_club, ri.branch_id as inst_branch
      from public._rental_installment_state(v_ids, v_today) st
      join public.rental_installments ri on ri.id = st.installment_id
      join public.invoices inv on inv.id = st.invoice_id
      where st.kind = 'rent' and st.payment_state = 'overdue'
        and st.due_date + coalesce(v_s.late_fee_grace_days, 5) < v_today
        -- the tenant must have had the invoice for the grace period (at
        -- least one day), so a late auto-issued invoice is never fined
        -- on the day it appears
        and inv.issued_at < now() - make_interval(days => greatest(coalesce(v_s.late_fee_grace_days, 5), 1))
        and not exists (select 1 from public.rental_installments lf where lf.source_installment_id = st.installment_id)
    loop
      v_fee := case when v_s.late_fee_type = 'fixed' then v_s.late_fee_value
                    else round(v_inst.amount * v_s.late_fee_value / 100.0, 2) end;
      if v_fee > 0 then
        insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end,
                                                due_date, amount, source_installment_id)
        values (v_inst.inst_club, v_inst.inst_branch, v_inst.contract_id, 'late_fee', 10000 + v_inst.sequence,
                v_inst.period_start, v_inst.period_end, v_today, v_fee, v_inst.installment_id)
        returning id into v_fee_id;
        perform public._rental_issue_invoice_internal(v_inst.contract_id, array[v_fee_id], 0);
        v_fees := v_fees + 1;
      end if;
    end loop;
  end if;

  -- c) WhatsApp reminders (only once the connector renders the templates)
  if public._rental_whatsapp_templates_live() and coalesce(v_s.whatsapp_reminders_enabled, true) then
    for v_inst in
      select st.*, rc.customer_id, rc.contract_number, s.name as space_name, c.full_name as customer_name,
             (v_today - st.due_date) as days_late
      from public._rental_installment_state(v_ids, v_today) st
      join public.rental_contracts rc on rc.id = st.contract_id
      join public.rental_spaces s on s.id = rc.space_id
      join public.customers c on c.id = rc.customer_id
      where st.kind in ('rent', 'late_fee')
        and ((st.payment_state in ('unpaid', 'partial') and st.due_date = v_today + coalesce(v_s.reminder_days_before, 3))
          or (st.payment_state = 'overdue' and (v_today - st.due_date) in (1, 7, 14, 30)))
    loop
      v_event := public.emit_notification_event(p_club_id,
        case when v_inst.payment_state = 'overdue' then 'rental.payment_overdue' else 'rental.payment_due' end,
        'rental_installment', v_inst.installment_id,
        jsonb_build_object('customer_id', v_inst.customer_id, 'contract_number', v_inst.contract_number,
                           'due_date', v_inst.due_date, 'outstanding', v_inst.outstanding));
      v_q := public.queue_whatsapp_notification(
        p_club_id, v_event, v_inst.customer_id,
        case when v_inst.payment_state = 'overdue' then 'rental-payment-overdue' else 'rental-payment-reminder' end,
        'rental_reminders',
        jsonb_build_object('club_name', v_club_name, 'customer_name', v_inst.customer_name,
          'space_name', v_inst.space_name, 'contract_number', v_inst.contract_number,
          'period_start', v_inst.period_start, 'period_end', v_inst.period_end,
          'due_date', v_inst.due_date, 'amount', v_inst.outstanding, 'days_late', v_inst.days_late,
          'invoice_number', v_inst.invoice_number, 'is_late_fee', v_inst.kind = 'late_fee'),
        'reminder',
        'rental.reminder:' || v_inst.installment_id::text || ':' || v_today::text,
        null, null);
      if v_q is not null then
        v_reminders := v_reminders + 1;
      end if;
    end loop;
  end if;

  return jsonb_build_object('club_id', p_club_id, 'issued', v_issued, 'late_fees', v_fees, 'reminders', v_reminders);
end;
$$;

create or replace function public.run_rental_daily_jobs()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club uuid;
  v_out jsonb := '[]'::jsonb;
begin
  for v_club in
    select cm.club_id from public.club_modules cm
    where cm.module_key = 'rentals' and cm.entitled and cm.active
      and exists (select 1 from public.rental_contracts rc where rc.club_id = cm.club_id and rc.status in ('active', 'terminated'))
  loop
    begin
      v_out := v_out || jsonb_build_array(public._rental_daily_jobs_for_club(v_club));
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('club_id', v_club, 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end;
$$;

revoke all on function public._rental_daily_jobs_for_club(uuid) from public, anon, authenticated;
revoke all on function public.run_rental_daily_jobs() from public, anon, authenticated;
grant execute on function public._rental_daily_jobs_for_club(uuid) to service_role;
grant execute on function public.run_rental_daily_jobs() to service_role;

select cron.schedule('rental-daily-jobs', '7 4 * * *', $$select public.run_rental_daily_jobs();$$);

-- ============================================================
-- 11. Customer portal
-- ============================================================
create or replace function public.get_my_portal_rentals()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_ids uuid[];
  v_rows jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select coalesce(array_agg(rc.id), array[]::uuid[]) into v_ids
  from public.rental_contracts rc
  join public.customers c on c.id = rc.customer_id
  where c.user_id = auth.uid() and rc.status <> 'cancelled';

  with st as (select * from public._rental_installment_state(v_ids, current_date))
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', rc.id, 'club_id', rc.club_id, 'club_name', cl.name, 'club_name_ar', cl.name_ar,
    'contract_number', rc.contract_number, 'space_name', s.name, 'space_type', s.space_type,
    'custom_type_label', s.custom_type_label, 'branch_name', b.name,
    'rent_cycle', rc.rent_cycle, 'custom_cycle_value', rc.custom_cycle_value, 'custom_cycle_unit', rc.custom_cycle_unit,
    'start_date', rc.start_date, 'end_date', rc.end_date, 'start_time', rc.start_time, 'end_time', rc.end_time,
    'termination_date', rc.termination_date, 'status', rc.status, 'security_deposit', rc.security_deposit,
    'installments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', st.kind, 'sequence', st.sequence, 'period_start', st.period_start, 'period_end', st.period_end,
        'due_date', st.due_date, 'amount', st.amount, 'paid', st.paid, 'outstanding', st.outstanding,
        'payment_state', st.payment_state, 'invoice_number', st.invoice_number
      ) order by st.due_date, st.sequence)
      from st where st.contract_id = rc.id and st.payment_state <> 'cancelled'
    ), '[]'::jsonb)
  ) order by rc.start_date desc), '[]'::jsonb)
  into v_rows
  from public.rental_contracts rc
  join public.rental_spaces s on s.id = rc.space_id
  join public.branches b on b.id = rc.branch_id
  join public.clubs cl on cl.id = rc.club_id
  where rc.id = any(v_ids);

  return v_rows;
end;
$$;

-- ============================================================
-- 12. Space expenses (profitability)
-- ============================================================
create or replace function public.record_rental_space_expense(
  p_space_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_description text,
  p_category_id uuid default null,
  p_expense_date date default null,
  p_paid_to text default null,
  p_idempotency_key uuid default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_space public.rental_spaces;
  v_expense_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_space from public.rental_spaces s
  where s.id = p_space_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', s.club_id);
  if v_space.id is null then
    raise exception 'rental space not found';
  end if;

  -- record_expense enforces expense.create, branch access, cash custody
  -- and idempotency exactly as for any other expense.
  v_expense_id := public.record_expense(v_space.club_id, v_space.branch_id, p_amount, p_payment_method,
    p_description, p_category_id, null, p_paid_to, least(coalesce(p_expense_date, public._rental_club_today(v_space.club_id)), current_date),
    p_idempotency_key);

  update public.expenses set rental_space_id = v_space.id where id = v_expense_id and rental_space_id is null;

  perform public.write_audit_log(v_space.club_id, 'rental.space.expense_linked', 'rental_space', v_space.id, null,
    jsonb_build_object('expense_id', v_expense_id, 'amount', p_amount), null);

  return v_expense_id;
end;
$$;

create or replace function public.list_rental_space_expenses(p_space_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_space public.rental_spaces;
begin
  select * into v_space from public.rental_spaces s
  where s.id = p_space_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', s.club_id);
  if v_space.id is null or not public.user_has_branch_access(v_space.club_id, v_space.branch_id) then
    raise exception 'rental space not found';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', e.id, 'amount', e.amount, 'description', e.description,
      'expense_date', e.expense_date, 'payment_method', e.payment_method, 'paid_to', e.paid_to, 'status', e.status)
      order by e.expense_date desc, e.created_at desc)
    from public.expenses e where e.rental_space_id = p_space_id
  ), '[]'::jsonb);
end;
$$;

-- ============================================================
-- 13. Reports
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
  received as (
    -- Money received in range per contract, split by line type. An
    -- invoice can hold several rental lines; allocation is split
    -- pro-rata by line_total so per-space totals add up exactly.
    select ri.contract_id, ii.reference_type,
      sum(pa.amount * ii.line_total / nullif(inv.subtotal, 0)) as amount
    from public.payments p
    join public.payment_allocations pa on pa.payment_id = p.id
    join public.invoices inv on inv.id = pa.invoice_id
    join public.invoice_items ii on ii.invoice_id = inv.id and ii.reference_type in ('rental', 'rental_deposit')
    join public.rental_installments ri on ri.id = ii.reference_id
    where p.club_id = p_club_id and p.status = 'completed'
      and p.received_at >= v_range_start and p.received_at < v_range_end
      and ri.contract_id = any(v_ids)
    group by ri.contract_id, ii.reference_type
  ),
  collected as (
    select contract_id, sum(amount) as amount from received where reference_type = 'rental' group by contract_id
  ),
  space_expenses as (
    select e.rental_space_id, sum(e.amount) as amount
    from public.expenses e
    where e.club_id = p_club_id and e.rental_space_id is not null and e.status <> 'voided'
      and e.expense_date between p_start_date and p_end_date
    group by e.rental_space_id
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
    'deposits_collected_in_range', (select coalesce(round(sum(amount), 2), 0) from received where reference_type = 'rental_deposit'),
    'late_fees_in_range', (select coalesce(sum(st.amount), 0) from st where st.kind = 'late_fee' and st.status <> 'cancelled'
                            and st.due_date between p_start_date and p_end_date),
    'expenses_in_range', (select coalesce(sum(amount), 0) from space_expenses),
    'net_in_range', (select coalesce(round(sum(amount), 2), 0) from collected) - (select coalesce(sum(amount), 0) from space_expenses),
    'due_in_range', (
      select coalesce(sum(st.amount), 0) from st
      where st.status <> 'cancelled' and st.kind <> 'deposit' and st.due_date between p_start_date and p_end_date
    ),
    'outstanding_total', (select coalesce(sum(st.outstanding), 0) from st),
    'overdue_total', (
      select coalesce(sum(st.outstanding) filter (where st.payment_state = 'overdue'), 0)
        + coalesce(sum(st.amount) filter (where st.payment_state = 'due_not_invoiced'), 0) from st
    ),
    'overdue_count', (select count(*) from st where st.payment_state in ('overdue', 'due_not_invoiced')),
    'not_invoiced_due_count', (select count(*) from st where st.payment_state = 'due_not_invoiced'),
    'deposits_held', (select coalesce(sum(st.paid), 0) from st where st.kind = 'deposit' and st.payment_state <> 'settled'),
    'deposits_refunded', (select coalesce(sum(c.deposit_refunded), 0) from contracts c),
    'deposits_kept', (select coalesce(sum(c.deposit_kept), 0) from contracts c),
    'by_space', coalesce((
      select jsonb_agg(jsonb_build_object(
        'space_id', s.id, 'space_name', s.name, 'space_type', s.space_type, 'custom_type_label', s.custom_type_label,
        'occupied_today', exists (
          select 1 from contracts c where c.space_id = s.id and c.status in ('active', 'terminated')
            and v_today between c.start_date and public._rental_contract_occupancy_end(c)),
        'collected', coalesce((select round(sum(col.amount), 2) from collected col join contracts c on c.id = col.contract_id where c.space_id = s.id), 0),
        'expenses', coalesce((select se.amount from space_expenses se where se.rental_space_id = s.id), 0),
        'net', coalesce((select round(sum(col.amount), 2) from collected col join contracts c on c.id = col.contract_id where c.space_id = s.id), 0)
             - coalesce((select se.amount from space_expenses se where se.rental_space_id = s.id), 0),
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
        'space_name', s.name, 'end_date', c.end_date,
        'renewed', exists (select 1 from public.rental_contracts nx where nx.renewed_from_contract_id = c.id and nx.status <> 'cancelled')
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

-- Revenue by source: deposits are their own non-revenue row.
select public._rentals_migration_patch_function(
  'public.get_revenue_by_source_report(uuid, date, date, uuid)'::regprocedure,
  $x$          when 'rental' then 'rental'
          else 'other' end
        from public.payment_allocations pa
        join public.invoice_items ii on ii.invoice_id = pa.invoice_id
        where pa.payment_id = p.id
        order by ii.reference_type = 'other', ii.id
        limit 1
      ), 'other') as source
    from public.payments p$x$,
  $x$          when 'rental' then 'rental'
          when 'rental_deposit' then 'rental_deposit'
          else 'other' end
        from public.payment_allocations pa
        join public.invoice_items ii on ii.invoice_id = pa.invoice_id
        where pa.payment_id = p.id
        order by ii.reference_type = 'other', ii.id
        limit 1
      ), 'other') as source
    from public.payments p$x$
);
select public._rentals_migration_patch_function(
  'public.get_revenue_by_source_report(uuid, date, date, uuid)'::regprocedure,
  $x$          when 'rental' then 'rental'
          else 'other' end
        from public.payment_allocations pa
        join public.invoice_items ii on ii.invoice_id = pa.invoice_id
        where pa.payment_id = p.id
        order by ii.reference_type = 'other', ii.id
        limit 1
      ), 'other') as source
    from public.refunds r$x$,
  $x$          when 'rental' then 'rental'
          when 'rental_deposit' then 'rental_deposit'
          else 'other' end
        from public.payment_allocations pa
        join public.invoice_items ii on ii.invoice_id = pa.invoice_id
        where pa.payment_id = p.id
        order by ii.reference_type = 'other', ii.id
        limit 1
      ), 'other') as source
    from public.refunds r$x$
);

-- Customer 360: deposit-only invoices are rental invoices too.
select public._rentals_migration_patch_function(
  'public.get_customer_financial_account(uuid, uuid, integer, integer)'::regprocedure,
  $x$rii.reference_type = 'rental') then 'rental'$x$,
  $x$rii.reference_type in ('rental', 'rental_deposit')) then 'rental'$x$
);

-- Revenue report: expose how much of the collected money is held
-- security deposits (a liability, refundable), so it can be shown
-- separately from earned revenue.
select public._rentals_migration_patch_function(
  'public.get_revenue_report(uuid, date, date, uuid, text)'::regprocedure,
  $x$    'refunds_total', coalesce(($x$,
  $x$    'deposits_collected', coalesce((
      select sum(pa.amount) from public.payments p
      join public.payment_allocations pa on pa.payment_id = p.id
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at >= v_range_start and p.received_at < v_range_end
        and (case when p_branch_id is not null then p.branch_id = p_branch_id
             else v_accessible is null or p.branch_id = any(v_accessible) end)
        and (p_method is null or p.method = p_method)
        and exists (select 1 from public.invoice_items ii where ii.invoice_id = pa.invoice_id and ii.reference_type = 'rental_deposit')
    ), 0),
    'refunds_total', coalesce(($x$
);

-- ============================================================
-- 14. Grants
-- ============================================================
revoke all on function public._rental_create_contract_internal(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, uuid) from public, anon, authenticated;
grant execute on function public._rental_create_contract_internal(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, uuid) to service_role;

revoke all on function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time) from public, anon;
revoke all on function public.renew_rental_contract(uuid, integer, numeric, numeric, boolean, uuid) from public, anon;
revoke all on function public.update_rental_contract(uuid, text, numeric, date, integer) from public, anon;
revoke all on function public.settle_rental_deposit(uuid, numeric, text) from public, anon;
revoke all on function public.get_rental_settings(uuid) from public, anon;
revoke all on function public.update_rental_settings(uuid, boolean, integer, text, numeric, integer, boolean, integer) from public, anon;
revoke all on function public.get_my_portal_rentals() from public, anon;
revoke all on function public.record_rental_space_expense(uuid, numeric, text, text, uuid, date, text, uuid) from public, anon;
revoke all on function public.list_rental_space_expenses(uuid) from public, anon;

grant execute on function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time) to authenticated, service_role;
grant execute on function public.renew_rental_contract(uuid, integer, numeric, numeric, boolean, uuid) to authenticated, service_role;
grant execute on function public.update_rental_contract(uuid, text, numeric, date, integer) to authenticated, service_role;
grant execute on function public.settle_rental_deposit(uuid, numeric, text) to authenticated, service_role;
grant execute on function public.get_rental_settings(uuid) to authenticated, service_role;
grant execute on function public.update_rental_settings(uuid, boolean, integer, text, numeric, integer, boolean, integer) to authenticated, service_role;
grant execute on function public.get_my_portal_rentals() to authenticated, service_role;
grant execute on function public.record_rental_space_expense(uuid, numeric, text, text, uuid, date, text, uuid) to authenticated, service_role;
grant execute on function public.list_rental_space_expenses(uuid) to authenticated, service_role;

-- _rentals_migration_patch_function is kept (owner-only, revoked) as in production.
