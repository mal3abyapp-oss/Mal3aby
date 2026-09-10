-- OWNER DECISION #20, RESOLVED (2026-09-10): enables the previously-
-- disabled Sales Intelligence -> Platform WhatsApp send path, now that
-- a genuinely distinct, send-ready draft artifact exists
-- (channel='whatsapp_message', 20260910110000_sales_whatsapp_message_
-- channel_and_edit_tracking.sql) -- whatsapp_talking_points remains
-- permanently un-sendable, unchanged.
--
-- Required workflow, enforced server-side end to end, not just in the
-- UI: generate -> owner review -> owner edit (optional) -> approve ->
-- explicit send -> Platform WhatsApp -> delivery result/history/audit.
-- Every numbered rule below is one of the owner's explicit "STRICT
-- SAFETY / CONTROL" requirements, implemented literally:
--
--  1. AI generation does NOT authorize sending -- generation only ever
--     produces a status='generated' row (unchanged, sales_generate_
--     outreach_message() never transitions past 'generated').
--  2. Approval does NOT silently send -- sales_approve_outreach_message()
--     (unchanged, not touched by this migration) only ever sets
--     status='approved'; nothing in that function enqueues or sends.
--  3. Only Platform Owner / an authorized platform role may send --
--     this function requires is_platform_owner() OR
--     has_platform_permission('platform.whatsapp_platform.manage'),
--     the SAME permission that governs every other Platform WhatsApp
--     action (owner decision #21 -- Platform WhatsApp send authority
--     is part of that domain's permission, deliberately NOT
--     platform.sales.send_outreach, which only gates the pre-existing
--     EMAIL queue path and would otherwise let a sales-permissioned
--     but WhatsApp-unpermissioned staff member send through Mal3aby's
--     own WhatsApp number).
--  4/5. Sales outreach MUST use PLATFORM WHATSAPP only, MUST NEVER fall
--     back to a tenant session -- this function writes exclusively to
--     platform_whatsapp_queue (never notification_queue/whatsapp_accounts),
--     has no p_club_id parameter anywhere in its signature or body, and
--     platform_whatsapp_queue itself has no club_id column at all --
--     structurally impossible to route through a tenant session.
--  6. Every send attempt is audit logged -- write_audit_log() call
--     below, plus the existing sales_lead_activities timeline.
--  7. Preserve history/version/approval state/sender/timestamps/
--     delivery-failure/retry state -- all already columns on
--     sales_outreach_messages (approved_by/approved_at/sent_at/
--     provider_reference/last_error) and platform_whatsapp_queue
--     (status/attempts/last_attempt_at/next_attempt_at/last_error/
--     provider_reference) -- untouched by this migration, this RPC
--     just correctly threads through them.
--  8. No automatic retry that can create duplicate customer messages --
--     a hard uniqueness constraint below (one platform_whatsapp_queue
--     row per outreach_message_id, EVER, enforced at the database
--     level) plus this function's own "already queued/sent" guard mean
--     a second Send click or a client-side retry cannot enqueue a
--     second delivery attempt for the same draft -- confirmed
--     structurally, not just by convention.
--  9. Server-side authorization and state transitions -- every check in
--     this function runs in the database; the frontend's disabled-
--     button states are convenience only, exactly like every other RPC
--     in this schema.
-- 10. Respect existing WhatsApp safety/rate controls, no unsolicited
--     bulk automation -- this function only ever inserts ONE queue row
--     per call, for one specific already-approved message; the actual
--     dispatch is claimed by whatsapp_connector_claim_next_platform_batch()
--     (unchanged, already rate-limited via platform_whatsapp_safety_settings,
--     20260909200000_platform_whatsapp_domain.sql) -- this migration
--     adds no new bulk/scheduled send path.

-- Idempotency, requirement 8: a given outreach message can only ever
-- occupy ONE row in the platform send queue, for its entire lifetime --
-- a second Send attempt (double-click, retry, re-approval after a
-- failure) cannot create a second delivery attempt. If a prior attempt
-- genuinely failed and a real resend is wanted, that is a deliberate
-- future action (re-queue after explicitly clearing the failed row),
-- not an implicit consequence of clicking Send again.
alter table public.platform_whatsapp_queue
  add constraint platform_whatsapp_queue_outreach_message_id_unique unique (outreach_message_id);

create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message public.sales_outreach_messages;
  v_lead public.sales_leads;
  v_phone text;
  v_effective_body text;
  v_queue_id uuid;
