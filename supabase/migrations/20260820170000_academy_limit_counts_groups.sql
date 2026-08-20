-- Fix: enforce_academy_limit() gated public.programs, but the Academy
-- Phase E / redesign work (20260820150000_academy_optional_program_season.sql)
-- made program_id/season_id nullable on public.groups so a club can create
-- a sellable Group ("Membership") without ever creating a Program row.
-- public.groups is now the actual billable "academy" unit under the
-- simplified model (it has capacity, coach, schedule, and subscription
-- price -- Program is optional organizational metadata only, per that
-- migration's own comment: "the actual billable academy unit under the
-- simplified model"). Left as-is, a club using the primary/simplified
-- path (Group with no Program) never hits this entitlement gate at all,
-- no matter how many Groups it creates.
--
-- Fix: move the trigger from public.programs to public.groups, and count
-- active groups instead of active programs everywhere academy_limit usage
-- is computed (enforce_academy_limit(), request_commercial_upgrade(),
-- commercial_entitlements_usage). NULL limit still means unlimited, so no
-- club with an unset academy_limit is newly affected.
--
-- Programs are deliberately NOT also gated: a Program is optional
-- metadata with no capacity/price of its own now, so counting it
-- alongside Groups would double-count or gate on something with no
-- commercial weight. Groups is the single source of truth for "how many
-- academy units does this club have."

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

  -- Section I (superseded): a Group is now the billable academy unit --
  -- see migration header. Counts active groups, not active programs.
  select count(*) into v_count from public.groups where club_id = new.club_id and status = 'active';
  if v_count >= v_limit then
    raise exception 'academy_limit_reached: club has reached its commercial academy limit (%)', v_limit
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke execute on function public.enforce_academy_limit() from public, anon, authenticated;

drop trigger if exists trg_enforce_academy_limit on public.programs;

drop trigger if exists trg_enforce_academy_limit on public.groups;
create trigger trg_enforce_academy_limit
  before insert on public.groups
  for each row execute function public.enforce_academy_limit();

-- ============================================================
-- request_commercial_upgrade(): current_usage snapshot for academy_limit
-- must match what the trigger enforces, or the upgrade-request record
-- would show a stale/wrong "current_usage" to Platform Owner.
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
    when 'academy_limit' then (select count(*) from public.groups where club_id = p_club_id and status = 'active')
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
-- commercial_entitlements_usage: academy_used must reflect the same
-- billable unit the trigger enforces (active groups), so the Settings
-- and Platform Owner "X/Y used" displays match reality.
-- ============================================================
create or replace view public.commercial_entitlements_usage
with (security_invoker = true) as
select
  c.id as club_id,
  c.name_ar as club_name,
  ce.branch_limit,
  (select count(*) from public.branches b where b.club_id = c.id and b.status = 'active') as branches_used,
  ce.field_limit,
  (select count(*) from public.fields f where f.club_id = c.id and f.status = 'active') as fields_used,
  ce.academy_limit,
  (select count(*) from public.groups g where g.club_id = c.id and g.status = 'active') as academy_used
from public.clubs c
left join public.commercial_entitlements ce on ce.club_id = c.id;

comment on view public.commercial_entitlements_usage is
  'Club-scoped entitlement usage (branches/fields/academy groups vs. their commercial limits). academy_used counts active public.groups rows -- the billable academy unit under the simplified model (see 20260820170000_academy_limit_counts_groups.sql) -- not public.programs, which is now optional organizational metadata. RLS-invoker: a club-side query only ever sees its own club via user_club_ids(); platform_owner sees all via is_platform_owner()-gated policies on the underlying tables it reads through.';
