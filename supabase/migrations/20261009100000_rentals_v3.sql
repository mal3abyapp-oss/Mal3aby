-- RENTALS MODULE v3 (2026-10-09)
--
-- Builds on 20261007100000_rentals_module.sql and 20261008100000_rentals_v2.sql:
--   1. Portal payment deep links: get_my_portal_rentals returns each
--      installment's invoice_id (the portal "Pay" button opens that exact
--      invoice's payment claim); get_my_portal_invoices shows up to 100.
--   2. Online hall booking requests from the customer portal
--      (rental_spaces.online_booking + rental_booking_requests), approved
--      or rejected by staff; approval creates the hourly booking.
--   3. Contract documents (private storage bucket 'rental-documents' +
--      rental_contract_documents).
--   4. (Deposit refund receipt is frontend-only.)
--   5. Pro-rated first period: a monthly/quarterly/semi-annual/annual
--      lease starting mid-month gets a partial first installment up to
--      the 1st of the next month, then full periods from that anchor.
--   6. Utility meters (electricity/water/gas/other) per contract; each
--      reading bills consumption x unit price as a 'utility' installment.
--   7. Contract-expiry staff alerts (rental_staff_alerts), raised daily.
--   8. VAT on rent: rental_settings.vat_rate adds invoices.tax on rent,
--      late-fee and utility invoices (never on deposits). Rental figures
--      (paid / collected) stay net of VAT; VAT collected is reported apart.
--
-- Changed RPC signatures are retired by rename (as in v2).

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
alter table public.rental_settings
  add column vat_rate numeric(5, 2) not null default 0 check (vat_rate >= 0 and vat_rate <= 100),
  add column expiry_alert_days integer not null default 30 check (expiry_alert_days between 0 and 180);

alter table public.rental_contracts
  add column schedule_anchor date,
  add column prorated_first boolean not null default false;

alter table public.rental_installments drop constraint rental_installments_kind_check;
alter table public.rental_installments add constraint rental_installments_kind_check
  check (kind in ('rent', 'deposit', 'late_fee', 'utility'));
alter table public.rental_installments add column note text;

alter table public.rental_spaces add column online_booking boolean not null default false;

-- Online booking requests (customer portal -> staff approval)
create table public.rental_booking_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  space_id uuid not null references public.rental_spaces(id),
  customer_id uuid not null references public.customers(id),
  requested_by uuid not null references auth.users(id),
  booking_date date not null,
  start_time time not null,
  hours integer not null check (hours between 1 and 24),
  notes text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  contract_id uuid references public.rental_contracts(id),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now()
);
create index rental_booking_requests_club_idx on public.rental_booking_requests (club_id, status, booking_date);
create index rental_booking_requests_customer_idx on public.rental_booking_requests (customer_id);
alter table public.rental_booking_requests enable row level security;
alter table public.rental_booking_requests force row level security;
create policy rental_booking_requests_staff_select on public.rental_booking_requests for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('rental.view', club_id));
create policy rental_booking_requests_customer_select on public.rental_booking_requests for select to authenticated
  using (customer_id in (select c.id from public.customers c where c.user_id = auth.uid()));
revoke all on public.rental_booking_requests from anon;
revoke insert, update, delete, truncate on public.rental_booking_requests from authenticated;
grant select on public.rental_booking_requests to authenticated;
grant all on public.rental_booking_requests to service_role;

-- Contract documents
create table public.rental_contract_documents (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  contract_id uuid not null references public.rental_contracts(id),
  doc_type text not null default 'other'
    check (doc_type in ('signed_contract', 'id_document', 'checkin_photo', 'checkout_photo', 'receipt', 'other')),
  file_name text not null,
  storage_path text not null unique,
  mime_type text,
  size_bytes bigint,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- removal is a soft delete (the storage object is removed by the client)
  deleted_at timestamptz,
  deleted_by uuid references auth.users(id)
);
create index rental_contract_documents_contract_idx on public.rental_contract_documents (contract_id);
alter table public.rental_contract_documents enable row level security;
alter table public.rental_contract_documents force row level security;
create policy rental_contract_documents_staff_select on public.rental_contract_documents for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('rental.view', club_id));
revoke all on public.rental_contract_documents from anon;
revoke insert, update, delete, truncate on public.rental_contract_documents from authenticated;
grant select on public.rental_contract_documents to authenticated;
grant all on public.rental_contract_documents to service_role;

-- Utility meters and readings
create table public.rental_meters (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  contract_id uuid not null references public.rental_contracts(id),
  meter_type text not null check (meter_type in ('electricity', 'water', 'gas', 'other')),
  label text,
  unit_price numeric(12, 4) not null check (unit_price >= 0),
  last_reading numeric(14, 3) not null default 0 check (last_reading >= 0),
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index rental_meters_contract_idx on public.rental_meters (contract_id);
create table public.rental_meter_readings (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  meter_id uuid not null references public.rental_meters(id),
  contract_id uuid not null references public.rental_contracts(id),
  reading_date date not null,
  previous_reading numeric(14, 3) not null,
  current_reading numeric(14, 3) not null,
  consumption numeric(14, 3) not null check (consumption >= 0),
  unit_price numeric(12, 4) not null,
  amount numeric(12, 2) not null,
  installment_id uuid references public.rental_installments(id),
  idempotency_key uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (meter_id, idempotency_key)
);
create index rental_meter_readings_meter_idx on public.rental_meter_readings (meter_id, reading_date);
alter table public.rental_meters enable row level security;
alter table public.rental_meters force row level security;
alter table public.rental_meter_readings enable row level security;
alter table public.rental_meter_readings force row level security;
create policy rental_meters_staff_select on public.rental_meters for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('rental.view', club_id));
create policy rental_meter_readings_staff_select on public.rental_meter_readings for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('rental.view', club_id));
revoke all on public.rental_meters, public.rental_meter_readings from anon;
revoke insert, update, delete, truncate on public.rental_meters, public.rental_meter_readings from authenticated;
grant select on public.rental_meters, public.rental_meter_readings to authenticated;
grant all on public.rental_meters, public.rental_meter_readings to service_role;

