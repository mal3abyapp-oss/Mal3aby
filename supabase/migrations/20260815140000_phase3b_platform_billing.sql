-- Phase 3b — Platform Billing Data Model + Access Control
-- See docs/IMPLEMENTATION_PLAN.md Phase 3b, docs/DATABASE_BLUEPRINT.md
-- "Platform Billing" + "Public Website" sections, docs/ARCHITECTURE.md
-- #platform-access-strategy.
--
-- Structurally separate from club-level customer billing (ADR-028). All
-- four core tables here are Platform-Owner-only; club-side sees only a
-- restricted summary view (ADR-035).

-- btree_gist is required for the exclusion constraint below (mixes uuid
-- equality with tstzrange overlap in one GiST index). Installed into
-- `extensions`, not `public` (get_advisors flags extensions in public).
create schema if not exists extensions;
create extension if not exists btree_gist schema extensions;

-- ============================================================
-- platform_settings (singleton)
-- ============================================================
create table public.platform_settings (
  id boolean primary key default true,
  default_trial_days int not null default 7,
  default_grace_period_days int not null default 7,
  updated_at timestamptz,
  constraint platform_settings_singleton check (id)
);
comment on table public.platform_settings is 'Singleton config row (id is always true). ADR-037.';

insert into public.platform_settings (id) values (true);

create trigger trg_platform_settings_updated_at before update on public.platform_settings
  for each row execute function public.set_updated_at();

-- ============================================================
-- platform_plans
-- ============================================================
create table public.platform_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  name_ar text not null,
  description_ar text,
  billing_interval text not null check (billing_interval in ('month', 'year')),
  billing_interval_count int not null check (billing_interval_count > 0),
  price numeric(12,2) not null check (price >= 0),
  currency text not null default 'EGP',
  discount_label text,
  features_summary text,
  default_grace_period_days int not null default 7,
  is_public boolean not null default false,
  display_order int not null default 0,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
comment on table public.platform_plans is 'Platform-owned reference data, not tenant-scoped. Editing never retroactively changes an already-created platform_subscriptions row (ADR-029/030).';

create trigger trg_platform_plans_updated_at before update on public.platform_plans
  for each row execute function public.set_updated_at();

-- ============================================================
-- platform_subscriptions (period-based, one row per billing cycle)
-- ============================================================
create table public.platform_subscriptions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  plan_id uuid references public.platform_plans(id),
  subscription_kind text not null check (subscription_kind in ('trial', 'paid', 'complimentary')),
  trial_origin text check (trial_origin in ('automatic', 'manual')),
  plan_name_snapshot text,
  price_snapshot numeric(12,2) not null default 0,
  currency_snapshot text,
  interval_snapshot text check (interval_snapshot in ('month', 'year')),
  interval_count_snapshot int,
  grace_period_days_snapshot int not null default 0,
  start_at timestamptz not null,
  end_at timestamptz not null,
  during tstzrange generated always as (tstzrange(start_at, end_at, '[)')) stored,
  previous_subscription_id uuid references public.platform_subscriptions(id),
  lifecycle_status text not null check (lifecycle_status in ('trial', 'active', 'cancelled')),
  cancelled_at timestamptz,
  cancelled_reason text,
  cancelled_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint platform_subscriptions_valid_period check (end_at > start_at),
  constraint platform_subscriptions_trial_origin_only_on_trial
    check (trial_origin is null or subscription_kind = 'trial')
);
comment on table public.platform_subscriptions is 'One row per billing period. A trial is subscription_kind = trial in this same table, never a separate structure (ADR-038).';

create trigger trg_platform_subscriptions_updated_at before update on public.platform_subscriptions
  for each row execute function public.set_updated_at();

-- Overlap prevention (ADR-032): same shape as the booking exclusion
-- constraint pattern, applies identically to trial and paid periods.
alter table public.platform_subscriptions add constraint no_overlapping_subscription_periods
  exclude using gist (club_id with =, during with &&)
  where (lifecycle_status != 'cancelled');

-- At most one non-cancelled trial per club, ever (ADR-039) — DB-level, not
-- just RPC discipline.
create unique index one_trial_per_club on public.platform_subscriptions (club_id)
  where subscription_kind = 'trial';

create index idx_platform_subscriptions_club_id on public.platform_subscriptions (club_id);

