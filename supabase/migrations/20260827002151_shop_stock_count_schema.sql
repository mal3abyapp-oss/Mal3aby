create table public.shop_stock_counts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  location_id uuid not null references public.shop_inventory_locations(id),
  status text not null default 'draft' check (status in ('draft', 'in_progress', 'completed', 'cancelled')),
  started_by uuid references auth.users(id),
  started_at timestamptz,
  completed_by uuid references auth.users(id),
  completed_at timestamptz,
  cancelled_by uuid references auth.users(id),
  cancelled_at timestamptz,
  notes text,
  idempotency_key uuid,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz
);

create index shop_stock_counts_club_id_idx on public.shop_stock_counts(club_id);
create index shop_stock_counts_location_id_idx on public.shop_stock_counts(location_id);
create unique index shop_stock_counts_club_idempotency_key_unique
  on public.shop_stock_counts(club_id, idempotency_key) where idempotency_key is not null;

-- Only one non-terminal (draft/in_progress) count session per location at a time --
-- prevents two overlapping counts silently double-adjusting the same balance.
create unique index shop_stock_counts_one_open_per_location
  on public.shop_stock_counts(location_id) where status in ('draft', 'in_progress');

alter table public.shop_stock_counts enable row level security;
alter table public.shop_stock_counts force row level security;

create policy shop_stock_counts_select on public.shop_stock_counts for select to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', club_id))
    or public.has_platform_support_access(club_id, false)
  );

create table public.shop_stock_count_items (
  id uuid primary key default gen_random_uuid(),
  stock_count_id uuid not null references public.shop_stock_counts(id) on delete cascade,
  product_id uuid not null references public.shop_products(id),
  variant_id uuid references public.shop_product_variants(id),
  system_quantity numeric not null,
  counted_quantity numeric,
  variance numeric generated always as (counted_quantity - system_quantity) stored,
  movement_id uuid references public.shop_inventory_movements(id),
  counted_by uuid references auth.users(id),
  counted_at timestamptz,
  created_at timestamptz not null default now()
);

create index shop_stock_count_items_stock_count_id_idx on public.shop_stock_count_items(stock_count_id);
create unique index shop_stock_count_items_unique_line
  on public.shop_stock_count_items(stock_count_id, product_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)));

alter table public.shop_stock_count_items enable row level security;
alter table public.shop_stock_count_items force row level security;

create policy shop_stock_count_items_select on public.shop_stock_count_items for select to authenticated
  using (
    exists (
      select 1 from public.shop_stock_counts sc
      where sc.id = stock_count_id
        and (
          (sc.club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', sc.club_id))
          or public.has_platform_support_access(sc.club_id, false)
        )
    )
  );
