-- Ban-protection hardening follow-up fix (2026-09-12, same day, independent
-- security review of the PR that introduced 20260912100000): the warm-up
-- multiplier was correctly applied to every OTHER cap in both claim
-- functions (per-minute, per-hour, per-day-per-account) but was left off
-- the per-recipient DAILY cap on both domains -- contradicting this
-- feature's own stated purpose and its own migration's doc comment
-- ("applied to every cap below" / "applied to every per-minute/per-hour/
-- per-day cap"). Concrete gap this closes: a freshly (re)connected account,
-- on day zero of warm-up, could still send up to the FULL per-recipient
-- daily cap (3 tenant-side default, 1 platform-side default) to a single
-- recipient -- the one rate dimension the "gentle ramp" wasn't gentling.
--
-- Fix: apply the same greatest(1, round(cap * warm_up_multiplier)) shape
-- already used for every sibling cap to the per-recipient daily count
-- comparison too. Everything else in both function bodies is byte-for-
-- byte unchanged from the live production definition (confirmed via
-- pg_get_functiondef before writing this migration, per this project's
-- own established practice for touching a function whose live body may
-- have drifted from its tracked migration text).

drop function if exists public.whatsapp_connector_claim_next_batch(integer);
create function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(id uuid, club_id uuid, recipient_customer_id uuid, recipient_phone text, template_key text, language text, variables jsonb, attempts integer, media_type text, media_intent text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  -- Everything below this point, up to the "return query" -- the
  -- cancellation-marking pass, the recipient-phone-shape guard, and
  -- the consent re-check -- is byte-for-byte unchanged from
  -- 20260821123500_whatsapp_consent_identity_queue_snapshot.sql, the
  -- authoritative pre-this-migration definition. This migration only
  -- widens the "return query" CTE chain below with restriction-signal/
  -- daily-cap/warm-up gates -- nothing above this comment was touched.
  update public.notification_queue nq
  set status = 'cancelled'
  from public.notification_events ne
  where nq.event_id = ne.id
    and nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and not public.notification_source_still_valid(ne.reference_type, ne.reference_id, ne.event_type);

  update public.notification_queue nq
  set status = 'suppressed_invalid_recipient',
      last_error = 'Recipient phone is missing or is not canonical E.164'
  where nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and (nq.recipient_phone is null or nq.recipient_phone !~ '^\+[1-9][0-9]{6,14}$');

  -- Re-check consent immediately before claim. This covers revocation and
  -- phone changes that occur after enqueue. Both are terminal for the old
  -- queue item; a future business event may enqueue after fresh consent.
  update public.notification_queue nq
  set status = 'suppressed_no_consent',
      last_error = 'Consent is absent, revoked, or belongs to a different phone identity'
  where nq.channel = 'whatsapp'
    and nq.status in ('pending', 'retrying')
    and nq.recipient_phone ~ '^\+[1-9][0-9]{6,14}$'
    and not exists (
      select 1
      from public.customers c
      join public.notification_consent nc
        on nc.club_id = c.club_id
       and nc.customer_id = c.id
       and nc.channel = 'whatsapp'
       and nc.enabled = true
       and nc.revoked_at is null
       and nc.phone_e164 = nq.recipient_phone
      where c.id = nq.recipient_customer_id
        and c.club_id = nq.club_id
        and c.phone_e164 = nq.recipient_phone
        and c.duplicate_review_status = 'none'
    );

  return query
    with eligible_accounts as (
      -- Part N (existing) + ban-protection hardening: an account with an
      -- open circuit breaker OR a detected restriction signal is skipped
      -- entirely -- its queue rows stay pending/retrying, never
      -- touched, never marked failed. warm_up_multiplier is computed
      -- once per account here, applied to every cap below (2026-09-12
      -- fix: including the per-recipient daily cap, previously missed).
      select
        wa.club_id,
        mss.max_sends_per_minute_per_account,
        mss.max_sends_per_hour_per_account,
        mss.max_sends_per_day_per_account,
        mss.min_minutes_between_recipient_sends,
        mss.max_sends_per_day_per_recipient,
        public.whatsapp_warm_up_multiplier(wa.connected_at, mss.warm_up_enabled, mss.warm_up_days, mss.warm_up_rate_multiplier) as warm_up_multiplier
      from public.whatsapp_accounts wa
      join public.messaging_safety_settings mss on mss.club_id = wa.club_id
      where wa.status = 'connected'
        and (wa.circuit_breaker_open_until is null or wa.circuit_breaker_open_until <= now())
        and wa.restriction_signal_detected_at is null
    ),
    -- Part G (existing) + ban-protection hardening's daily window.
    account_recent_activity as (
      select
        nq.club_id,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 minute') as sent_last_minute,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 hour') as sent_last_hour,
        count(*) filter (where nq.last_attempt_at > now() - interval '1 day') as sent_last_day
      from public.notification_queue nq
      where nq.channel = 'whatsapp' and nq.status in ('processing', 'sent')
      group by nq.club_id
    ),
    accounts_under_rate_cap as (
      select
        ea.club_id, ea.min_minutes_between_recipient_sends, ea.max_sends_per_day_per_recipient,
        ea.warm_up_multiplier
      from eligible_accounts ea
      left join account_recent_activity ara on ara.club_id = ea.club_id
      where coalesce(ara.sent_last_minute, 0) < greatest(1, round(ea.max_sends_per_minute_per_account * ea.warm_up_multiplier))
        and coalesce(ara.sent_last_hour, 0) < greatest(1, round(ea.max_sends_per_hour_per_account * ea.warm_up_multiplier))
        and coalesce(ara.sent_last_day, 0) < greatest(1, round(ea.max_sends_per_day_per_account * ea.warm_up_multiplier))
    ),
    candidates as (
      select nq.id, nq.club_id, nq.recipient_customer_id, nq.scheduled_at,
             aur.min_minutes_between_recipient_sends, aur.max_sends_per_day_per_recipient,
             aur.warm_up_multiplier
      from public.notification_queue nq
      join accounts_under_rate_cap aur on aur.club_id = nq.club_id
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    -- Part H (existing) + ban-protection hardening's daily-per-recipient
    -- cap -- 2026-09-12 fix: now also warm-up-scaled, matching every
    -- sibling cap above instead of being the one exception.
    filtered as (
      select c.id, c.scheduled_at
      from candidates c
      where c.recipient_customer_id is null or (
        not exists (
          select 1 from public.notification_queue nq2
          where nq2.channel = 'whatsapp'
            and nq2.recipient_customer_id = c.recipient_customer_id
            and nq2.status in ('processing', 'sent')
            and nq2.last_attempt_at > now() - make_interval(mins => c.min_minutes_between_recipient_sends)
        )
        and (
          select count(*) from public.notification_queue nq4
          where nq4.channel = 'whatsapp'
            and nq4.recipient_customer_id = c.recipient_customer_id
            and nq4.status in ('processing', 'sent')
            and nq4.last_attempt_at > now() - interval '1 day'
        ) < greatest(1, round(c.max_sends_per_day_per_recipient * c.warm_up_multiplier))
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
    returning nq.id, nq.club_id, nq.recipient_customer_id, nq.recipient_phone,
      nq.template_key, nq.language, nq.variables, nq.attempts,
      nq.media_type, nq.media_intent;
end;
$function$;

revoke all on function public.whatsapp_connector_claim_next_batch(integer) from public, anon, authenticated;

comment on function public.whatsapp_connector_claim_next_batch(integer) is 'Parts G/H/N (existing) + ban-protection hardening (2026-09-12, warm-up-per-recipient-cap fix same day): gated by (4) a detected WhatsApp-side restriction signal (status=''restricted'' accounts are excluded, same as an open circuit breaker), (5) per-account AND per-recipient DAILY caps, (6) a warm-up multiplier that shrinks EVERY rate cap -- per-minute, per-hour, per-day-per-account, AND per-day-per-recipient -- for the first warm_up_days after connecting. A row that does not clear any gate is simply left pending/retrying for a later poll tick -- never marked failed or dropped.';

-- Platform domain: same fix, same discipline.
drop function if exists public.whatsapp_connector_claim_next_platform_batch(integer);
create function public.whatsapp_connector_claim_next_platform_batch(p_limit integer default 10)
returns table(id uuid, recipient_phone text, message_body text, attempts integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Expire anything past its own expiry before claiming, matching
  -- whatsapp_connector_expire_stale()'s own per-club convention.
  update public.platform_whatsapp_queue
  set status = 'expired'
  where status in ('pending', 'retrying') and expires_at is not null and expires_at <= now();

  return query
    with breaker as (
      select
        (pa.circuit_breaker_open_until is null or pa.circuit_breaker_open_until <= now()) as is_open,
        pa.status = 'connected' as is_connected,
        pa.restriction_signal_detected_at is null as no_restriction_signal,
        public.whatsapp_warm_up_multiplier(pa.connected_at, s.warm_up_enabled, s.warm_up_days, s.warm_up_rate_multiplier) as warm_up_multiplier
      from public.platform_whatsapp_account pa, public.platform_whatsapp_safety_settings s
    ),
    recent_activity as (
      select
        count(*) filter (where last_attempt_at > now() - interval '1 minute') as sent_last_minute,
        count(*) filter (where last_attempt_at > now() - interval '1 hour') as sent_last_hour,
        count(*) filter (where last_attempt_at > now() - interval '1 day') as sent_last_day
      from public.platform_whatsapp_queue
      where status in ('processing', 'sent')
    ),
    settings as (select * from public.platform_whatsapp_safety_settings),
    candidates as (
      select q.id, q.scheduled_at, q.recipient_phone
      from public.platform_whatsapp_queue q, breaker b, recent_activity ra, settings s
      where b.is_open and b.is_connected and b.no_restriction_signal
        and q.status in ('pending', 'retrying')
        and q.scheduled_at <= now()
        and (q.next_attempt_at is null or q.next_attempt_at <= now())
        and coalesce(ra.sent_last_minute, 0) < greatest(1, round(s.max_sends_per_minute * b.warm_up_multiplier))
        and coalesce(ra.sent_last_hour, 0) < greatest(1, round(s.max_sends_per_hour * b.warm_up_multiplier))
        and coalesce(ra.sent_last_day, 0) < greatest(1, round(s.max_sends_per_day * b.warm_up_multiplier))
        and not exists (
          select 1 from public.platform_whatsapp_queue q2
          where q2.recipient_phone = q.recipient_phone
            and q2.status in ('processing', 'sent')
            and q2.last_attempt_at > now() - make_interval(mins => s.min_minutes_between_recipient_sends)
        )
        and (
          select count(*) from public.platform_whatsapp_queue q3
          where q3.recipient_phone = q.recipient_phone
            and q3.status in ('processing', 'sent')
            and q3.last_attempt_at > now() - interval '1 day'
        ) < greatest(1, round(s.max_sends_per_day_per_recipient * b.warm_up_multiplier))
    ),
    claimed as (
      select c.id from candidates c
      join public.platform_whatsapp_queue q3 on q3.id = c.id
      order by c.scheduled_at
      limit greatest(p_limit, 0)
      for update of q3 skip locked
    )
    update public.platform_whatsapp_queue q
    set status = 'processing', last_attempt_at = now(), attempts = q.attempts + 1
    from claimed
    where q.id = claimed.id
    returning q.id, q.recipient_phone, q.message_body, q.attempts;
end;
$$;

revoke all on function public.whatsapp_connector_claim_next_platform_batch(integer) from public, anon, authenticated;

comment on function public.whatsapp_connector_claim_next_platform_batch(integer) is 'Same widening as whatsapp_connector_claim_next_batch, platform domain (2026-09-12, warm-up-per-recipient-cap fix same day): now also gated by a detected restriction signal, per-account daily cap, and a warm-up multiplier applied to EVERY rate cap including per-day-per-recipient.';
