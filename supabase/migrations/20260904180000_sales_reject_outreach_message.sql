-- Sales Intelligence -- multi-channel outreach readiness (2026-09-04):
-- sales_reject_outreach_message() -- the missing counterpart to
-- sales_approve_outreach_message(). Found as a genuine, real gap while
-- verifying the 5 pilot leads' existing outreach history for this
-- mission's Phase 16 (message reuse/adaptation): Mr Soccer Academy has
-- a 'generated' (never approved/sent) draft, timestamped 2026-09-04
-- 11:40:09, that repeats the EXACT Giza->Gaza transliteration defect
-- already found, fixed, and merged as PR #8 the same day (the fix
-- landed and is proven working by a LATER correct draft on the same
-- lead, timestamped 11:46:32, which correctly says "في الجيزة"). The
-- stale, factually-wrong draft was left sitting in 'generated' status
-- with nothing preventing a platform-staff member from approving and
-- sending it by mistake instead of the corrected draft -- a real,
-- live risk to the mission's own "0 unsupported/incorrect claims"
-- requirement, caught here rather than left unaddressed.
--
-- No prior reject path existed: sales_outreach_messages.status already
-- allows 'rejected' (see the original CHECK constraint in
-- 20260904090000_sales_intelligence_schema.sql), but no RPC ever wrote
-- it. This adds that RPC, symmetric with sales_approve_outreach_message
-- (same permission, same generated-only precondition), then this
-- migration uses it once to reject the specific stale draft described
-- above -- a reversible, safe DATA-QUALITY correction (marking a never-
-- sent draft as rejected), not an outreach send and not a change to any
-- already-sent message.
create or replace function public.sales_reject_outreach_message(p_message_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.approve_outreach')) then
    raise exception 'not authorized';
  end if;

  update public.sales_outreach_messages
  set status = 'rejected'
  where id = p_message_id and status = 'generated'
  returning lead_id into v_lead_id;

  if v_lead_id is null then
    raise exception 'message not found or not in generated status';
  end if;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (v_lead_id, 'message_rejected', jsonb_build_object('message_id', p_message_id, 'reason', p_reason), auth.uid());
end;
$$;

revoke all on function public.sales_reject_outreach_message(uuid, text) from public, anon;
grant execute on function public.sales_reject_outreach_message(uuid, text) to authenticated;

-- One-time data correction: reject the specific stale, pre-city-guard-fix
-- draft on Mr Soccer Academy described above. Run as service_role (this
-- migration itself), recorded with an explicit reason for audit.
-- Deliberately NOT wrapped in the RPC's own auth.uid()-based permission
-- check bypass -- migrations run with elevated database privileges
-- directly, matching how every other one-time data-correction migration
-- in this project operates (e.g. sales_record_signal() calls in the
-- pilot mission's own hotline-number correction).
update public.sales_outreach_messages
set status = 'rejected'
where id = '5b96f4ce-3869-4400-95df-03df6565e427'
  and status = 'generated';

insert into public.sales_lead_activities (lead_id, activity_type, detail)
select lead_id, 'message_rejected',
  jsonb_build_object(
    'message_id', '5b96f4ce-3869-4400-95df-03df6565e427',
    'reason', 'stale pre-fix draft incorrectly transliterated Giza as Gaza (غزّة) -- superseded by a corrected draft generated later the same session after the city-guard fix (PR #8) was deployed'
  )
from public.sales_outreach_messages
where id = '5b96f4ce-3869-4400-95df-03df6565e427';
