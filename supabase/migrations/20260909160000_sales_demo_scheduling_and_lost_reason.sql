-- PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2: Sales
-- Intelligence Control. Demo scheduling.
--
-- CONFIRMED GAP (architecture inspection, 2026-09-09): sales_demo_events
-- (20260904090000_sales_intelligence_schema.sql:447-458) exists, has
-- correct RLS (sales_demo_events_write, gated on platform.sales.qualify,
-- 20260904090100_sales_intelligence_rls_and_permissions.sql:207-209),
-- and is already read/projected by get_lead_full_profile() -- but NO
-- RPC anywhere writes to it. Scheduling/completing a demo is a genuine
-- schema-only stub today; this migration is the first thing to write
-- to that table.
--
-- Design mirrors sales_change_lead_status()'s own established pattern
-- exactly (20260904140100_fix_sales_service_role_auth_current_user_bug_
-- class.sql:97-145): same authorization check shape
-- (auth.uid() is null [service_role] OR is_platform_owner() OR
-- has_platform_permission('platform.sales.qualify'/'platform.sales.edit')),
-- same guard-then-mutate-then-audit-twice structure (sales_lead_status_history
-- + sales_lead_activities), reusing the EXISTING status enum values
-- (demo_scheduled/demo_completed already exist in the 16-value enum,
-- 20260904120000_sales_tenant_activation_invites_schema.sql:41-47 --
-- no new status value invented). No lead status is changed by these
-- RPCs directly via UPDATE -- they call the existing
-- sales_change_lead_status() internally, so its own transition guards
-- (do_not_contact/won/converted terminal-state checks) are never
-- duplicated or bypassed.

-- ============================================================
-- sales_schedule_demo: creates a sales_demo_events row AND moves the
-- lead to demo_scheduled (via the existing, unmodified
-- sales_change_lead_status() -- its own guards apply unchanged, e.g. a
-- do_not_contact or already-won lead correctly cannot be scheduled).
-- ============================================================
create or replace function public.sales_schedule_demo(
  p_lead_id uuid,
  p_scheduled_at timestamptz,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_demo_id uuid;
begin
  if not (
    auth.uid() is null
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.qualify')
  ) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.sales_leads where id = p_lead_id) then
    raise exception 'lead not found';
  end if;

  if p_scheduled_at is null then
    raise exception 'a scheduled time is required';
  end if;

  insert into public.sales_demo_events (lead_id, scheduled_at, notes, owner_id)
  values (p_lead_id, p_scheduled_at, p_notes, auth.uid())
  returning id into v_demo_id;

  -- Reuses the existing, unmodified status-change RPC -- its own
  -- terminal-state/do_not_contact guards apply unchanged. A demo can
  -- legitimately be (re)scheduled from most non-terminal statuses, not
  -- only from "qualified", so no additional status precondition is
  -- added here beyond what sales_change_lead_status() itself already
  -- enforces.
  perform public.sales_change_lead_status(p_lead_id, 'demo_scheduled', 'demo scheduled for ' || p_scheduled_at::text);

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'demo_scheduled', jsonb_build_object('demo_id', v_demo_id, 'scheduled_at', p_scheduled_at, 'notes', p_notes), auth.uid());

  return v_demo_id;
end;
$$;

revoke execute on function public.sales_schedule_demo(uuid, timestamptz, text) from public, anon;
grant execute on function public.sales_schedule_demo(uuid, timestamptz, text) to authenticated;

-- ============================================================
-- sales_complete_demo: records the outcome on the most recent
-- scheduled-but-not-yet-completed demo event for this lead, and moves
-- the lead to demo_completed. outcome uses the exact same 4-value
-- check constraint sales_demo_events.outcome already has
-- (positive/neutral/negative/no_show,
-- 20260904090000_sales_intelligence_schema.sql:452) -- not a new enum.
-- ============================================================
create or replace function public.sales_complete_demo(
  p_lead_id uuid,
  p_outcome text,
  p_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_demo_id uuid;
begin
  if not (
    auth.uid() is null
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.qualify')
  ) then
    raise exception 'not authorized';
  end if;

  if p_outcome not in ('positive', 'neutral', 'negative', 'no_show') then
    raise exception 'invalid outcome -- must be one of positive, neutral, negative, no_show';
  end if;

  select id into v_demo_id
  from public.sales_demo_events
  where lead_id = p_lead_id and completed_at is null
  order by scheduled_at desc nulls last, created_at desc
  limit 1;

  if v_demo_id is null then
    raise exception 'no scheduled, not-yet-completed demo found for this lead -- schedule one first';
  end if;

  update public.sales_demo_events
  set completed_at = now(), outcome = p_outcome, notes = coalesce(p_notes, notes)
  where id = v_demo_id;

  perform public.sales_change_lead_status(p_lead_id, 'demo_completed', 'demo outcome: ' || p_outcome);

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'demo_completed', jsonb_build_object('demo_id', v_demo_id, 'outcome', p_outcome, 'notes', p_notes), auth.uid());

  return v_demo_id;
end;
$$;

revoke execute on function public.sales_complete_demo(uuid, text, text) from public, anon;
grant execute on function public.sales_complete_demo(uuid, text, text) to authenticated;

comment on function public.sales_schedule_demo(uuid, timestamptz, text) is
  'Creates a sales_demo_events row and moves the lead to demo_scheduled via the existing sales_change_lead_status(). First writer to sales_demo_events -- the table existed with correct RLS but no RPC before this migration.';
comment on function public.sales_complete_demo(uuid, text, text) is
  'Records the outcome on the most recent open demo event for a lead and moves it to demo_completed via the existing sales_change_lead_status().';
