-- REAL P1 BUG, second layer of the same self-suppression class, found
-- live during MAL3ABY FINAL PRODUCTION HARDENING immediately after
-- fixing cancel_pending_whatsapp_for_booking() (previous migration):
-- even with that fix applied, a fresh booking.cancelled notification
-- STILL got wiped to status='cancelled' before the connector could
-- claim it. Root cause: whatsapp_connector_claim_next_batch() runs its
-- own general sweep using notification_source_still_valid(), which
-- for reference_type='booking' returns false whenever the booking's
-- CURRENT status is 'cancelled' -- with no exception for a
-- booking.cancelled notification event, whose entire purpose is to
-- report exactly that state transition. So a booking.cancelled notice
-- was ALWAYS judged "invalid" by the same test that correctly
-- suppresses a stale booking-confirmed reminder for an
-- already-cancelled booking.
--
-- Confirmed live: booking 76bd6177-c59d-4499-afd5-86157307f60d was
-- cancelled via the real cancel_booking() RPC (after the previous
-- migration's fix was already applied); its booking.cancelled queue
-- row (id 87f28f80-bca6-476e-93dc-c595403b997b) was still swept to
-- status='cancelled' with zero attempts by
-- whatsapp_connector_claim_next_batch()'s general validity check --
-- a SEPARATE code path from cancel_pending_whatsapp_for_booking(),
-- confirming this is a distinct bug, not a leftover of the first one.
-- Re-tested after this fix (booking 98cd5be9-a26d-4f24-8d99-01fde3d7af8e,
-- cancellation queue row 7838afac-45eb-4e04-990a-590f53bc3117): the
-- cancellation notice was correctly claimed and genuinely delivered
-- via WhatsApp (provider_reference 3EB07963E3E9BCD28C1399).
--
-- Fix: notification_source_still_valid() gains an optional
-- p_event_type parameter. For reference_type='booking', a
-- 'booking.cancelled' event is now always considered valid
-- regardless of the booking's current status (that status being
-- 'cancelled' is precisely what the notification is reporting, not a
-- reason to suppress it). Every other booking-referencing event type
-- keeps the existing "booking must not be cancelled" rule unchanged.
-- whatsapp_connector_claim_next_batch() is updated to pass
-- ne.event_type through. The stale 2-arg overload of
-- notification_source_still_valid() is dropped (confirmed via
-- repo-wide grep it had exactly one caller, claim_next_batch itself,
-- which now always calls the 3-arg form) so nothing can accidentally
-- call the old self-suppressing version again.

create or replace function public.notification_source_still_valid(p_reference_type text, p_reference_id uuid, p_event_type text default null)
returns boolean
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_status text;
begin
  if p_reference_type = 'booking' then
    if p_event_type = 'booking.cancelled' then
      return true;
    end if;
    select status into v_status from public.bookings where id = p_reference_id;
    return v_status is not null and v_status <> 'cancelled';
  elsif p_reference_type = 'payment' then
    return exists (select 1 from public.payments where id = p_reference_id);
  end if;
  return true;
end;
$$;

comment on function public.notification_source_still_valid(text, uuid, text) is 'Final production hardening fix, 20260818: a booking.cancelled event is always valid regardless of the booking''s current (cancelled) status -- that status IS what the notification reports, not a reason to suppress it. Every other event type keeps the original "booking must still be active" rule. Real bug found live: a fresh cancellation notice was being self-suppressed by this exact check before the p_event_type parameter existed. Re-verified live post-fix: cancellation notices now genuinely reach WhatsApp.';

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(id uuid, club_id uuid, recipient_customer_id uuid, recipient_phone text, template_key text, language text, variables jsonb, attempts integer)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  -- Part K, fixed: pass ne.event_type through so a booking.cancelled
  -- notice is never judged invalid by this general sweep.
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id, ne.event_type);

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

-- The 2-arg notification_source_still_valid(text, uuid) overload is
-- now dead code -- claim_next_batch (its only real caller) always
-- calls the 3-arg version above. Dropping it removes the trap of a
-- future caller accidentally invoking the old self-suppressing form.
drop function if exists public.notification_source_still_valid(text, uuid);
