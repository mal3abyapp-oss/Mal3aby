-- P0 FIX (2026-09-06, Final Sell-Readiness Mission — Workstreams F+G):
-- _complete_sales_conversion() calls complete_new_club_onboarding() to
-- create the tenant, but never called mark_club_onboarding_complete()
-- afterwards. Since 20260904210300_commercial_packaging_trial_gate_on_
-- onboarding.sql moved the actual trial-start INSERT into platform_
-- subscriptions out of complete_new_club_onboarding() and into mark_
-- club_onboarding_complete() (a distinct, separately-called RPC), and
-- NOTHING in this codebase ever called that second RPC (confirmed: zero
-- references outside generated types.ts), every tenant converted via
-- the Sales Intelligence "invite-based owner activation" flow
-- (ADR-054 Phase 14) would end up with a real club, a real activated
-- owner account, and ZERO platform_subscriptions rows -- which
-- get_club_platform_access() resolves to 'blocked' for a club with no
-- subscription row at all (see 20260818142000_scope_club_platform_
-- access_caller.sql). A prospect who was WON, verified their email +
-- activation secret, and created their account would land in the app
-- immediately locked out, with no trial ever having started -- the
-- worst possible first impression for a paying-intent lead the
-- platform owner personally converted.
--
-- Verified live in production (read-only query, 2026-09-06): every
-- existing club has onboarding_completed_at IS NULL (the column has
-- never been set by anything), including clubs with long-running
-- active trial/paid subscriptions predating this gate -- so this has
-- not yet stranded a real customer only because no club has been
-- created since the 2026-09-04 migration landed. The very next
-- self-serve signup or sales-activation would be the first to hit it.
-- (The self-serve /onboarding wizard is fixed separately, in the same
-- pass, by calling mark_club_onboarding_complete() from OnboardingPage.
-- tsx right after complete_new_club_onboarding() succeeds -- that
-- wizard's own final step IS "the owner finishing initial setup".)
--
-- Fix here: call mark_club_onboarding_complete() from inside
-- _complete_sales_conversion() itself, in the same transaction as
-- complete_new_club_onboarding(), right after the club is created --
-- server-side, so this can never again be missed by a frontend gap.
-- A sales-activated tenant has no separate "finish initial setup" UI
-- step distinct from claiming the invite (unlike the self-serve
-- wizard's explicit 4-step flow) -- claiming the invite IS the
-- completion of onboarding for this path. mark_club_onboarding_
-- complete() is idempotent and safe to call unconditionally.
--
-- No contract change to any RPC signature; _complete_sales_conversion
-- has no external grants (called only from claim_sales_activation_
-- invite() in the same transaction), so this is a pure body-only fix.
create or replace function public._complete_sales_conversion(
  p_invite_id uuid,
  p_lead_id uuid
)
returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lead record;
  v_invite record;
  v_onboard record;
begin
  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;

  -- Already converted (safe retry / race loser) -- return the existing
  -- club, never call onboarding again.
  if v_lead.status = 'tenant_activated' and v_lead.converted_club_id is not null then
    return v_lead.converted_club_id;
  end if;

  if v_lead.status <> 'awaiting_owner_activation' then
    raise exception 'this lead is not currently awaiting owner activation';
  end if;

  select * into v_invite from public.sales_tenant_activation_invites where id = p_invite_id for update;

  -- complete_new_club_onboarding() reuses existing tenant-onboarding
  -- logic UNMODIFIED, per the mandatory "do not duplicate onboarding
  -- business logic" rule -- called here, under the prospect's OWN real
  -- session (auth.uid() = the verified, freshly-bound identity), which
  -- is exactly the trust context that RPC's own auth.uid()-only design
  -- requires. The prospect (not the platform owner) becomes club_owner.
  select * into v_onboard from public.complete_new_club_onboarding(
    p_business_type := coalesce(v_invite.business_type, 'sports_club'),
    p_club_name := v_invite.business_name,
    p_club_name_ar := coalesce(v_invite.business_name_ar, v_invite.business_name),
    p_branch_name := coalesce(v_invite.city, v_invite.business_name),
    p_city := coalesce(v_invite.city, ''),
    p_phone := coalesce(v_invite.contact_phone, ''),
    p_owner_email := v_invite.owner_email,
    p_owner_mobile := coalesce(v_invite.contact_phone, ''),
    p_government_affiliated := false,
    p_country := v_invite.country,
    p_phone_e164 := v_invite.contact_phone_e164
  );

  -- P0 FIX: start the trial (or confirm no-trial state) now -- see this
  -- migration's own header comment. mark_club_onboarding_complete() is
  -- idempotent and internally scoped to user_club_ids(), which auth.uid()
  -- (the just-claimed prospect identity, now club_owner via the insert
  -- inside complete_new_club_onboarding() above) satisfies.
  perform public.mark_club_onboarding_complete(v_onboard.club_id);

  update public.sales_leads
  set status = 'tenant_activated', converted_club_id = v_onboard.club_id, converted_at = now(), updated_at = now()
  where id = p_lead_id;

  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, 'awaiting_owner_activation', 'tenant_activated', null, auth.uid());

  insert into public.sales_conversion_records (lead_id, club_id, copied_fields, converted_by)
  values (
    p_lead_id, v_onboard.club_id,
    jsonb_build_object(
      'business_name', v_invite.business_name, 'business_name_ar', v_invite.business_name_ar,
      'business_type', v_invite.business_type, 'city', v_invite.city, 'country', v_invite.country,
      'owner_email', v_invite.owner_email, 'trial_granted', v_onboard.trial_granted
    ),
    auth.uid()
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'tenant_created', jsonb_build_object('club_id', v_onboard.club_id, 'trial_granted', v_onboard.trial_granted), auth.uid());
  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'owner_linked', jsonb_build_object('user_id', auth.uid(), 'club_id', v_onboard.club_id), auth.uid());
  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'conversion_completed', jsonb_build_object('club_id', v_onboard.club_id), auth.uid());

  perform public.write_audit_log(
    v_onboard.club_id, 'sales.lead_converted', 'sales_leads', p_lead_id, null,
    jsonb_build_object('club_id', v_onboard.club_id, 'lead_id', p_lead_id), null
  );

  return v_onboard.club_id;
end;
$function$;

revoke all on function public._complete_sales_conversion(uuid, uuid) from public, anon, authenticated, service_role;

comment on function public._complete_sales_conversion(uuid, uuid) is
  'Internal step of claim_sales_activation_invite() -- creates the tenant via complete_new_club_onboarding() then immediately starts the trial via mark_club_onboarding_complete() (P0 fix 2026-09-06: this second call was previously missing entirely, so every sales-activated tenant landed with zero platform_subscriptions rows and instant blocked access). No external grants -- only ever called from claim_sales_activation_invite() in the same transaction.';
