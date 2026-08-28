-- Commerce Pro C3 (COMMERCE_PRO_UPGRADE_PLAN.md Section 4/11): additive
-- schema for discount-at-sale, a per-club "Walk-in Customer" system
-- row, and Hold/Resume draft staging tables.

-- ------------------------------------------------------------
-- 1. Discount columns on shop_sales.
-- ------------------------------------------------------------
-- Mirrors invoices.discount (which already exists, currently hardcoded
-- to 0 by create_shop_sale -- see the RPC migration in this same
-- batch). shop_sales gets its OWN copy rather than always joining to
-- invoices, because Shop reports (ReportShopPage.tsx, get_shop_top_products,
-- etc.) query shop_sales directly today -- confirmed via grep of every
-- get_shop_*_report RPC, none of which currently join invoices for
-- totals. Kept in sync by the same create_shop_sale call that writes
-- both rows in the same transaction; never diverges because both are
-- written once, together, at creation, and neither is ever updated
-- afterward (no UPDATE path exists for either column on either table --
-- discounts are creation-time-only, per the plan's Non-negotiable
-- Invariant #2).
alter table public.shop_sales
  add column if not exists discount_amount numeric not null default 0 check (discount_amount >= 0),
  add column if not exists discount_reason text;

comment on column public.shop_sales.discount_amount is
  'Commerce Pro C3: discount applied at sale creation only, mirrors invoices.discount. Never updated after insert -- see create_shop_sale.';
comment on column public.shop_sales.discount_reason is
  'Commerce Pro C3: optional free-text reason captured alongside discount_amount, for audit/reporting.';

-- ------------------------------------------------------------
-- 2. Walk-in Customer system row (per club, lazy/idempotent).
-- ------------------------------------------------------------
-- create_shop_sale requires a real, non-null p_customer_id (see
-- 20260826211221_fix_create_shop_sale_require_customer.sql -- this was
-- a deliberate fix, not an oversight: "every invoice in this entire
-- project requires a real customer, with zero exceptions anywhere else
-- in the codebase"). Rather than weakening that established, recently-
-- fixed invariant, a genuine "Walk-in Customer" is a real customers row
-- per club, marked so the POS layer (and any future report) can find it
-- reliably without fragile name-matching. Lazily created on first use
-- via get_or_create_shop_walk_in_customer() (next migration) --  not
-- seeded eagerly for every club here, since many clubs may never use
-- Shop at all.
alter table public.customers
  add column if not exists is_walk_in boolean not null default false;

comment on column public.customers.is_walk_in is
  'Commerce Pro C3: marks the single system "Walk-in Customer" row lazily created per club for POS sales with no real customer picked. See get_or_create_shop_walk_in_customer().';

-- At most one walk-in row per club -- the lazy-create RPC is written to
-- be idempotent (find-or-create under this same guarantee), and this
-- partial unique index is the actual database-level backstop against a
-- race creating two.
create unique index if not exists idx_customers_one_walk_in_per_club
  on public.customers (club_id)
  where is_walk_in = true;

-- ------------------------------------------------------------
-- 3. Hold/Resume draft staging tables (non-canonical, per plan
--    Non-negotiable Invariant #1).
-- ------------------------------------------------------------
-- Deliberately NO foreign key into invoices/payments/shop_sales, and NO
-- inventory-movement row is ever written for a held sale -- stock is
-- untouched until the cashier actually resumes and completes checkout
-- through the normal create_shop_sale path. This is a draft cart
-- snapshot only.
create table public.shop_held_sales (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  customer_id uuid references public.customers(id),
  held_by uuid references auth.users(id),
  held_at timestamptz not null default now(),
  note text
);

comment on table public.shop_held_sales is
  'Commerce Pro C3: non-canonical POS cart draft, held for later resume. No FK into invoices/payments/shop_sales -- stock is NOT reserved (create_shop_sale is still the only place stock deducts). See hold_shop_sale/resume_shop_sale/list_held_shop_sales/discard_held_shop_sale.';

alter table public.shop_held_sales enable row level security;
alter table public.shop_held_sales force row level security;

create policy shop_held_sales_select
  on public.shop_held_sales for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('shop.sale.create', club_id));
-- No direct insert/update/delete policy -- writes exclusively through
-- the RPCs in the next migration, matching shop_sales' own "no direct
-- write policy, RPC-only" convention.

create table public.shop_held_sale_items (
  id uuid primary key default gen_random_uuid(),
  held_sale_id uuid not null references public.shop_held_sales(id) on delete cascade,
  product_id uuid not null references public.shop_products(id),
  variant_id uuid references public.shop_product_variants(id),
  quantity numeric not null check (quantity > 0)
);

comment on table public.shop_held_sale_items is
  'Commerce Pro C3: line items for a held (draft) sale. product_id/variant_id/quantity only -- no price snapshot (prices are re-derived live on resume, exactly like create_shop_sale re-derives every price server-side rather than trusting a client-cached value).';

alter table public.shop_held_sale_items enable row level security;
alter table public.shop_held_sale_items force row level security;

create policy shop_held_sale_items_select
  on public.shop_held_sale_items for select to authenticated
  using (
    exists (
      select 1 from public.shop_held_sales h
      where h.id = held_sale_id
        and h.club_id in (select public.user_club_ids())
        and public.has_permission('shop.sale.create', h.club_id)
    )
  );

create index idx_shop_held_sales_club on public.shop_held_sales(club_id, held_at desc);
create index idx_shop_held_sale_items_held_sale on public.shop_held_sale_items(held_sale_id);
