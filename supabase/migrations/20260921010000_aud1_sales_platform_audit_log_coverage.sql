-- AUD-1 (owner brief, live QA 2026-09-19/20): the platform-wide,
-- hash-chained audit_logs table (row_hash/previous_row_hash,
-- _chain_audit_log_row() trigger) is the codebase's own established bar
-- for "this action needs a tamper-evident record" -- comparable-severity
-- actions like platform_suspend_club/set_platform_staff_role already
-- write there (20260817100225_*, 20260826121851_*), and
-- 20260829040000_revoke_unaudited_platform_owner_direct_writes.sql
-- treated an unaudited platform-owner write path as a live P0 ("audit
-- tampering allowing fraud concealment"). Sales Intelligence only had 4
-- call sites into audit_logs (provider config, email webhook secret,
-- conversion COMPLETION, and Platform WhatsApp send) -- every other
-- sensitive sales action only ever reached sales_lead_activities (a
-- simple append-only per-lead log with no hash chain, no immutability
-- trigger, and no DB-level UPDATE/DELETE-blocking policy -- confirmed
-- by comparing its own RLS/grants against audit_logs' stronger
-- guarantee before writing this migration).
--
-- The clearest internal precedent for what's missing:
-- sales_queue_platform_whatsapp_message() (20260910120000) explicitly
-- calls write_audit_log() with the comment "Rule 6: platform-wide audit
-- trail, matching every other sensitive Platform WhatsApp action in
-- this schema" -- but the EMAIL send path (sales_mark_outreach_sent(),
-- the exact same kind of "real message sent to an external prospect
-- under the platform's identity") was never retrofitted with the same
-- call. That inconsistency, plus the two other highest-blast-radius
-- gaps found by direct investigation, are what this migration closes:
--
-- 1. sales_win_lead_and_invite_owner() -- the actual "convert this lead
--    into a real tenant" decision point (mints an activation invite that
--    can create a brand-new paying club). Previously only
--    sales_lead_activities; the LATER _complete_sales_conversion() step
--    (20260904120100) already correctly audit-logs when the prospect
--    claims the invite, but the decision itself, made by the platform
--    owner/staff, did not.
-- 2. sales_mark_outreach_sent() -- email send completion (success path
--    only; a failed/retrying send is not itself a sensitive action worth
--    a platform audit row). Brings the email channel to parity with the
--    WhatsApp channel's own existing audit coverage.
-- 3. sales_approve_outreach_message() / sales_reject_outreach_message()
--    -- the human approval gate itself, the pipeline's own designated
--    control point for "a message goes out under Mal3aby's identity
--    only after a human signs off" (owner decision #20). Neither
--    direction of that decision was previously audit-logged.
--
-- Deliberately NOT included here (per the brief's own decision rule:
-- report the real cause, don't invent scope beyond what the evidence
-- supports): sales_change_lead_status() -- an internal pipeline-state
-- transition, lower blast-radius than the three actions above (no
-- external message sent, no tenant created), and giving
-- sales_lead_activities its own hash chain -- a materially bigger,
-- separate design decision (a new chained table, not a few
-- write_audit_log() calls) that deserves its own explicit owner
-- decision rather than being bundled into this fix.
--
-- p_club_id is null for every call here, matching
-- sales_queue_platform_whatsapp_message()'s own precedent exactly: a
-- sales lead has no club_id until conversion, and platform_whatsapp_queue
-- (which that RPC audits) has no club_id column either -- audit_logs'
-- own club_id column is nullable specifically for platform-wide actions
-- like this.

