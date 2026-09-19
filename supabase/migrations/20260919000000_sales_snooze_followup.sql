-- Sales Intelligence: add a real "snooze" (reschedule) capability for
-- follow-ups (2026-09-18/19, live-verified audit finding).
--
-- ROOT CAUSE: sales_followups only ever had two states reachable from
-- the UI: pending (until its scheduled_at passes, after which
-- get_pending_followups() flags it "overdue" forever) or completed
-- (via sales_complete_followup(), which REQUIRES a real p_last_action
-- description of what was actually done). There was no way to simply
-- push a follow-up's date out -- a salesperson who just wants to defer
-- "call back next week" (no real action has happened yet) was forced
-- to either invent a fake p_last_action to "complete" it, or let it
-- pile up as permanently-overdue clutter with no bulk or per-item way
-- to clear it. Confirmed live: 20/20 visible follow-ups were stuck in
-- exactly this state, 7-11 days overdue.
--
-- FIX: sales_snooze_followup() moves scheduled_at forward in place
-- (status stays 'pending' -- this is NOT a completion, no last_action
-- is recorded or required) and logs a real audit trail entry via
-- sales_lead_activities, mirroring sales_create_call_task()'s own
-- activity-logging pattern. Same permission gate as
-- sales_complete_followup() -- this is not a new capability tier, just
-- a second, more honest way to act on a follow-up you're not ready to
-- close yet.

create or replace function public.sales_snooze_followup(p_followup_id uuid, p_new_scheduled_at timestamptz)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
  v_old_scheduled_at timestamptz;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_followups')) then
    raise exception 'not authorized';
  end if;

  if p_new_scheduled_at <= now() then
    raise exception 'the new date must be in the future';
  end if;

  select lead_id, scheduled_at into v_lead_id, v_old_scheduled_at
  from public.sales_followups
  where id = p_followup_id and status = 'pending'
  for update;

  if not found then
    raise exception 'follow-up not found or not pending';
  end if;

  update public.sales_followups
  set scheduled_at = p_new_scheduled_at
  where id = p_followup_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (
    v_lead_id,
    'followup_snoozed',
    jsonb_build_object('followup_id', p_followup_id, 'old_scheduled_at', v_old_scheduled_at, 'new_scheduled_at', p_new_scheduled_at),
    auth.uid()
  );
end;
$$;

revoke all on function public.sales_snooze_followup(uuid, timestamptz) from public;
revoke all on function public.sales_snooze_followup(uuid, timestamptz) from anon;
revoke all on function public.sales_snooze_followup(uuid, timestamptz) from authenticated;
grant execute on function public.sales_snooze_followup(uuid, timestamptz) to authenticated;
