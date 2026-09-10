-- OWNER DECISION #20 FRONTEND (2026-09-10): the required workflow is
-- Lead -> Generate WhatsApp Draft -> Owner Review -> Owner Edit
-- (optional) -> Approve -> explicit Send -> Platform WhatsApp ->
-- delivery result/history/audit. No "Edit" RPC existed anywhere in this
-- schema before this migration (confirmed by grep across every prior
-- sales migration) -- the previous outreach UI explicitly documented
-- "no in-place edit" as a deliberate scope decision
-- (SalesLeadDetailPage.tsx's outreachNoEditNotice). The owner's decision
-- #20 now requires exactly that for whatsapp_message drafts, and the
-- schema layer for it (edited_body/edited_at/edited_by) already landed
-- in 20260910110000_sales_whatsapp_message_channel_and_edit_tracking.sql
-- with no writer yet. This migration is that writer -- small and
-- focused, one new RPC only.
--
-- sales_edit_outreach_draft(): writes ONLY to edited_body/edited_at/
-- edited_by, never to body itself (preserves the AI's original output
-- and the grounding audit trail, exactly as 20260910110000's own header
-- describes). Permission and status-guard shape deliberately mirrors
-- sales_approve_outreach_message()/sales_reject_outreach_message()
-- (20260904090400_sales_intelligence_scoring_outreach_conversion.sql,
-- 20260904180000_sales_reject_outreach_message.sql): same
-- is_platform_owner() OR has_platform_permission(...) pattern, same
-- "update ... where id = ... and status in (...) returning ... into ...;
-- if not found then raise" shape, same sales_lead_activities logging
-- convention. Permission used is platform.sales.edit -- the existing
-- generic sales-edit permission already used to gate every other
-- lead-mutation RPC in this schema (notes, status changes, etc. --
-- confirmed via grep across supabase/migrations before use here), not a
-- new key.
--
-- Allowed while status in ('generated', 'approved') -- an owner may
-- polish a fresh draft OR touch up one they already approved, but never
-- a draft that has moved past approval (queued/sent) or is already
-- rejected -- editing a message that has already been queued/sent could
-- silently rewrite what a customer is told was sent, and editing a
-- rejected draft makes no sense (regenerate instead, unchanged).
create or replace function public.sales_edit_outreach_draft(p_message_id uuid, p_edited_body text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.edit')) then
    raise exception 'not authorized';
  end if;

  if p_edited_body is null or btrim(p_edited_body) = '' then
    raise exception 'edited message body cannot be empty';
  end if;

  update public.sales_outreach_messages
  set edited_body = p_edited_body, edited_at = now(), edited_by = auth.uid()
  where id = p_message_id and status in ('generated', 'approved')
  returning lead_id into v_lead_id;

  if v_lead_id is null then
    raise exception 'message not found or not in generated/approved status';
  end if;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (v_lead_id, 'message_edited', jsonb_build_object('message_id', p_message_id), auth.uid());
end;
$$;

revoke all on function public.sales_edit_outreach_draft(uuid, text) from public, anon;
grant execute on function public.sales_edit_outreach_draft(uuid, text) to authenticated;

comment on function public.sales_edit_outreach_draft(uuid, text) is
  'Owner Edit step of owner decision #20''s workflow. Writes ONLY edited_body/edited_at/edited_by -- the AI-generated body column is never overwritten, preserving the grounding audit trail. Allowed while status is generated or approved (not after queued/sent/rejected). Gated by platform.sales.edit, the same generic permission used to gate every other lead-mutation RPC in this schema.';
