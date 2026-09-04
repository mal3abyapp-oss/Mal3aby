-- Sales Intelligence -- multi-channel outreach readiness, Phase 8-12
-- (2026-09-04): channel eligibility engine. A single, reusable,
-- explainable RPC that determines, per lead, which of
-- EMAIL_ELIGIBLE / WHATSAPP_ELIGIBLE / CALL_TASK_ELIGIBLE apply, and the
-- single recommended channel + reason -- or NO_SAFE_CHANNEL if none do.
--
-- CHANNEL_CONNECTED vs LEAD_CHANNEL_ELIGIBLE (this mission's own Phase 8
-- distinction, honored explicitly below): "connected" means the
-- underlying transport is technically operational for THIS PLATFORM
-- (Resend verified for email; the WhatsApp connector is production-
-- proven for CONNECTED CLUBS). "Eligible" means THIS SPECIFIC LEAD may
-- actually receive outreach on that channel right now. A channel can be
-- connected platform-wide while still being ineligible for every lead
-- (this is EXACTLY WhatsApp's real state for Sales Intelligence, proven
-- below, not assumed).
--
-- WHATSAPP STRUCTURAL FINDING (verified via live schema inspection this
-- session, not inferred): whatsapp_accounts.club_id is the PRIMARY KEY,
-- `references public.clubs(id) on delete cascade` -- one WhatsApp
-- session slot exists per real, already-onboarded CLUB, and only per
-- club. notification_queue.club_id is NOT NULL -- there is no queueing
-- path that does not belong to a real club. A sales_leads row is NOT a
-- club (Phase 14/ADR-054's own conversion flow -- the thing that WOULD
-- turn a lead into a club -- is explicitly NOT YET BUILT, a genuine,
-- separately-documented open decision). Therefore: for every current
-- Sales Intelligence lead, there is no whatsapp_accounts row to send
-- through, by construction, not by a missing feature -- WHATSAPP_ELIGIBLE
-- is FALSE for 100% of leads today, and this function says so
-- explicitly rather than guessing or defaulting silently. This is NOT
-- "WhatsApp is broken" (docs/engineering/WHATSAPP_QR_PAIRING_FINAL_
-- ACCEPTANCE_REPORT.md proves the opposite for its real, intended
-- use -- connected CLUBS messaging their own CUSTOMERS) -- it is a
-- correct, intentional non-overlap between two different products' data
-- models, and this mission's own instruction is explicit: "DO NOT build
-- another WhatsApp system. DO NOT replace the existing QR connector" --
-- so no workaround (e.g. a fake platform-owned club row) is introduced
-- here to manufacture eligibility that does not structurally exist.
--
-- CALL_TASK_ELIGIBLE: for a lead with a phone number but no safe
-- automated channel (or as a supplementary channel alongside email) --
-- creates an INTERNAL SALES TASK for a human to call, never an
-- automated dialer (this mission's Phase 10 explicit requirement: "not
-- automated calling").
create or replace function public.get_lead_channel_eligibility(p_lead_id uuid)
returns table(
  lead_id uuid,
  email_eligible boolean,
  email_reason text,
  whatsapp_eligible boolean,
  whatsapp_reason text,
  call_task_eligible boolean,
  call_task_reason text,
  recommended_channel text,
  recommended_reason text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead public.sales_leads%rowtype;
  v_email_eligible boolean := false;
  v_email_reason text;
  v_whatsapp_eligible boolean := false;
  v_whatsapp_reason text;
  v_call_eligible boolean := false;
  v_call_reason text;
  v_recommended text;
  v_recommended_reason text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.view')) then
    raise exception 'not authorized';
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;

  -- A do_not_contact lead is ineligible on EVERY channel, unconditionally
  -- -- checked first so nothing below can ever override it.
  if v_lead.status = 'do_not_contact' then
    return query select
      p_lead_id, false, 'lead is marked do_not_contact', false, 'lead is marked do_not_contact',
      false, 'lead is marked do_not_contact', 'NO_SAFE_CHANNEL', 'lead is marked do_not_contact -- no outreach on any channel';
    return;
  end if;

  -- EMAIL_ELIGIBLE: a verified public_email on file. Sending
  -- infrastructure itself (Resend/mal3aby.app) is platform-CONNECTED
  -- (see SALES_INTELLIGENCE_MULTICHANNEL_PILOT_APPROVAL.md's EMAIL
  -- ARCHITECTURE section) -- this check is the LEAD-specific
  -- eligibility layer on top of that: does this lead have a real
  -- destination address at all.
  if v_lead.public_email is not null and v_lead.public_email <> '' then
    v_email_eligible := true;
    v_email_reason := 'verified public_email on file; email sending platform-connected (Resend, mal3aby.app verified)';
  else
    v_email_reason := 'no public_email on file for this lead';
  end if;

  -- WHATSAPP_ELIGIBLE: structurally FALSE for every Sales Intelligence
  -- lead today -- see this function's own header. Not lead-specific:
  -- true for zero leads regardless of whether a phone number exists,
  -- because the gap is architectural (no club_id to send through), not
  -- data-quality.
  v_whatsapp_eligible := false;
  v_whatsapp_reason := 'WhatsApp connector is club-scoped (whatsapp_accounts.club_id is the primary key, one session per onboarded club) -- a sales lead is not yet a club (Phase 14/ADR-054 conversion flow not yet built), so no WhatsApp account slot exists for outreach to this lead. This is a structural non-overlap, not a bug.';

  -- CALL_TASK_ELIGIBLE: a public_phone on file. Never automated --
  -- always creates a human-actioned internal task (see
  -- sales_create_call_task below).
  if v_lead.public_phone is not null and v_lead.public_phone <> '' then
    v_call_eligible := true;
    v_call_reason := 'verified public_phone on file -- eligible for a human-actioned call task (never automated)';
  else
    v_call_reason := 'no public_phone on file for this lead';
  end if;

  -- Recommended channel: EMAIL first (the only channel this mission
  -- actually automates end-to-end -- generate/approve/queue/send),
  -- CALL_TASK as the fallback when email is unavailable but a phone
  -- number is, NO_SAFE_CHANNEL if neither.
  if v_email_eligible then
    v_recommended := 'EMAIL';
    v_recommended_reason := 'email is the only channel with a verified destination and an automated, approval-gated send pipeline';
  elsif v_call_eligible then
    v_recommended := 'CALL_TASK';
    v_recommended_reason := 'no email address on file, but a phone number is -- recommend a human-actioned call task instead of no action';
  else
    v_recommended := 'NO_SAFE_CHANNEL';
    v_recommended_reason := 'no verified email or phone contact channel exists for this lead -- no safe outreach channel available';
  end if;

  return query select
    p_lead_id, v_email_eligible, v_email_reason, v_whatsapp_eligible, v_whatsapp_reason,
    v_call_eligible, v_call_reason, v_recommended, v_recommended_reason;
end;
$$;

revoke all on function public.get_lead_channel_eligibility(uuid) from public, anon;
grant execute on function public.get_lead_channel_eligibility(uuid) to authenticated;

-- ============================================================
-- sales_call_tasks: internal, human-actioned call tasks (Phase 10) --
-- explicitly NOT an automated dialer integration. A platform-staff
-- member creates one when CALL_TASK is the recommended/selected
-- channel, works it manually (phone in hand), and marks the outcome.
-- ============================================================
create table public.sales_call_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  phone_number text not null,
  talking_points text,  -- reuses the AI-generated whatsapp_talking_points/phone_script content where available (Phase 16 -- adapt, don't regenerate)
  status text not null default 'pending' check (status in ('pending', 'completed', 'cancelled')),
  owner_id uuid references auth.users(id),
  outcome text,          -- free-text human summary of how the call went
  outcome_event_type text check (outcome_event_type is null or outcome_event_type in (
    'positive_reply', 'negative_reply', 'not_interested', 'requested_information',
    'demo_requested', 'wrong_contact', 'do_not_contact'
  )),
  completed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index sales_call_tasks_lead_idx on public.sales_call_tasks (lead_id, created_at desc);
create index sales_call_tasks_pending_idx on public.sales_call_tasks (status) where status = 'pending';

alter table public.sales_call_tasks enable row level security;
alter table public.sales_call_tasks force row level security;

create policy sales_call_tasks_select on public.sales_call_tasks
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));

revoke all on table public.sales_call_tasks from anon, public;

create or replace function public.sales_create_call_task(p_lead_id uuid, p_talking_points text default null, p_owner_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_task_id uuid;
  v_phone text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.send_outreach')) then
    raise exception 'not authorized';
  end if;

  select public_phone into v_phone from public.sales_leads where id = p_lead_id and status <> 'do_not_contact';
  if v_phone is null then
    raise exception 'lead not found, marked do_not_contact, or has no public_phone on file';
  end if;

  insert into public.sales_call_tasks (lead_id, phone_number, talking_points, owner_id, created_by)
  values (p_lead_id, v_phone, p_talking_points, coalesce(p_owner_id, auth.uid()), auth.uid())
  returning id into v_task_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'call_task_created', jsonb_build_object('task_id', v_task_id), auth.uid());

  return v_task_id;
end;
$$;

revoke all on function public.sales_create_call_task(uuid, text, uuid) from public, anon;
grant execute on function public.sales_create_call_task(uuid, text, uuid) to authenticated;

create or replace function public.sales_complete_call_task(p_task_id uuid, p_outcome text, p_outcome_event_type text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.send_outreach')) then
    raise exception 'not authorized';
  end if;

  update public.sales_call_tasks
  set status = 'completed', outcome = p_outcome, outcome_event_type = p_outcome_event_type, completed_at = now()
  where id = p_task_id and status = 'pending'
  returning lead_id into v_lead_id;

  if v_lead_id is null then
    raise exception 'call task not found or not pending';
  end if;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (v_lead_id, 'call_task_completed', jsonb_build_object('task_id', p_task_id, 'outcome_event_type', p_outcome_event_type), auth.uid());

  -- Same reply-driven follow-up cancellation as the email path, if the
  -- call outcome was classified into the reply taxonomy -- a phone
  -- conversation is just as much a "the prospect responded" signal as
  -- an email reply, and a stale scheduled follow-up must not fire.
  if p_outcome_event_type is not null then
    update public.sales_followups
    set status = 'cancelled', last_action = format('auto-cancelled: call task outcome (%s)', p_outcome_event_type), completed_at = now()
    where lead_id = v_lead_id and status = 'pending';

    if p_outcome_event_type = 'do_not_contact' then
      update public.sales_leads
      set status = 'do_not_contact', status_reason = 'call outcome requested no further contact', updated_at = now()
      where id = v_lead_id and status <> 'do_not_contact';
    elsif p_outcome_event_type in ('positive_reply', 'demo_requested', 'requested_information', 'negative_reply', 'not_interested') then
      update public.sales_leads
      set status = 'replied', updated_at = now()
      where id = v_lead_id and status in ('contacted', 'contact_ready', 'qualified', 'enriched');
    end if;
  end if;
end;
$$;

revoke all on function public.sales_complete_call_task(uuid, text, text) from public, anon;
grant execute on function public.sales_complete_call_task(uuid, text, text) to authenticated;

create or replace function public.get_lead_call_tasks(p_lead_id uuid)
returns setof public.sales_call_tasks
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select * from public.sales_call_tasks
  where lead_id = p_lead_id
    and (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
  order by created_at desc
$$;

revoke all on function public.get_lead_call_tasks(uuid) from public, anon;
grant execute on function public.get_lead_call_tasks(uuid) to authenticated;