-- ============================================================
-- platform_invoices / platform_payments
-- ============================================================
create sequence public.platform_invoice_number_seq start 1;

create table public.platform_invoices (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  platform_subscription_id uuid not null references public.platform_subscriptions(id),
  invoice_number bigint not null default nextval('public.platform_invoice_number_seq'),
  amount numeric(12,2) not null check (amount >= 0),
  due_date date not null,
  status text not null default 'pending' check (status in ('pending', 'paid', 'overdue', 'void')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  unique (invoice_number)
);
comment on table public.platform_invoices is 'Trials never generate a row here (ADR-036). No hard delete once issued. invoice_number is globally sequential platform-wide, not per-branch (this is Mala3by''s own numbering, not a club''s).';

create trigger trg_platform_invoices_updated_at before update on public.platform_invoices
  for each row execute function public.set_updated_at();

create table public.platform_payments (
  id uuid primary key default gen_random_uuid(),
  platform_invoice_id uuid not null references public.platform_invoices(id),
  amount numeric(12,2) not null check (amount > 0),
  method text not null check (method in ('bank_transfer', 'cash', 'other')),
  reference text,
  recorded_by uuid references auth.users(id),
  recorded_at timestamptz not null default now(),
  reversed_at timestamptz,
  reversed_by uuid references auth.users(id),
  reversal_reason text
);
comment on table public.platform_payments is 'No hard delete -- a mistaken record is reversed, never deleted.';

-- ============================================================
-- automatic_trial_entitlements
-- ============================================================
create table public.automatic_trial_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id),
  club_id uuid not null references public.clubs(id),
  owner_normalized_mobile_snapshot text,
  owner_email_snapshot text,
  consumed_at timestamptz not null default now()
);
comment on table public.automatic_trial_entitlements is 'The unique(user_id) constraint IS the concurrency guard -- no SELECT-then-INSERT race window (ADR-051).';

