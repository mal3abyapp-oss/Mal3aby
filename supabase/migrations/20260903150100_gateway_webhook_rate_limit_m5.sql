-- M-5: no rate limiting on the 15 payment gateway Edge Functions
-- (Stripe/PayPal/Paymob/Kashier/Fawry -- webhook receiver + create-
-- checkout-session + create-refund, per provider). This migration adds
-- a lightweight, DB-backed sliding-window rate limiter for the 5
-- INBOUND webhook RECEIVERS ONLY (the higher-risk abuse surface -- see
-- this session's report for why outbound calls are deferred).
--
-- PATTERN MIRRORED from messaging_safety_settings' circuit-breaker
-- design (20260817044244_safe_messaging_rate_control_circuit_breaker.sql):
-- a small state table + a SECURITY DEFINER RPC that does the
-- check-and-increment atomically, called once at the very top of each
-- webhook handler, before any signature verification or candidate
-- resolution work.
--
-- MONEY-SAFETY DISCIPLINE (per the master directive): this is
-- ABUSE/LOAD protection only, layered ON TOP of, never INSTEAD OF, the
-- existing idempotency guarantees (payment_gateway_webhook_events'
-- unique index on (provider_key, provider_event_id) / payload_hash,
-- untouched by this migration). Specifically:
--   1. The limiter is keyed PER PROVIDER (provider_key), not per
--      request/signature -- a request is never accepted or rejected
--      based on whether its signature is valid, because validity isn't
--      known yet at the point the limiter runs (verification is
--      expensive -- vault reads, HMAC compute -- and happens AFTER).
--      This bounds worst-case DB/compute load from a flood of forged
--      requests without ever discriminating against genuine ones by
--      content.
--   2. On limit exceeded, the function returns HTTP 429 with a
--      Retry-After header -- NEVER a silent drop, NEVER a 2xx. Stripe,
--      PayPal, Paymob, Kashier and Fawry all retry failed webhook
--      deliveries on non-2xx responses (documented per-provider retry
--      policies), so a genuine event that is momentarily rate-limited
--      is retried later and still lands -- it is never permanently
--      lost.
--   3. The window is generous (see per-provider defaults below) --
--      sized for "abusive flood", not "a normal retry burst from a
--      provider having a bad day". A legitimate provider's own retry
--      cadence (minutes-to-hours between attempts, per their docs)
--      never comes close to tripping this.
--   4. Threshold is per-provider (not per-club/per-connection) so this
--      migration adds ONE cheap table read+upsert per webhook request,
--      not a query keyed on data we haven't resolved yet (club/
--      connection resolution is itself the expensive part these
--      functions do AFTER signature verification).
create table public.gateway_webhook_rate_limit_state (
  provider_key text primary key references public.payment_gateway_providers(key),
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);

alter table public.gateway_webhook_rate_limit_state enable row level security;
alter table public.gateway_webhook_rate_limit_state force row level security;

-- No client access at all -- this table is purely internal counter
-- state written by the service-role RPC below, never read or written
-- directly by any client role.
revoke all on public.gateway_webhook_rate_limit_state from public, anon, authenticated;

-- Seed one row per existing provider so the RPC's UPDATE path is
-- always the common case (no INSERT race on first request after
-- deploy). New providers added later get a row via the RPC's own
-- ON CONFLICT DO NOTHING fallback insert.
insert into public.gateway_webhook_rate_limit_state (provider_key)
select key from public.payment_gateway_providers
on conflict (provider_key) do nothing;

-- Atomic check-and-increment sliding window (fixed-window, reset on
-- expiry -- simpler than a true sliding log and sufficient for coarse
-- abuse protection; a fixed window can admit at most 2x the configured
-- rate across a window boundary, which is an acceptable trade-off for
-- load protection, not a security boundary).
--
-- p_max_requests / p_window_seconds are passed by the caller (rather
-- than hardcoded) so each of the 5 webhook functions can tune its own
-- threshold without a migration change -- see the per-function call
-- sites for the actual defaults chosen (generous multiples of each
-- provider's documented normal traffic).
create or replace function public.check_gateway_webhook_rate_limit(
  p_provider_key text,
  p_max_requests integer default 120,
  p_window_seconds integer default 60
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_window_elapsed numeric;
begin
  -- Ensure a row exists for this provider even if the seed above
  -- predates a provider added later.
  insert into public.gateway_webhook_rate_limit_state (provider_key)
  values (p_provider_key)
  on conflict (provider_key) do nothing;

  select * into v_row
  from public.gateway_webhook_rate_limit_state
  where provider_key = p_provider_key
  for update;

  v_window_elapsed := extract(epoch from (now() - v_row.window_started_at));

  if v_window_elapsed >= p_window_seconds then
    -- Window expired -- reset and admit this request as the first of a
    -- fresh window.
    update public.gateway_webhook_rate_limit_state
    set window_started_at = now(), request_count = 1
    where provider_key = p_provider_key;
    return query select true, 0;
  end if;

  if v_row.request_count < p_max_requests then
    update public.gateway_webhook_rate_limit_state
    set request_count = v_row.request_count + 1
    where provider_key = p_provider_key;
    return query select true, 0;
  end if;

  -- Over the limit for the remainder of this window -- tell the caller
  -- exactly how long until the window resets so it can set a real
  -- Retry-After header (never a made-up constant).
  return query select false, greatest(1, ceil(p_window_seconds - v_window_elapsed)::integer);
end;
$$;

revoke all on function public.check_gateway_webhook_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_gateway_webhook_rate_limit(text, integer, integer) to service_role;

comment on function public.check_gateway_webhook_rate_limit(text, integer, integer) is
  'M-5: coarse per-provider fixed-window rate limiter for the 5 gateway webhook receivers, called BEFORE signature verification so cost is bounded regardless of request validity. Never used to reject a validly-signed request permanently -- callers must respond 429+Retry-After (which every one of the 5 providers retries), never drop silently. Abuse/load protection layered on top of the existing (provider_key, provider_event_id)/payload_hash idempotency unique index on payment_gateway_webhook_events, which remains the sole source of truth for exactly-once payment processing.';

comment on table public.gateway_webhook_rate_limit_state is
  'M-5: internal counter state for check_gateway_webhook_rate_limit(). One row per provider_key (global across all clubs/connections for that gateway) -- service-role/RPC access only, never exposed to any client role.';
