-- SEND-1 fix (2026-09-19, owner brief): the real root cause was
-- confirmed live -- supabase/functions/sales-outreach-email-sender is
-- a complete, correct claim-and-send implementation, but nothing ever
-- scheduled it. pg_net is not installed on this project (confirmed
-- live), so the pg_cron -> pg_net trigger this function's own comment
-- describes was never viable. Instead of adding pg_net as a new
-- dependency, this project already has a proven, running precedent
-- for exactly this shape of job: cloudflare/email-worker, which polls
-- notification_queue on a Cloudflare Cron Trigger (every minute) and
-- calls email_worker_claim_next_batch()/email_worker_report_send_result().
-- This migration brings sales_outreach_messages up to that SAME
-- retry/backoff/lease-recovery design (email-worker's own RPC bodies
-- were read in full before writing this migration, and are mirrored
-- here as closely as the schema difference allows), so
-- cloudflare/email-worker's scheduled() handler can be extended to
-- also drive sales outreach on its own already-running Cron Trigger --
-- no new Worker, no new schedule, no new dependency.
--
-- Schema additions: attempts/last_attempt_at/next_attempt_at (retry
-- bookkeeping) and a new 'processing'/'retrying' pair of statuses,
-- exactly mirroring notification_queue's own column set and status
-- vocabulary.

alter table public.sales_outreach_messages
  add column if not exists attempts integer not null default 0,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

alter table public.sales_outreach_messages drop constraint if exists sales_outreach_messages_status_check;
alter table public.sales_outreach_messages add constraint sales_outreach_messages_status_check
  check (status = any (array['generated', 'approved', 'queued', 'processing', 'retrying', 'sent', 'failed', 'rejected']));

-- sales_claim_queued_outreach_message() REPLACED (return shape widened
-- with message_id's own attempts count, callers already only read the
-- columns they need) -- now claims 'queued' OR 'retrying' (whose
-- next_attempt_at has arrived), locks it into 'processing', and skips
-- locked rows exactly like email_worker_claim_next_batch(). Still one
-- row per call, matching the sender function's own one-invocation-one-
-- message design (its own comment: "the caller is expected to invoke
-- repeatedly... keeping each invocation short and bounded") -- this
-- migration does not change that shape, only what counts as claimable
-- and what claiming does to the row.
drop function if exists public.sales_claim_queued_outreach_message();
create function public.sales_claim_queued_outreach_message()
returns table(message_id uuid, lead_id uuid, subject text, body text, recipient_email text, language text, attempts integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_msg record;
begin
  select m.id as message_id, m.lead_id as lead_id, m.subject as subject, m.body as body,
         l.public_email as recipient_email, m.language as language, m.attempts as attempts
    into v_msg
  from public.sales_outreach_messages m
  join public.sales_leads l on l.id = m.lead_id
  where m.channel = 'email' and l.status <> 'do_not_contact'
    and (
      m.status = 'queued'
      or (m.status = 'retrying' and (m.next_attempt_at is null or m.next_attempt_at <= now()))
    )
  order by m.created_at
  for update of m skip locked
  limit 1;

  if v_msg.message_id is null then
    return;
  end if;

  update public.sales_outreach_messages
  set status = 'processing', last_attempt_at = now(), attempts = attempts + 1
  where id = v_msg.message_id;

  return query select v_msg.message_id, v_msg.lead_id, v_msg.subject, v_msg.body, v_msg.recipient_email, v_msg.language, v_msg.attempts + 1;
end;
$$;

revoke all on function public.sales_claim_queued_outreach_message() from public;
revoke all on function public.sales_claim_queued_outreach_message() from anon;
revoke all on function public.sales_claim_queued_outreach_message() from authenticated;
grant execute on function public.sales_claim_queued_outreach_message() to service_role;

-- sales_mark_outreach_sent() REPLACED -- adds p_permanent/
-- p_retry_after_seconds, same backoff ladder as
-- email_worker_report_send_result() (1/5/20/60 minutes), same 5-attempt
-- ceiling before giving up. p_permanent defaults to true so any
-- EXISTING caller (there was only ever one: the sender function,
-- updated in this same commit) that doesn't pass it keeps today's
-- exact behavior (fail once, no retry) rather than silently starting
-- to retry sends nobody asked for. DROP FIRST (this project's own
-- established rule: CREATE OR REPLACE cannot add parameters without
-- creating a second overload -- confirmed live in this migration's own
-- dry run before this fix was added) -- the old 4-arg signature must
-- not survive alongside the new one, or callers could accidentally
-- bind to either.
drop function if exists public.sales_mark_outreach_sent(uuid, boolean, text, text);
create function public.sales_mark_outreach_sent(
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
  v_attempts int;
  v_max_attempts constant int := 5;
  v_backoff_minutes int;
begin
  if p_success then
    update public.sales_outreach_messages
    set status = 'sent', sent_at = now(), provider_reference = p_provider_reference, last_error = null
    where id = p_message_id
    returning lead_id into v_lead_id;

    if v_lead_id is not null then
      insert into public.sales_lead_activities (lead_id, activity_type, detail)
      values (v_lead_id, 'message_sent', jsonb_build_object('message_id', p_message_id));

      update public.sales_leads set status = 'contacted', updated_at = now()
      where id = v_lead_id and status in ('discovered', 'enriching', 'enriched', 'qualified', 'contact_ready');

      insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason)
      select v_lead_id, 'contact_ready', 'contacted', 'first outreach message sent'
      where exists (select 1 from public.sales_leads where id = v_lead_id and status = 'contacted');
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

-- Explicit grants (2026-09-19 lesson, this project's own established
-- rule, reconfirmed live in this migration's own dry run): DROP+CREATE
-- silently reopens EXECUTE to PUBLIC/anon/authenticated on the new
-- function -- a REVOKE FROM PUBLIC/anon/authenticated is REQUIRED
-- after every DROP+CREATE, never assumed to carry over. This function
-- is internal-worker-only (called only by the Cloudflare Worker's
-- service-role client), matching its pre-migration grants exactly
-- (service_role + postgres only, confirmed live before this migration
-- was written).
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from public;
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from anon;
revoke all on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) from authenticated;
grant execute on function public.sales_mark_outreach_sent(uuid, boolean, text, text, boolean, integer) to service_role;

-- sales_expire_stale_outreach_processing() -- new, mirrors
-- email_worker_expire_stale()'s "recovered" case only (this domain has
-- no expires_at concept for outreach messages, and no "delivered but
-- crashed before reporting" edge case since Resend's own idempotency
-- key already covers a genuine retry-of-the-same-send -- see the
-- sender function's own Idempotency-Key header, unchanged by this
-- migration). A message stuck in 'processing' for over 10 minutes means
-- the worker invocation that claimed it died mid-send -- recovered back
-- to 'retrying' so it is picked up again rather than stuck forever.
create or replace function public.sales_expire_stale_outreach_processing()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_recovered_count integer;
begin
  with recovered as (
    update public.sales_outreach_messages
    set status = 'retrying', next_attempt_at = now(),
        last_error = 'recovered from a stuck processing state (worker likely crashed/restarted mid-send)'
    where status = 'processing' and last_attempt_at < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer into v_recovered_count from recovered;

  return v_recovered_count;
end;
$$;

revoke all on function public.sales_expire_stale_outreach_processing() from public;
revoke all on function public.sales_expire_stale_outreach_processing() from anon;
revoke all on function public.sales_expire_stale_outreach_processing() from authenticated;
grant execute on function public.sales_expire_stale_outreach_processing() to service_role;