-- Staff alerts (contract expiring)
create table public.rental_staff_alerts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  contract_id uuid not null references public.rental_contracts(id),
  kind text not null default 'contract_expiring' check (kind in ('contract_expiring')),
  days_left integer not null,
  end_date date not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  read_by uuid references auth.users(id),
  unique (contract_id, kind, days_left, end_date)
);
create index rental_staff_alerts_club_idx on public.rental_staff_alerts (club_id, read_at);
alter table public.rental_staff_alerts enable row level security;
alter table public.rental_staff_alerts force row level security;
create policy rental_staff_alerts_staff_select on public.rental_staff_alerts for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('rental.view', club_id));
revoke all on public.rental_staff_alerts from anon;
revoke insert, update, delete, truncate on public.rental_staff_alerts from authenticated;
grant select on public.rental_staff_alerts to authenticated;
grant all on public.rental_staff_alerts to service_role;

-- Private storage bucket for contract documents. Path:
-- <club_id>/<contract_id>/<uuid>-<file name>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('rental-documents', 'rental-documents', false, 10 * 1024 * 1024,
        array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

-- The uuid casts only run for this bucket (CASE guards them, since
-- policy quals can be evaluated in any order), and the contract folder
-- must belong to a branch the caller can access.
create or replace function public._rental_document_path_allowed(p_name text, p_permission text)
returns boolean
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_parts text[] := storage.foldername(p_name);
  v_club uuid;
  v_contract uuid;
begin
  if coalesce(array_length(v_parts, 1), 0) < 2
     or v_parts[1] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     or v_parts[2] !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  v_club := v_parts[1]::uuid;
  v_contract := v_parts[2]::uuid;
  return v_club in (select public.user_club_ids())
    and public.has_permission(p_permission, v_club)
    and exists (select 1 from public.rental_contracts rc
                where rc.id = v_contract and rc.club_id = v_club
                  and public.user_has_branch_access(rc.club_id, rc.branch_id));
end;
$$;
revoke all on function public._rental_document_path_allowed(text, text) from public, anon;
grant execute on function public._rental_document_path_allowed(text, text) to authenticated, service_role;

create policy rental_documents_bucket_select on storage.objects
  for select to authenticated
  using (case when bucket_id = 'rental-documents' then public._rental_document_path_allowed(name, 'rental.view') else false end);
create policy rental_documents_bucket_insert on storage.objects
  for insert to authenticated
  with check (case when bucket_id = 'rental-documents' then public._rental_document_path_allowed(name, 'rental.contract.create') else false end);
create policy rental_documents_bucket_delete on storage.objects
  for delete to authenticated
  using (case when bucket_id = 'rental-documents' then public._rental_document_path_allowed(name, 'rental.contract.manage') else false end);

-- End time of an hourly slot; null when it would pass midnight
-- (exactly midnight is '24:00').
create or replace function public._rental_hourly_end_time(p_start time, p_hours integer)
returns time
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case
    when p_start is null or p_hours is null then null
    when (extract(epoch from p_start) / 60)::integer + 60 * p_hours > 1440 then null
    when (extract(epoch from p_start) / 60)::integer + 60 * p_hours = 1440 then '24:00:00'::time
    else (p_start + make_interval(hours => p_hours))::time
  end
$$;
revoke all on function public._rental_hourly_end_time(time, integer) from public, anon;
grant execute on function public._rental_hourly_end_time(time, integer) to authenticated, service_role;

-- ============================================================
-- 2. Invoicing: VAT + utility descriptions
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
  v_vat_rate numeric;
  v_tax numeric := 0;
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

  -- VAT applies to rent, late fees and utilities -- never to a deposit,
  -- which is a refundable liability, not a supply.
  if not v_has_deposit then
    select coalesce(s.vat_rate, 0) into v_vat_rate from public.rental_settings s where s.club_id = v_contract.club_id;
    v_tax := round((v_subtotal - coalesce(p_discount, 0)) * coalesce(v_vat_rate, 0) / 100.0, 2);
  end if;

  perform 1 from public.rental_installments where id = any(p_installment_ids) for update;

  v_invoice_number := public.issue_invoice_number(v_contract.branch_id, v_contract.club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, tax, total, due_date, issued_at, created_by)
  values (v_contract.club_id, v_contract.branch_id, v_invoice_number, v_contract.customer_id, 'issued',
          v_subtotal, coalesce(p_discount, 0), v_tax, round(v_subtotal - coalesce(p_discount, 0) + v_tax, 2), v_due, now(), auth.uid())
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
    elsif v_inst.kind = 'utility' then
      v_description := coalesce(v_inst.note, 'استهلاك مرافق') || ' — ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || chr(8297);
    else
      v_description := 'إيجار ' || v_space.name || ' ' || chr(8296) || v_contract.contract_number || ' #' || v_inst.sequence
        || ' ' || v_period || chr(8297)
        || case when v_inst.note is not null then ' (' || v_inst.note || ')' else '' end;
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
                       'subtotal', v_subtotal, 'discount', coalesce(p_discount, 0), 'tax', v_tax),
    null
  );

  return v_invoice_id;
end;
$$;

-- Installment paid amounts stay net of VAT: the share of each payment
-- that settles the invoice's tax is not rent.
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
      coalesce(i.total, 0) as inv_total, coalesce(i.tax, 0) as inv_tax,
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
      least(o.net_amt, greatest(
        round((s.total - s.outstanding) * (o.inv_total - o.inv_tax) / nullif(o.inv_total, 0), 2) - o.net_before, 0))
    else 0 end,
    o.dep_settled
  from ordered o
  left join summ s on s.invoice_id = o.invoice_id
$$;

-- ============================================================
-- 3. Contract creation with optional pro-rated first period
-- ============================================================
alter function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time)
  rename to _retired_create_rental_contract_v2;
revoke all on function public._retired_create_rental_contract_v2(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time) from public, anon, authenticated;
alter function public._rental_create_contract_internal(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, uuid)
  rename to _retired_rental_create_contract_internal_v2;
