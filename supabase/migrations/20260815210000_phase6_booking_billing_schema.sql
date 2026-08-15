-- Phase 6 — Booking Engine: base schema.
-- Includes the minimal billing schema (invoices/invoice_items/payments/
-- payment_allocations/invoice_number_sequences) since create_booking's
-- "validate -> booking -> invoice -> optional payment -> allocation" flow
-- (IMPLEMENTATION_PLAN.md Phase 6) structurally depends on them, even
-- though DATABASE_BLUEPRINT.md lists their full spec under Phase 7. Built
-- here at the minimal scope Phase 6 needs; Phase 7 adds refunds,
-- outstanding_invoices, and the rest of the billing-domain UI on top of
-- these same tables, per the Documentation authority order (a phase
-- cannot function without tables its own RPC contract requires).

-- ============================================================
-- invoice_number_sequences (built first -- invoices FK-adjacent nothing,
-- but numbering must exist before the invoice-creation helper is written)
-- ============================================================
create table public.invoice_number_sequences (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id),
  year int not null,
  last_number bigint not null default 0,
  unique (branch_id, year)
);
comment on table public.invoice_number_sequences is 'Concurrency-safe per-branch invoice numbering. Updated only via UPDATE ... RETURNING inside the invoice-creation helper, never a direct client write.';

-- ============================================================
-- invoices / invoice_items
-- ============================================================
create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  invoice_number text not null,
  customer_id uuid not null references public.customers(id),
  status text not null default 'draft' check (status in ('draft', 'issued', 'void')),
  subtotal numeric(12,2) not null default 0,
  discount numeric(12,2) not null default 0,
  tax numeric(12,2) not null default 0,
  total numeric(12,2) not null default 0,
  due_date date,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id),
  unique (branch_id, invoice_number)
);
comment on table public.invoices is 'Financial document, not tied to a single booking. No amount_paid/amount_remaining columns -- outstanding is always derived from payment_allocations minus refunds at query time.';

create index idx_invoices_club_id on public.invoices (club_id);
create index idx_invoices_customer_id on public.invoices (customer_id);

create trigger trg_invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id),
  description text not null,
  reference_type text not null check (reference_type in ('booking', 'subscription', 'registration_fee', 'other')),
  reference_id uuid,
  quantity numeric(10,2) not null default 1,
  unit_price numeric(12,2) not null,
  line_total numeric(12,2) not null,
  created_at timestamptz not null default now()
);
comment on table public.invoice_items is 'Line items. No hard delete once the parent invoice is issued (enforced at the RLS/RPC layer, not a DB trigger, since draft-stage edits are legitimate).';

create index idx_invoice_items_invoice_id on public.invoice_items (invoice_id);

-- ============================================================
-- payments / payment_allocations
-- ============================================================
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  method text not null check (method in ('cash', 'card', 'bank_transfer', 'wallet', 'other')),
  amount numeric(12,2) not null check (amount > 0),
  status text not null default 'completed' check (status in ('completed', 'void')),
  reference text,
  received_by uuid references auth.users(id),
  received_at timestamptz not null default now()
);
comment on table public.payments is 'Money actually received. No invoice_id column -- payment_allocations is the only payment<->invoice relationship (ADR-011b).';

create index idx_payments_club_id on public.payments (club_id);
create index idx_payments_customer_id on public.payments (customer_id);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id),
  invoice_id uuid not null references public.invoices(id),
  amount numeric(12,2) not null check (amount > 0),
  created_at timestamptz not null default now()
);
comment on table public.payment_allocations is 'Bridges payments <-> invoices many-to-many. Supports split/partial payments.';

create index idx_payment_allocations_payment_id on public.payment_allocations (payment_id);
create index idx_payment_allocations_invoice_id on public.payment_allocations (invoice_id);

-- Check trigger: SUM(payment_allocations.amount) per payment_id <= payments.amount.
create or replace function public.check_payment_allocation_sum()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_payment_amount numeric;
  v_allocated_sum numeric;
begin
  select amount into v_payment_amount from public.payments where id = new.payment_id;
  if v_payment_amount is null then
    raise exception 'payment not found';
  end if;

  select coalesce(sum(amount), 0) into v_allocated_sum
  from public.payment_allocations
  where payment_id = new.payment_id;

  if v_allocated_sum > v_payment_amount then
    raise exception 'allocation total (%) exceeds payment amount (%)', v_allocated_sum, v_payment_amount;
  end if;

  return new;
end;
$$;

create trigger trg_check_payment_allocation_sum after insert on public.payment_allocations
  for each row execute function public.check_payment_allocation_sum();

-- ============================================================
-- bookings
-- ============================================================
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  field_id uuid not null references public.fields(id),
  customer_id uuid not null references public.customers(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  during tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored,
  status text not null default 'pending_payment' check (status in ('pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show')),
  total_price numeric(12,2) not null,
  discount_amount numeric(12,2) not null default 0,
  notes text,
  cancelled_reason text,
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  marked_by uuid references auth.users(id),
  marked_at timestamptz,
  booking_series_id uuid,
  invoice_id uuid references public.invoices(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id),
  constraint bookings_valid_period check (end_at > start_at)
);
comment on table public.bookings is 'The core operational record. A recurring booking is N real rows here -- never a single row with an expanded pattern (ADR-047).';

create trigger trg_bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

-- The exclusion constraint -- the final, unconditional line of defense
-- against double-booking, enforced by Postgres itself regardless of
-- whether every RPC-level check was implemented correctly.
alter table public.bookings add constraint no_overlapping_field_bookings
  exclude using gist (field_id with =, during with &&)
  where (status in ('pending_payment', 'confirmed', 'checked_in'));

create index idx_bookings_club_id on public.bookings (club_id);
create index idx_bookings_field_id on public.bookings (field_id);
create index idx_bookings_customer_id on public.bookings (customer_id);
create index idx_bookings_series_id on public.bookings (booking_series_id);

-- ============================================================
-- booking_series
-- ============================================================
create table public.booking_series (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  field_id uuid not null references public.fields(id),
  customer_id uuid not null references public.customers(id),
  pattern_description text,
  requested_occurrences int not null,
  created_occurrences int not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
comment on table public.booking_series is 'Bookkeeping only -- never a data-integrity, conflict-checking, or financial load-bearing structure (ADR-047). Every linked booking has a fully independent financial lifecycle (ADR-052). No series_invoice concept exists.';

alter table public.bookings add constraint bookings_series_fkey
  foreign key (booking_series_id) references public.booking_series(id);

create index idx_booking_series_club_id on public.booking_series (club_id);
