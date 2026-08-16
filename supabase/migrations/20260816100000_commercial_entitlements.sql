-- Commercial Entitlements, Anti-Abuse & Owner Transparency Phase
-- (2026-08-16), Step 1: the commercial entitlement data model.
--
-- Prior art already in the schema (verified before writing this):
-- - complete_new_club_onboarding() already caps a user to ONE
--   automatic trial (automatic_trial_entitlements.user_id has a UNIQUE
--   constraint) -- any additional club from the same owner gets
--   v_trial_granted = false and consequently NO platform_subscriptions
--   row at all.
-- - get_club_platform_access()/club_write_allowed() already treat a
--   club with zero platform_subscriptions rows as 'blocked' for every
--   action category. So an additional club is ALREADY commercially
--   non-operational by construction -- Section B/C's core requirement
--   ("Preferred: B -- pending/blocked until Platform Owner approves")
--   already holds without any change here.
-- What's genuinely missing and added by this migration: numeric
-- branch/field/academy-program limits (Sections D-J), which nothing in
-- the schema enforced before now.

-- ============================================================
-- commercial_entitlements: one row per club, Platform-Owner-only
-- writable. NULL limit = unlimited (used for clubs Platform Owner has
-- not yet capped, e.g. legacy/manually-managed clubs) so this migration
-- never silently breaks any existing club's ability to operate.
-- ============================================================
create table public.commercial_entitlements (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  branch_limit integer,
  field_limit integer,
  academy_limit integer,
  notes text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.commercial_entitlements enable row level security;

-- Every club-scoped staff member may READ their own club's entitlements
-- (so the product can show "4/5 ملاعب مستخدمة"), but only platform_owner
-- may write.
create policy "commercial_entitlements_select_own_club" on public.commercial_entitlements
  for select using (club_id in (select public.user_club_ids()));

create policy "commercial_entitlements_platform_owner_write" on public.commercial_entitlements
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

comment on table public.commercial_entitlements is
  'Platform-Owner-controlled commercial limits per club. NULL = unlimited. Club owners/managers cannot modify this table (no INSERT/UPDATE/DELETE policy grants it to them).';

-- ============================================================
-- commercial_upgrade_requests: Section AK -- a club that hits a limit
-- gets "لقد وصلت إلى حد اشتراكك" + a request button, not a self-serve
-- price change. This is the lead/alert record Platform Owner sees.
-- ============================================================
create table public.commercial_upgrade_requests (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  requested_by uuid not null references auth.users(id),
  limit_type text not null check (limit_type in ('branch_limit', 'field_limit', 'academy_limit')),
  current_limit integer,
  current_usage integer not null,
  note text,
  status text not null default 'pending' check (status in ('pending', 'reviewed', 'approved', 'dismissed')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);

alter table public.commercial_upgrade_requests enable row level security;

create policy "commercial_upgrade_requests_select_own_club" on public.commercial_upgrade_requests
  for select using (club_id in (select public.user_club_ids()));

create policy "commercial_upgrade_requests_insert_own_club" on public.commercial_upgrade_requests
  for insert with check (club_id in (select public.user_club_ids()) and requested_by = auth.uid());

create policy "commercial_upgrade_requests_platform_owner_full" on public.commercial_upgrade_requests
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

comment on table public.commercial_upgrade_requests is
  'Section AK upgrade-request/lead flow: a club hitting a commercial limit can request an increase; Platform Owner reviews and (outside this schema, via direct entitlement edit) approves.';

-- ============================================================
-- request_commercial_upgrade: club-side RPC to file an upgrade
-- request. Deliberately does NOT change the entitlement itself --
-- only Platform Owner can do that, by design (Section AH).
-- ============================================================
create or replace function public.request_commercial_upgrade(
  p_club_id uuid,
  p_limit_type text,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
  v_current_limit integer;
  v_current_usage integer;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids())) then
    raise exception 'not authorized';
  end if;

  if p_limit_type not in ('branch_limit', 'field_limit', 'academy_limit') then
    raise exception 'unknown limit type';
  end if;

  select
    case p_limit_type
      when 'branch_limit' then branch_limit
      when 'field_limit' then field_limit
      when 'academy_limit' then academy_limit
    end
  into v_current_limit
  from public.commercial_entitlements where club_id = p_club_id;

  v_current_usage := case p_limit_type
    when 'branch_limit' then (select count(*) from public.branches where club_id = p_club_id and status = 'active')
    when 'field_limit' then (select count(*) from public.fields where club_id = p_club_id and status = 'active')
    when 'academy_limit' then (select count(*) from public.programs where club_id = p_club_id and status = 'active')
  end;

  insert into public.commercial_upgrade_requests (club_id, requested_by, limit_type, current_limit, current_usage, note)
  values (p_club_id, auth.uid(), p_limit_type, v_current_limit, v_current_usage, p_note)
  returning id into v_request_id;

  return v_request_id;
end;
$$;

revoke execute on function public.request_commercial_upgrade(uuid, text, text) from public;
revoke execute on function public.request_commercial_upgrade(uuid, text, text) from anon;
grant execute on function public.request_commercial_upgrade(uuid, text, text) to authenticated;

-- ============================================================
-- Enforcement: BEFORE INSERT triggers on branches/fields/programs.
-- Matches this codebase's established pattern (see
-- protect_club_status_from_non_platform_owner) for expressing
-- constraints RLS's row-level model can't cleanly enforce with a
-- readable error message. NULL limit = unlimited, so clubs with no
-- commercial_entitlements row (or a NULL field on it) are never
-- newly blocked by this migration.
-- ============================================================
create or replace function public.enforce_branch_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  select branch_limit into v_limit from public.commercial_entitlements where club_id = new.club_id;
  if v_limit is null then
    return new;
  end if;

  select count(*) into v_count from public.branches where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'branch_limit_reached: club has reached its commercial branch limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_branch_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_branch_limit on public.branches;
