-- STATE-1(a) fix (2026-09-19/20, owner brief): sales_change_lead_status()
-- already had real guards (confirmed by reading it in full before
-- writing this migration) blocking do_not_contact re-activation, any
-- direct status change once won/awaiting_owner_activation/
-- tenant_activated, and reaching those three statuses at all except
-- via the dedicated conversion flow -- STATE-1(b) ("won -> tenant
-- activated" jump) is therefore NOT REPRODUCIBLE as described:
-- sales_win_lead_and_invite_owner() already transitions
-- won -> awaiting_owner_activation within the same transaction (the
-- 'won' state is real but transient, by design -- this IS the owner
-- brief's own section 9 default, "won = club activated", already
-- correctly implemented).
--
-- STATE-1(a) is real and unguarded: nothing prevented jumping straight
-- to contact_ready (or demo_scheduled, negotiation, etc.) for a lead
-- with no computed score and no eligible outreach channel. Fixed with
-- the brief's own stated acceptance criterion: "ready_to_contact
-- requires an eligible channel and score computed." Reuses
-- get_lead_channel_eligibility()'s own eligibility logic (read in
-- full before writing this migration) rather than re-implementing it
-- -- "eligible" here means the same thing that function already
-- computes: a verified email OR phone on file.
--
-- Scope: this guard applies only to contact_ready and every status
-- that implies contact already happened or is imminent (contacted,
-- replied, demo_scheduled, demo_completed, negotiation) -- discovered/
-- enriching/enriched/qualified/lost/do_not_contact are unaffected
-- (early pipeline stages and terminal-negative statuses need no
-- readiness proof). won/awaiting_owner_activation/tenant_activated
-- were already unreachable through this function before this
-- migration and remain so.

create or replace function public.sales_change_lead_status(p_lead_id uuid, p_new_status text, p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current text;
  v_lead public.sales_leads%rowtype;
  v_eligible boolean;
begin
  if not (
    auth.uid() is null  -- service_role caller: no anon/authenticated grant exists, so reaching this point already proves trust
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.qualify')
    or public.has_platform_permission('platform.sales.edit')
  ) then
    raise exception 'not authorized';
  end if;

  if p_new_status in ('lost', 'do_not_contact') and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required when marking a lead as % ', p_new_status;
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;
  v_current := v_lead.status;

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

  -- STATE-1(a) fix: a readiness guard for contact_ready and every
  -- status that implies contact has happened or is imminent -- same
  -- eligibility test get_lead_channel_eligibility() already applies
  -- (verified email OR phone on file), plus a computed score.
  if p_new_status in ('contact_ready', 'contacted', 'replied', 'demo_scheduled', 'demo_completed', 'negotiation') then
    if v_lead.current_score is null then
      raise exception 'this lead has no computed score yet -- run scoring before marking it %', p_new_status;
    end if;

    v_eligible := coalesce(v_lead.public_email, '') <> '' or coalesce(v_lead.public_phone, '') <> '';
    if not v_eligible then
      raise exception 'this lead has no verified email or phone on file -- no safe outreach channel exists, cannot mark it %', p_new_status;
    end if;
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