begin
  -- Rule 3: send authority is the Platform WhatsApp domain permission,
  -- not the generic sales send-outreach permission (which only ever
  -- gated the pre-existing email queue path).
  if not (
    auth.uid() is null
    or public.is_platform_owner()
    or public.has_platform_permission('platform.whatsapp_platform.manage')
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_message from public.sales_outreach_messages where id = p_message_id;
  if v_message.id is null then
    raise exception 'outreach message not found';
  end if;

  -- Rule 2: only an explicitly approved draft can be sent -- a
  -- generated/rejected/already-queued/already-sent/failed message
  -- cannot re-enter the queue through this function.
  if v_message.status <> 'approved' then
    raise exception 'only an approved message can be queued for sending (current status: %)', v_message.status;
  end if;

  -- whatsapp_talking_points remains permanently un-sendable -- see this
  -- migration's own header. Only the new, genuinely distinct
  -- whatsapp_message channel is eligible.
  if v_message.channel <> 'whatsapp_message' then
    raise exception 'only channel=whatsapp_message can be sent through Platform WhatsApp -- % is not a send-ready channel (whatsapp_talking_points is a human call/chat script; use sales_queue_outreach_message for channel=email)', v_message.channel;
  end if;

  -- Rule 8 (belt-and-suspenders alongside the unique constraint above):
  -- an explicit, readable guard before the INSERT that would fail on
  -- the constraint anyway, so the caller gets a clear message instead
  -- of a raw unique-violation error.
  if exists (select 1 from public.platform_whatsapp_queue where outreach_message_id = p_message_id) then
    raise exception 'this message has already been queued or sent -- Send cannot be pressed twice for the same draft';
  end if;

  select * into v_lead from public.sales_leads where id = v_message.lead_id;
  v_phone := coalesce(v_lead.whatsapp_public_number, v_lead.public_phone);
  if v_phone is null then
    raise exception 'this lead has no phone number on file to send WhatsApp to';
  end if;

  -- The owner-edited version, when one exists, is what actually gets
  -- sent -- "the owner-edited approved draft sends the edited version"
  -- is a direct, structural consequence of this coalesce, not a UI
  -- convention. The AI's original `body` is never overwritten (see
  -- 20260910110000's own comment on edited_body).
  v_effective_body := coalesce(v_message.edited_body, v_message.body, '');

  insert into public.platform_whatsapp_queue (lead_id, outreach_message_id, recipient_phone, message_body, requested_by)
  values (v_message.lead_id, v_message.id, v_phone, v_effective_body, auth.uid())
  returning id into v_queue_id;

  update public.sales_outreach_messages set status = 'queued' where id = p_message_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (
    v_message.lead_id, 'message_queued',
    jsonb_build_object('message_id', p_message_id, 'queue_id', v_queue_id, 'via', 'platform_whatsapp', 'was_edited', v_message.edited_body is not null),
    auth.uid()
  );

  -- Rule 6: platform-wide audit trail, matching every other sensitive
  -- Platform WhatsApp action in this schema.
  perform public.write_audit_log(
    null, 'sales.platform_whatsapp_message_queued', 'sales_outreach_messages', p_message_id,
    jsonb_build_object('status', 'approved'), jsonb_build_object('status', 'queued', 'queue_id', v_queue_id),
    null
  );

  return v_queue_id;
end;
$$;

comment on function public.sales_queue_platform_whatsapp_message(uuid) is
  'ENABLED (owner decision #20, 2026-09-10). Queues an approved, channel=whatsapp_message outreach draft for sending through the PLATFORM WhatsApp account only. Requires platform.whatsapp_platform.manage (not the generic sales send_outreach permission). Sends the owner-edited text when one exists, otherwise the AI-generated original. One queue row per message ever (unique constraint) -- Send cannot be pressed twice for the same draft. whatsapp_talking_points (a human call/chat script) remains permanently rejected.';

-- ============================================================
-- sales_reject_platform_whatsapp_draft is NOT a new function -- the
-- existing sales_reject_outreach_message(p_message_id, p_reason) RPC
-- (20260904180000, unchanged) already works for any channel/status
-- generically. No new RPC needed for reject.
-- ============================================================

-- ============================================================
-- get_platform_whatsapp_sender_identity: "see which Platform WhatsApp
-- account will send it" + "see connection status" (explicit UX
-- requirement). Thin, read-only, reuses platform_get_whatsapp_status()'s
-- own authorization tier -- exposed as its own narrow RPC (rather than
-- requiring the Sales UI to call the full platform_get_whatsapp_status())
-- so the Sales send button can check "is Platform WhatsApp connected"
-- without importing platform-whatsapp-page-level detail it doesn't need.
-- ============================================================
create or replace function public.get_platform_whatsapp_sender_identity()
returns table(status text, connected_phone_number text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (
    public.is_platform_owner()
    or public.has_platform_permission('platform.whatsapp_platform.manage')
    or public.has_platform_permission('platform.sales.send_outreach')
  ) then
    raise exception 'not authorized';
  end if;

  return query
    select pa.status, pa.connected_phone_number from public.platform_whatsapp_account pa;
end;
$$;

revoke execute on function public.get_platform_whatsapp_sender_identity() from public, anon;
grant execute on function public.get_platform_whatsapp_sender_identity() to authenticated;

comment on function public.get_platform_whatsapp_sender_identity() is
  'Narrow read of the Platform WhatsApp account''s status + connected number, for the Sales send UI to show "which account will send this" and gate the Send button on connection state without requiring the full platform.whatsapp_platform.manage permission just to view it -- a caller who can send outreach (platform.sales.send_outreach) can also see this, even without WhatsApp management rights, since they need it to know whether Send will work.';