revoke all on function public._retired_rental_create_contract_internal_v2(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, uuid) from public, anon, authenticated;

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
  p_prorate_first boolean,
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
  v_prorate boolean := coalesce(p_prorate_first, false)
    and p_rent_cycle in ('monthly', 'quarterly', 'semi_annual', 'annual')
    and extract(day from p_start_date) <> 1;
  v_anchor date;
  v_offset integer := 0;
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

  -- Full periods run from the anchor: the contract start, or (pro-rated)
  -- the 1st of the month after a mid-month start.
  v_anchor := case when v_prorate then (date_trunc('month', p_start_date) + interval '1 month')::date else p_start_date end;

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
    v_end := public._rental_period_start(v_anchor, p_rent_cycle, p_cycles_count, v_cv, v_cu) - 1;
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
    renewed_from_contract_id, status, notes, idempotency_key, created_by, schedule_anchor, prorated_first
  ) values (
    p_club_id, v_space.branch_id, p_space_id, p_customer_id, v_number, p_rent_cycle,
    v_cv, v_cu, p_cycles_count, round(p_cycle_amount, 2), 0,
    round(coalesce(p_security_deposit, 0), 2), p_start_date, v_end,
    case when p_rent_cycle = 'hourly' then p_start_time end, v_end_time,
    case when p_rent_cycle = 'hourly' then 0 else v_pct end,
    p_renewed_from, 'active', nullif(trim(coalesce(p_notes, '')), ''), p_idempotency_key, auth.uid(),
    case when v_prorate then v_anchor end, v_prorate
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
    if v_prorate then
      -- Partial first period: start .. end of the start month, priced as
      -- the monthly share of the rent x (days used / days in that month).
      v_amount := round(p_cycle_amount
        / case p_rent_cycle when 'quarterly' then 3 when 'semi_annual' then 6 when 'annual' then 12 else 1 end
        * (v_anchor - p_start_date)::numeric
        / (v_anchor - date_trunc('month', p_start_date)::date), 2);
      insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end,
                                              due_date, amount, note)
      values (p_club_id, v_space.branch_id, v_contract_id, 'rent', 1, p_start_date, v_anchor - 1, p_start_date, v_amount,
              'فترة جزئية ' || (v_anchor - p_start_date) || ' يوم')
      returning id into v_first_rent;
      v_total := v_amount;
      v_offset := 1;
    end if;
    for v_i in 0 .. p_cycles_count - 1 loop
      v_ps := public._rental_period_start(v_anchor, p_rent_cycle, v_i, v_cv, v_cu);
      v_pe := public._rental_period_start(v_anchor, p_rent_cycle, v_i + 1, v_cv, v_cu) - 1;
      v_amount := public._rental_escalated_amount(p_cycle_amount, v_pct, v_anchor, v_ps);
      insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
      values (p_club_id, v_space.branch_id, v_contract_id, 'rent', v_i + 1 + v_offset, v_ps, v_pe, v_ps, v_amount)
      returning id into v_inst_id;
      if v_first_rent is null then
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
      'security_deposit', coalesce(p_security_deposit, 0), 'renewed_from', p_renewed_from,
      'prorated_first', v_prorate),
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
  p_start_time time default null,
  p_prorate_first boolean default false
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
      p_idempotency_key, p_annual_increase_pct, p_start_time, null, p_prorate_first) r;
end;
$$;

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
  v_amount := coalesce(p_cycle_amount, round(coalesce(v_last_amount, v_src.cycle_amount) * (1 + v_pct / 100.0), 2));

  return query
    select r.contract_id, r.contract_number, r.invoice_id, r.deposit_invoice_id
    from public._rental_create_contract_internal(
      v_src.club_id, v_src.space_id, v_src.customer_id, v_src.end_date + 1, v_src.rent_cycle,
      coalesce(p_cycles_count, v_src.cycles_count), v_amount, v_src.custom_cycle_value, v_src.custom_cycle_unit,
      0, v_src.notes, p_issue_first_invoice, p_idempotency_key, v_pct, null, v_src.id, false) r;
end;
$$;

-- Editing: extensions continue from the schedule anchor (pro-rated
-- contracts have one extra, partial, installment before it).
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
  v_anchor date;
  v_offset integer;
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
  v_anchor := coalesce(v_c.schedule_anchor, v_c.start_date);
  v_offset := case when v_c.prorated_first then 1 else 0 end;

  if p_new_cycle_amount is not null then
    v_from := coalesce(p_effective_from, public._rental_club_today(v_c.club_id));
    update public.rental_installments ri
    set amount = case when v_c.rent_cycle = 'hourly'
                      then round(p_new_cycle_amount * v_c.cycles_count, 2)
                      else public._rental_escalated_amount(p_new_cycle_amount, v_c.annual_increase_pct, v_from, ri.period_start) end,
        updated_at = now()
    where ri.contract_id = v_c.id and ri.kind = 'rent' and ri.status = 'scheduled' and ri.period_start >= v_from
      and ri.note is null;
    get diagnostics v_changed = row_count;
  end if;

  if coalesce(p_extend_cycles, 0) > 0 then
    v_new_end := public._rental_period_start(v_anchor, v_c.rent_cycle, v_c.cycles_count + p_extend_cycles,
                                             v_c.custom_cycle_value, v_c.custom_cycle_unit) - 1;
    select * into v_space from public.rental_spaces where id = v_c.space_id;
    if not v_space.allow_overlapping_contracts
       and public._rental_space_has_conflict(v_c.space_id, v_c.end_date + 1, v_new_end, null, null, v_c.id) then
      raise exception 'this space is already rented for overlapping dates';
    end if;
    v_base := coalesce(p_new_cycle_amount, v_c.cycle_amount);
    for v_i in v_c.cycles_count .. v_c.cycles_count + p_extend_cycles - 1 loop
      v_ps := public._rental_period_start(v_anchor, v_c.rent_cycle, v_i, v_c.custom_cycle_value, v_c.custom_cycle_unit);
      v_pe := public._rental_period_start(v_anchor, v_c.rent_cycle, v_i + 1, v_c.custom_cycle_value, v_c.custom_cycle_unit) - 1;
      insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount)
      values (v_c.club_id, v_c.branch_id, v_c.id, 'rent', v_i + 1 + v_offset, v_ps, v_pe, v_ps,
              case when p_new_cycle_amount is not null
                   then public._rental_escalated_amount(v_base, v_c.annual_increase_pct, coalesce(p_effective_from, v_anchor), v_ps)
                   else public._rental_escalated_amount(v_base, v_c.annual_increase_pct, v_anchor, v_ps) end);
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
-- 4. Settings (VAT, expiry alerts)
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
    'vat_rate', coalesce(v_s.vat_rate, 0),
    'expiry_alert_days', coalesce(v_s.expiry_alert_days, 30),
    'whatsapp_templates_live', public._rental_whatsapp_templates_live()
  );
end;
$$;

alter function public.update_rental_settings(uuid, boolean, integer, text, numeric, integer, boolean, integer)
  rename to _retired_update_rental_settings_v2;
