-- Real bug found live during Safe Messaging test #105 (cancellation
-- suppression test): a connector process crash (an unhandled exception
-- deep inside Baileys' own retry-message handling, "Connection
-- Closed") left a claimed notification_queue row permanently stuck in
-- status='processing' -- claim_next_batch() only ever looks at
-- pending/retrying, so a processing row abandoned by a dead connector
-- process had NO recovery path at all: not retried, not expired, not
-- visible as failed, invisible to every existing diagnostic. This is
-- a real reliability gap independent of (but exposed by) the crash --
-- the fix for the crash itself (installCrashGuards() in
-- whatsapp-connector/src/index.ts) prevents this going forward, but
-- does nothing for a row already stuck from ANY cause (process kill,
-- host restart, OOM), so both fixes are needed together.
--
-- Fix: whatsapp_connector_expire_stale() (already called once per
-- QueueConsumer poll tick) is extended to ALSO reclaim any 'processing'
-- row whose last_attempt_at is older than a conservative timeout (10
-- minutes -- far longer than any real send attempt should take,
-- short enough that a genuinely abandoned row doesn't sit invisible
-- for hours) back to 'retrying' with the normal backoff, so it
-- re-enters the exact same capped-retry path as any other transient
-- failure. This is recovery from a stuck lock, not a new retry
-- policy -- attempts is NOT incremented here (the original claim
-- already counted as one attempt), and the existing 5-attempt cap in
-- whatsapp_connector_report_send_result still applies on its next
-- real outcome.
create or replace function public.whatsapp_connector_expire_stale()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired_count integer;
  v_recovered_count integer;
begin
  with expired as (
    update public.notification_queue
    set status = 'expired'
    where channel = 'whatsapp'
      and status in ('pending', 'retrying')
      and expires_at is not null
      and expires_at <= now()
    returning id
  )
  select count(*)::integer into v_expired_count from expired;

  with recovered as (
    update public.notification_queue
    set status = 'retrying',
        next_attempt_at = now(),
        last_error = 'recovered from a stuck processing state (connector likely crashed/restarted mid-send)'
    where channel = 'whatsapp'
      and status = 'processing'
      and last_attempt_at < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer into v_recovered_count from recovered;

  return v_expired_count + v_recovered_count;
end;
$$;

revoke execute on function public.whatsapp_connector_expire_stale() from public, anon, authenticated;

comment on function public.whatsapp_connector_expire_stale() is 'Part J/L: sweeps whatsapp-channel pending/retrying rows past expires_at to expired, AND recovers any row stuck in processing for >10 minutes (abandoned by a crashed/killed connector process) back to retrying so it re-enters the normal capped-retry path rather than being lost forever. Called once per QueueConsumer poll tick, before claiming.';
