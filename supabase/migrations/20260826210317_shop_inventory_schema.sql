-- COMMERCIAL MODULE ARCHITECTURE, continued -- Phase D: Inventory Core.
-- See COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 5.

create table public.shop_inventory_locations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  kind text not null check (kind in ('branch', 'warehouse')),
  -- 1:1 with an existing branches row when kind='branch'; null for a
  -- club-level warehouse (directive Section 14 -- do not pretend
  -- warehouses are branches).
  branch_id uuid references public.branches(id),
  name text not null,
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  check ((kind = 'branch') = (branch_id is not null)),
  unique (branch_id)
);

alter table public.shop_inventory_locations enable row level security;
alter table public.shop_inventory_locations force row level security;

create policy shop_inventory_locations_select
  on public.shop_inventory_locations for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', club_id)
         or public.has_platform_support_access(club_id, false));

create policy shop_inventory_locations_insert
  on public.shop_inventory_locations for insert to authenticated
  with check (
    (club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', club_id))
    or public.has_platform_support_access(club_id, true)
  );

create policy shop_inventory_locations_update
  on public.shop_inventory_locations for update to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('inventory.receive', club_id))
    or public.has_platform_support_access(club_id, true)
  );

-- shop_inventory_balances: the ONLY source of "how much stock is here
-- right now" -- never manually editable from application code, only
-- maintained by _apply_shop_inventory_movement_internal() (next
-- migration). variant_id is nullable: a non-variant product's balance
-- row has variant_id=null (not a fake variant row -- see
-- COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 4).
create table public.shop_inventory_balances (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  location_id uuid not null references public.shop_inventory_locations(id),
  product_id uuid not null references public.shop_products(id),
  variant_id uuid references public.shop_product_variants(id),
  on_hand numeric not null default 0 check (on_hand >= 0),
  updated_at timestamptz not null default now(),
  unique (location_id, product_id, variant_id)
);

alter table public.shop_inventory_balances enable row level security;
alter table public.shop_inventory_balances force row level security;

create policy shop_inventory_balances_select
  on public.shop_inventory_balances for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', club_id)
         or public.has_platform_support_access(club_id, false));
-- No direct insert/update/delete policy -- balances are written
-- exclusively by the SECURITY DEFINER movement-application function.

-- shop_inventory_movements: append-only ledger, the historical source
-- of truth. quantity is always positive; direction is encoded by
-- movement_type (directive Section 16/17 -- avoids a sign-convention
-- bug class).
create table public.shop_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  location_id uuid not null references public.shop_inventory_locations(id),
  product_id uuid not null references public.shop_products(id),
  variant_id uuid references public.shop_product_variants(id),
  movement_type text not null check (movement_type in (
    'opening_balance', 'purchase_receipt', 'sale', 'sale_return',
    'transfer_out', 'transfer_in', 'adjustment_in', 'adjustment_out',
    'damage', 'loss', 'stock_count_adjustment'
  )),
  quantity numeric not null check (quantity > 0),
  unit_cost numeric check (unit_cost >= 0),
  actor_id uuid references auth.users(id),
  reference_type text,
  reference_id uuid,
  reason text,
  created_at timestamptz not null default now(),
  -- Adjustment/damage/loss require a reason (directive Section 23);
  -- every other movement_type is system/business-event-driven and
  -- reason is optional/redundant with reference_type+reference_id.
  check (movement_type not in ('adjustment_in', 'adjustment_out', 'damage', 'loss') or reason is not null)
);

alter table public.shop_inventory_movements enable row level security;
alter table public.shop_inventory_movements force row level security;

create policy shop_inventory_movements_select
  on public.shop_inventory_movements for select to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('inventory.view', club_id)
         or public.has_platform_support_access(club_id, false));
-- No direct insert policy -- movements are written exclusively by
-- _apply_shop_inventory_movement_internal(), never a raw client INSERT
-- (directive Section 13/16 -- "no silent quantity update", enforced by
-- construction: there is no other path to this table at all).

create index idx_shop_inventory_balances_lookup on public.shop_inventory_balances(location_id, product_id, variant_id);
create index idx_shop_inventory_movements_lookup on public.shop_inventory_movements(club_id, location_id, product_id, created_at desc);
create index idx_shop_inventory_movements_reference on public.shop_inventory_movements(reference_type, reference_id);