revoke all on function public._retired_update_rental_settings_v2(uuid, boolean, integer, text, numeric, integer, boolean, integer) from public, anon, authenticated;

create or replace function public.update_rental_settings(
  p_club_id uuid,
  p_auto_issue_invoices boolean,
  p_issue_days_before integer,
  p_late_fee_type text,
  p_late_fee_value numeric,
  p_late_fee_grace_days integer,
  p_whatsapp_reminders_enabled boolean,
  p_reminder_days_before integer,
  p_vat_rate numeric default 0,
  p_expiry_alert_days integer default 30
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
    whatsapp_reminders_enabled, reminder_days_before, vat_rate, expiry_alert_days, updated_at, updated_by
  ) values (
    p_club_id, p_auto_issue_invoices, p_issue_days_before, p_late_fee_type, coalesce(p_late_fee_value, 0),
    p_late_fee_grace_days, p_whatsapp_reminders_enabled, p_reminder_days_before,
    coalesce(p_vat_rate, 0), coalesce(p_expiry_alert_days, 30), now(), auth.uid()
  )
  on conflict (club_id) do update set
    auto_issue_invoices = excluded.auto_issue_invoices,
    issue_days_before = excluded.issue_days_before,
    late_fee_type = excluded.late_fee_type,
    late_fee_value = excluded.late_fee_value,
    late_fee_grace_days = excluded.late_fee_grace_days,
    whatsapp_reminders_enabled = excluded.whatsapp_reminders_enabled,
    reminder_days_before = excluded.reminder_days_before,
    vat_rate = excluded.vat_rate,
    expiry_alert_days = excluded.expiry_alert_days,
    updated_at = now(),
    updated_by = auth.uid();

  perform public.write_audit_log(p_club_id, 'rental.settings.updated', 'rental_settings', null,
    to_jsonb(v_before),
    jsonb_build_object('auto_issue_invoices', p_auto_issue_invoices, 'issue_days_before', p_issue_days_before,
      'late_fee_type', p_late_fee_type, 'late_fee_value', p_late_fee_value, 'late_fee_grace_days', p_late_fee_grace_days,
      'whatsapp_reminders_enabled', p_whatsapp_reminders_enabled, 'reminder_days_before', p_reminder_days_before,
      'vat_rate', p_vat_rate, 'expiry_alert_days', p_expiry_alert_days),
    null);
end;
$$;

