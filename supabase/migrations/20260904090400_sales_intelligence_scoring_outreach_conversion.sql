-- Sales Intelligence — scoring, signals, outreach lifecycle, campaigns,
-- follow-ups, and governed tenant conversion (ADR-054, Phases 6/7/9/11/
-- 12/13/14).

-- ============================================================
-- sales_record_signal(): evidence-backed opportunity signal write
-- (Phase 6). Deactivates any prior active signal of the same key on
-- the same lead (a signal can change over time -- a site that added
-- booking should retire the NO_ONLINE_BOOKING signal, not accumulate a
-- contradictory duplicate) rather than deleting history.
-- ============================================================
create or replace function public.sales_record_signal(
  p_lead_id uuid,
  p_signal_key text,
  p_confidence text,
  p_evidence jsonb,
  p_source_url text default null,
  p_enrichment_run_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_signal_id uuid;
begin
  -- Same service_role bypass rationale as sales_change_lead_status --
  -- this is the genuine authenticated Postgres role for a trusted
  -- server-side worker (sales-website-enrichment), never a
  -- client-forgeable claim.
  if current_user <> 'service_role' and not (
       public.is_platform_owner() or public.has_platform_permission('platform.sales.enrich')
     ) then
    raise exception 'not authorized';
  end if;

  update public.sales_lead_signals
  set is_active = false
  where lead_id = p_lead_id and signal_key = p_signal_key and is_active = true;

  insert into public.sales_lead_signals (lead_id, signal_key, confidence, evidence, source_url, enrichment_run_id)
  values (p_lead_id, p_signal_key, p_confidence, p_evidence, p_source_url, p_enrichment_run_id)
  returning id into v_signal_id;

  -- Keep sales_leads' denormalized summary columns in sync for fast list filters.
  if p_signal_key = 'no_online_booking' then
    update public.sales_leads set has_online_booking = false where id = p_lead_id;
  elsif p_signal_key = 'multi_branch' then
    update public.sales_leads set branch_count_estimate = greatest(coalesce(branch_count_estimate, 1), 2) where id = p_lead_id;
  elsif p_signal_key = 'multi_field_facility' then
    update public.sales_leads set facility_count_estimate = greatest(coalesce(facility_count_estimate, 1), 2) where id = p_lead_id;
  elsif p_signal_key = 'academy_present' then
    update public.sales_leads set has_academy_presence = true where id = p_lead_id;
  end if;

  return v_signal_id;
end;
$$;

revoke all on function public.sales_record_signal(uuid, text, text, jsonb, text, uuid) from public, anon;
grant execute on function public.sales_record_signal(uuid, text, text, jsonb, text, uuid) to authenticated, service_role;

-- ============================================================
-- sales_compute_lead_score(): explainable scoring engine (Phase 7).
-- Deterministic, rule-based (no opaque AI-only ranking, per the
-- mission's explicit requirement) -- every dimension is a plain
-- computation over sales_leads columns + active sales_lead_signals,
-- and dimension_breakdown + a plain-language explanation are persisted
-- alongside the score so "why" is always answerable.
--
-- Dimensions (0-100 total, weights chosen to reflect commercial fit
-- for Mal3aby specifically -- booking/operations software for sports
-- facilities):
--   digital_maturity_gap (0-30): no_website/outdated_website/
--     no_online_booking/whatsapp_only/phone_only signals -- the CORE
--     Mal3aby pitch is closing exactly this gap, so it's weighted highest.
--   facility_scale (0-25): multi_field_facility + multi_branch signals
--     + branch/facility count estimates -- bigger operations = bigger
--     subscription tier fit.
--   academy_potential (0-15): academy_present signal -- opens the
--     separate academy/attendance/subscriptions module.
--   demand_signal (0-15): rating + review_count -- proxy for real
--     booking volume worth digitizing.
--   contactability (0-15): how many real contact channels exist
--     (website/phone/email/social) -- a lead with zero contact
--     channels cannot be pursued regardless of fit.
-- ============================================================
create or replace function public.sales_compute_lead_score(p_lead_id uuid)
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead public.sales_leads%rowtype;
  v_signal_keys text[];
  v_digital_gap int := 0;
  v_facility_scale int := 0;
  v_academy int := 0;
  v_demand int := 0;
  v_contactability int := 0;
  v_total int;
  v_band text;
  v_breakdown jsonb;
  v_explanation_ar text;
  v_explanation_en text;
  v_contact_channels int := 0;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.qualify')) then
    raise exception 'not authorized';
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;

  select array_agg(signal_key) into v_signal_keys
  from public.sales_lead_signals where lead_id = p_lead_id and is_active = true;
  v_signal_keys := coalesce(v_signal_keys, '{}');

  -- digital_maturity_gap (0-30)
  if 'no_website' = any(v_signal_keys) then v_digital_gap := v_digital_gap + 12; end if;
  if 'no_online_booking' = any(v_signal_keys) then v_digital_gap := v_digital_gap + 10; end if;
  if 'whatsapp_only_booking' = any(v_signal_keys) or 'phone_only_booking' = any(v_signal_keys) then v_digital_gap := v_digital_gap + 6; end if;
  if 'outdated_website' = any(v_signal_keys) then v_digital_gap := v_digital_gap + 2; end if;
  v_digital_gap := least(v_digital_gap, 30);

  -- facility_scale (0-25)
  v_facility_scale := least(coalesce(v_lead.branch_count_estimate, 1) - 1, 3) * 4
                     + least(coalesce(v_lead.facility_count_estimate, 1) - 1, 5) * 2;
  if 'multi_branch' = any(v_signal_keys) then v_facility_scale := v_facility_scale + 5; end if;
  v_facility_scale := least(v_facility_scale, 25);

  -- academy_potential (0-15)
  if v_lead.has_academy_presence or 'academy_present' = any(v_signal_keys) then v_academy := 15; end if;

  -- demand_signal (0-15)
  if v_lead.rating is not null and v_lead.rating >= 4.0 then v_demand := v_demand + 6; end if;
  if v_lead.review_count is not null then
    v_demand := v_demand + least(v_lead.review_count / 20, 9);
  end if;
  if 'high_review_volume' = any(v_signal_keys) then v_demand := v_demand + 3; end if;
  v_demand := least(v_demand, 15);

  -- contactability (0-15)
  if v_lead.website is not null then v_contact_channels := v_contact_channels + 1; end if;
  if v_lead.public_phone is not null then v_contact_channels := v_contact_channels + 1; end if;
  if v_lead.public_email is not null then v_contact_channels := v_contact_channels + 1; end if;
  if exists (select 1 from public.sales_lead_social_links where lead_id = p_lead_id) then v_contact_channels := v_contact_channels + 1; end if;
  v_contactability := least(v_contact_channels * 4, 15);
  -- A lead with genuinely zero contact channels cannot be pursued -- hard floor regardless of other dimensions.
  if v_contact_channels = 0 then
    v_digital_gap := 0; v_facility_scale := 0; v_academy := 0; v_demand := 0;
  end if;

  v_total := v_digital_gap + v_facility_scale + v_academy + v_demand + v_contactability;
  v_band := case when v_total >= 65 then 'hot' when v_total >= 35 then 'warm' else 'cold' end;

  v_breakdown := jsonb_build_object(
    'digital_maturity_gap', v_digital_gap,
    'facility_scale', v_facility_scale,
    'academy_potential', v_academy,
    'demand_signal', v_demand,
    'contactability', v_contactability
  );

  v_explanation_en := format(
    'Score %s/100 (%s). Digital gap: %s/30 (opportunity to sell online booking/operations). Facility scale: %s/25. Academy fit: %s/15. Demand signal: %s/15 (rating/reviews). Contactability: %s/15 (%s channel(s) found).%s',
    v_total, upper(v_band), v_digital_gap, v_facility_scale, v_academy, v_demand, v_contactability, v_contact_channels,
    case when v_contact_channels = 0 then ' No contact channel found -- score floored, cannot be pursued until a contact method is discovered.' else '' end
  );
  v_explanation_ar := format(
    'النتيجة %s من 100 (%s). فجوة التحول الرقمي: %s من 30 (فرصة لبيع الحجز الإلكتروني وأدوات التشغيل). حجم المنشأة: %s من 25. ملاءمة الأكاديمية: %s من 15. مؤشر الطلب: %s من 15 (التقييم/المراجعات). إمكانية التواصل: %s من 15 (تم العثور على %s قناة تواصل).%s',
    v_total, case v_band when 'hot' then 'ساخن' when 'warm' then 'دافئ' else 'بارد' end,
    v_digital_gap, v_facility_scale, v_academy, v_demand, v_contactability, v_contact_channels,
    case when v_contact_channels = 0 then ' لم يتم العثور على قناة تواصل -- تم تصفير النتيجة، لا يمكن المتابعة حتى يتم اكتشاف وسيلة تواصل.' else '' end
  );

  insert into public.sales_lead_scores (lead_id, score, score_band, dimension_breakdown, explanation_ar, explanation_en)
  values (p_lead_id, v_total, v_band, v_breakdown, v_explanation_ar, v_explanation_en);

  update public.sales_leads set current_score = v_total, current_score_band = v_band, updated_at = now() where id = p_lead_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'scored', jsonb_build_object('score', v_total, 'band', v_band), auth.uid());

  return v_total;
end;
$$;

revoke all on function public.sales_compute_lead_score(uuid) from public, anon;
grant execute on function public.sales_compute_lead_score(uuid) to authenticated, service_role;

-- ============================================================
-- Outreach lifecycle: GENERATE -> APPROVE -> QUEUE -> SEND (Phase 11),
-- four distinct, separately-permissioned steps -- no single RPC
-- collapses generate+send, by design, so the human-approval gate the
-- mission requires cannot be silently skipped by a future UI shortcut.
-- ============================================================

-- sales_generate_outreach_message(): GENERATE step. Content itself is
-- produced by the Edge Function AI adapter (Phase 10) and passed in
-- here as p_body/p_subject -- this RPC's job is only to persist it with
-- its grounding evidence and status='generated', never to call the AI
-- itself (RPCs in this codebase never make outbound HTTP calls).
create or replace function public.sales_generate_outreach_message(
  p_lead_id uuid,
  p_channel text,
  p_message_type text,
  p_language text,
  p_subject text,
  p_body text,
  p_grounding jsonb,
  p_campaign_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_message_id uuid;
  v_status text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.generate_offer')) then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.sales_leads where id = p_lead_id and status = 'do_not_contact') then
    raise exception 'this lead is marked do_not_contact -- outreach content cannot be generated for it';
  end if;

  insert into public.sales_outreach_messages (lead_id, campaign_id, channel, message_type, language, subject, body, grounding, created_by)
  values (p_lead_id, p_campaign_id, p_channel, p_message_type, p_language, p_subject, p_body, p_grounding, auth.uid())
  returning id into v_message_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'message_generated', jsonb_build_object('message_id', v_message_id, 'channel', p_channel, 'type', p_message_type), auth.uid());

  return v_message_id;
end;
$$;

revoke all on function public.sales_generate_outreach_message(uuid, text, text, text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.sales_generate_outreach_message(uuid, text, text, text, text, text, jsonb, uuid) to authenticated, service_role;

-- sales_approve_outreach_message(): APPROVE step.
create or replace function public.sales_approve_outreach_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.approve_outreach')) then
    raise exception 'not authorized';
  end if;

  update public.sales_outreach_messages
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_message_id and status = 'generated';

  if not found then
    raise exception 'message not found or not in generated status';
  end if;
end;
$$;

revoke all on function public.sales_approve_outreach_message(uuid) from public, anon;
grant execute on function public.sales_approve_outreach_message(uuid) to authenticated;

-- sales_queue_outreach_message(): QUEUE step. WHATSAPP IS EXPLICITLY
-- REFUSED HERE -- the mission's Phase 11 hard rule ("DO NOT IMPLEMENT
-- AUTOMATED COLD WHATSAPP OUTREACH... do not touch the existing
-- WhatsApp subsystem"). whatsapp_talking_points and phone_script
-- channels are for human-read talking points only and are never queued
-- for automated sending -- this function only accepts channel='email'.
create or replace function public.sales_queue_outreach_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_channel text;
  v_lead_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.send_outreach')) then
    raise exception 'not authorized';
  end if;

  select channel, lead_id into v_channel, v_lead_id from public.sales_outreach_messages where id = p_message_id and status = 'approved';
  if v_channel is null then
    raise exception 'message not found or not in approved status';
  end if;

  if v_channel <> 'email' then
    raise exception 'only channel=email can be queued for automated sending; % is a human-read talking-points channel, not an outbound send channel', v_channel;
  end if;

  if exists (select 1 from public.sales_leads where id = v_lead_id and status = 'do_not_contact') then
    raise exception 'this lead is marked do_not_contact -- queueing is blocked';
  end if;

  update public.sales_outreach_messages set status = 'queued' where id = p_message_id;
end;
$$;

revoke all on function public.sales_queue_outreach_message(uuid) from public, anon;
grant execute on function public.sales_queue_outreach_message(uuid) to authenticated;

-- sales_claim_queued_outreach_message() / sales_mark_outreach_sent():
-- SEND step, executed by an Edge Function worker (service-role) that
-- actually calls the email provider -- mirrors the discovery job claim
-- pattern.
create or replace function public.sales_claim_queued_outreach_message()
returns table(message_id uuid, lead_id uuid, subject text, body text, recipient_email text, language text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_msg record;
begin
  select m.id, m.lead_id, m.subject, m.body, l.public_email, m.language
    into v_msg
  from public.sales_outreach_messages m
  join public.sales_leads l on l.id = m.lead_id
  where m.status = 'queued' and m.channel = 'email' and l.status <> 'do_not_contact'
  order by m.created_at
  for update of m skip locked
  limit 1;

  if v_msg.message_id is null then
    return;
  end if;

  return query select v_msg.message_id, v_msg.lead_id, v_msg.subject, v_msg.body, v_msg.public_email, v_msg.language;
end;
$$;

revoke all on function public.sales_claim_queued_outreach_message() from public, anon, authenticated;
grant execute on function public.sales_claim_queued_outreach_message() to service_role;

create or replace function public.sales_mark_outreach_sent(p_message_id uuid, p_success boolean, p_provider_reference text default null, p_error text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
begin
  update public.sales_outreach_messages
  set status = case when p_success then 'sent' else 'failed' end,
      sent_at = case when p_success then now() else sent_at end,
      provider_reference = p_provider_reference,
      last_error = p_error
  where id = p_message_id
  returning lead_id into v_lead_id;

  if p_success then
    insert into public.sales_lead_activities (lead_id, activity_type, detail)
    values (v_lead_id, 'message_sent', jsonb_build_object('message_id', p_message_id));

    -- Auto-advance status_ready leads to contacted on first successful send, matching Phase 9's pipeline shape.
    update public.sales_leads set status = 'contacted', updated_at = now()
    where id = v_lead_id and status in ('discovered', 'enriching', 'enriched', 'qualified', 'contact_ready');

    insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason)
    select v_lead_id, 'contact_ready', 'contacted', 'first outreach message sent'
    where exists (select 1 from public.sales_leads where id = v_lead_id and status = 'contacted');
  end if;
end;
$$;

revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.sales_mark_outreach_sent(uuid, boolean, text, text) to service_role;

-- ============================================================
-- sales_create_campaign() / sales_add_leads_to_campaign() (Phase 12) --
-- populates a campaign from live filter criteria via search_sales_leads,
-- so campaign targeting reuses the exact same filter logic the Discover/
-- Leads UI already uses rather than a second, divergent implementation.
-- ============================================================
create or replace function public.sales_create_campaign(p_name text, p_description text, p_criteria jsonb)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_campaign_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns')) then
    raise exception 'not authorized';
  end if;

  insert into public.sales_campaigns (name, description, criteria, created_by)
  values (p_name, p_description, p_criteria, auth.uid())
  returning id into v_campaign_id;

  return v_campaign_id;
end;
$$;

revoke all on function public.sales_create_campaign(text, text, jsonb) from public, anon;
grant execute on function public.sales_create_campaign(text, text, jsonb) to authenticated;

create or replace function public.sales_add_leads_to_campaign(p_campaign_id uuid, p_lead_ids uuid[])
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count int;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_campaigns')) then
    raise exception 'not authorized';
  end if;

  insert into public.sales_campaign_leads (campaign_id, lead_id)
  select p_campaign_id, unnest(p_lead_ids)
  on conflict do nothing;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.sales_add_leads_to_campaign(uuid, uuid[]) from public, anon;
grant execute on function public.sales_add_leads_to_campaign(uuid, uuid[]) to authenticated;

create or replace function public.get_campaign_stats(p_campaign_id uuid)
returns table(target_count bigint, queued bigint, contacted bigint, replied bigint, demos bigint, won bigint, lost bigint)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    count(*) as target_count,
    count(*) filter (where exists (select 1 from public.sales_outreach_messages m where m.lead_id = cl.lead_id and m.campaign_id = p_campaign_id and m.status = 'queued')) as queued,
    count(*) filter (where l.status in ('contacted', 'replied', 'demo_scheduled', 'demo_completed', 'negotiation', 'won', 'lost')) as contacted,
    count(*) filter (where l.status in ('replied', 'demo_scheduled', 'demo_completed', 'negotiation', 'won', 'lost')) as replied,
    count(*) filter (where l.status in ('demo_scheduled', 'demo_completed', 'negotiation', 'won')) as demos,
    count(*) filter (where l.status = 'won') as won,
    count(*) filter (where l.status = 'lost') as lost
  from public.sales_campaign_leads cl
  join public.sales_leads l on l.id = cl.lead_id
  where cl.campaign_id = p_campaign_id
    and (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
$$;

revoke all on function public.get_campaign_stats(uuid) from public, anon;
grant execute on function public.get_campaign_stats(uuid) to authenticated;

-- ============================================================
-- sales_schedule_followup() / sales_complete_followup() (Phase 13) --
-- every future action has lead/reason/scheduled_time/status/owner/
-- last_action, per the mission's explicit shape. No perpetual-loop
-- primitive exists -- a followup is always a single scheduled row, a
-- next one must be explicitly created after completion, never
-- auto-regenerated.
-- ============================================================
create or replace function public.sales_schedule_followup(p_lead_id uuid, p_reason text, p_scheduled_at timestamptz, p_owner_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_followup_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_followups')) then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.sales_leads where id = p_lead_id and status in ('do_not_contact', 'won', 'lost')) then
    raise exception 'cannot schedule a follow-up on a lead marked do_not_contact/won/lost';
  end if;

  insert into public.sales_followups (lead_id, reason, scheduled_at, owner_id, created_by)
  values (p_lead_id, p_reason, p_scheduled_at, coalesce(p_owner_id, auth.uid()), auth.uid())
  returning id into v_followup_id;

  return v_followup_id;
end;
$$;

revoke all on function public.sales_schedule_followup(uuid, text, timestamptz, uuid) from public, anon;
grant execute on function public.sales_schedule_followup(uuid, text, timestamptz, uuid) to authenticated;

create or replace function public.sales_complete_followup(p_followup_id uuid, p_last_action text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_followups')) then
    raise exception 'not authorized';
  end if;

  update public.sales_followups
  set status = 'completed', last_action = p_last_action, completed_at = now()
  where id = p_followup_id and status = 'pending';

  if not found then
    raise exception 'follow-up not found or not pending';
  end if;
end;
$$;

revoke all on function public.sales_complete_followup(uuid, text) from public, anon;
grant execute on function public.sales_complete_followup(uuid, text) to authenticated;

-- ============================================================
-- convert_sales_lead_to_tenant(): Phase 14 -- INTENTIONALLY NOT
-- IMPLEMENTED IN THIS MIGRATION. TRUE STOP (materially ambiguous
-- identity/ownership rule -- see the mission's own stop-condition list).
--
-- complete_new_club_onboarding() (20260831095910) is coupled to
-- auth.uid(): it inserts the club_owner club_membership row for
-- WHOEVER IS CALLING IT, derives created_by from that same session, and
-- (via automatic_trial_entitlements) grants a one-per-account free
-- trial keyed to that same caller's identity. It has no parameter for
-- "create this club and make a DIFFERENT, not-currently-authenticated
-- person its owner" -- there is no p_owner_user_id, no invite-token
-- path, nothing. It is designed exclusively for self-service signup,
-- where the person completing the form IS the future owner.
--
-- A Platform Owner clicking "Convert to Tenant" on a lead is a
-- DIFFERENT session than the prospect who would actually own the
-- resulting club. Calling this RPC as-is would make the PLATFORM
-- OWNER'S OWN ACCOUNT the club_owner of every converted lead -- not
-- the real business owner -- which is a genuine identity-ownership
-- defect, not a UX inconvenience: it would leave every sales-converted
-- tenant owned by the wrong, non-billable, non-operational identity.
--
-- Two resolutions exist and neither is mine to pick alone:
--   (a) Two-step conversion: platform owner marks WON + fills in the
--       approved business info, which sends the prospect a real
--       invite/magic-link (this codebase already has a safe precedent
--       for exactly this shape -- portal_invites /
--       claim_portal_invite_service, 20260823070000/20260824250000).
--       The prospect then completes their OWN onboarding by
--       accepting the invite -- conversion becomes asynchronous,
--       "WON" no longer means "tenant exists this instant."
--   (b) Extend complete_new_club_onboarding() (or add a genuinely new,
--       carefully-scoped platform-owner-only sibling RPC) to accept an
--       explicit p_owner_user_id/p_owner_email and create the
--       club_membership for THAT identity instead of auth.uid(), with
--       its own separate authorization gate (platform.sales.convert_to_
--       tenant, never reachable by a club_owner) and an explicit
--       decision on whether a sales-converted tenant should receive
--       the SAME automatic free trial a self-service signup gets, or a
--       different (or no) commercial terms path -- that trial-grant
--       question is itself a real business decision (automatic_trial_
--       entitlements is documented elsewhere in this codebase as
--       "one per user account, enforced via a dedicated
--       concurrency-safe entitlement table" -- ADR-051 -- extending its
--       meaning to a sales-originated conversion is a policy call, not
--       an engineering one).
--
-- Per the mission's autonomous-execution rule, everything else in this
-- module is built and functions independently of this one decision:
-- discovery, dedup, enrichment, scoring, CRM pipeline, outreach,
-- campaigns, follow-ups, and analytics all work end-to-end without
-- conversion. sales_leads.status CAN reach 'won' via
-- sales_change_lead_status() (which permits the do_not_contact/won
-- terminal-state transitions already) -- what's missing is only the
-- automated "and now create the real tenant" step. The UI (Phase 8/9)
-- surfaces a "Convert to Tenant -- CONFIGURATION_BLOCKED: identity/
-- ownership model needs a decision, see docs/DECISIONS.md ADR-054"
-- action instead of a broken or silently-wrong button.
--
-- sales_conversion_records and sales_leads.converted_club_id/
-- converted_at exist and are ready to be populated the moment this
-- decision is made and the real conversion RPC is written -- no schema
-- change will be needed, only this one function.
-- ============================================================
