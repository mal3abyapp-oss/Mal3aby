-- Master Payment Directive Phase 5-6 (task #82): configurable tenant
-- payment methods.
--
-- Design decision: payments.method stays the small, stable enum
-- ('cash','card','bank_transfer','wallet','other') used for actual
-- money-movement bookkeeping -- it's what cash-shift reconciliation
-- (Gate 13 #62) and the collections report (#58) already key off, and
-- widening that enum touches every RPC that validates it
-- (record_payment, _create_booking_internal, subscription payment
-- paths, the payment reversal path). Rewriting it is NOT justified by
-- this task; per the directive's own Part II Section 16 (REUSE ->
-- EXTEND -> NORMALIZE, never DUPLICATE) the correct move is a new
-- table that maps ONTO that existing enum with the rich per-tenant
-- display/instruction layer the directive actually asks for (a phone
-- number, an IBAN, a provider name, customer visibility, display
-- order) -- not a second competing payment-recording system.
create table public.payment_method_configs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  -- Which payments.method value a payment recorded against this config
  -- actually gets stored as. 'other' covers fully custom manual methods.
  underlying_method text not null check (underlying_method in ('cash', 'card', 'bank_transfer', 'wallet', 'other')),
  provider text, -- e.g. 'instapay', 'vodafone_cash', 'orange_cash', 'stripe', 'paypal', null for plain cash/generic bank/custom
  name_ar text not null,
  name_en text not null,
  instructions_ar text,
  instructions_en text,
  -- Public payment-collection details (phone/link/account holder/
  -- account number/IBAN/SWIFT/branch) kept as one flexible jsonb blob
  -- rather than a wide sparse column set, since InstaPay/wallet/bank
  -- each need a different subset of fields (Sections 31-36).
  details jsonb not null default '{}'::jsonb,
  reference_required boolean not null default false,
  proof_required boolean not null default false,
  customer_visible boolean not null default true,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.payment_method_configs enable row level security;

-- Section 97 tenant isolation: staff of club A can never see club B's
-- bank accounts / InstaPay numbers / gateway configuration.
create policy "payment_method_configs_select_club_staff" on public.payment_method_configs
  for select using (club_id in (select public.user_club_ids()));

create policy "payment_method_configs_write_with_permission" on public.payment_method_configs
  for all using (
    club_id in (select public.user_club_ids())
    and public.has_permission('payment.methods.manage', club_id)
  )
  with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('payment.methods.manage', club_id)
  );

-- Customers (portal, self-service) may read only the active + visible
-- methods of their OWN club at checkout -- never inactive/hidden
-- entries (which may carry stale or intentionally-unpublished bank
-- details), and never another club's configuration.
create policy "payment_method_configs_select_customer_own_club" on public.payment_method_configs
  for select using (
    is_active = true
    and customer_visible = true
    and club_id in (select c.club_id from public.customers c where c.user_id = auth.uid())
  );

comment on table public.payment_method_configs is
  'Master Payment Directive task #82: per-tenant configurable payment methods (Cash/InstaPay/Wallet/Bank/POS/Custom), each mapped onto the existing payments.method enum. details jsonb holds method-specific public collection info (phone/link/IBAN/etc per Sections 31-36).';

drop trigger if exists trg_payment_method_configs_updated_at on public.payment_method_configs;
create trigger trg_payment_method_configs_updated_at
  before update on public.payment_method_configs
  for each row execute function public.set_updated_at();

-- ============================================================
-- Seed the new payment.methods.* permissions (Section 98).
-- ============================================================
insert into public.permissions (key, description) values
  ('payment.methods.view', 'View configured payment methods'),
  ('payment.methods.manage', 'Create/edit/disable payment methods and their bank/InstaPay/wallet details')
on conflict (key) do nothing;

-- club_owner, club_manager, branch_manager: full manage (same tier as
-- field.update/pricing.update -- settings-level, not front-desk).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager', 'branch_manager')
  and p.key in ('payment.methods.view', 'payment.methods.manage')
on conflict do nothing;

-- receptionist, accountant: view only -- they need to see instructions
-- to relay to a customer at checkout, but must not edit bank details.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('receptionist', 'accountant')
  and p.key = 'payment.methods.view'
on conflict do nothing;

-- Seed one default Cash method per existing club so payment.create's
-- callers always have at least one active, customer-visible method to
-- select -- never leaves an existing club with an empty checkout list.
-- No unique constraint to conflict on (a club may legitimately want
-- more than one cash-mapped config later), so guard with not exists
-- instead of on conflict.
insert into public.payment_method_configs (club_id, underlying_method, name_ar, name_en, customer_visible, display_order)
select c.id, 'cash', 'نقدًا', 'Cash', true, 0
from public.clubs c
where not exists (
  select 1 from public.payment_method_configs pmc where pmc.club_id = c.id
);
