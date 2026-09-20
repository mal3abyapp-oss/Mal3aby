-- WA-1 (owner brief, live QA 2026-09-19/20): get_lead_channel_eligibility()
-- has hardcoded whatsapp_eligible = false for every lead, unconditionally,
-- since it was first written (20260904170000_sales_channel_eligibility_
-- engine.sql, 2026-09-04). That was TRUE and correctly reasoned AT THE
-- TIME: Platform WhatsApp sales send did not exist yet, and the
-- function's own header explains the real structural gap that existed
-- then (whatsapp_accounts.club_id being club-scoped, no slot for a
-- pre-conversion lead).
--
-- That gap was closed six days later, and this function was never
-- updated to match: 20260909200000_platform_whatsapp_domain.sql built a
-- platform-owned, club-independent WhatsApp account/queue specifically
-- to route around the club-scoping problem, and
-- 20260910120000_sales_platform_whatsapp_send_enabled.sql wired a real,
-- working, human-approved send path through it
-- (sales_queue_platform_whatsapp_message(), channel='whatsapp_message',
-- gated on platform.whatsapp_platform.manage + platform_whatsapp_
-- account.status='connected' + message status='approved') -- confirmed
-- live and unmodified since (STATE-1/DRAFT-1/AUD-1, all already fixed
-- in this same brief, each reference this send path approvingly without
-- touching its guard). FINAL_OWNER_DECISIONS_REQUIRED.md's own Decision
-- #20 documents this as "RESOLVED -- human-approved, editable AI
-- WhatsApp sales workflow," independently tested (37 isolation tests,
-- security + UX review, zero P0/P1).
--
-- Net effect before this fix: SalesLeadDetailPage.tsx's Channels panel
-- told a Platform Owner "WhatsApp: Not Eligible (structural, not a
-- bug)" for a lead, while a working, clickable Send-via-Platform-
-- WhatsApp button rendered further down the SAME page for an approved
-- whatsapp_message draft on that SAME lead -- a real, live,
-- self-contradictory UI a Platform Owner could see in one screen.
--
-- Fix: whatsapp_eligible now mirrors the EXACT lead-specific condition
-- sales_queue_platform_whatsapp_message() itself uses to resolve a send
-- number -- coalesce(whatsapp_public_number, public_phone) is not null
-- -- so this RPC and the real send path can never again disagree about
-- whether a given lead is reachable. Platform WhatsApp's own connection
-- status (connected/disconnected) is deliberately NOT folded into this
-- check -- that is a separate CHANNEL_CONNECTED concern (this
-- function's own header distinction, still correct) already surfaced
-- correctly at Send-time by the existing "Platform WhatsApp is not
-- connected" banner + /platform/whatsapp link on the Send button itself
-- (20260910120000's own guard, unchanged). Folding connection status in
-- here too would make LEAD_CHANNEL_ELIGIBLE flicker every time the
-- connector reconnects/disconnects, which is not what "is this lead
-- reachable" should mean.
--
-- recommended_channel: WhatsApp is now offered as a fallback ahead of
-- CALL_TASK when eligible -- a human clicking one Send button on an
-- AI-drafted, approved message is a strictly more productive outcome
-- than a bare call task with no message actually sent, and this mission
-- has never treated WhatsApp send as unsafe or undesirable, only as
-- (until now) structurally unavailable. EMAIL remains first choice,
-- unchanged -- it is still the only channel with a bounded automated
-- send pipeline (queue -> worker -> retry/backoff) rather than a
-- one-click-per-message human action.
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
  v_whatsapp_phone text;
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

  -- WHATSAPP_ELIGIBLE (WA-1 fix, 2026-09-21): mirrors the exact
  -- destination-resolution logic sales_queue_platform_whatsapp_message()
  -- itself uses -- coalesce(whatsapp_public_number, public_phone) -- so
  -- this eligibility check and the real send path can never disagree.
  -- Connection status (is Platform WhatsApp currently connected) is
  -- deliberately a separate, Send-time concern, not folded in here --
  -- see this migration's own header.
  v_whatsapp_phone := coalesce(nullif(v_lead.whatsapp_public_number, ''), nullif(v_lead.public_phone, ''));
  if v_whatsapp_phone is not null then
    v_whatsapp_eligible := true;
    v_whatsapp_reason := 'verified phone number on file (whatsapp_public_number or public_phone) -- eligible for a human-approved Platform WhatsApp send once a draft is generated and approved';
  else
    v_whatsapp_reason := 'no whatsapp_public_number or public_phone on file for this lead';
  end if;

  -- CALL_TASK_ELIGIBLE: a public_phone on file. Never automated --
  -- always creates a human-actioned internal task (see
  -- sales_create_call_task below).
  if v_lead.public_phone is not null and v_lead.public_phone <> '' then
    v_call_eligible := true;
    v_call_reason := 'verified public_phone on file -- eligible for a human-actioned call task (never automated)';
  else
    v_call_reason := 'no public_phone on file for this lead';
  end if;

  -- Recommended channel: EMAIL first (the only channel with a bounded
  -- automated send pipeline -- queue/worker/retry-backoff), WhatsApp
  -- next when eligible (a human-approved, one-click send is strictly
  -- more productive than a bare call task), CALL_TASK as the fallback
  -- when neither is available, NO_SAFE_CHANNEL if none apply.
  if v_email_eligible then
    v_recommended := 'EMAIL';
    v_recommended_reason := 'email is the only channel with a verified destination and an automated, approval-gated send pipeline';
  elsif v_whatsapp_eligible then
    v_recommended := 'WHATSAPP';
    v_recommended_reason := 'no email address on file, but a phone number is -- recommend generating a WhatsApp draft for human-approved send instead of no action';
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