-- ============================================================
-- 5. Daily jobs: expiry alerts
-- ============================================================
create or replace function public._rental_raise_expiry_alerts(p_club_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today date := public._rental_club_today(p_club_id);
  v_days integer;
  v_n integer;
begin
  select coalesce(s.expiry_alert_days, 30) into v_days from public.rental_settings s where s.club_id = p_club_id;
  v_days := coalesce(v_days, 30);
  if v_days = 0 then
    return 0;
  end if;
  -- One alert at the configured lead time, then again at 7 days and on
  -- the last day; only for active leases that are not yet renewed.
  insert into public.rental_staff_alerts (club_id, contract_id, kind, days_left, end_date)
  select y.club_id, y.id, 'contract_expiring', y.d, y.end_date
  from (
    -- the tightest threshold the lease has reached today
    select rc.club_id, rc.id, rc.end_date, min(x.d) as d
    from public.rental_contracts rc
    cross join (select distinct unnest(array[v_days, 7, 0]) as d) x
    where rc.club_id = p_club_id and rc.status = 'active' and rc.rent_cycle <> 'hourly'
      and x.d <= v_days
      and rc.end_date - v_today between 0 and x.d
      and not exists (select 1 from public.rental_contracts nx where nx.renewed_from_contract_id = rc.id and nx.status <> 'cancelled')
    group by rc.club_id, rc.id, rc.end_date
  ) y
  where not exists (select 1 from public.rental_staff_alerts a
                    where a.contract_id = y.id and a.kind = 'contract_expiring' and a.end_date = y.end_date and a.days_left <= y.d)
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public._rental_raise_expiry_alerts(uuid) from public, anon, authenticated;
grant execute on function public._rental_raise_expiry_alerts(uuid) to service_role;

create or replace function public.run_rental_daily_jobs()
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club uuid;
  v_out jsonb := '[]'::jsonb;
  v_res jsonb;
begin
  for v_club in
    select cm.club_id from public.club_modules cm
    where cm.module_key = 'rentals' and cm.entitled and cm.active
      and exists (select 1 from public.rental_contracts rc where rc.club_id = cm.club_id and rc.status in ('active', 'terminated'))
  loop
    begin
      v_res := public._rental_daily_jobs_for_club(v_club);
      v_res := v_res || jsonb_build_object('expiry_alerts', public._rental_raise_expiry_alerts(v_club));
      v_out := v_out || jsonb_build_array(v_res);
    exception when others then
      v_out := v_out || jsonb_build_array(jsonb_build_object('club_id', v_club, 'error', sqlerrm));
    end;
  end loop;
  return v_out;
end;
$$;

create or replace function public.list_rental_alerts(p_club_id uuid, p_include_read boolean default false)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'kind', a.kind, 'days_left', a.days_left, 'end_date', a.end_date, 'created_at', a.created_at,
      'read_at', a.read_at, 'contract_id', rc.id, 'contract_number', rc.contract_number,
      'customer_name', c.full_name, 'space_name', s.name,
      'renewed', exists (select 1 from public.rental_contracts nx where nx.renewed_from_contract_id = rc.id and nx.status <> 'cancelled')
    ) order by a.read_at nulls first, a.end_date, a.days_left)
    from public.rental_staff_alerts a
    join public.rental_contracts rc on rc.id = a.contract_id
    join public.customers c on c.id = rc.customer_id
    join public.rental_spaces s on s.id = rc.space_id
    where a.club_id = p_club_id and (p_include_read or a.read_at is null)
      and public.user_has_branch_access(p_club_id, rc.branch_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.mark_rental_alerts_read(p_club_id uuid, p_alert_ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  update public.rental_staff_alerts a set read_at = now(), read_by = auth.uid()
  from public.rental_contracts rc
  where rc.id = a.contract_id and public.user_has_branch_access(p_club_id, rc.branch_id)
    and a.club_id = p_club_id and a.read_at is null and (p_alert_ids is null or a.id = any(p_alert_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ============================================================
-- 6. Customer portal: invoice ids + online hall booking
-- ============================================================
create or replace function public.get_my_portal_invoices()
returns table(invoice_id uuid, invoice_number text, total numeric, status text, issued_at timestamptz, created_at timestamptz, customer_id uuid, club_id uuid)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select i.id, i.invoice_number, i.total, i.status, i.issued_at, i.created_at, i.customer_id, i.club_id
  from public.invoices i
  where i.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
  order by i.created_at desc
  limit 100;
$$;

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
        -- what the tenant actually pays: invoiced amounts include their
        -- invoice's VAT share
        'due_date', st.due_date,
        'amount', round(st.amount * coalesce(vf.factor, 1), 2),
        'paid', round(st.paid * coalesce(vf.factor, 1), 2),
        'outstanding', round(st.outstanding * coalesce(vf.factor, 1), 2),
        'payment_state', st.payment_state, 'invoice_number', st.invoice_number,
        'invoice_id', case when st.invoice_status = 'issued' then st.invoice_id end
      ) order by st.due_date, st.sequence)
      from st
      left join lateral (
        select coalesce(
          (select i.total / nullif(i.total - i.tax, 0) from public.invoices i
           where i.id = st.invoice_id and st.invoice_status = 'issued'),
          case when st.kind <> 'deposit' and (st.invoice_id is null or st.invoice_status = 'void')
               then 1 + coalesce((select rs.vat_rate from public.rental_settings rs where rs.club_id = rc.club_id), 0) / 100.0 end,
          1) as factor
      ) vf on true
      where st.contract_id = rc.id and st.payment_state <> 'cancelled'
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

create or replace function public.set_rental_space_online_booking(p_space_id uuid, p_enabled boolean)
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
  select * into v_space from public.rental_spaces s
  where s.id = p_space_id and s.club_id in (select public.user_club_ids())
    and public.has_permission('rental.space.manage', s.club_id);
  if v_space.id is null or not public.user_has_branch_access(v_space.club_id, v_space.branch_id) then
    raise exception 'rental space not found';
  end if;
  if p_enabled and (v_space.default_rent_cycle is distinct from 'hourly' or coalesce(v_space.default_rent_amount, 0) <= 0) then
    raise exception 'online booking needs an hourly default rent cycle and an hourly price on the space';
  end if;
  update public.rental_spaces set online_booking = p_enabled, updated_at = now() where id = p_space_id;
  perform public.write_audit_log(v_space.club_id, 'rental.space.online_booking_changed', 'rental_space', p_space_id,
    jsonb_build_object('online_booking', v_space.online_booking), jsonb_build_object('online_booking', p_enabled), null);
end;
$$;

-- Spaces a signed-in customer of this club can request online, with the
-- busy slots of the next 60 days (times only -- never other tenants'
-- names).
create or replace function public.get_portal_bookable_spaces(p_club_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_today date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not exists (select 1 from public.customers c where c.club_id = p_club_id and c.user_id = auth.uid()) then
    raise exception 'not authorized';
  end if;
  if not public._rentals_module_active(p_club_id) then
    return '[]'::jsonb;
  end if;
  v_today := public._rental_club_today(p_club_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'name', s.name, 'space_type', s.space_type, 'custom_type_label', s.custom_type_label,
      'description', s.description, 'capacity', s.capacity, 'branch_name', b.name,
      'hourly_rate', s.default_rent_amount,
      'busy', coalesce((
        select jsonb_agg(jsonb_build_object('date', rc.start_date, 'end_date', public._rental_contract_occupancy_end(rc),
                                            'start_time', rc.start_time, 'end_time', rc.end_time)
                         order by rc.start_date, rc.start_time)
        from public.rental_contracts rc
        where rc.space_id = s.id and rc.status in ('active', 'terminated')
          and public._rental_contract_occupancy_end(rc) >= v_today and rc.start_date <= v_today + 60
      ), '[]'::jsonb)
    ) order by s.name)
    from public.rental_spaces s
    join public.branches b on b.id = s.branch_id
    where s.club_id = p_club_id and s.status = 'active' and s.online_booking
  ), '[]'::jsonb);
end;
$$;

create or replace function public.request_rental_booking(
  p_space_id uuid, p_booking_date date, p_start_time time, p_hours integer, p_notes text default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_space public.rental_spaces;
  v_customer uuid;
  v_end time;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_space from public.rental_spaces where id = p_space_id;
  if v_space.id is null or not v_space.online_booking or v_space.status <> 'active'
     or not public._rentals_module_active(v_space.club_id) then
    raise exception 'this space cannot be booked online';
  end if;
  select c.id into v_customer from public.customers c where c.club_id = v_space.club_id and c.user_id = auth.uid() limit 1;
  if v_customer is null then
    raise exception 'not authorized';
  end if;
  if p_booking_date is null or p_booking_date < public._rental_club_today(v_space.club_id) then
    raise exception 'the booking date must be today or later';
  end if;
  if p_start_time is null or p_hours is null or p_hours < 1 or p_hours > 24 then
    raise exception 'an hourly booking cannot exceed 24 hours';
  end if;
  v_end := public._rental_hourly_end_time(p_start_time, p_hours);
  if v_end is null then
    raise exception 'an hourly booking must end on the same day';
  end if;
  if not v_space.allow_overlapping_contracts
     and public._rental_space_has_conflict(p_space_id, p_booking_date, p_booking_date, p_start_time, v_end, null) then
    raise exception 'this space is already rented for overlapping dates';
  end if;
  if (select count(*) from public.rental_booking_requests r where r.customer_id = v_customer and r.status = 'pending') >= 5 then
    raise exception 'you already have too many pending booking requests';
  end if;

  insert into public.rental_booking_requests (club_id, branch_id, space_id, customer_id, requested_by, booking_date, start_time, hours, notes)
  values (v_space.club_id, v_space.branch_id, v_space.id, v_customer, auth.uid(), p_booking_date, p_start_time, p_hours,
          nullif(trim(coalesce(p_notes, '')), ''))
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.cancel_my_rental_booking_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  update public.rental_booking_requests r set status = 'cancelled', decided_at = now()
  where r.id = p_request_id and r.status = 'pending'
    and r.customer_id in (select c.id from public.customers c where c.user_id = auth.uid());
  if not found then
    raise exception 'booking request not found or no longer pending';
  end if;
end;
$$;

create or replace function public.get_my_rental_booking_requests()
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id, 'club_id', r.club_id, 'space_name', s.name, 'booking_date', r.booking_date,
    'start_time', r.start_time, 'hours', r.hours, 'status', r.status, 'notes', r.notes,
    'decision_note', r.decision_note, 'created_at', r.created_at, 'hourly_rate', s.default_rent_amount
  ) order by r.created_at desc), '[]'::jsonb)
  from public.rental_booking_requests r
  join public.rental_spaces s on s.id = r.space_id
  where r.customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
