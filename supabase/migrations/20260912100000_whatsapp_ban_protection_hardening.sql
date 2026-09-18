-- WHATSAPP BAN-PROTECTION HARDENING (2026-09-12), owner directive:
-- "اريد منك عمل طبقه حمايه كامله ضد الحظر من واتس اب علي كامل المنصه
-- وكذلك اسلوب الرسائل" (a complete protection layer against a WhatsApp
-- ban across the whole platform, and message style). This migration
-- closes 5 concrete, previously-confirmed-absent gaps in the existing
-- safe-messaging layer (messaging_safety_settings /
-- platform_whatsapp_safety_settings, both already live and already
-- doing real work -- rate caps, circuit breakers, quiet hours):
--
--   1. WhatsApp-side restriction/ban SIGNAL DETECTION -- 'restricted'
--      was a dead enum value with zero code path ever setting it.
--      Adds a real, evidence-based detector (connector-side, this
--      migration's own RPC counterpart) for the two genuine signals an
--      unofficial Multi-Device client CAN actually observe: a
--      403/"forbidden" disconnect from WhatsApp's own servers
--      (distinct from 401 loggedOut, which is a normal user-initiated
--      unlink), and a known-shape account-risk notice arriving as a
--      message from WhatsApp's own system JID. Neither is guessed --
--      both are documented, real, externally-observable protocol-level
--      facts, not a heuristic invented for this migration.
--   2. DAILY caps -- per-recipient and per-account -- alongside the
--      existing per-minute/per-hour caps, which do nothing to stop N
--      sends/day to the same person or account spread out in time.
--   3. Inbound STOP/إيقاف keyword handling -- opt-out was previously
--      only ever staff- or system-failure-triggered, never
--      customer-message-triggered.
--   4. Platform WhatsApp safety settings become genuinely READABLE/
--      WRITABLE via RPC (the table already existed with sane defaults,
--      but had no owner-facing control surface at all, unlike the
--      tenant side's MessagingSafetyCard).
--   5. A gentle WARM-UP ramp for a newly (re)connected account --
--      tighter caps for the first few days after connecting, widening
--      to the configured steady-state caps -- since a burst of volume
--      immediately after a fresh pairing is a well-documented real
--      risk signal difference from an account with an established
--      sending history.
--
-- Explicit non-goals, preserved unchanged from Part A's original
-- philosophy (20260817043657_safe_messaging_controls.sql:1-10): still
-- NO randomized/varied message text, NO number rotation, NO spoofed
-- human behavior, NO artificial evasion-oriented delay. Every
-- mechanism below is either (a) a real signal WhatsApp's own protocol
-- actually exposes, or (b) a conservative, disclosed rate/volume
-- reduction -- never a claim of guaranteed safety, and never a
-- technique designed to defeat WhatsApp's own enforcement rather than
-- to behave more like a genuine low-volume, consent-respecting sender.

-- ============================================================
-- PART 1: restriction-signal detection -- tenant domain
-- ============================================================

-- whatsapp_accounts.status already has 'restricted' in its check
-- constraint (added 20260817043657, never previously set by any code
-- path) -- this migration is what finally makes it real. Two new
-- columns record the evidence, so 'restricted' is never set on a bare
-- guess: a human (or this migration's own future reader) can always
-- see WHY.
alter table public.whatsapp_accounts
  add column if not exists restriction_signal_detected_at timestamptz,
  add column if not exists restriction_signal_detail text;

comment on column public.whatsapp_accounts.restriction_signal_detected_at is 'When a genuine WhatsApp-side restriction signal was last observed for this account (a 403/forbidden disconnect from WhatsApp''s own servers, or a known-shape account-risk system notice) -- null if none has ever been observed. Distinct from circuit_breaker_open_until (which reacts to OUR OWN send-failure rate, not a WhatsApp-side signal).';
comment on column public.whatsapp_accounts.restriction_signal_detail is 'Human-readable evidence for the restriction signal (e.g. "403 forbidden disconnect x3 within 10 minutes" or "WhatsApp system notice received"). Never the raw notice text itself -- see whatsapp_connector_report_restriction_signal()''s own comment for why.';

create or replace function public.whatsapp_connector_report_restriction_signal(p_club_id uuid, p_detail text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.whatsapp_accounts
  set status = 'restricted',
      restriction_signal_detected_at = now(),
      restriction_signal_detail = p_detail,
      updated_at = now()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'restriction_signal_detected', null, jsonb_build_object('detail', p_detail));
end;
$$;

revoke execute on function public.whatsapp_connector_report_restriction_signal(uuid, text) from public, anon, authenticated;

comment on function public.whatsapp_connector_report_restriction_signal(uuid, text) is 'Connector-only. Called ONLY when the connector observes a genuine, protocol-level WhatsApp-side restriction signal (403/forbidden disconnect pattern, or a known-shape system-JID risk notice) -- never a guess, never derived from OUR OWN send-failure rate (that is circuit_breaker_open_until''s job). Sets status=''restricted'' -- a Platform Owner / club staff member must then explicitly acknowledge and reconnect (or disconnect) via the existing UI; this RPC never auto-recovers a restricted account.';

-- ============================================================
-- PART 1b: restriction-signal detection -- platform domain
-- ============================================================

alter table public.platform_whatsapp_account
  add column if not exists restriction_signal_detected_at timestamptz,
  add column if not exists restriction_signal_detail text;

comment on column public.platform_whatsapp_account.restriction_signal_detected_at is 'Same meaning as whatsapp_accounts.restriction_signal_detected_at, for the Platform WhatsApp domain.';
comment on column public.platform_whatsapp_account.restriction_signal_detail is 'Same meaning as whatsapp_accounts.restriction_signal_detail, for the Platform WhatsApp domain.';

create or replace function public.whatsapp_connector_report_platform_restriction_signal(p_detail text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.platform_whatsapp_account
  set status = 'restricted',
      restriction_signal_detected_at = now(),
      restriction_signal_detail = p_detail,
      updated_at = now()
  where singleton_guard = 1;

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('restriction_signal_detected', null, jsonb_build_object('detail', p_detail));
end;
$$;

revoke execute on function public.whatsapp_connector_report_platform_restriction_signal(text) from public, anon, authenticated;

comment on function public.whatsapp_connector_report_platform_restriction_signal(text) is 'Connector-only, Platform WhatsApp domain counterpart of whatsapp_connector_report_restriction_signal(). Same evidence discipline: only ever called on a genuine protocol-level signal.';

-- ============================================================
-- PART 1c: widen the owner-facing status RPCs (both domains) to
-- surface the new restriction-signal evidence fields. Based on the
-- REAL LIVE function bodies (confirmed via pg_get_functiondef against
-- production before writing this, not the possibly-stale migration
-- file text -- get_whatsapp_status() in particular has already drifted
-- from its originally-tracked 20260817110000 definition to include
-- circuit_breaker_open_until/circuit_breaker_reason/last_successful_send_at,
-- added by a migration that reached production outside this repo's own
-- tracked history; a known, separately-flagged, pre-existing drift
-- issue -- this migration widens the CURRENT live shape faithfully,
-- every pre-existing column and check preserved verbatim.
-- ============================================================
drop function if exists public.get_whatsapp_status(uuid);
create function public.get_whatsapp_status(p_club_id uuid)
returns table(
  status text,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  qr_expires_at timestamptz,
  circuit_breaker_open_until timestamptz,
  circuit_breaker_reason text,
  last_successful_send_at timestamptz,
  restriction_signal_detected_at timestamptz,
  restriction_signal_detail text
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select wa.status, wa.connected_phone_number, wa.connected_at, wa.last_seen_at, wa.last_error, wa.qr_expires_at,
           wa.circuit_breaker_open_until, wa.circuit_breaker_reason, wa.last_successful_send_at,
           wa.restriction_signal_detected_at, wa.restriction_signal_detail
    from public.whatsapp_accounts wa
    where wa.club_id = p_club_id;
end;
$function$;

revoke execute on function public.get_whatsapp_status(uuid) from public, anon;
grant execute on function public.get_whatsapp_status(uuid) to authenticated;

drop function if exists public.platform_get_whatsapp_status();
create function public.platform_get_whatsapp_status()
returns table(
  status text,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  qr_expires_at timestamptz,
  circuit_breaker_open_until timestamptz,
  last_successful_send_at timestamptz,
  restriction_signal_detected_at timestamptz,
  restriction_signal_detail text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  return query
    select pa.status, pa.connected_phone_number, pa.connected_at, pa.last_seen_at,
           pa.last_error, pa.qr_expires_at, pa.circuit_breaker_open_until, pa.last_successful_send_at,
           pa.restriction_signal_detected_at, pa.restriction_signal_detail
    from public.platform_whatsapp_account pa;
end;
$$;

revoke execute on function public.platform_get_whatsapp_status() from public, anon;
grant execute on function public.platform_get_whatsapp_status() to authenticated;

-- ============================================================
-- PART 2: daily caps -- tenant domain
-- ============================================================

alter table public.messaging_safety_settings
  add column if not exists max_sends_per_day_per_account integer not null default 500 check (max_sends_per_day_per_account > 0),
  add column if not exists max_sends_per_day_per_recipient integer not null default 3 check (max_sends_per_day_per_recipient > 0);

comment on column public.messaging_safety_settings.max_sends_per_day_per_account is 'Daily send cap for this account, closing the gap the existing per-minute/per-hour caps leave open: an account could otherwise sustain its hourly max continuously for 24 hours. Conservative default; a club can raise it, same "no guaranteed-safe number" discipline as every other cap in this table.';
comment on column public.messaging_safety_settings.max_sends_per_day_per_recipient is 'Daily cap on messages to the SAME recipient, closing the gap min_minutes_between_recipient_sends leaves open: spacing messages 6 minutes apart all day still allows ~240/day to one person. A backstop, not the per-event dedup guarantee (dedup_key already prevents a genuine duplicate).';

-- ============================================================
-- PART 2b: daily caps -- platform domain
-- ============================================================

alter table public.platform_whatsapp_safety_settings
  add column if not exists max_sends_per_day integer not null default 100 check (max_sends_per_day > 0),
  add column if not exists max_sends_per_day_per_recipient integer not null default 1 check (max_sends_per_day_per_recipient > 0);

comment on column public.platform_whatsapp_safety_settings.max_sends_per_day is 'Daily send cap for the whole Platform WhatsApp account, same rationale as messaging_safety_settings.max_sends_per_day_per_account. Lower default than the tenant side''s (100 vs 500) since sales outreach is a smaller, deliberately conservative volume by design.';
comment on column public.platform_whatsapp_safety_settings.max_sends_per_day_per_recipient is 'Daily cap on Sales Intelligence messages to the SAME lead. Default 1 -- a lead should never receive more than one Platform WhatsApp sales message per day regardless of how many drafts exist for them.';

-- ============================================================
-- PART 3: warm-up ramp -- tenant domain
-- ============================================================

alter table public.messaging_safety_settings
  add column if not exists warm_up_enabled boolean not null default true,
  add column if not exists warm_up_days integer not null default 7 check (warm_up_days >= 0),
  add column if not exists warm_up_rate_multiplier numeric not null default 0.25 check (warm_up_rate_multiplier > 0 and warm_up_rate_multiplier <= 1);

comment on column public.messaging_safety_settings.warm_up_enabled is 'Whether a newly (re)connected account gets a temporarily-reduced rate cap for warm_up_days after connecting, widening linearly to the full configured caps. A fresh pairing sending at full configured volume from minute one is a real, documented risk-signal difference from an account with an established sending history -- this is a conservative volume reduction, not a claim it makes the account "safe".';
comment on column public.messaging_safety_settings.warm_up_days is 'How many days after whatsapp_accounts.connected_at the reduced warm-up rate applies. After this many days, full configured caps apply with no further ramp.';
comment on column public.messaging_safety_settings.warm_up_rate_multiplier is 'The FLOOR multiplier applied to every per-minute/per-hour/per-day cap on the very first day after connecting (e.g. 0.25 = 25% of the configured cap). Ramps linearly from this floor on day 0 up to 1.0 (full cap) at warm_up_days -- never abrupt, never below this floor even on the very first send.';

-- ============================================================
-- PART 3b: warm-up ramp -- platform domain
-- ============================================================

alter table public.platform_whatsapp_safety_settings
  add column if not exists warm_up_enabled boolean not null default true,
  add column if not exists warm_up_days integer not null default 7 check (warm_up_days >= 0),
  add column if not exists warm_up_rate_multiplier numeric not null default 0.25 check (warm_up_rate_multiplier > 0 and warm_up_rate_multiplier <= 1);

comment on column public.platform_whatsapp_safety_settings.warm_up_enabled is 'Same meaning as messaging_safety_settings.warm_up_enabled, for the Platform WhatsApp domain.';
comment on column public.platform_whatsapp_safety_settings.warm_up_days is 'Same meaning as messaging_safety_settings.warm_up_days, for the Platform WhatsApp domain.';
comment on column public.platform_whatsapp_safety_settings.warm_up_rate_multiplier is 'Same meaning as messaging_safety_settings.warm_up_rate_multiplier, for the Platform WhatsApp domain.';

-- Helper: given a connection start time and this row's own warm-up
-- settings, returns the multiplier to apply to every rate cap RIGHT
-- NOW. Pure, STABLE (not volatile -- same inputs always produce the
-- same output within one statement, matching every other pure helper
-- in this schema), reused by both domains' claim functions below so
-- the ramp MATH lives in exactly one place.
create or replace function public.whatsapp_warm_up_multiplier(
  p_connected_at timestamptz,
  p_warm_up_enabled boolean,
  p_warm_up_days integer,
  p_warm_up_floor numeric
)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when not p_warm_up_enabled or p_connected_at is null or p_warm_up_days <= 0 then 1.0
    else least(
      1.0,
      p_warm_up_floor + (1.0 - p_warm_up_floor) * greatest(0, extract(epoch from (now() - p_connected_at)) / 86400.0) / p_warm_up_days
    )
  end;
$$;

comment on function public.whatsapp_warm_up_multiplier(timestamptz, boolean, integer, numeric) is 'Linear ramp from p_warm_up_floor (at the moment of connecting) to 1.0 (at p_warm_up_days later), clamped to [floor, 1.0]. Returns 1.0 unconditionally if warm-up is disabled, the account has never connected, or warm_up_days is 0 -- a genuinely established or warm-up-disabled account is never artificially throttled.';

-- ============================================================
-- PART 4: inbound STOP/إيقاف opt-out handling -- tenant domain
-- ============================================================

-- 'opted_out' already exists as a valid notification_suppressions.reason
-- (20260817043657) -- this is the first RPC that can actually REACH it
-- from a customer's own typed message, rather than only a manual staff
-- action or a system-detected delivery failure.
create or replace function public.whatsapp_connector_record_opt_out_keyword(p_club_id uuid, p_from_phone_digits_only text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid;
begin
  -- Best-effort match against this club's own customers by normalized
  -- phone -- if no match, there is nothing to suppress (a stranger
  -- texting "stop" to a club's WhatsApp number that isn't in
  -- customers at all has no consent/suppression row to begin with).
  select c.id into v_customer_id
  from public.customers c
  where c.club_id = p_club_id and c.normalized_mobile = p_from_phone_digits_only
  limit 1;

  if v_customer_id is null then
    return;
  end if;

  insert into public.notification_suppressions (club_id, customer_id, channel, reason, detail)
  values (p_club_id, v_customer_id, 'whatsapp', 'opted_out', 'customer sent a stop/إيقاف keyword')
  on conflict (customer_id, channel) do update
    set reason = 'opted_out', detail = 'customer sent a stop/إيقاف keyword', created_at = now();

  -- Mirror the effect onto notification_consent too, per that table's
  -- own existing revoked_at column (20260816280000) -- suppression and
  -- consent are deliberately separate tables (Part O's own comment),
  -- but a customer-initiated opt-out is exactly the case where BOTH
  -- should reflect it: consent.revoked_at is what a "resubscribe" flow
  -- would need to check, while notification_suppressions is what the
  -- enqueue-time gate actually enforces today.
  update public.notification_consent
  set revoked_at = now()
  where club_id = p_club_id and customer_id = v_customer_id and channel = 'whatsapp' and revoked_at is null;
end;
$$;

revoke execute on function public.whatsapp_connector_record_opt_out_keyword(uuid, text) from public, anon, authenticated;

comment on function public.whatsapp_connector_record_opt_out_keyword(uuid, text) is 'Connector-only. Called when an INCOMING message from a real customer (never fromMe, never the WhatsApp-system JID) matches a known stop/إيقاف keyword pattern -- see whatsapp-connector''s own OptOutKeywordMatcher.ts for the exact, narrow pattern list. Idempotent (ON CONFLICT upsert) -- a customer texting "stop" twice does not error or duplicate.';

-- ============================================================
-- PART 5: Platform WhatsApp safety settings -- owner-facing RPCs
-- ============================================================

create or replace function public.get_platform_whatsapp_safety_settings()
returns public.platform_whatsapp_safety_settings
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.platform_whatsapp_safety_settings;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;
  select * into v_row from public.platform_whatsapp_safety_settings;
  return v_row;
end;
$$;

revoke all on function public.get_platform_whatsapp_safety_settings() from public, anon;
grant execute on function public.get_platform_whatsapp_safety_settings() to authenticated;

comment on function public.get_platform_whatsapp_safety_settings() is 'Owner-facing read of the Platform WhatsApp domain''s safety settings (rate caps, daily caps, circuit breaker thresholds, warm-up config) -- the table itself already existed with sane defaults (20260909200000) but had no RPC read/write surface at all, unlike the tenant side''s messaging_safety_settings (which MessagingSafetyCard.tsx already exposes). Gated on the SAME platform.whatsapp_platform.manage permission that governs every other Platform WhatsApp action (owner decision #21).';

create or replace function public.update_platform_whatsapp_safety_settings(
  p_max_sends_per_minute integer default null,
  p_max_sends_per_hour integer default null,
  p_max_sends_per_day integer default null,
  p_min_minutes_between_recipient_sends integer default null,
  p_max_sends_per_day_per_recipient integer default null,
  p_circuit_breaker_enabled boolean default null,
  p_warm_up_enabled boolean default null,
  p_warm_up_days integer default null
)
returns public.platform_whatsapp_safety_settings
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
  v_row public.platform_whatsapp_safety_settings;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  select to_jsonb(s) into v_before from public.platform_whatsapp_safety_settings s;

  update public.platform_whatsapp_safety_settings
  set max_sends_per_minute = coalesce(p_max_sends_per_minute, max_sends_per_minute),
      max_sends_per_hour = coalesce(p_max_sends_per_hour, max_sends_per_hour),
      max_sends_per_day = coalesce(p_max_sends_per_day, max_sends_per_day),
      min_minutes_between_recipient_sends = coalesce(p_min_minutes_between_recipient_sends, min_minutes_between_recipient_sends),
      max_sends_per_day_per_recipient = coalesce(p_max_sends_per_day_per_recipient, max_sends_per_day_per_recipient),
      circuit_breaker_enabled = coalesce(p_circuit_breaker_enabled, circuit_breaker_enabled),
      warm_up_enabled = coalesce(p_warm_up_enabled, warm_up_enabled),
      warm_up_days = coalesce(p_warm_up_days, warm_up_days)
  where singleton_guard = 1
  returning * into v_row;

  perform public.write_audit_log(
    null, 'platform_whatsapp.safety_settings_updated', 'platform_whatsapp_safety_settings', null,
    v_before, to_jsonb(v_row), null
  );

  return v_row;
end;
$$;

revoke all on function public.update_platform_whatsapp_safety_settings(integer, integer, integer, integer, integer, boolean, boolean, integer) from public, anon;
grant execute on function public.update_platform_whatsapp_safety_settings(integer, integer, integer, integer, integer, boolean, boolean, integer) to authenticated;

comment on function public.update_platform_whatsapp_safety_settings(integer, integer, integer, integer, integer, boolean, boolean, integer) is 'Owner-facing write for Platform WhatsApp safety settings -- every parameter optional (only supplied fields change, matching this schema''s existing coalesce-update convention), fully audit-logged. Same permission gate as the read RPC above.';

-- ============================================================
-- PART 6: enforce daily caps + warm-up in the CLAIM functions
-- ============================================================
-- Both claim functions below are widened, not narrowed -- every
-- existing gate (circuit breaker, per-minute/per-hour caps, per-
-- recipient spacing floor, restriction-signal check) is preserved
-- byte-for-byte; only the NEW daily-cap and warm-up-multiplier logic
-- is added, and a restriction-signal check is added so a
-- status='restricted' account is excluded from claiming exactly like
-- an open circuit breaker already excludes one -- 'restricted' was a
-- dead status before this migration; it must now actually stop sends,
-- not just be a label nobody reacts to.

create or replace function public.whatsapp_connector_claim_next_batch(p_limit integer default 10)
returns table(
  id uuid,
  club_id uuid,
  recipient_customer_id uuid,
  recipient_phone text,
  template_key text,
  language text,
  variables jsonb,
  attempts integer,
  media_type text,
  media_intent text
)
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
      -- Part N (existing) + this migration: an account with an open
      -- circuit breaker OR a detected restriction signal is skipped
      -- entirely -- its queue rows stay pending/retrying, never
      -- touched, never marked failed. warm_up_multiplier is computed
      -- once per account here, applied to every cap below.
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
    -- Part G (existing) + this migration's daily window.
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
        ea.club_id, ea.min_minutes_between_recipient_sends, ea.max_sends_per_day_per_recipient
      from eligible_accounts ea
      left join account_recent_activity ara on ara.club_id = ea.club_id
      where coalesce(ara.sent_last_minute, 0) < greatest(1, round(ea.max_sends_per_minute_per_account * ea.warm_up_multiplier))
        and coalesce(ara.sent_last_hour, 0) < greatest(1, round(ea.max_sends_per_hour_per_account * ea.warm_up_multiplier))
        and coalesce(ara.sent_last_day, 0) < greatest(1, round(ea.max_sends_per_day_per_account * ea.warm_up_multiplier))
    ),
    candidates as (
      select nq.id, nq.club_id, nq.recipient_customer_id, nq.scheduled_at,
             aur.min_minutes_between_recipient_sends, aur.max_sends_per_day_per_recipient
      from public.notification_queue nq
      join accounts_under_rate_cap aur on aur.club_id = nq.club_id
      where nq.channel = 'whatsapp'
        and nq.status in ('pending', 'retrying')
        and nq.scheduled_at <= now()
        and (nq.next_attempt_at is null or nq.next_attempt_at <= now())
        and (nq.expires_at is null or nq.expires_at > now())
    ),
    -- Part H (existing) + this migration's daily-per-recipient cap.
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
        ) < c.max_sends_per_day_per_recipient
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

comment on function public.whatsapp_connector_claim_next_batch(integer) is 'Parts G/H/N (existing) + ban-protection hardening (2026-09-12): now ALSO gated by (4) a detected WhatsApp-side restriction signal (status=''restricted'' accounts are excluded, same as an open circuit breaker), (5) per-account AND per-recipient DAILY caps, (6) a warm-up multiplier that shrinks every rate cap for the first warm_up_days after connecting. A row that does not clear any gate is simply left pending/retrying for a later poll tick -- never marked failed or dropped.';

-- Platform domain: same widening, same discipline.
create or replace function public.whatsapp_connector_claim_next_platform_batch(p_limit integer default 10)
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
        ) < s.max_sends_per_day_per_recipient
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

revoke execute on function public.whatsapp_connector_claim_next_platform_batch(integer) from public, anon, authenticated;

comment on function public.whatsapp_connector_claim_next_platform_batch(integer) is 'Ban-protection hardening (2026-09-12): now ALSO gated by a detected restriction signal, per-account AND per-recipient DAILY caps, and a warm-up multiplier for a newly-connected Platform WhatsApp account. Every pre-existing gate (circuit breaker, per-minute/per-hour caps, per-recipient spacing) preserved unchanged.';
