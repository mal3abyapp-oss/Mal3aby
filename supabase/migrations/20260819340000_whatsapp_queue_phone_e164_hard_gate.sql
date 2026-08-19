-- WhatsApp hard gate on canonical phone (directive section 17/18/19/20).
--
-- Before this migration, whatsapp_connector_claim_next_batch() resolved
-- the recipient phone as coalesce(recipient_phone, customers.normalized_mobile)
-- -- raw/legacy data, never validated as E.164. This meant an invalid or
-- unparseable phone number would be claimed, sent to the connector, fail
-- at the provider, and get endlessly retried as a generic provider
-- failure (directive section 44: this misclassification hides the real
-- problem from the club owner).
--
-- Fix: resolve strictly from customers.phone_e164 (falling back to
-- recipient_phone only when it is ALREADY E.164-shaped -- directive
-- section 19 lets either snapshot-at-queue-time or resolve-at-send-time
-- be the source of truth; this project already resolves at send time,
-- this migration keeps that but makes phone_e164 the only value used).
-- A row whose resolved phone is missing or not E.164-shaped is never
-- claimed for sending -- it is immediately marked
-- 'suppressed_invalid_recipient' (a new terminal status, not a
-- provider failure) so it never gets pointless retries and WhatsApp
-- Failed Messages can show a distinct, actionable reason.

alter table public.notification_queue
  drop constraint if exists notification_queue_status_check;

alter table public.notification_queue
  add constraint notification_queue_status_check
  check (status = any (array['pending','scheduled','processing','sent','delivered','failed','retrying','cancelled','expired','suppressed_invalid_recipient']));

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(id uuid, club_id uuid, recipient_customer_id uuid, recipient_phone text, template_key text, language text, variables jsonb, attempts integer, media_type text, media_intent text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id, ne.event_type);

  -- Hard gate: suppress (never claim, never retry) any pending/retrying
  -- row whose resolvable phone is missing or not E.164-shaped. This is
  -- the directive's "IF recipient phone_e164 IS NULL OR INVALID THEN
  -- DO NOT QUEUE MESSAGE" rule applied at claim time, since this
  -- project resolves the phone at send time rather than snapshotting
  -- it at enqueue time.
  update public.notification_queue nq
  set status = 'suppressed_invalid_recipient'
  where nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and coalesce(
          case when nq.recipient_phone ~ '^\+[1-9][0-9]{6,14}$' then nq.recipient_phone end,
          (select c.phone_e164 from public.customers c where c.id = nq.recipient_customer_id)
        ) is null;

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
      -- Canonical E.164 only -- never raw normalized_mobile (directive
      -- section 20: the connector must receive canonical input, not
      -- decide country logic itself).
      coalesce(
        case when nq.recipient_phone ~ '^\+[1-9][0-9]{6,14}$' then nq.recipient_phone end,
        (select c.phone_e164 from public.customers c where c.id = nq.recipient_customer_id)
      ),
      nq.template_key, nq.language, nq.variables, nq.attempts,
      nq.media_type, nq.media_intent;
end;
$function$;

-- This RPC is service_role-only (the connector authenticates with the
-- service key, never a user session) -- matches the pre-existing
-- grant, not widened by this migration.
revoke all on function public.whatsapp_connector_claim_next_batch(integer) from public;
revoke all on function public.whatsapp_connector_claim_next_batch(integer) from anon;
revoke all on function public.whatsapp_connector_claim_next_batch(integer) from authenticated;