-- ============================================================
-- contact_requests (public leads)
-- ============================================================
create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  business_name text,
  message text,
  status text not null default 'new' check (status in ('new', 'contacted', 'converted', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
comment on table public.contact_requests is 'Anonymous insert-only public leads inbox, not a CRM.';

create trigger trg_contact_requests_updated_at before update on public.contact_requests
  for each row execute function public.set_updated_at();

-- ============================================================
-- public_plans view (safe public column subset)
-- ============================================================
create view public.public_plans as
select name_ar, description_ar, billing_interval, billing_interval_count, price, currency,
       discount_label, features_summary
from public.platform_plans
where is_public = true and status = 'active'
order by display_order;

-- ============================================================
-- get_club_platform_access / auth.club_write_allowed
-- NOTE: corrected vs. the ARCHITECTURE.md code sketch, which had the
-- `lifecycle_status = 'trial'` branch return 'full' unconditionally even
-- past end_at. Per the authoritative derivation table in the same doc
-- (grace_days = 0 for trial by convention), a trial past end_at must go
-- straight to blocked, not stay full or hit grace. Fixed here.
-- ============================================================
create or replace function public.get_club_platform_access(p_club_id uuid)
returns text  -- 'full' | 'grace' | 'blocked'
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_status text;
  v_sub record;
begin
  select status into v_club_status from public.clubs where id = p_club_id;
  if v_club_status is null or v_club_status in ('suspended', 'closed') then
    return 'blocked';
  end if;

  select * into v_sub from public.platform_subscriptions
    where club_id = p_club_id and lifecycle_status != 'cancelled'
    order by start_at desc limit 1;

  if v_sub is null then
    return 'blocked';
  elsif now() < v_sub.end_at then
    return 'full';
  elsif now() < v_sub.end_at + (v_sub.grace_period_days_snapshot || ' days')::interval then
    return 'grace';
  else
    return 'blocked';
  end if;
end;
$$;

revoke execute on function public.get_club_platform_access(uuid) from public;
revoke execute on function public.get_club_platform_access(uuid) from anon;
grant execute on function public.get_club_platform_access(uuid) to authenticated;

create or replace function public.club_write_allowed(p_club_id uuid, p_action_category text)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case public.get_club_platform_access(p_club_id)
    when 'full' then true
    when 'grace' then p_action_category in ('settle_existing', 'operational_continuity')
    else false
  end
$$;

revoke execute on function public.club_write_allowed(uuid, text) from public;
revoke execute on function public.club_write_allowed(uuid, text) from anon;
grant execute on function public.club_write_allowed(uuid, text) to authenticated;

-- ============================================================
-- Club Owner's own-club restricted summary view (ADR-035)
-- ============================================================
create view public.club_platform_subscription_summary as
select
  ps.club_id,
  ps.subscription_kind,
  ps.lifecycle_status,
  ps.start_at,
  ps.end_at,
  ps.plan_name_snapshot,
  public.get_club_platform_access(ps.club_id) as effective_access
from public.platform_subscriptions ps
where ps.lifecycle_status != 'cancelled'
  and ps.id = (
    select id from public.platform_subscriptions ps2
    where ps2.club_id = ps.club_id and ps2.lifecycle_status != 'cancelled'
    order by start_at desc limit 1
  );

-- ============================================================
-- RLS
-- ============================================================
alter table public.platform_settings enable row level security;
alter table public.platform_plans enable row level security;
alter table public.platform_subscriptions enable row level security;
alter table public.platform_invoices enable row level security;
alter table public.platform_payments enable row level security;
alter table public.automatic_trial_entitlements enable row level security;
alter table public.contact_requests enable row level security;

-- platform_settings: readable by any authenticated user (marketing copy
-- needs trial length without hardcoding); anon reads via a wrapper RPC
-- added in Phase 3d, not directly.
create policy "platform_settings_select_authenticated" on public.platform_settings
  for select using (auth.uid() is not null);
create policy "platform_settings_platform_owner_write" on public.platform_settings
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

create policy "platform_plans_platform_owner_full_access" on public.platform_plans
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

create policy "platform_subscriptions_platform_owner_full_access" on public.platform_subscriptions
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

create policy "platform_invoices_platform_owner_full_access" on public.platform_invoices
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

create policy "platform_payments_platform_owner_full_access" on public.platform_payments
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

create policy "automatic_trial_entitlements_platform_owner_select" on public.automatic_trial_entitlements
  for select using (public.is_platform_owner());
-- No direct client INSERT policy -- written only inside
-- complete_new_club_onboarding() (Phase 3d), which is SECURITY DEFINER.

create policy "contact_requests_anon_insert" on public.contact_requests
  for insert to anon with check (true);
create policy "contact_requests_authenticated_insert" on public.contact_requests
  for insert to authenticated with check (true);
create policy "contact_requests_platform_owner_select" on public.contact_requests
  for select using (public.is_platform_owner());
create policy "contact_requests_platform_owner_update" on public.contact_requests
  for update using (public.is_platform_owner());

-- public_plans view: deliberately left as a definer view (default) so it
-- can read platform_plans (which blocks anon entirely) while exposing only
-- this safe column subset -- the standard Postgres pattern for ADR-040.
grant select on public.public_plans to anon;
grant select on public.public_plans to authenticated;

-- club_platform_subscription_summary: Club Owner (staff.create/staff.update
-- holder is too broad; use club.update as the "manages club settings"
-- permission already defined in Phase 2 seed) can read their own club's row.
-- RLS on the underlying platform_subscriptions table still blocks
-- non-platform-owner direct access; grant SELECT on the view + a policy
-- keyed off club_memberships so it's still club_id-scoped, not blanket.
alter view public.club_platform_subscription_summary set (security_invoker = true);
grant select on public.club_platform_subscription_summary to authenticated;

create policy "platform_subscriptions_club_owner_summary_read" on public.platform_subscriptions
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('club.update', club_id)
  );

-- ============================================================
-- Post-apply security-advisor fixes (get_advisors security scan):
-- 1. public_plans as a SECURITY DEFINER view was an ERROR-level finding.
--    Switched to security_invoker + a genuinely RLS-scoped anon/authenticated
--    SELECT policy on platform_plans (restricted to is_public/active rows) --
--    strictly better than a definer-view bypass.
-- 2. btree_gist installed in `public` was a WARN -- moved to `extensions`.
-- ============================================================
alter view public.public_plans set (security_invoker = true);

create policy "platform_plans_anon_public_select" on public.platform_plans
  for select to anon
  using (is_public = true and status = 'active');

create policy "platform_plans_authenticated_public_select" on public.platform_plans
  for select to authenticated
  using (is_public = true and status = 'active');
