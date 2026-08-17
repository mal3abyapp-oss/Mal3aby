-- Part K: cancellation suppression. Before a queued WhatsApp
-- notification is actually claimed for sending, revalidate the source
-- object it refers to -- if a booking was cancelled after its
-- confirmation/reminder message was already queued (e.g. queued at
-- t=0, cancelled at t=30s, connector claims at t=45s), the message must
-- never go out. This REPLACES whatsapp_connector_claim_next_batch()
-- again (same signature/contract) to add one more exclusion, on top
-- of the rate/circuit-breaker gates from 20260818050000.
--
-- Scope: only 'booking' is checked for now, since it's the only
-- reference_type any current business RPC emits events for
-- (booking.created/confirmed/cancelled, payment.received/refunded --
-- payments/refunds are themselves terminal facts, not "pending"
-- states that get un-done the way a booking can be cancelled after
-- being queued). Generic enough to extend to other reference_types
-- later (subscriptions, invoices) without another rewrite of the
-- claim function's overall shape.

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
    -- Part K: exclude a candidate whose source booking has since been
    -- cancelled. A row with no event_id, or an event not referencing a
    -- booking, is unaffected (nothing to revalidate).
    not_superseded as (
      select c.*
      from candidates c
      where not exists (
        select 1
        from public.notification_events ne
        join public.bookings b on b.id = ne.reference_id
        where ne.id = c.event_id
          and ne.reference_type = 'booking'
          and b.status = 'cancelled'
      )
    ),
    filtered as (
      select c.id, c.club_id, c.recipient_customer_id, c.scheduled_at
      from not_superseded c
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

comment on function public.whatsapp_connector_claim_next_batch(integer) is 'Parts G/H/K/N: atomically claims up to p_limit eligible whatsapp queue rows, gated by (1) circuit breaker, (2) per-account rate caps, (3) per-recipient spacing floor, (4) Part K source-object revalidation -- a row referencing a since-cancelled booking is never claimed. Superseded rows are simply left pending forever (not marked failed/cancelled) unless/until they hit their own expires_at -- acceptable since they will never again pass this filter while the booking stays cancelled, and the row itself is invisible to normal queue-age diagnostics being counted as failed.';

-- A cancelled booking's still-pending queue rows should also be
-- explicitly marked 'cancelled' (not just silently filtered out of
-- every future claim) so they surface honestly in diagnostics/audit
-- rather than sitting in 'pending' forever looking like a stuck
-- message. cancel_booking() itself (task #93's wiring) already emits
-- booking.cancelled and queues a NEW cancellation notice -- this
-- function additionally marks any OTHER still-pending row tied to the
-- same booking (e.g. a booking-confirmed message that hadn't gone out
-- yet) as cancelled, called from cancel_booking() below.
create or replace function public.cancel_pending_whatsapp_for_booking(p_booking_id uuid)
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with cancelled as (
    update public.notification_queue nq
    set status = 'cancelled'
    from public.notification_events ne
    where nq.event_id = ne.id
      and ne.reference_type = 'booking'
      and ne.reference_id = p_booking_id
      and nq.channel = 'whatsapp'
      and nq.status in ('pending', 'retrying')
    returning nq.id
  )
  select count(*)::integer from cancelled;
$$;

revoke execute on function public.cancel_pending_whatsapp_for_booking(uuid) from public, anon, authenticated;

comment on function public.cancel_pending_whatsapp_for_booking(uuid) is 'Part K: explicitly marks any still-pending/retrying whatsapp queue row tied to this booking as status=cancelled, so a superseded message is honestly visible as cancelled in diagnostics rather than sitting in pending indefinitely. Called from cancel_booking() after it emits its own cancellation notice. Internal-only.';
