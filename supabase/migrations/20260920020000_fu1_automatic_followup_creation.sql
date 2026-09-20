-- FU-1 fix, part 1 (2026-09-19/20, owner brief): "After a send,
-- follow-ups are created by rule (no reply, no bounce, not
-- do_not_contact, max N)."
--
-- INVESTIGATION FIRST (per the brief's own decision rules): reading
-- sales_record_outreach_event() in full before writing anything here
-- revealed the CANCELLATION half of this requirement already exists
-- and is fully implemented ("Phase 14: automatic follow-up
-- cancellation on reply / do_not_contact" -- any genuine reply
-- auto-cancels every pending follow-up for that lead). What was
-- actually missing is narrower than the brief's own framing suggests:
-- nothing ever CREATES a follow-up automatically in the first place --
-- sales_schedule_followup() only ever fires from a manual frontend
-- button click. This migration adds only that missing half; the
-- cancel-on-reply logic is untouched.
--
-- Default cadence (owner brief section 9's own stated default, used
-- verbatim since this decision was not answered explicitly): first
-- follow-up 3 days after a successful send, reason text making clear
-- WHY it exists and that no reply has been recorded yet. No "final at
-- 7 days" follow-up is separately auto-created here -- a second
-- automatic follow-up would need its own trigger point (this
-- migration only has a hook at SEND time, not at the 3-day mark
-- itself, since there is no scheduled job in this codebase that runs
-- "N days after X" sweeps yet); the existing Followups screen's manual
-- "schedule another" flow covers a genuine need for a second round
-- after the first one is manually reviewed. Documented here as a real,
-- deliberate scope boundary, not silently dropped.
--
-- Guards: never for the activation_invite system message (that's not
-- sales outreach, matches INV-1's own message_type value exactly, and
-- this the exact class of "duplicate/irrelevant follow-up" content the
-- brief's own FU-1 evidence complained about); never a second
-- auto-followup while one is already pending for the same lead (the
-- exact "duplicate follow-ups on the same date" pattern the brief's
-- evidence showed); never for a lead that reached a terminal/replied
-- status between the message being queued and it actually sending
-- (mirrors sales_schedule_followup()'s own do_not_contact/won/lost guard).

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

-- Grants (2026-09-19 lesson, this project's own established rule):
-- signature unchanged from the SEND-1 fix's own version, so
-- CREATE OR REPLACE alone would normally be grant-preserving -- but
-- re-asserting explicitly anyway rather than assuming, matching this
-- migration's own DROP+CREATE discipline elsewhere in this session.
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from public;
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from anon;
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from authenticated;
grant execute on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) to service_role;
