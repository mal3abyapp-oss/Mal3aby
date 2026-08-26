-- COMMERCIAL MODULE ARCHITECTURE, continued -- Phase C: Product Catalog.
-- See COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 4 for full rationale.
-- Every table: club-scoped, FORCE RLS (confirmed universal project
-- convention via direct pg_class.relforcerowsecurity read), separate
-- per-command policies (confirmed as the existing invoices/payments
-- pattern, not one catch-all policy).

create table public.shop_categories (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name_ar text not null,
  name_en text,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.shop_categories enable row level security;
alter table public.shop_categories force row level security;

create policy shop_categories_select
  on public.shop_categories for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('shop.view', club_id)
         or public.has_platform_support_access(club_id, false));

create policy shop_categories_insert
  on public.shop_categories for insert to authenticated
  with check (
    (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
    or public.has_platform_support_access(club_id, true)
  );

create policy shop_categories_update
  on public.shop_categories for update to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
    or public.has_platform_support_access(club_id, true)
  );

-- shop_suppliers: minimal lookup only (directive Section 21 -- no
-- procurement/accounts-payable engine).
create table public.shop_suppliers (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  name text not null,
  phone text,
  email text,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

alter table public.shop_suppliers enable row level security;
alter table public.shop_suppliers force row level security;

create policy shop_suppliers_select
  on public.shop_suppliers for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', club_id)
         or public.has_platform_support_access(club_id, false));

create policy shop_suppliers_insert
  on public.shop_suppliers for insert to authenticated
  with check (
    (club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', club_id))
    or public.has_platform_support_access(club_id, true)
  );

create policy shop_suppliers_update
  on public.shop_suppliers for update to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', club_id))
    or public.has_platform_support_access(club_id, true)
  );

-- shop_products: club-owned (directive Section 12 decision -- never
-- academy-owned, see COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 4).
create table public.shop_products (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  category_id uuid references public.shop_categories(id),
  name_ar text not null,
  name_en text,
  description text,
  image_url text,
  has_variants boolean not null default false,
  base_price numeric not null check (base_price >= 0),
  -- Only meaningful for has_variants=false (a variant-less product's
  -- own sellable identity -- see shop_product_variants comment for why
  -- this is NOT a fake variant row).
  sku text,
  barcode text,
  reorder_level integer,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id),
  unique (club_id, sku),
  unique (club_id, barcode)
);

alter table public.shop_products enable row level security;
alter table public.shop_products force row level security;

create policy shop_products_select
  on public.shop_products for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('shop.view', club_id)
         or public.has_platform_support_access(club_id, false));

create policy shop_products_insert
  on public.shop_products for insert to authenticated
  with check (
    (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
    or public.has_platform_support_access(club_id, true)
  );

create policy shop_products_update
  on public.shop_products for update to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
    or public.has_platform_support_access(club_id, true)
  );

-- shop_product_variants: only rows exist for has_variants=true
-- products (directive Section 10 -- size/color dimensions only, not a
-- generic option engine).
create table public.shop_product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.shop_products(id) on delete cascade,
  club_id uuid not null references public.clubs(id) on delete cascade,
  size text,
  color text,
  sku text,
  barcode text,
  price_override numeric check (price_override >= 0),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  unique (club_id, sku),
  unique (club_id, barcode)
);

alter table public.shop_product_variants enable row level security;
alter table public.shop_product_variants force row level security;

create policy shop_product_variants_select
  on public.shop_product_variants for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('shop.view', club_id)
         or public.has_platform_support_access(club_id, false));

create policy shop_product_variants_insert
  on public.shop_product_variants for insert to authenticated
  with check (
    (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
    or public.has_platform_support_access(club_id, true)
  );

create policy shop_product_variants_update
  on public.shop_product_variants for update to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', club_id))
    or public.has_platform_support_access(club_id, true)
  );

create index idx_shop_products_club on public.shop_products(club_id, status);
create index idx_shop_product_variants_product on public.shop_product_variants(product_id);