$$;

create or replace function public.list_rental_booking_requests(p_club_id uuid, p_status text default 'pending')
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('rental.view', p_club_id)) then
    raise exception 'not authorized';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'space_id', r.space_id, 'space_name', s.name, 'customer_id', r.customer_id,
      'customer_name', c.full_name, 'customer_mobile', c.mobile_display,
      'booking_date', r.booking_date, 'start_time', r.start_time, 'hours', r.hours,
      'hourly_rate', s.default_rent_amount, 'notes', r.notes, 'status', r.status,
      'contract_id', r.contract_id, 'decision_note', r.decision_note, 'created_at', r.created_at,
      'conflict', r.status = 'pending' and s.allow_overlapping_contracts is false and public._rental_space_has_conflict(
        r.space_id, r.booking_date, r.booking_date, r.start_time,
        coalesce(public._rental_hourly_end_time(r.start_time, r.hours), '24:00:00'::time), null)
    ) order by r.booking_date, r.start_time)
    from public.rental_booking_requests r
    join public.rental_spaces s on s.id = r.space_id
    join public.customers c on c.id = r.customer_id
    where r.club_id = p_club_id and (p_status is null or p_status = 'all' or r.status = p_status)
      and public.user_has_branch_access(p_club_id, r.branch_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.decide_rental_booking_request(
  p_request_id uuid, p_approve boolean, p_note text default null, p_issue_invoice boolean default true
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_r public.rental_booking_requests;
  v_space public.rental_spaces;
  v_contract uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_r from public.rental_booking_requests r
  where r.id = p_request_id and r.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.create', r.club_id)
  for update;
  if v_r.id is null or not public.user_has_branch_access(v_r.club_id, v_r.branch_id) then
    raise exception 'booking request not found';
  end if;
  if v_r.status <> 'pending' then
    raise exception 'booking request not found or no longer pending';
  end if;

  if p_approve then
    if not public._rentals_module_active(v_r.club_id) then
      raise exception 'the rentals module is not active for this club';
    end if;
    if not public.club_write_allowed(v_r.club_id, 'new_commitment') then
      raise exception 'club subscription does not allow new commitments';
    end if;
    select * into v_space from public.rental_spaces where id = v_r.space_id;
    select r.contract_id into v_contract
    from public._rental_create_contract_internal(
      v_r.club_id, v_r.space_id, v_r.customer_id, v_r.booking_date, 'hourly', v_r.hours,
      coalesce(v_space.default_rent_amount, 0), null, null, 0,
      coalesce(v_r.notes, 'حجز أونلاين من بوابة العميل'), coalesce(p_issue_invoice, true), gen_random_uuid(), 0,
      v_r.start_time, null, false) r;
    update public.rental_booking_requests set status = 'approved', contract_id = v_contract,
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '')
    where id = v_r.id;
  else
    update public.rental_booking_requests set status = 'rejected',
      decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '')
    where id = v_r.id;
  end if;

  perform public.write_audit_log(v_r.club_id,
    case when p_approve then 'rental.booking_request.approved' else 'rental.booking_request.rejected' end,
    'rental_booking_request', v_r.id, null,
    jsonb_build_object('contract_id', v_contract, 'note', p_note), null);
  return v_contract;
end;
$$;

-- ============================================================
-- 7. Contract documents
-- ============================================================
create or replace function public.add_rental_contract_document(
  p_contract_id uuid, p_storage_path text, p_file_name text, p_doc_type text default 'other',
  p_mime_type text default null, p_size_bytes bigint default null
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c public.rental_contracts;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_c from public.rental_contracts rc
  where rc.id = p_contract_id and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.create', rc.club_id);
  if v_c.id is null or not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'rental contract not found';
  end if;
  if p_storage_path is null or p_storage_path not like v_c.club_id::text || '/' || v_c.id::text || '/%' then
    raise exception 'invalid document path';
  end if;
  insert into public.rental_contract_documents (club_id, contract_id, doc_type, file_name, storage_path, mime_type, size_bytes, uploaded_by)
  values (v_c.club_id, v_c.id, coalesce(p_doc_type, 'other'), left(coalesce(nullif(trim(p_file_name), ''), 'document'), 200),
          p_storage_path, p_mime_type, p_size_bytes, auth.uid())
  returning id into v_id;
  perform public.write_audit_log(v_c.club_id, 'rental.document.added', 'rental_contract', v_c.id, null,
    jsonb_build_object('document_id', v_id, 'doc_type', p_doc_type, 'file_name', p_file_name), null);
  return v_id;
end;
$$;

create or replace function public.list_rental_contract_documents(p_contract_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c public.rental_contracts;
begin
  select * into v_c from public.rental_contracts rc
  where rc.id = p_contract_id and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', rc.club_id);
  if v_c.id is null or not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'rental contract not found';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', d.id, 'doc_type', d.doc_type, 'file_name', d.file_name,
      'storage_path', d.storage_path, 'mime_type', d.mime_type, 'size_bytes', d.size_bytes, 'created_at', d.created_at)
      order by d.created_at desc)
    from public.rental_contract_documents d where d.contract_id = p_contract_id and d.deleted_at is null
  ), '[]'::jsonb);
end;
$$;

