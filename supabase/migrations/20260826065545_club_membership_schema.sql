-- CLUB MEMBERSHIPS domain -- schema.
--
-- Naming: club_memberships (staff roles) and subscriptions/
-- subscription_freezes (academy) already exist with different meanings
-- -- every new table uses an unambiguous club_membership_ prefix (see
-- CLUB_MEMBERSHIP_DISCOVERY.md).
--
-- Architecture: two tables (plans + subscriptions), mirroring the
-- proven academy subscriptions pattern -- one row per period, never
-- mutated, a fresh row per renewal preserves full history without a
-- separate 3rd "identity" table (the customer+club pairing across
-- multiple subscription rows already IS the membership history).

create table public.club_membership_plans (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  name_ar text not null,
  name_en text not null,
  description text,
  price numeric(12,2) not null check (price >= 0),
  duration_value integer not null check (duration_value > 0),
  duration_unit text not null check (duration_unit in ('day','month','year')),
  is_active boolean not null default true,
  is_public boolean not null default true,
  allow_renewal boolean not null default true,
  allow_freeze boolean not null default false,
  max_freeze_days_per_period integer check (max_freeze_days_per_period is null or max_freeze_days_per_period > 0),
  branch_scope text not null default 'all_branches' check (branch_scope in ('all_branches','selected_branches')),
  sort_order integer not null default 0,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id)
);

comment on table public.club_membership_plans is
  'Club Membership product definitions (a service/entitlement the club sells to customers for a fixed period). NOT academy enrollment (subscriptions table) and NOT platform SaaS billing (platform_subscriptions).';

create index club_membership_plans_club_id_idx on public.club_membership_plans(club_id);
create index club_membership_plans_active_public_idx on public.club_membership_plans(club_id, is_active, is_public) where archived_at is null;

-- Empty set = all branches, mirroring user_has_branch_access()'s own
-- "no membership_branches rows = unrestricted" convention -- but
-- branch_scope is stored explicitly too so an owner can see at a
-- glance whether a plan is deliberately club-wide vs. just has no
-- selections yet (UX clarity, not a second source of truth: server
-- logic always resolves availability from branch_scope + this table).
create table public.club_membership_plan_branches (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.club_membership_plans(id) on delete cascade,
  branch_id uuid not null references public.branches(id),
  unique (plan_id, branch_id)
);

create index club_membership_plan_branches_plan_idx on public.club_membership_plan_branches(plan_id);

-- One row per membership PERIOD (initial purchase or renewal). Never
-- mutated after creation except for: status transitions (via the
-- sanctioned bypass-trigger pattern), end_date extension on freeze
-- resume is NOT done here -- effective end date is DERIVED (mirrors
-- get_subscription_effective_end_date), base end_date is immutable
-- once set at creation, exactly like academy subscriptions.end_date.
create table public.club_membership_subscriptions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  customer_id uuid not null references public.customers(id),
  plan_id uuid not null references public.club_membership_plans(id),
  membership_number text not null,
  -- Snapshot columns: the row IS the snapshot, exactly matching
  -- subscriptions.price/plan_type -- a future plan price/name change
  -- never alters an already-sold period.
  plan_name_ar_snapshot text not null,
  plan_name_en_snapshot text not null,
  price_snapshot numeric(12,2) not null check (price_snapshot >= 0),
  duration_value_snapshot integer not null check (duration_value_snapshot > 0),
  duration_unit_snapshot text not null check (duration_unit_snapshot in ('day','month','year')),
  start_date date not null,
  end_date date not null check (end_date >= start_date),
  status text not null default 'pending_payment' check (status in ('pending_payment','scheduled','active','frozen','expired','cancelled')),
  invoice_id uuid references public.invoices(id),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancel_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

comment on table public.club_membership_subscriptions is
  'One row per Club Membership PERIOD (initial purchase or renewal) -- never mutated after creation except status/cancellation fields. A renewal always inserts a NEW row (mirrors public.subscriptions'' own non-overlapping renewal pattern) -- full history is every row for a given (club_id, customer_id).';

create index club_membership_subscriptions_club_customer_idx on public.club_membership_subscriptions(club_id, customer_id);
create index club_membership_subscriptions_club_status_idx on public.club_membership_subscriptions(club_id, status);
create index club_membership_subscriptions_invoice_idx on public.club_membership_subscriptions(invoice_id);
create index club_membership_subscriptions_plan_idx on public.club_membership_subscriptions(plan_id);
create index club_membership_subscriptions_dates_idx on public.club_membership_subscriptions(club_id, start_date, end_date);
create unique index club_membership_subscriptions_membership_number_idx on public.club_membership_subscriptions(club_id, membership_number);

