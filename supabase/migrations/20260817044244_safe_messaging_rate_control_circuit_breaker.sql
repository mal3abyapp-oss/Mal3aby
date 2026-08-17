-- Fix + extend: the previous migration's whatsapp_accounts_status_check
-- widening (20260818030000) dropped the pre-existing 'error' value
-- instead of keeping it alongside the new Part M states -- a real bug,
-- found before it caused a live failure: BaileysProvider.ts,
-- SupabaseSync.ts, WhatsAppProvider.ts, and WhatsAppConnectionCard.tsx
-- all actively use 'error' as a real status (the "5 reconnect attempts
-- then give up" terminal state). whatsapp_connector_report_status()'s
-- own hardcoded validation list also still only had the original 7
-- values, so it would have raised 'invalid status' the moment the
-- connector tried to report 'degraded'/'restricted'/'failed'. Fixed
-- here, additively, before either gap could cause a real regression --
-- per the resume directive's instruction not to touch already-verified
-- pairing/session code, this restores exactly the prior working
-- behavior and only adds the new states on top.

alter table public.whatsapp_accounts drop constraint if exists whatsapp_accounts_status_check;
alter table public.whatsapp_accounts add constraint whatsapp_accounts_status_check
  check (status in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'degraded', 'logged_out', 'restricted', 'failed', 'error'
  ));

create or replace function public.whatsapp_connector_report_status(
  p_club_id uuid,
  p_status text,
  p_qr_payload text default null,
  p_qr_ttl_seconds integer default null,
  p_connected_phone_number text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'degraded', 'logged_out', 'restricted', 'failed', 'error'
  ) then
    raise exception 'invalid status';
  end if;

  update public.whatsapp_accounts
  set status = p_status,
      qr_payload = case when p_status = 'qr_required' then p_qr_payload else null end,
      qr_expires_at = case when p_status = 'qr_required' and p_qr_ttl_seconds is not null then now() + make_interval(secs => p_qr_ttl_seconds) else null end,
      connected_phone_number = case when p_status = 'connected' then coalesce(p_connected_phone_number, connected_phone_number) when p_status in ('disconnected', 'logged_out') then null else connected_phone_number end,
      connected_at = case when p_status = 'connected' and connected_at is null then now() when p_status in ('disconnected', 'logged_out') then null else connected_at end,
      last_seen_at = case when p_status = 'connected' then now() else last_seen_at end,
      last_error = p_error,
      updated_at = now()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'status_' || p_status, null, jsonb_build_object('error', p_error));
end;
$$;

revoke execute on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text) from public, anon, authenticated;

comment on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text) is 'Connector-only (service-role). Validation list includes both the original 7 states and the Part M additions (degraded/restricted/failed) plus the pre-existing error state -- all 10 are valid so the connector''s own existing error-state reporting (BaileysProvider.ts) keeps working unchanged.';

-- ============================================================
-- Parts G/H/N: claim_next_batch REPLACED to add rate control,
-- recipient frequency cap, and circuit-breaker awareness. Same
-- signature/return contract -- the connector's SupabaseSync.ts calling
-- code needs no changes.
-- ============================================================
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
      -- Part N: an account with an open circuit breaker is skipped
      -- entirely -- its queue rows stay pending/retrying (never
      -- touched, never marked failed just because the breaker is
      -- open) until the breaker's cooldown elapses.
      select wa.club_id, mss.max_sends_per_minute_per_account, mss.max_sends_per_hour_per_account, mss.min_minutes_between_recipient_sends
      from public.whatsapp_accounts wa
      join public.messaging_safety_settings mss on mss.club_id = wa.club_id
      where wa.status = 'connected'
        and (wa.circuit_breaker_open_until is null or wa.circuit_breaker_open_until <= now())
    ),
    -- Part G: per-account rate window counts (sent/processing in the
    -- last minute / last hour), computed once per claim call rather
    -- than per candidate row.
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
      select nq.id, nq.club_id, nq.recipient_customer_id, nq.scheduled_at,
             aur.min_minutes_between_recipient_sends
      from public.notification_queue nq
      join accounts_under_rate_cap aur on aur.club_id = nq.club_id
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    -- Part H: recipient frequency floor -- exclude a candidate if the
    -- same recipient (customer) already has a whatsapp message sent/
    -- processing more recently than min_minutes_between_recipient_sends
    -- ago, regardless of category. This is a backstop, not the
    -- per-event dedup guarantee (that's dedup_key, already enforced at
    -- insert time).
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

