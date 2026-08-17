-- Bug found via live testing of Part K (Safety Test #3: booking
-- cancelled before its queued reminder is sent -> reminder must be
-- suppressed). 20260817045120_safe_messaging_cancellation_suppression's
-- whatsapp_connector_claim_next_batch() correctly EXCLUDES a row whose
-- booking was since cancelled from ever being claimed (via the
-- not_superseded CTE's inline booking-status join), and
-- cancel_booking() itself (20260817045250) explicitly marks any other
-- still-pending row 'cancelled' at the moment of cancellation via
-- cancel_pending_whatsapp_for_booking() -- but that coverage only
-- fires when cancellation actually goes through cancel_booking(). A
-- row whose booking's status changed to 'cancelled' through any other
-- path (or was already stuck pending before this wiring existed) stays
-- silently 'pending' forever: never claimed, never marked cancelled,
-- invisible to whatsapp_queue_diagnostics as anything other than a
-- normal in-flight pending message. Confirmed live: inserted a real
-- test booking + reminder, cancelled the booking via a direct UPDATE
-- (bypassing cancel_booking()), called whatsapp_connector_claim_next_batch()
-- repeatedly -- the row correctly never got claimed, but also never
-- transitioned out of 'pending', which violates Part K's "cancelled /
-- suppressed" requirement (a suppressed message must be observable as
-- suppressed, not indistinguishable from "just hasn't been picked up
-- yet").
--
-- Fix: fold the exclusion into an explicit UPDATE, run once per claim
-- call, using the same notification_source_still_valid() helper
-- (20260818050000) the rest of the schema already uses -- so there is
-- exactly one definition of "is this notification's source object
-- still valid", not two definitions (this function's own inline
-- booking-cancelled check vs. the standalone helper) that could
-- silently drift apart over time. This is defense-in-depth alongside
-- (not a replacement for) cancel_pending_whatsapp_for_booking()'s
-- immediate marking at cancellation time -- the sweep here catches any
-- row that slips through that immediate path for any reason.
--
-- Verified live after this fix: the same test row correctly
-- transitioned from 'pending' to 'cancelled' on the next
-- whatsapp_connector_claim_next_batch() call, and was never claimed.

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(
  id uuid,
  club_id uuid,
  recipient_customer_id uuid,
  recipient_phone text,
  template_key text,
  language text,
  variables jsonb,
  attempts int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id);

  return query
    with eligible_accounts as (
      select wa.club_id, mss.max_sends_per_minute_per_account, mss.max_sends_per_hour_per_account, mss.min_minutes_between_recipient_sends
      from public.whatsapp_accounts wa
      join public.messaging_safety_settings mss on mss.club_id = wa.club_id
      where wa.status = 'connected'
        and (wa.circuit_breaker_open_until is null or wa.circuit_breaker_open_until <= now())
    ),
    account_recent_activity as (
      select
        nq.club_id,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 minute') as sent_last_minute,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 hour') as sent_last_hour
      from public.notification_queue nq
      where nq.channel = 'whatsapp' and nq.status in ('processing', 'sent')
      group by nq.club_id
    ),
    accounts_under_rate_cap as (
      select ea.club_id, ea.min_minutes_between_recipient_sends
      from eligible_accounts ea
      left join account_recent_activity ara on ara.club_id = ea.club_id
      where coalesce(ara.sent_last_minute, 0) < ea.max_sends_per_minute_per_account
        and coalesce(ara.sent_last_hour, 0) < ea.max_sends_per_hour_per_account
    ),
    candidates as (
      select nq.id, nq.club_id, nq.recipient_customer_id, nq.scheduled_at, nq.event_id,
             aur.min_minutes_between_recipient_sends
      from public.notification_queue nq
      join accounts_under_rate_cap aur on aur.club_id = nq.club_id
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    filtered as (
      select c.id, c.club_id, c.recipient_customer_id, c.scheduled_at
      from candidates c
      where c.recipient_customer_id is null or not exists (
        select 1 from public.notification_queue nq2
        where nq2.channel = 'whatsapp'
          and nq2.recipient_customer_id = c.recipient_customer_id
          and nq2.status in ('processing', 'sent')
          and nq2.last_attempt_at > now() - make_interval(mins => c.min_minutes_between_recipient_sends)
      )
    ),
    claimed as (
      select f.id
      from filtered f
      join public.notification_queue nq3 on nq3.id = f.id
      order by f.scheduled_at
      limit greatest(p_limit, 0)
      for update of nq3 skip locked
    )
    update public.notification_queue nq
    set status = 'processing',
        last_attempt_at = now(),
        attempts = nq.attempts + 1
    from claimed
    where nq.id = claimed.id
    returning
      nq.id, nq.club_id, nq.recipient_customer_id,
      coalesce(nq.recipient_phone, (select c.normalized_mobile from public.customers c where c.id = nq.recipient_customer_id)),
      nq.template_key, nq.language, nq.variables, nq.attempts;
end;
$$;

revoke execute on function public.whatsapp_connector_claim_next_batch(integer) from public, anon, authenticated;

comment on function public.whatsapp_connector_claim_next_batch(integer) is 'Connector-only (service-role). Marks any whatsapp pending/retrying row whose source object is no longer valid (Part K, via notification_source_still_valid()) as cancelled BEFORE claiming, so such a row is never claimed and never stays silently stuck at pending -- defense-in-depth alongside cancel_pending_whatsapp_for_booking()''s immediate marking at cancel_booking() time. Then claims eligible rows respecting per-account rate limits (Part G) and per-recipient spacing (Part H). FOR UPDATE SKIP LOCKED -- safe under concurrent/restarted connector instances.';
