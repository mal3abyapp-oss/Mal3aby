-- COMMERCIAL MODULE ARCHITECTURE, continued -- Phase E: Sales domain
-- schema. See COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 6/7.

create table public.shop_sales (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  location_id uuid not null references public.shop_inventory_locations(id),
  customer_id uuid references public.customers(id),
  sold_by uuid references auth.users(id),
  invoice_id uuid references public.invoices(id),
  status text not null default 'draft' check (status in (
    'draft', 'completed', 'cancelled', 'partially_returned', 'returned'
  )),
  created_at timestamptz not null default now()
);

alter table public.shop_sales enable row level security;
alter table public.shop_sales force row level security;

create policy shop_sales_select
  on public.shop_sales for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('shop.view', club_id)
         or public.has_platform_support_access(club_id, false));
-- No direct insert/update policy -- writes exclusively through
-- create_shop_sale() / return_shop_sale() (next migrations), which
-- enforce the full entitlement/permission/cash-shift/stock invariant
-- chain in one transaction.

create table public.shop_sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.shop_sales(id) on delete cascade,
  product_id uuid not null references public.shop_products(id),
  variant_id uuid references public.shop_product_variants(id),
  quantity numeric not null check (quantity > 0),
  unit_price numeric not null check (unit_price >= 0),
  line_total numeric not null check (line_total >= 0),
  returned_quantity numeric not null default 0 check (returned_quantity >= 0),
  invoice_item_id uuid references public.invoice_items(id),
  check (returned_quantity <= quantity)
);

alter table public.shop_sale_items enable row level security;
alter table public.shop_sale_items force row level security;

create policy shop_sale_items_select
  on public.shop_sale_items for select to authenticated
  using (
    exists (
      select 1 from public.shop_sales s
      where s.id = sale_id
        and (s.club_id in (select public.user_club_ids()) and public.has_permission('shop.view', s.club_id)
             or public.has_platform_support_access(s.club_id, false))
    )
  );

create index idx_shop_sales_club on public.shop_sales(club_id, created_at desc);
create index idx_shop_sale_items_sale on public.shop_sale_items(sale_id);
create index idx_shop_sale_items_product on public.shop_sale_items(product_id);

-- shop_sale_returns: references the original sale, never free-floating
-- (directive Section 41). restock/refund_payment_id are the two
-- independent flags separating physical return from financial refund
-- (directive Section 42, see COMMERCIAL_DOMAIN_ARCHITECTURE.md Section
-- 8).
create table public.shop_sale_returns (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.shop_sales(id),
  club_id uuid not null references public.clubs(id) on delete cascade,
  processed_by uuid references auth.users(id),
  restock boolean not null default true,
  refund_payment_id uuid references public.refunds(id),
  reason text not null,
  created_at timestamptz not null default now()
);

alter table public.shop_sale_returns enable row level security;
alter table public.shop_sale_returns force row level security;

create policy shop_sale_returns_select
  on public.shop_sale_returns for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('shop.view', club_id)
         or public.has_platform_support_access(club_id, false));

create table public.shop_sale_return_items (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.shop_sale_returns(id) on delete cascade,
  sale_item_id uuid not null references public.shop_sale_items(id),
  quantity numeric not null check (quantity > 0)
);

alter table public.shop_sale_return_items enable row level security;
alter table public.shop_sale_return_items force row level security;

create policy shop_sale_return_items_select
  on public.shop_sale_return_items for select to authenticated
  using (
    exists (
      select 1 from public.shop_sale_returns r
      where r.id = return_id
        and (r.club_id in (select public.user_club_ids()) and public.has_permission('shop.view', r.club_id)
             or public.has_platform_support_access(r.club_id, false))
    )
  );

create index idx_shop_sale_returns_sale on public.shop_sale_returns(sale_id);
create index idx_shop_sale_return_items_return on public.shop_sale_return_items(return_id);