-- Overlap protection: NO overlapping date ranges among non-terminal
-- periods for the same customer+club -- but an early renewal (current
-- period still active, new period scheduled to start the day after
-- current end_date) is explicitly allowed to coexist (directive
-- Section 21/19: "current active period + future scheduled renewal").
-- A plain unique index cannot express "no overlap," so this uses a
-- GiST exclusion constraint over the [start_date, end_date] daterange
-- (btree_gist already enabled in this project -- see the enable_
-- btree_gist migration from the booking domain). Two rows with
-- disjoint ranges (e.g. active ending 2026-12-31, scheduled starting
-- 2027-01-01) never overlap and are both permitted; two rows whose
-- ranges genuinely overlap are rejected at the DB layer regardless of
-- which RPC path created them -- the strongest possible guarantee
-- against concurrent-renewal double-booking (directive Section 75/77).
alter table public.club_membership_subscriptions
  add constraint club_membership_subscriptions_no_overlap
  exclude using gist (
    club_id with =,
    customer_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
  where (status in ('pending_payment','scheduled','active','frozen'));

-- Freeze rows, mirroring subscription_freezes exactly: date-range
-- based, base end_date on the subscription row is never mutated,
-- effective end date is always derived by summing freeze durations.
create table public.club_membership_freezes (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  membership_subscription_id uuid not null references public.club_membership_subscriptions(id),
  start_date date not null,
  end_date date not null check (end_date > start_date),
  reason text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

comment on table public.club_membership_freezes is
  'Date-range freeze periods for a club_membership_subscriptions row. The subscription''s own end_date is never mutated -- the effective end date is base end_date + sum(freeze durations), mirroring get_subscription_effective_end_date() exactly.';

create index club_membership_freezes_subscription_idx on public.club_membership_freezes(membership_subscription_id);

-- Idempotency table for the sale RPC, matching this project's
-- established pattern (employee_cash_liability_settlement_keys) rather
-- than reusing payments.idempotency_key alone -- the sale RPC creates
-- BOTH an invoice row AND a subscription row atomically; this key
-- guards the whole compound operation against replay, independent of
-- record_payment's own separate idempotency_key on the payment itself.
create table public.club_membership_sale_keys (
  idempotency_key uuid primary key,
  membership_subscription_id uuid not null references public.club_membership_subscriptions(id),
  created_at timestamptz not null default now()
);

alter table public.club_membership_plans enable row level security;
alter table public.club_membership_plans force row level security;
alter table public.club_membership_plan_branches enable row level security;
alter table public.club_membership_plan_branches force row level security;
alter table public.club_membership_subscriptions enable row level security;
alter table public.club_membership_subscriptions force row level security;
alter table public.club_membership_freezes enable row level security;
alter table public.club_membership_freezes force row level security;
alter table public.club_membership_sale_keys enable row level security;
alter table public.club_membership_sale_keys force row level security;

-- RLS: SELECT only for staff (all writes go through RPCs, matching
-- employee_cash_liabilities' own single-SELECT-policy pattern). Public
-- catalog browsing (is_active/is_public) is served by a dedicated RPC,
-- not RLS to anon, since anon has no club membership to scope by.
create policy club_membership_plans_select_own_club on public.club_membership_plans
  for select
  using (
    club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.plan.view', club_id)
  );

create policy club_membership_plan_branches_select_own_club on public.club_membership_plan_branches
  for select
  using (
    exists (
      select 1 from public.club_membership_plans p
      where p.id = plan_id
        and p.club_id in (select public.user_club_ids())
        and public.has_permission('club_membership.plan.view', p.club_id)
    )
  );

create policy club_membership_subscriptions_select_own_club on public.club_membership_subscriptions
  for select
  using (
    club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.view', club_id)
    and public.user_has_branch_access(club_id, branch_id)
  );

-- Customer self-service read: a customer can see their own membership
-- rows directly (mirrors customers_self_service_select's own pattern),
-- independent of any staff permission.
create policy club_membership_subscriptions_self_service_select on public.club_membership_subscriptions
  for select
  using (
    customer_id in (select c.id from public.customers c where c.user_id = (select auth.uid()))
  );

create policy club_membership_freezes_select_own_club on public.club_membership_freezes
  for select
  using (
    club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.view', club_id)
  );

create policy club_membership_freezes_self_service_select on public.club_membership_freezes
  for select
  using (
    exists (
      select 1 from public.club_membership_subscriptions s
      join public.customers c on c.id = s.customer_id
      where s.id = membership_subscription_id and c.user_id = (select auth.uid())
    )
  );

-- No SELECT policy on club_membership_sale_keys at all -- pure
-- server-side idempotency bookkeeping, never read by any client,
-- mirroring employee_cash_liability_settlement_keys (also policy-less).
