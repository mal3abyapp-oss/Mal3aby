-- PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Phase 16 independent UX
-- review, P2 finding: "record reason lost" (this mission's own
-- explicit instruction) was enforced UI-only, not server-side.
--
-- sales_change_lead_status(p_lead_id, p_new_status, p_reason default
-- null) already threads p_reason through to status_reason/
-- sales_lead_status_history/sales_lead_activities for every transition
-- (20260904140100_fix_sales_service_role_auth_current_user_bug_class.
-- sql:97-145) -- but never required a non-empty reason for any specific
-- target status. The new Sales pipeline UI (this mission) requires a
-- reason client-side when moving to lost/do_not_contact, but a direct
-- RPC call (devtools, a script, a future UI regression) could still
-- mark a lead lost/do-not-contact with reason=null, exactly the same
-- audit-quality gap class already fixed once for platform staff actions
-- (20260908150000_platform_staff_actions_require_reason.sql) and for
-- club suspension (20260817100225_platform_suspend_reactivate_club_
-- with_reason.sql) in prior missions. Same fix shape here: a real,
-- non-empty reason is now required specifically for lost/
-- do_not_contact (the two terminal-ish, "why did we stop pursuing
-- this" transitions the mission singled out) -- every other transition
-- (qualified, contacted, demo_scheduled, etc.) keeps reason optional,
-- unchanged, since those aren't the ones the mission asked to record a
-- reason for.
--
-- Every other line of business logic in this function is byte-for-byte
-- unchanged from the 20260904140100 version -- the do_not_contact
-- re-activation guard, the won/converted terminal-state guard, the
-- won-must-go-through-conversion-flow guard, the history/activity
-- inserts, all preserved verbatim.
create or replace function public.sales_change_lead_status(p_lead_id uuid, p_new_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current text;
begin
  if not (
    auth.uid() is null  -- service_role caller: no anon/authenticated grant exists, so reaching this point already proves trust
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.qualify')
    or public.has_platform_permission('platform.sales.edit')
  ) then
    raise exception 'not authorized';
  end if;

  -- FIX (this migration): a real reason is now required for the two
  -- transitions the mission explicitly asked to have a recorded reason
  -- -- lost and do_not_contact. Every other transition's p_reason stays
  -- fully optional, unchanged.
  if p_new_status in ('lost', 'do_not_contact') and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required when marking a lead as % ', p_new_status;
  end if;

  select status into v_current from public.sales_leads where id = p_lead_id for update;
  if v_current is null then
    raise exception 'lead not found';
  end if;

  if v_current = 'do_not_contact' and p_new_status not in ('do_not_contact', 'lost') then
    raise exception 'this lead is marked do_not_contact and cannot be re-activated for outreach';
  end if;

  if v_current in ('won', 'awaiting_owner_activation', 'tenant_activated') and p_new_status <> v_current then
    raise exception 'this lead has already been won/converted and cannot change status through this action';
  end if;

  if p_new_status = 'won' then
    raise exception 'a lead can only reach won status via sales_win_lead_and_invite_owner() (Convert to Tenant), not a direct status change';
  end if;

  if p_new_status in ('awaiting_owner_activation', 'tenant_activated') then
    raise exception 'this status is only reachable via the tenant activation flow (Convert to Tenant / owner activation), not a direct status change';
  end if;

  update public.sales_leads
  set status = p_new_status, status_reason = p_reason, updated_at = now()
  where id = p_lead_id;

  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, v_current, p_new_status, p_reason, auth.uid());

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'status_changed', jsonb_build_object('from', v_current, 'to', p_new_status, 'reason', p_reason), auth.uid());
end;
$$;

comment on function public.sales_change_lead_status(uuid, text, text) is
  'Changes a lead''s pipeline status. Reason REQUIRED (non-empty) when p_new_status is lost or do_not_contact -- matches platform_suspend_club()''s validation shape. Optional for every other transition. Same terminal-state/conversion guards as before, unchanged.';