comment on function public.whatsapp_connector_claim_next_batch(integer) is 'Parts G/H/N: atomically claims up to p_limit eligible whatsapp queue rows, now gated by (1) circuit breaker open/closed per account, (2) per-account per-minute/per-hour send-rate caps from messaging_safety_settings, (3) per-recipient minimum spacing floor. A row that does not clear these gates is simply left pending/retrying for a later poll tick -- never marked failed or dropped for a rate/breaker reason.';

-- ============================================================
-- Part N: circuit breaker evaluation, folded into report_send_result
-- so every send outcome updates both the queue row (existing
-- behavior, unchanged) AND the account's rolling failure-rate state.
-- REPLACED, same signature/contract.
-- ============================================================
create or replace function public.whatsapp_connector_report_send_result(
  p_queue_id uuid,
  p_success boolean,
  p_provider_reference text default null,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts int;
  v_max_attempts constant int := 5;
  v_backoff_minutes int;
  v_club_id uuid;
  v_settings record;
  v_window_start timestamptz;
  v_total int;
  v_failed int;
  v_failure_rate numeric;
begin
  select club_id into v_club_id from public.notification_queue where id = p_queue_id;
  if v_club_id is null then
    return; -- unknown row -- nothing to do, never raise on a stale/foreign id
  end if;

  if p_success then
    update public.notification_queue
    set status = 'sent',
        provider_reference = p_provider_reference,
        last_error = null
    where id = p_queue_id;

    update public.whatsapp_accounts
    set last_successful_send_at = now()
    where club_id = v_club_id;
  else
    select attempts into v_attempts from public.notification_queue where id = p_queue_id;

    if v_attempts >= v_max_attempts then
      update public.notification_queue
      set status = 'failed', last_error = p_error
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

  -- Part N: circuit breaker evaluation -- a failure RATE over a
  -- rolling window (min_sample_size guards against tripping on 1
  -- failure out of 1 attempt on a quiet night), not a raw failure
  -- count. Only evaluated on this account's own recent activity, never
  -- across tenants.
  select circuit_breaker_enabled, circuit_breaker_failure_rate_threshold,
         circuit_breaker_min_sample_size, circuit_breaker_window_minutes,
         circuit_breaker_cooldown_minutes
  into v_settings
  from public.messaging_safety_settings
  where club_id = v_club_id;

  if v_settings is not null and v_settings.circuit_breaker_enabled then
    v_window_start := now() - make_interval(mins => v_settings.circuit_breaker_window_minutes);

    select count(*), count(*) filter (where status = 'failed' and last_attempt_at > v_window_start)
    into v_total, v_failed
    from public.notification_queue
    where channel = 'whatsapp'
      and club_id = v_club_id
      and last_attempt_at > v_window_start
      and status in ('sent', 'failed');

    if v_total >= v_settings.circuit_breaker_min_sample_size then
      v_failure_rate := v_failed::numeric / v_total::numeric;
      if v_failure_rate >= v_settings.circuit_breaker_failure_rate_threshold then
        update public.whatsapp_accounts
        set circuit_breaker_open_until = now() + make_interval(mins => v_settings.circuit_breaker_cooldown_minutes),
            circuit_breaker_reason = format(
              'failure rate %s%% over last %s minute(s), %s of %s sends failed',
              round(v_failure_rate * 100), v_settings.circuit_breaker_window_minutes, v_failed, v_total
            )
        where club_id = v_club_id
          -- Don't repeatedly extend an already-open breaker on every
          -- single failure -- only (re)trip it if it isn't already
          -- open, so the cooldown timer means what it says.
          and (circuit_breaker_open_until is null or circuit_breaker_open_until <= now());

        insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
        select v_club_id, 'circuit_breaker_opened', null,
               jsonb_build_object('failure_rate', v_failure_rate, 'failed', v_failed, 'total', v_total)
        where exists (
          select 1 from public.whatsapp_accounts
          where club_id = v_club_id and circuit_breaker_open_until > now()
        );
      end if;
    end if;
  end if;
end;
$$;

revoke execute on function public.whatsapp_connector_report_send_result(uuid, boolean, text, text) from public, anon, authenticated;

comment on function public.whatsapp_connector_report_send_result(uuid, boolean, text, text) is 'Success -> sent (terminal), records last_successful_send_at. Failure -> retrying with capped backoff up to 5 attempts, then failed (terminal). Also evaluates Part N''s circuit breaker: if this account''s failure rate over the configured rolling window meets/exceeds the threshold (with a minimum sample size so a single early failure never trips it), opens the breaker for a cooldown period and records why in whatsapp_connection_events -- never an infinite retry storm, never silently blind to a failure spike.';
