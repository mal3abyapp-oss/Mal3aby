-- RELIABILITY FIX (P2, confirmed real but narrow-window):
-- Duplicate-send risk on connector crash between "WhatsApp confirmed
-- the send" and "the result was persisted".
--
-- Root cause: whatsapp_connector_claim_next_batch() marks a row
-- 'processing' and whatsapp_connector_expire_stale() (fixed earlier in
-- 20260818100000_fix_stuck_processing_recovery.sql) correctly reclaims
-- any row stuck in 'processing' for >10 minutes back to 'retrying' --
-- this is necessary (without it, a genuinely crashed/killed connector
-- would leave a message silently lost forever, confirmed live in the
-- original investigation). But BaileysProvider.sendMessage() confirms
-- delivery to WhatsApp's own servers (captures Baileys' message key as
-- provider_reference) BEFORE control returns to QueueConsumer, which
-- then still has to complete media handling, call
-- whatsapp_connector_report_send_result() (a full network round trip),
-- and only THAT RPC persists provider_reference/status='sent'. A
-- connector crash landing in that specific gap (confirmed to exist by
-- reading BaileysProvider.ts:690-706 and QueueConsumer.ts:192-201 --
-- there is no atomic "send and report" step, they are necessarily two
-- separate operations against two different systems) leaves the row
-- stuck in 'processing' with the message ALREADY delivered. The
-- existing 10-minute recovery then reclaims it to 'retrying', and a
-- subsequent successful attempt sends the SAME message a second time
-- to a real customer -- WhatsApp and Baileys provide no client-supplied
-- idempotency key that would let a resend be deduplicated on the
-- provider side, so this cannot be fixed by "try harder not to crash"
-- alone.
--
-- This is a narrow window (a crash has to land in the specific span
-- between Baileys' own send confirmation and one DB round-trip, not
-- "any crash during a send"), not a routine occurrence, and removing
-- the stuck-processing recovery entirely would trade a rare duplicate
-- for guaranteed silent message loss on every real crash -- strictly
-- worse. The correct minimal fix shrinks the blast radius instead of
-- removing the safety net: record the provider_reference the MOMENT
-- Baileys confirms the text send (a single, fast, best-effort UPDATE
-- the connector fires before doing anything else -- media generation,
-- classification writes, or the full report RPC), so that if a crash
-- happens after that point, the recovery sweep can tell the difference
-- between "genuinely stuck, safe to retry" (no provider_reference
-- recorded) and "already delivered, must NOT be resent" (a
-- provider_reference IS recorded) and route the latter to a terminal,
-- operator-visible 'failed' state instead of silently resending.
--
-- This does not achieve perfect exactly-once delivery (a crash landing
-- in the few-millisecond gap between Baileys returning its response and
-- this new UPDATE completing is still possible, in principle, though
-- far narrower than the full round-trip window it replaces) -- it is a
-- best-effort narrowing, documented honestly as such rather than
-- claimed as a full fix.

create or replace function public.whatsapp_connector_mark_provider_reference(
  p_queue_id uuid,
  p_provider_reference text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if p_provider_reference is null or trim(p_provider_reference) = '' then
    return;
  end if;

  -- Only meaningful while the row is still 'processing' (i.e. this is
  -- genuinely an in-flight marker for the current claim, not a stray
  -- write against a row that has already moved on for any reason).
  update public.notification_queue
  set provider_reference = p_provider_reference
  where id = p_queue_id
    and status = 'processing'
    and provider_reference is null;
end;
$function$;

revoke execute on function public.whatsapp_connector_mark_provider_reference(uuid, text) from public, anon, authenticated;

comment on function public.whatsapp_connector_mark_provider_reference(uuid, text) is
  'Best-effort in-flight marker: records provider_reference the moment Baileys confirms a text send, before the full report round-trip, so whatsapp_connector_expire_stale() can distinguish an already-delivered crashed send (must not resend) from a genuinely stuck one (safe to retry). See 20260821160000 for full rationale.';

-- Extend the stuck-processing recovery: a 'processing' row that ALREADY
-- has a provider_reference (the connector confirmed delivery, then
-- crashed before reporting the result) must never be routed back to
-- 'retrying' -- that would resend an already-delivered message to a
-- real customer. Route it to a terminal 'failed' with an operator-
-- visible explanation instead; it is not silently lost (the
-- provider_reference proves it went out), just not auto-retried.
create or replace function public.whatsapp_connector_expire_stale()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expired_count integer;
  v_recovered_count integer;
  v_delivered_not_resent_count integer;
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

  -- Confirmed-delivered-but-unreported: never resend, mark terminal.
  with delivered_not_resent as (
    update public.notification_queue
    set status = 'failed',
        last_error = 'connector confirmed delivery (provider_reference recorded) then crashed before reporting the result -- not resent to avoid duplicating an already-delivered message; verify manually if needed'
    where channel = 'whatsapp'
      and status = 'processing'
      and provider_reference is not null
      and last_attempt_at < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer into v_delivered_not_resent_count from delivered_not_resent;

  -- Genuinely stuck (no provider_reference ever recorded): safe to retry.
  with recovered as (
    update public.notification_queue
    set status = 'retrying',
        next_attempt_at = now(),
        last_error = 'recovered from a stuck processing state (connector likely crashed/restarted mid-send)'
    where channel = 'whatsapp'
      and status = 'processing'
      and provider_reference is null
      and last_attempt_at < now() - interval '10 minutes'
    returning id
  )
  select count(*)::integer into v_recovered_count from recovered;

  return v_expired_count + v_recovered_count + v_delivered_not_resent_count;
end;
$$;

revoke execute on function public.whatsapp_connector_expire_stale() from public, anon, authenticated;

comment on function public.whatsapp_connector_expire_stale() is 'Part J/L/M: sweeps whatsapp-channel pending/retrying rows past expires_at to expired; recovers a row stuck in processing for >10 minutes back to retrying UNLESS it already has a provider_reference (confirmed delivered before the connector crashed), in which case it is marked failed instead of resent, to avoid duplicating an already-delivered WhatsApp message. Called once per QueueConsumer poll tick, before claiming.';