create or replace function public.sales_win_lead_and_invite_owner(
  p_lead_id uuid,
  p_owner_email text,
  p_contact_phone text default null,
  p_business_name_ar text default null,
  p_reason text default null
)
returns table(raw_token text, raw_secret text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_lead record;
  v_mint record;
  v_contact_phone_e164 text;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.convert_to_tenant')) then
    raise exception 'not authorized';
  end if;

  if p_owner_email is null or p_owner_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'a valid owner email is required to send the activation invite';
  end if;

  select * into v_lead from public.sales_leads where id = p_lead_id for update;
  if v_lead.id is null then
    raise exception 'lead not found';
  end if;
  if v_lead.merged_into_lead_id is not null then
    raise exception 'this lead was merged into another record and cannot be converted directly';
  end if;
  if v_lead.status in ('won', 'awaiting_owner_activation', 'tenant_activated') then
    raise exception 'this lead has already reached won/activation status';
  end if;
  if v_lead.status in ('lost', 'do_not_contact') then
    raise exception 'this lead is marked % and cannot be converted', v_lead.status;
  end if;

  v_contact_phone_e164 := coalesce(nullif(trim(p_contact_phone), ''), v_lead.public_phone);

  -- WON, recorded in history/activities, then immediately superseded by
  -- awaiting_owner_activation in the same transaction -- satisfies the
  -- mandatory rule that WON alone must never create/imply a tenant while
  -- still leaving a real, queryable WON moment in the audit trail.
  update public.sales_leads set status = 'won', status_reason = p_reason, updated_at = now() where id = p_lead_id;
  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, v_lead.status, 'won', p_reason, auth.uid());
  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'won', jsonb_build_object('reason', p_reason), auth.uid());

  update public.sales_leads set status = 'awaiting_owner_activation', updated_at = now() where id = p_lead_id;
  insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason, changed_by)
  values (p_lead_id, 'won', 'awaiting_owner_activation', null, auth.uid());

  select * into v_mint from public._mint_sales_activation_invite_internal(
    p_lead_id, v_lead.business_name, coalesce(p_business_name_ar, v_lead.business_name),
    v_lead.business_type, v_lead.city, v_lead.country,
    v_contact_phone_e164, null, p_owner_email,
    now() + interval '7 days', auth.uid()
  );

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (p_lead_id, 'activation_invite_created', jsonb_build_object('owner_email', lower(trim(p_owner_email)), 'expires_at', now() + interval '7 days'), auth.uid());

  -- AUD-1 fix: the platform-wide, tamper-evident record of the actual
  -- WIN decision -- who converted this lead, to which prospect email,
  -- when. sales_lead_activities already has 'won'/
  -- 'activation_invite_created' rows for lead-scoped history; this is
  -- the separate, hash-chained platform record the codebase's own bar
  -- requires for an action of this blast radius (can lead to a new
  -- paying tenant).
  perform public.write_audit_log(
    null, 'sales.lead_won_and_invited', 'sales_leads', p_lead_id,
    jsonb_build_object('status', v_lead.status),
    jsonb_build_object('status', 'awaiting_owner_activation', 'owner_email', lower(trim(p_owner_email))),
    p_reason
  );

  return query select v_mint.raw_token, v_mint.raw_secret;
end;
$function$;

revoke all on function public.sales_win_lead_and_invite_owner(uuid, text, text, text, text) from public, anon;
grant execute on function public.sales_win_lead_and_invite_owner(uuid, text, text, text, text) to authenticated;

