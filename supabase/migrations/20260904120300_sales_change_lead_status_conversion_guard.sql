-- Phase 14 follow-up: sales_change_lead_status()'s won-guard message was
-- written before the identity/ownership decision was made and now reads
-- as stale ("...which requires an identity/ownership model decision not
-- yet made -- see docs/DECISIONS.md ADR-054"). Also widens the guard to
-- refuse the two NEW statuses this generic setter must never touch
-- directly -- awaiting_owner_activation and tenant_activated are only
-- ever reachable via sales_win_lead_and_invite_owner() and
-- claim_sales_activation_invite() respectively, which carry their own
-- specific invariants (invite minting, onboarding idempotency) this
-- generic status setter does not implement.
create or replace function public.sales_change_lead_status(p_lead_id uuid, p_new_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_current text;
begin
  if current_user <> 'service_role' and not (
       public.is_platform_owner() or public.has_platform_permission('platform.sales.qualify')
       or public.has_platform_permission('platform.sales.edit')
     ) then
    raise exception 'not authorized';
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

revoke all on function public.sales_change_lead_status(uuid, text, text) from public, anon;
grant execute on function public.sales_change_lead_status(uuid, text, text) to authenticated, service_role;
