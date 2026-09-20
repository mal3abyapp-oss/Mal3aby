-- DRAFT-1 (owner brief, live QA 2026-09-19/20): sales_edit_outreach_draft()
-- (20260910130000) writes edited_body unconditionally -- no re-check
-- against the commercial quality gate (_shared/outreach-quality-gate.ts)
-- that every AI-generated draft is held to at generation time. An owner
-- could edit an approval_ready or already-approved whatsapp_message draft
-- to reintroduce a placeholder, an empty CTA, or an overstated evidence
-- claim (the exact defect class 20260904190000's own gate exists to
-- catch -- see that migration's header re: the real Elmasry
-- Giza/Gaza-transliteration incident), and it would bypass the gate
-- entirely, since the gate only ever runs inside the AI generation Edge
-- Function, never on a manual edit. This weakens the approval-gated send
-- pipeline the brief's own constraints require stay intact.
--
-- Two real gaps fixed here, both confirmed by reading the RPC and its
-- sibling sales_queue_platform_whatsapp_message() (20260910120000) before
-- writing this migration:
--
-- 1. No quality re-validation on edit. Fixed by widening this RPC to
--    accept the SAME p_quality_status/p_quality_gate_result shape
--    sales_generate_outreach_message() already persists (computed by the
--    NEW sales-edit-outreach-draft Edge Function, which re-runs
--    evaluateOutreachQuality() against the edited text using the
--    message's own stored `grounding` -- same deterministic, non-LLM
--    gate, same evidence, no new AI call, no quota cost). A
--    quality_rejected edit is still SAVED (an owner must be able to see
--    and fix what they typed), just with quality_status set directly to
--    whatever the fresh gate run decided ('approval_ready' or
--    'quality_rejected') -- so sales_approve_outreach_message()'s existing
--    "quality_status <> 'approval_ready' -> cannot approve" guard
--    (20260904190000) applies to edited content exactly as it already
--    does to generated content, with zero changes needed to that
--    function.
--
-- 2. Editing an ALREADY-approved draft left status='approved' untouched
--    -- confirmed by reading sales_queue_platform_whatsapp_message()'s own
--    guard (`if v_message.status <> 'approved' then raise exception`):
--    a Send click immediately after an edit would send the edited text
--    with NO re-approval and (before fix 1) no re-validation at all. Human
--    approval before send is the brief's own explicit, non-negotiable
--    constraint. Fixed by reverting status to 'generated' whenever the
--    edited row was 'approved' at edit time, forcing a fresh
--    sales_approve_outreach_message() call (and, per fix 1, a fresh
--    quality_status check) before it can be sent again. A message already
--    'generated' (not yet approved) is unaffected -- editing before first
--    approval was always fine and remains a no-op on status.

create or replace function public.sales_edit_outreach_draft(
  p_message_id uuid,
  p_edited_body text,
  p_quality_status text default 'pending_quality_check',
  p_quality_gate_result jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
  v_prior_status text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit')) then
    raise exception 'not authorized';
  end if;

  if p_edited_body is null or btrim(p_edited_body) = '' then
    raise exception 'edited message body cannot be empty';
  end if;

  if p_quality_status not in ('pending_quality_check', 'approval_ready', 'quality_rejected') then
    raise exception 'invalid quality_status: %', p_quality_status;
  end if;

  select status into v_prior_status
  from public.sales_outreach_messages
  where id = p_message_id and status in ('generated', 'approved')
  for update;

  if v_prior_status is null then
    raise exception 'message not found or not in generated/approved status';
  end if;

  update public.sales_outreach_messages
  set
    edited_body = p_edited_body,
    edited_at = now(),
    edited_by = auth.uid(),
    quality_status = p_quality_status,
    quality_gate_result = coalesce(p_quality_gate_result, quality_gate_result),
    -- an edit to an already-approved draft requires fresh approval --
    -- see this migration's header, gap 2.
    status = case when v_prior_status = 'approved' then 'generated' else v_prior_status end,
    approved_by = case when v_prior_status = 'approved' then null else approved_by end,
    approved_at = case when v_prior_status = 'approved' then null else approved_at end
  where id = p_message_id
  returning lead_id into v_lead_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (
    v_lead_id,
    'message_edited',
    jsonb_build_object(
      'message_id', p_message_id,
      'quality_status', p_quality_status,
      'reverted_to_generated', v_prior_status = 'approved'
    ),
    auth.uid()
  );
end;
$$;

-- Drop the stale 2-arg overload from 20260910130000 -- same
-- CREATE OR REPLACE + new trailing params defect class this project has
-- hit and fixed before; an explicit DROP is required or both overloads
-- would coexist and the client's positional call could resolve to either.
drop function if exists public.sales_edit_outreach_draft(uuid, text);

revoke all on function public.sales_edit_outreach_draft(uuid, text, text, jsonb) from public, anon;
revoke all on function public.sales_edit_outreach_draft(uuid, text, text, jsonb) from authenticated;
grant execute on function public.sales_edit_outreach_draft(uuid, text, text, jsonb) to service_role;

comment on function public.sales_edit_outreach_draft(uuid, text, text, jsonb) is
  'Owner Edit step of owner decision #20''s workflow. Writes edited_body/edited_at/edited_by (AI-generated body column never overwritten) plus quality_status/quality_gate_result from a fresh evaluateOutreachQuality() re-check computed by the sales-edit-outreach-draft Edge Function (DRAFT-1 fix, 2026-09-20) -- the same deterministic gate every AI generation is held to now also applies to manual edits. If the message was already approved, editing reverts it to generated (approved_by/approved_at cleared) so it must be re-approved before it can be sent again. service_role only -- callers must go through the sales-edit-outreach-draft Edge Function, never this RPC directly, so the quality gate cannot be bypassed by calling the RPC straight from the client.';
