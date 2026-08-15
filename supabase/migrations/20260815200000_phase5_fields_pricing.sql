-- Phase 5 — Fields, Operating Hours, Pricing
-- See docs/IMPLEMENTATION_PLAN.md Phase 5, docs/DATABASE_BLUEPRINT.md
-- "Facilities" + "Pricing" sections.

-- ============================================================
-- fields
-- ============================================================
create table public.fields (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  name text not null,
  sport text not null,
  indoor boolean not null default false,
  capacity int,
  default_duration_minutes int not null default 60,
  status text not null default 'active' check (status in ('active', 'maintenance', 'inactive')),
  maintenance_status text,
  images jsonb,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  created_by uuid references auth.users(id)
);
comment on table public.fields is 'Bookable units. No separate facilities layer in V1.';

create index idx_fields_club_id on public.fields (club_id);
create index idx_fields_branch_id on public.fields (branch_id);

create trigger trg_fields_updated_at before update on public.fields
  for each row execute function public.set_updated_at();

-- ============================================================
-- field_operating_hours
-- ============================================================
create table public.field_operating_hours (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid references public.branches(id),
  field_id uuid references public.fields(id),
  day_of_week int not null check (day_of_week between 0 and 6),
  open_time time not null,
  close_time time not null,
  created_at timestamptz not null default now(),
  constraint field_operating_hours_valid_range check (close_time > open_time)
);
comment on table public.field_operating_hours is 'Unified hours model -- field_id null applies to all fields in the branch.';

create index idx_field_operating_hours_club_id on public.field_operating_hours (club_id);
create index idx_field_operating_hours_field_id on public.field_operating_hours (field_id);

-- ============================================================
-- field_blocks
-- ============================================================
create table public.field_blocks (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  field_id uuid not null references public.fields(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text,
  type text not null check (type in ('maintenance', 'weather', 'private_event', 'manual', 'holiday')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  constraint field_blocks_valid_period check (end_at > start_at)
);
comment on table public.field_blocks is 'Maintenance windows, holidays, manual closures. Creating a block never cancels an existing conflicting booking -- see create_field_block RPC (Phase 6).';

create index idx_field_blocks_club_id on public.field_blocks (club_id);
create index idx_field_blocks_field_id on public.field_blocks (field_id);

-- ============================================================
-- pricing_rules
-- ============================================================
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  field_id uuid references public.fields(id),
  day_of_week int check (day_of_week between 0 and 6),
  date_specific date,
  start_time time not null,
  end_time time not null,
  price_per_hour numeric(12,2) not null check (price_per_hour >= 0),
  priority int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint pricing_rules_valid_range check (end_time > start_time),
  constraint pricing_rules_day_or_date check (
    (day_of_week is not null and date_specific is null)
    or (day_of_week is null and date_specific is not null)
  )
);
comment on table public.pricing_rules is 'Rule-priority price resolution, not a rule-engine DSL. Higher priority wins on overlap -- date_specific (holiday) rules should be seeded with higher priority by convention.';

create index idx_pricing_rules_club_id on public.pricing_rules (club_id);
create index idx_pricing_rules_field_id on public.pricing_rules (field_id);

create trigger trg_pricing_rules_updated_at before update on public.pricing_rules
  for each row execute function public.set_updated_at();

-- ============================================================
-- resolve_field_price: given a field + a specific date/time window,
-- return the applicable price_per_hour. Read-only, callable by any staff
-- role that can view fields -- not a privileged RPC, but SECURITY DEFINER
-- since pricing_rules RLS is club-scoped and this needs to resolve across
-- field_id-specific and field_id-null (branch/club-wide) rules in one call.
-- ============================================================
create or replace function public.resolve_field_price(
  p_field_id uuid,
  p_date date,
  p_start_time time,
  p_end_time time
)
returns numeric
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_day_of_week int;
  v_price numeric;
begin
  select club_id into v_club_id from public.fields where id = p_field_id;
  if v_club_id is null then
    raise exception 'field not found';
  end if;

  -- Caller must actually have visibility into this club (mirrors the
  -- fields_select policy check) -- resolve_field_price is not a public
  -- price-scraping endpoint.
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('field.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  v_day_of_week := extract(dow from p_date)::int;

  select price_per_hour into v_price
  from public.pricing_rules
  where club_id = v_club_id
    and (field_id = p_field_id or field_id is null)
    and (
      (date_specific = p_date)
      or (date_specific is null and day_of_week = v_day_of_week)
    )
    and start_time <= p_start_time
    and end_time >= p_end_time
  order by
    -- date_specific rules and field-specific rules both narrow the match;
    -- priority is still the documented final tiebreaker.
    (field_id is not null) desc,
    (date_specific is not null) desc,
    priority desc
  limit 1;

  if v_price is null then
    raise exception 'no pricing rule found for this field/time';
  end if;

  return v_price;
end;
$$;

revoke execute on function public.resolve_field_price(uuid, date, time, time) from public;
revoke execute on function public.resolve_field_price(uuid, date, time, time) from anon;
grant execute on function public.resolve_field_price(uuid, date, time, time) to authenticated;

-- ============================================================
-- RLS
-- ============================================================
alter table public.fields enable row level security;
alter table public.field_operating_hours enable row level security;
alter table public.field_blocks enable row level security;
alter table public.pricing_rules enable row level security;

-- ---- fields ----
create policy "fields_select_club_staff" on public.fields
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.view', club_id)
  );

create policy "fields_insert_with_permission" on public.fields
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.create', club_id)
  );

