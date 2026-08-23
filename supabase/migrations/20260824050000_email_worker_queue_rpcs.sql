-- EMAIL DELIVERY CHANNEL -- worker-facing queue RPCs (2026-08-24).
--
-- Mirrors the already-proven whatsapp_connector_claim_next_batch /
-- whatsapp_connector_expire_stale / whatsapp_connector_report_send_result
-- pattern exactly (directive rules 36-38: atomic claim via `for
-- update skip locked`, stuck-processing lease recovery, bounded
-- retry with backoff) -- simplified where email genuinely differs
-- from WhatsApp (no per-account rate caps/circuit breaker/consent
-- gate, since queue_email_notification already resolved and
-- validated the recipient at queue time and there is no persistent
-- provider connection to protect).
--
-- All three functions are service_role-only (same grant shape as
-- their WhatsApp counterparts) -- mala3by-email-worker is the only
-- caller, using its own SUPABASE_SERVICE_ROLE_KEY secret.

create or replace function public.email_worker_claim_next_batch(p_limit integer default 10)
returns table(id uuid, club_id uuid, recipient_customer_id uuid, recipient_email text, template_key text, language text, variables jsonb, attempts integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Same "source event still valid" cancellation this project already
  -- applies to WhatsApp (e.g. a booking cancelled after its
  -- confirmation email was queued but before it was claimed).
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'email'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id, ne.event_type);

  -- Defensive re-validation immediately before claim -- catches an
  -- email that somehow became malformed between queue time and now
  -- (should not happen given queue-time validation, but never trust
  -- only the write-time check for a boundary this security-relevant).
  update public.notification_queue nq
  set status = 'suppressed_invalid_recipient',
      last_error = 'Recipient email is missing or failed format check'
  where nq.channel = 'email'
    and nq.status in ('pending', 'retrying')
    and (nq.recipient_email is null or nq.recipient_email !~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$');

  return query
    with candidates as (
      select nq.id, nq.scheduled_at
      from public.notification_queue nq
      where nq.channel = 'email'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    claimed as (
      select c.id
      from candidates c
      join public.notification_queue nq2 on nq2.id = c.id
      order by c.scheduled_at
      limit greatest(p_limit, 0)
      for update of nq2 skip locked
    )
    update public.notification_queue nq
    set status = 'processing',
        last_attempt_at = now(),
        attempts = nq.attempts + 1
    from claimed
    where nq.id = claimed.id
    returning nq.id, nq.club_id, nq.recipient_customer_id, nq.recipient_email,
      nq.template_key, nq.language, nq.variables, nq.attempts;
end;
$function$;

revoke all on function public.email_worker_claim_next_batch(integer) from public, anon, authenticated;
grant execute on function public.email_worker_claim_next_batch(integer) to service_role;

-- Lease recovery -- identical shape to whatsapp_connector_expire_stale.
-- A Worker invocation that dies mid-send (Cloudflare Worker CPU/wall
-- time limit, transient crash) leaves rows stuck in 'processing'; this
-- recovers them after a 10-minute lease window, distinguishing
-- "already has a provider_reference" (delivered, but the Worker
-- crashed before writing 'sent' -- do NOT resend, would duplicate a
-- real delivery) from "no provider_reference yet" (genuinely never
-- reached Resend, or Resend never responded -- safe to retry).
create or replace function public.email_worker_expire_stale()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_expired_count integer;
  v_recovered_count integer;
  v_delivered_not_resent_count integer;
begin
  with expired as (
    update public.notification_queue
    set status = 'expired'
    where channel = 'email'
      and status in ('pending', 'retrying')
      and expires_at is not null
      and expires_at <= now()
    returning id
  )
  select count(*)::integer into v_expired_count from expired;

  with delivered_not_resent as (
    update public.notification_queue
    set status = 'failed',
        last_error = 'worker confirmed delivery (provider_reference recorded) then crashed before reporting the result -- not resent to avoid duplicating an already-delivered email; verify manually if needed'
    where channel = 'email'
      and status = 'processing'
      and provider_reference is not null
      and provider_reference != ''
      and last_attempt_at < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer into v_delivered_not_resent_count from delivered_not_resent;

  with recovered as (
    update public.notification_queue
    set status = 'retrying',
        next_attempt_at = now(),
        last_error = 'recovered from a stuck processing state (worker likely crashed/restarted mid-send)'
    where channel = 'email'
      and status = 'processing'
      and (provider_reference is null or provider_reference = '')
      and last_attempt_at < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer into v_recovered_count from recovered;

  return v_expired_count + v_recovered_count + v_delivered_not_resent_count;
end;
$function$;

revoke all on function public.email_worker_expire_stale() from public, anon, authenticated;
grant execute on function public.email_worker_expire_stale() to service_role;

-- Bounded retry with backoff -- same max_attempts=5, same escalating
-- backoff schedule as whatsapp_connector_report_send_result (1/5/20/60
-- minutes), minus the WhatsApp-specific circuit-breaker/account-health
-- bookkeeping (email has no persistent provider connection to
-- protect). p_permanent distinguishes a permanent failure (invalid
-- recipient/domain rejection -- directive rule 14: "do not retry
-- permanent failures forever") from a temporary one (429/5xx/network)
-- -- a permanent failure skips the retry ladder entirely and goes
-- straight to 'failed' on the FIRST attempt, never consuming all 5
-- attempts pointlessly against an address that will never accept
-- mail.
create or replace function public.email_worker_report_send_result(
  p_queue_id uuid,
  p_success boolean,
  p_provider_reference text default null,
  p_error text default null,
  p_permanent boolean default false,
  p_retry_after_seconds integer default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_attempts int;
  v_max_attempts constant int := 5;
  v_backoff_minutes int;
begin
  if p_success then
    update public.notification_queue
    set status = 'sent',
        provider_reference = p_provider_reference,
        provider_accepted_at = now(),
        last_error = null
    where id = p_queue_id;
    return;
  end if;

  if p_permanent then
    update public.notification_queue
    set status = 'failed', last_error = p_error
    where id = p_queue_id;
    return;
  end if;

  select attempts into v_attempts from public.notification_queue where id = p_queue_id;
  if v_attempts is null then
    return;
  end if;

  if v_attempts >= v_max_attempts then
    update public.notification_queue
    set status = 'failed', last_error = p_error
    where id = p_queue_id;
  else
    -- Honor Resend's own Retry-After when it gave one (429 case);
    -- otherwise use the same escalating schedule already proven for
    -- WhatsApp.
    if p_retry_after_seconds is not null and p_retry_after_seconds > 0 then
      update public.notification_queue
      set status = 'retrying',
          last_error = p_error,
          next_attempt_at = now() + make_interval(secs => p_retry_after_seconds)
      where id = p_queue_id;
    else
      v_backoff_minutes := case v_attempts
        when 1 then 1
        when 2 then 5
        when 3 then 20
        else 60
      end;
      update public.notification_queue
      set status = 'retrying',
          last_error = p_error,
          next_attempt_at = now() + make_interval(mins => v_backoff_minutes)
      where id = p_queue_id;
    end if;
  end if;
end;
$function$;

revoke all on function public.email_worker_report_send_result(uuid, boolean, text, text, boolean, integer) from public, anon, authenticated;
grant execute on function public.email_worker_report_send_result(uuid, boolean, text, text, boolean, integer) to service_role;