create or replace function public.delete_rental_contract_document(p_document_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_d public.rental_contract_documents;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select d.* into v_d from public.rental_contract_documents d
  join public.rental_contracts rc on rc.id = d.contract_id
  where d.id = p_document_id and d.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.manage', d.club_id)
    and public.user_has_branch_access(rc.club_id, rc.branch_id)
    and d.deleted_at is null;
  if v_d.id is null then
    raise exception 'document not found';
  end if;
  update public.rental_contract_documents set deleted_at = now(), deleted_by = auth.uid() where id = v_d.id;
  perform public.write_audit_log(v_d.club_id, 'rental.document.deleted', 'rental_contract', v_d.contract_id,
    jsonb_build_object('document_id', v_d.id, 'file_name', v_d.file_name), null, null);
  return v_d.storage_path;
end;
$$;

-- ============================================================
-- 8. Utility meters
-- ============================================================
create or replace function public.upsert_rental_meter(
  p_contract_id uuid, p_meter_id uuid, p_meter_type text, p_label text, p_unit_price numeric,
  p_initial_reading numeric default 0, p_active boolean default true
) returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c public.rental_contracts;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_c from public.rental_contracts rc
  where rc.id = p_contract_id and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.manage', rc.club_id);
  if v_c.id is null or not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'rental contract not found or you do not have permission to manage it';
  end if;
  if p_meter_type not in ('electricity', 'water', 'gas', 'other') then
    raise exception 'invalid meter type';
  end if;
  if p_unit_price is null or p_unit_price < 0 then
    raise exception 'unit price must not be negative';
  end if;
  if p_meter_id is null then
    insert into public.rental_meters (club_id, contract_id, meter_type, label, unit_price, last_reading, created_by)
    values (v_c.club_id, v_c.id, p_meter_type, nullif(trim(coalesce(p_label, '')), ''), p_unit_price,
            greatest(coalesce(p_initial_reading, 0), 0), auth.uid())
    returning id into v_id;
  else
    update public.rental_meters set meter_type = p_meter_type, label = nullif(trim(coalesce(p_label, '')), ''),
      unit_price = p_unit_price, active = coalesce(p_active, true)
    where id = p_meter_id and contract_id = v_c.id
    returning id into v_id;
    if v_id is null then
      raise exception 'meter not found';
    end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.record_rental_meter_reading(
  p_meter_id uuid, p_reading numeric, p_reading_date date default null,
  p_issue_invoice boolean default true, p_idempotency_key uuid default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_m public.rental_meters;
  v_c public.rental_contracts;
  v_existing public.rental_meter_readings;
  v_consumption numeric;
  v_amount numeric;
  v_inst uuid;
  v_invoice uuid;
  v_seq integer;
  v_date date;
  v_type_label text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select m.* into v_m from public.rental_meters m
  where m.id = p_meter_id and m.club_id in (select public.user_club_ids())
    and public.has_permission('rental.contract.create', m.club_id)
  for update;
  if v_m.id is null then
    raise exception 'meter not found';
  end if;
  select * into v_c from public.rental_contracts where id = v_m.contract_id;
  if not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'you do not have access to this branch';
  end if;
  if p_idempotency_key is not null then
    select * into v_existing from public.rental_meter_readings where meter_id = v_m.id and idempotency_key = p_idempotency_key;
    if v_existing.id is not null then
      return jsonb_build_object('reading_id', v_existing.id, 'amount', v_existing.amount,
        'invoice_id', (select invoice_id from public.rental_installments where id = v_existing.installment_id));
    end if;
  end if;
  if v_c.status = 'cancelled' then
    raise exception 'this rental contract is cancelled';
  end if;
  if not v_m.active then
    raise exception 'this meter is inactive';
  end if;
  if p_reading is null or p_reading < v_m.last_reading then
    raise exception 'the new reading cannot be lower than the previous reading (%)', v_m.last_reading;
  end if;
  v_date := least(coalesce(p_reading_date, public._rental_club_today(v_c.club_id)), public._rental_club_today(v_c.club_id));
  v_consumption := p_reading - v_m.last_reading;
  v_amount := round(v_consumption * v_m.unit_price, 2);
  v_type_label := case v_m.meter_type when 'electricity' then 'كهرباء' when 'water' then 'مياه' when 'gas' then 'غاز' else 'مرافق' end;

  if v_amount > 0 then
    select coalesce(max(sequence), 20000) + 1 into v_seq from public.rental_installments
    where contract_id = v_c.id and kind = 'utility';
    insert into public.rental_installments (club_id, branch_id, contract_id, kind, sequence, period_start, period_end, due_date, amount, note)
    values (v_c.club_id, v_c.branch_id, v_c.id, 'utility', v_seq, v_date, v_date, v_date, v_amount,
            'استهلاك ' || v_type_label || coalesce(' (' || v_m.label || ')', '') || ': '
              || trim(to_char(v_m.last_reading, 'FM999999999990.###')) || ' → ' || trim(to_char(p_reading, 'FM999999999990.###'))
              || ' = ' || trim(to_char(v_consumption, 'FM999999999990.###')))
    returning id into v_inst;
    -- Always invoiced at once: nothing else picks up utility
    -- installments later (p_issue_invoice is kept for API stability).
    v_invoice := public._rental_issue_invoice_internal(v_c.id, array[v_inst], 0);
  end if;

  insert into public.rental_meter_readings (club_id, meter_id, contract_id, reading_date, previous_reading, current_reading,
                                            consumption, unit_price, amount, installment_id, idempotency_key, created_by)
  values (v_m.club_id, v_m.id, v_c.id, v_date, v_m.last_reading, p_reading, v_consumption, v_m.unit_price, v_amount,
          v_inst, p_idempotency_key, auth.uid());
  update public.rental_meters set last_reading = p_reading where id = v_m.id;

  perform public.write_audit_log(v_c.club_id, 'rental.meter.reading', 'rental_contract', v_c.id, null,
    jsonb_build_object('meter_id', v_m.id, 'reading', p_reading, 'consumption', v_consumption, 'amount', v_amount,
                       'invoice_id', v_invoice), null);
  return jsonb_build_object('consumption', v_consumption, 'amount', v_amount, 'invoice_id', v_invoice);
end;
$$;

create or replace function public.list_rental_meters(p_contract_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_c public.rental_contracts;
begin
  select * into v_c from public.rental_contracts rc
  where rc.id = p_contract_id and rc.club_id in (select public.user_club_ids())
    and public.has_permission('rental.view', rc.club_id);
  if v_c.id is null or not public.user_has_branch_access(v_c.club_id, v_c.branch_id) then
    raise exception 'rental contract not found';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', m.id, 'meter_type', m.meter_type, 'label', m.label, 'unit_price', m.unit_price,
      'last_reading', m.last_reading, 'active', m.active,
      'readings', coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'reading_date', r.reading_date, 'previous_reading', r.previous_reading,
          'current_reading', r.current_reading, 'consumption', r.consumption, 'amount', r.amount,
          'invoice_id', ri.invoice_id) order by r.created_at desc)
        from public.rental_meter_readings r
        left join public.rental_installments ri on ri.id = r.installment_id
        where r.meter_id = m.id
      ), '[]'::jsonb)
    ) order by m.created_at)
    from public.rental_meters m where m.contract_id = p_contract_id
  ), '[]'::jsonb);