create policy "fields_update_with_permission" on public.fields
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.update', club_id)
  );

create policy "fields_platform_owner_select" on public.fields
  for select using (public.is_platform_owner());

-- ---- field_operating_hours ----
create policy "field_operating_hours_select_club_staff" on public.field_operating_hours
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.view', club_id)
  );

create policy "field_operating_hours_write_with_permission" on public.field_operating_hours
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.update', club_id)
  );

create policy "field_operating_hours_update_with_permission" on public.field_operating_hours
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.update', club_id)
  );

create policy "field_operating_hours_delete_with_permission" on public.field_operating_hours
  for delete using (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.update', club_id)
  );

-- ---- field_blocks ----
create policy "field_blocks_select_club_staff" on public.field_blocks
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.view', club_id)
  );

create policy "field_blocks_write_with_permission" on public.field_blocks
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('field.update', club_id)
  );

-- No UPDATE/DELETE policy on field_blocks -- a block is a historical
-- record of a closure decision; correcting a mistaken block is a new
-- action (create a replacement, don't silently rewrite history), matching
-- the general no-hard-delete-on-operational-records posture.

-- ---- pricing_rules ----
-- Deliberately gated by pricing.view, not field.view -- RLS_MATRIX.md
-- grants pricing_rules SELECT to club_owner/club_manager/branch_manager/
-- receptionist/accountant only, NOT academy_manager/coach, even though
-- all of those hold field.view.
create policy "pricing_rules_select_club_staff" on public.pricing_rules
  for select using (
    club_id in (select public.user_club_ids())
    and public.has_permission('pricing.view', club_id)
  );

create policy "pricing_rules_write_with_permission" on public.pricing_rules
  for insert with check (
    club_id in (select public.user_club_ids())
    and public.has_permission('pricing.update', club_id)
  );

create policy "pricing_rules_update_with_permission" on public.pricing_rules
  for update using (
    club_id in (select public.user_club_ids())
    and public.has_permission('pricing.update', club_id)
  );

create policy "pricing_rules_delete_with_permission" on public.pricing_rules
  for delete using (
    club_id in (select public.user_club_ids())
    and public.has_permission('pricing.update', club_id)
  );

-- ============================================================
-- Seed new permissions + role grants (per RLS_MATRIX.md: fields S,I,U for
-- club_owner/club_manager, S,U for branch_manager, S for
-- receptionist/accountant/academy_manager/coach on fields; pricing_rules
-- S,I,U for club_owner/club_manager, S,U for branch_manager, S for
-- receptionist/accountant, none for academy_manager/coach)
-- ============================================================
insert into public.permissions (key, description) values
  ('field.view', 'View fields, hours, and blocks'),
  ('field.create', 'Create a field'),
  ('field.update', 'Update a field, its hours, or create a block'),
  ('pricing.view', 'View pricing rules'),
  ('pricing.update', 'Manage pricing rules')
on conflict (key) do nothing;

-- club_owner, club_manager: fields S,I,U + pricing S,I,U.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager')
  and p.key in ('field.view', 'field.create', 'field.update', 'pricing.view', 'pricing.update')
on conflict do nothing;

-- branch_manager: fields S,U (no create) + pricing S,U (no create).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key = 'branch_manager'
  and p.key in ('field.view', 'field.update', 'pricing.view', 'pricing.update')
on conflict do nothing;

-- receptionist, accountant: fields S + pricing S (both listed with S,S
-- in RLS_MATRIX.md -- view only, no write on either).
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('receptionist', 'accountant')
  and p.key in ('field.view', 'pricing.view')
on conflict do nothing;

-- academy_manager, coach: fields S only, no pricing_rules access at all.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('academy_manager', 'coach')
  and p.key = 'field.view'
on conflict do nothing;