create trigger trg_enforce_branch_limit
  before insert on public.branches
  for each row execute function public.enforce_branch_limit();

create or replace function public.enforce_field_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  select field_limit into v_limit from public.commercial_entitlements where club_id = new.club_id;
  if v_limit is null then
    return new;
  end if;

  -- Section E/F/G: the license is club-wide, summed across ALL branches
  -- of the same club, never per-branch.
  select count(*) into v_count from public.fields where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'field_limit_reached: club has reached its commercial field limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_field_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_field_limit on public.fields;
create trigger trg_enforce_field_limit
  before insert on public.fields
  for each row execute function public.enforce_field_limit();

create or replace function public.enforce_academy_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  select academy_limit into v_limit from public.commercial_entitlements where club_id = new.club_id;
  if v_limit is null then
    return new;
  end if;

  -- Section I: one active Academy Program = one licensed academy unit
  -- (the V1 interpretation adopted per the directive's own preferred
  -- reading, since nothing in the locked schema defines a narrower
  -- billable academy unit than "program").
  select count(*) into v_count from public.programs where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'academy_limit_reached: club has reached its commercial academy limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_academy_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_academy_limit on public.programs;
create trigger trg_enforce_academy_limit
  before insert on public.programs
  for each row execute function public.enforce_academy_limit();

-- ============================================================
-- commercial_entitlements_usage: a read-only view giving both the club
-- side (Settings) and the platform side (Clubs commercial detail) a
-- single source for "X/Y used" without duplicating the counting logic
-- in every screen.
-- ============================================================
create view public.commercial_entitlements_usage
with (security_invoker = true) as
select
  c.id as club_id,
  c.name_ar as club_name,
  ce.branch_limit,
  (select count(*) from public.branches b where b.club_id = c.id and b.status = 'active') as branches_used,
  ce.field_limit,
  (select count(*) from public.fields f where f.club_id = c.id and f.status = 'active') as fields_used,
  ce.academy_limit,
  (select count(*) from public.programs p where p.club_id = c.id and p.status = 'active') as academy_used
from public.clubs c
left join public.commercial_entitlements ce on ce.club_id = c.id;

comment on view public.commercial_entitlements_usage is
  'Club-scoped entitlement usage (branches/fields/academy programs vs. their commercial limits). RLS-invoker: a club-side query only ever sees its own club via user_club_ids(); platform_owner sees all via is_platform_owner()-gated policies on the underlying tables it reads through.';