end;
$$;

-- ============================================================
-- 9. Report: collected stays net of VAT; VAT and utilities reported
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
  paid_lines as (
    -- Each payment allocation split over the invoice's rental lines
    -- pro-rata, with the VAT share separated out.
    select ri.contract_id, ri.kind, ii.reference_type,
      pa.amount * ii.line_total / nullif(inv.subtotal, 0) * (inv.total - inv.tax) / nullif(inv.total, 0) as net_amount,
      pa.amount * ii.line_total / nullif(inv.subtotal, 0) * inv.tax / nullif(inv.total, 0) as vat_amount
    from public.payments p
    join public.payment_allocations pa on pa.payment_id = p.id
    join public.invoices inv on inv.id = pa.invoice_id
    join public.invoice_items ii on ii.invoice_id = inv.id and ii.reference_type in ('rental', 'rental_deposit')
    join public.rental_installments ri on ri.id = ii.reference_id
    where p.club_id = p_club_id and p.status = 'completed'
      and p.received_at >= v_range_start and p.received_at < v_range_end
      and ri.contract_id = any(v_ids)
  ),
  received as (
    select contract_id, reference_type, sum(net_amount) as amount from paid_lines group by contract_id, reference_type
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
    'utilities_collected_in_range', (select coalesce(round(sum(net_amount), 2), 0) from paid_lines where kind = 'utility'),
    'vat_collected_in_range', (select coalesce(round(sum(vat_amount), 2), 0) from paid_lines),
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

-- ============================================================
-- 10. Patches: space list (online flag), attention (requests/alerts)
-- ============================================================
select public._rentals_migration_patch_function(
  'public.list_rental_spaces(uuid, boolean)'::regprocedure,
  $x$'allow_overlapping_contracts', s.allow_overlapping_contracts, 'status', s.status,$x$,
  $x$'allow_overlapping_contracts', s.allow_overlapping_contracts, 'status', s.status,
    'online_booking', s.online_booking,$x$
);
select public._rentals_migration_patch_function(
  'public.get_rental_attention_summary(uuid)'::regprocedure,
  $x$    'module_active', true,$x$,
  $x$    'module_active', true,
    'pending_booking_requests_count', (select count(*) from public.rental_booking_requests br
                                       where br.club_id = p_club_id and br.status = 'pending'
                                         and public.user_has_branch_access(p_club_id, br.branch_id)),
    'unread_alerts_count', (select count(*) from public.rental_staff_alerts a
                            join public.rental_contracts arc on arc.id = a.contract_id
                            where a.club_id = p_club_id and a.read_at is null
                              and public.user_has_branch_access(p_club_id, arc.branch_id)),$x$
);

-- ============================================================
-- 11. Grants
-- ============================================================
revoke all on function public._rental_create_contract_internal(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, uuid, boolean) from public, anon, authenticated;
grant execute on function public._rental_create_contract_internal(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, uuid, boolean) to service_role;

revoke all on function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, boolean) from public, anon;
revoke all on function public.update_rental_settings(uuid, boolean, integer, text, numeric, integer, boolean, integer, numeric, integer) from public, anon;
revoke all on function public.list_rental_alerts(uuid, boolean) from public, anon;
revoke all on function public.mark_rental_alerts_read(uuid, uuid[]) from public, anon;
revoke all on function public.set_rental_space_online_booking(uuid, boolean) from public, anon;
revoke all on function public.get_portal_bookable_spaces(uuid) from public, anon;
revoke all on function public.request_rental_booking(uuid, date, time, integer, text) from public, anon;
revoke all on function public.cancel_my_rental_booking_request(uuid) from public, anon;
revoke all on function public.get_my_rental_booking_requests() from public, anon;
revoke all on function public.list_rental_booking_requests(uuid, text) from public, anon;
revoke all on function public.decide_rental_booking_request(uuid, boolean, text, boolean) from public, anon;
revoke all on function public.add_rental_contract_document(uuid, text, text, text, text, bigint) from public, anon;
revoke all on function public.list_rental_contract_documents(uuid) from public, anon;
revoke all on function public.delete_rental_contract_document(uuid) from public, anon;
revoke all on function public.upsert_rental_meter(uuid, uuid, text, text, numeric, numeric, boolean) from public, anon;
revoke all on function public.record_rental_meter_reading(uuid, numeric, date, boolean, uuid) from public, anon;
revoke all on function public.list_rental_meters(uuid) from public, anon;

grant execute on function public.create_rental_contract(uuid, uuid, uuid, date, text, integer, numeric, integer, text, numeric, text, boolean, uuid, numeric, time, boolean) to authenticated, service_role;
grant execute on function public.update_rental_settings(uuid, boolean, integer, text, numeric, integer, boolean, integer, numeric, integer) to authenticated, service_role;
grant execute on function public.list_rental_alerts(uuid, boolean) to authenticated, service_role;
grant execute on function public.mark_rental_alerts_read(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.set_rental_space_online_booking(uuid, boolean) to authenticated, service_role;
grant execute on function public.get_portal_bookable_spaces(uuid) to authenticated, service_role;
grant execute on function public.request_rental_booking(uuid, date, time, integer, text) to authenticated, service_role;
grant execute on function public.cancel_my_rental_booking_request(uuid) to authenticated, service_role;
grant execute on function public.get_my_rental_booking_requests() to authenticated, service_role;
grant execute on function public.list_rental_booking_requests(uuid, text) to authenticated, service_role;
grant execute on function public.decide_rental_booking_request(uuid, boolean, text, boolean) to authenticated, service_role;
grant execute on function public.add_rental_contract_document(uuid, text, text, text, text, bigint) to authenticated, service_role;
grant execute on function public.list_rental_contract_documents(uuid) to authenticated, service_role;
grant execute on function public.delete_rental_contract_document(uuid) to authenticated, service_role;
grant execute on function public.upsert_rental_meter(uuid, uuid, text, text, numeric, numeric, boolean) to authenticated, service_role;
grant execute on function public.record_rental_meter_reading(uuid, numeric, date, boolean, uuid) to authenticated, service_role;
grant execute on function public.list_rental_meters(uuid) to authenticated, service_role;