-- ============================================================
-- sales_mark_outreach_sent(): success path only gains a write_audit_log
-- call, bringing the email channel to parity with
-- sales_queue_platform_whatsapp_message()'s existing audit coverage. The
-- failure/retry paths are unchanged (a failed send is not itself a
-- sensitive action worth a platform audit row -- sales_lead_activities/
-- last_error already records it for operational visibility).
-- ============================================================
create or replace function public.sales_mark_outreach_sent(
  p_message_id uuid,
  p_success boolean,
  p_provider_reference text DEFAULT NULL::text,
  p_error text DEFAULT NULL::text,
  p_permanent boolean DEFAULT true,
  p_retry_after_seconds integer DEFAULT NULL::integer
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
  v_message_type text;
  v_lead_status text;
  v_attempts int;
  v_max_attempts constant int := 5;
  v_backoff_minutes int;
begin
  if p_success then
    update public.sales_outreach_messages
    set status = 'sent', sent_at = now(), provider_reference = p_provider_reference, last_error = null
    where id = p_message_id
    returning lead_id, message_type into v_lead_id, v_message_type;

    if v_lead_id is not null then
      insert into public.sales_lead_activities (lead_id, activity_type, detail)
      values (v_lead_id, 'message_sent', jsonb_build_object('message_id', p_message_id));

      -- AUD-1 fix: platform-wide record that a real message went out to
      -- an external prospect under the platform's identity -- exactly
      -- the same event class sales_queue_platform_whatsapp_message()
      -- already audits for the WhatsApp channel.
      perform public.write_audit_log(
        null, 'sales.outreach_message_sent', 'sales_outreach_messages', p_message_id,
        jsonb_build_object('status', 'queued'),
        jsonb_build_object('status', 'sent', 'channel', 'email', 'provider_reference', p_provider_reference),
        null
      );

      update public.sales_leads set status = 'contacted', updated_at = now()
      where id = v_lead_id and status in ('discovered', 'enriching', 'enriched', 'qualified', 'contact_ready');

      insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason)
      select v_lead_id, 'contact_ready', 'contacted', 'first outreach message sent'
      where exists (select 1 from public.sales_leads where id = v_lead_id and status = 'contacted');

      -- FU-1 fix: automatic 3-day follow-up, real sales outreach only.
      select status into v_lead_status from public.sales_leads where id = v_lead_id;
      if v_message_type <> 'activation_invite'
        and v_lead_status not in ('do_not_contact', 'won', 'awaiting_owner_activation', 'tenant_activated', 'lost', 'replied')
        and not exists (select 1 from public.sales_followups where lead_id = v_lead_id and status = 'pending')
      then
        insert into public.sales_followups (lead_id, reason, scheduled_at, owner_id, created_by)
        values (
          v_lead_id,
          'auto: follow up if no reply within 3 days of the last outreach message',
          now() + interval '3 days',
          null,
          null
        );
      end if;
    end if;
    return;
  end if;

  if p_permanent then
    update public.sales_outreach_messages
    set status = 'failed', last_error = p_error
    where id = p_message_id;
    return;
  end if;

  select attempts into v_attempts from public.sales_outreach_messages where id = p_message_id;
  if v_attempts is null then
    return;
  end if;

  if v_attempts >= v_max_attempts then
    update public.sales_outreach_messages
    set status = 'failed', last_error = p_error
    where id = p_message_id;
  else
    if p_retry_after_seconds is not null and p_retry_after_seconds > 0 then
      update public.sales_outreach_messages
      set status = 'retrying', last_error = p_error, next_attempt_at = now() + make_interval(secs => p_retry_after_seconds)
      where id = p_message_id;
    else
      v_backoff_minutes := case v_attempts when 1 then 1 when 2 then 5 when 3 then 20 else 60 end;
      update public.sales_outreach_messages
      set status = 'retrying', last_error = p_error, next_attempt_at = now() + make_interval(mins => v_backoff_minutes)
      where id = p_message_id;
    end if;
  end if;
end;
$$;

revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from public;
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from anon;
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from authenticated;
grant execute on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) to service_role;

-- ============================================================
-- sales_approve_outreach_message() / sales_reject_outreach_message():
-- the human approval gate itself -- owner decision #20's own designated
-- control point ("a message goes out under Mal3aby's identity only
-- after a human signs off"). Neither direction was previously
-- platform-audit-logged.
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

  perform public.write_audit_log(
    null, 'sales.outreach_message_approved', 'sales_outreach_messages', p_message_id,
    jsonb_build_object('status', 'generated'),
    jsonb_build_object('status', 'approved'),
    null
  );
end;
$$;

revoke all on function public.sales_approve_outreach_message(uuid) from public, anon;
grant execute on function public.sales_approve_outreach_message(uuid) to authenticated;

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

  perform public.write_audit_log(
    null, 'sales.outreach_message_rejected', 'sales_outreach_messages', p_message_id,
    jsonb_build_object('status', 'generated'),
    jsonb_build_object('status', 'rejected'),
    p_reason
  );
end;
$$;

revoke all on function public.sales_reject_outreach_message(uuid, text) from public, anon;
grant execute on function public.sales_reject_outreach_message(uuid, text) to authenticated;
