-- Sales Intelligence -- Commercial Outreach Quality Gate (2026-09-04).
-- Owner decision: "The current 5-lead pilot package is NOT approved for
-- send... the remaining problem is COMMERCIAL CONTENT QUALITY... fix
-- the generation/validation system so the same defects cannot recur."
--
-- Required lifecycle: GENERATE -> GROUNDING VALIDATION -> COMMERCIAL
-- QUALITY VALIDATION -> APPROVAL_READY -> HUMAN APPROVAL -> SEND.
--
-- Adds quality_status/quality_gate_result to sales_outreach_messages
-- (additive columns, existing `status` lifecycle untouched) and widens
-- sales_generate_outreach_message() to accept and persist the
-- deterministic quality-gate result computed by
-- _shared/outreach-quality-gate.ts in the Edge Function. Critically,
-- sales_approve_outreach_message() is now gated: a message with
-- quality_status = 'quality_rejected' can NEVER be approved through the
-- normal path -- this is the server-side enforcement of "a draft that
-- fails commercial validation must NEVER become approval-ready", not a
-- UI-only suggestion a client could bypass.

alter table public.sales_outreach_messages
  add column if not exists quality_status text not null default 'pending_quality_check'
    check (quality_status in ('pending_quality_check', 'approval_ready', 'quality_rejected')),
  add column if not exists quality_gate_result jsonb;

comment on column public.sales_outreach_messages.quality_status is
  'Deterministic commercial-quality gate outcome (NOT an LLM self-evaluation) -- approval_ready only if every mandatory gate passed. quality_rejected messages cannot be approved via sales_approve_outreach_message().';
comment on column public.sales_outreach_messages.quality_gate_result is
  'Full QualityGateResult from _shared/outreach-quality-gate.ts: per-gate pass/fail booleans, rejection_reasons array, and diagnostic detail (word count, placeholders found, etc).';

-- sales_generate_outreach_message(): widen to accept the quality-gate
-- result computed by the Edge Function immediately after generation
-- (same call, same transaction boundary as the original insert -- the
-- gate is not a separate later step that could be skipped).
create or replace function public.sales_generate_outreach_message(
  p_lead_id uuid,
  p_channel text,
  p_message_type text,
  p_language text,
  p_subject text,
  p_body text,
  p_grounding jsonb,
  p_campaign_id uuid default null,
  p_ai_provider text default null,
  p_ai_model text default null,
  p_ai_usage jsonb default null,
  p_ai_latency_ms int default null,
  p_quality_status text default 'pending_quality_check',
  p_quality_gate_result jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_message_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.generate_offer')) then
    raise exception 'not authorized';
  end if;

  if exists (select 1 from public.sales_leads where id = p_lead_id and status = 'do_not_contact') then
    raise exception 'this lead is marked do_not_contact -- outreach content cannot be generated for it';
  end if;

  if p_quality_status not in ('pending_quality_check', 'approval_ready', 'quality_rejected') then
    raise exception 'invalid quality_status: %', p_quality_status;
  end if;

  insert into public.sales_outreach_messages (
    lead_id, campaign_id, channel, message_type, language, subject, body, grounding,
    ai_provider, ai_model, ai_usage, ai_latency_ms, quality_status, quality_gate_result, created_by
  )
  values (
    p_lead_id, p_campaign_id, p_channel, p_message_type, p_language, p_subject, p_body, p_grounding,
    p_ai_provider, p_ai_model, p_ai_usage, p_ai_latency_ms, p_quality_status, p_quality_gate_result, auth.uid()
  )
  returning id into v_message_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (
    p_lead_id, 'message_generated',
    jsonb_build_object(
      'message_id', v_message_id, 'channel', p_channel, 'type', p_message_type,
      'ai_provider', p_ai_provider, 'ai_model', p_ai_model, 'quality_status', p_quality_status
    ),
    auth.uid()
  );

  return v_message_id;
end;
$$;

revoke all on function public.sales_generate_outreach_message(uuid, text, text, text, text, text, jsonb, uuid, text, text, jsonb, int, text, jsonb) from public, anon;
grant execute on function public.sales_generate_outreach_message(uuid, text, text, text, text, text, jsonb, uuid, text, text, jsonb, int, text, jsonb) to authenticated, service_role;

-- Drop the stale 12-arg overload -- same defect class this project has
-- fixed twice before (CREATE OR REPLACE with new trailing params creates
-- a SECOND overload, not a replacement, since the parameter count
-- differs even with defaults). The 12-arg version defaults
-- quality_status to the column's own default and quality_gate_result to
-- null if invoked directly, so no caller silently breaks, but leaving
-- it live would let a stale/cached client insert a message that skips
-- quality-gate persistence review entirely alongside the new 14-arg one
-- -- exactly the "silently generate a message with no ... attribution"
-- risk this project's own prior fix (20260904150100_*) already
-- documented for this exact widening pattern.
drop function if exists public.sales_generate_outreach_message(
  uuid, text, text, text, text, text, jsonb, uuid, text, text, jsonb, int
);

-- ============================================================
-- sales_approve_outreach_message(): SERVER-SIDE quality-gate
-- enforcement. A quality_rejected message can never reach 'approved'
-- through this function -- no client-side check is trusted, matching
-- this codebase's convention throughout (RLS/RPC bodies are the actual
-- gate, never the frontend alone). No override mechanism is added here
-- (owner's explicit instruction: "do not create such an override unless
-- one already exists and is justified by the architecture" -- none
-- exists in this codebase's outreach lifecycle, so none is added).
-- ============================================================
create or replace function public.sales_approve_outreach_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_quality_status text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.approve_outreach')) then
    raise exception 'not authorized';
  end if;

  select quality_status into v_quality_status from public.sales_outreach_messages where id = p_message_id and status = 'generated';
  if v_quality_status is null then
    raise exception 'message not found or not in generated status';
  end if;

  if v_quality_status <> 'approval_ready' then
    raise exception 'this message is not APPROVAL_READY (quality_status=%) -- it failed the commercial quality gate and cannot be approved. Regenerate a compliant draft instead.', v_quality_status;
  end if;

  update public.sales_outreach_messages
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_message_id and status = 'generated';
end;
$$;

revoke all on function public.sales_approve_outreach_message(uuid) from public, anon;
grant execute on function public.sales_approve_outreach_message(uuid) to authenticated;

-- ============================================================
-- get_lead_full_profile()'s outreach_messages projection needs
-- quality_status/quality_gate_result surfaced for the Sales UI (Phase:
-- "Expose the commercial quality result to Platform Owner"). Rather
-- than touch that large, unrelated RPC in this migration, a dedicated
-- narrow read RPC is added instead -- smaller blast radius, and the
-- lead-profile RPC already returns outreach_messages for list display;
-- this one is for the detail/quality-review view specifically.
-- ============================================================
create or replace function public.get_outreach_message_quality(p_message_id uuid)
returns table(
  id uuid, channel text, quality_status text, quality_gate_result jsonb, status text
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select m.id, m.channel, m.quality_status, m.quality_gate_result, m.status
  from public.sales_outreach_messages m
  join public.sales_leads l on l.id = m.lead_id
  where m.id = p_message_id
    and (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
$$;

revoke all on function public.get_outreach_message_quality(uuid) from public, anon;
grant execute on function public.get_outreach_message_quality(uuid) to authenticated;
