-- Safe Messaging / Anti-Abuse Control Layer, per the "RESUME DIRECTIVE
-- -- PAYMENTS + SAFE WHATSAPP OPERATIONS". Explicit non-goal (Part A):
-- this is NOT ban-evasion tooling -- no randomized text, no number
-- rotation, no spoofed human behavior, no artificial delay designed to
-- defeat WhatsApp's own enforcement. The goal is consent + relevance +
-- low volume + deduplication + safe retries + observability, i.e.
-- responsible operational messaging, not automation designed to evade
-- detection. No claim anywhere in this schema or its comments implies
-- a guaranteed "safe messages/hour" number -- there is none for an
-- unofficial connector, and this migration does not pretend otherwise.
--
-- Reuse-first: notification_queue.priority already implements the
-- exact category taxonomy Part B asks for
-- (critical_operational/transactional/reminder/informational/
-- marketing, set in 20260816280000_notification_core.sql) -- reused
-- as the message category, not duplicated. dedup_key + its partial
-- unique index (Part E) and expires_at (Part J) already exist on
-- notification_queue from the same migration. This migration adds
-- what's genuinely missing: richer consent fields (Part C), tenant
-- safety settings (quiet hours + rate limits, Parts G/H/I), circuit
-- breaker + extended account health states (Parts M/N), and
-- suppression tracking (Part K/O).

-- ============================================================
-- Part C: richer consent. notification_consent already has
-- (club_id, customer_id, channel, enabled, consent_source, consent_at,
-- revoked_at) -- adding phone/normalized_phone/preferred_language so
-- consent carries its own snapshot of who it applies to (a customer's
-- phone can change; the consent record should reflect what was
-- actually consented for, and normalized_phone is what the connector
-- and policy layer key off without a second join in the hot path).
-- ============================================================
alter table public.notification_consent
  add column if not exists phone_display text,
  add column if not exists normalized_phone text,
  add column if not exists preferred_language text not null default 'ar' check (preferred_language in ('ar', 'en'));

comment on column public.notification_consent.phone_display is 'Part C: display-format phone at time of consent -- not the live customer record, so consent stays auditable even if the customer later edits their phone.';
comment on column public.notification_consent.normalized_phone is 'Part C/R: canonical normalized phone this consent applies to, via normalize_mobile(). Populated from customers.normalized_mobile at consent time.';

-- ============================================================
-- Part O: per-customer suppression signal, separate from consent.
-- Consent is "did they agree to this channel"; suppression is "should
-- we stop trying regardless of consent" (invalid number, repeated
-- permanent delivery failure). Kept as its own table rather than
-- overloading notification_consent.enabled=false, because a
-- suppression can be system-detected (bad number) while consent
-- remains a customer-controlled opt-in/opt-out -- conflating them
-- would make an opt-out and an invalid-number failure
-- indistinguishable in an audit trail.
-- ============================================================
create table public.notification_suppressions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  customer_id uuid not null references public.customers(id),
  channel text not null,
  reason text not null check (reason in ('invalid_recipient', 'repeated_permanent_failure', 'opted_out', 'manual_staff_action')),
  detail text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  unique (customer_id, channel)
);

alter table public.notification_suppressions enable row level security;

create policy "notification_suppressions_select_own_club" on public.notification_suppressions
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('notification.view', club_id));

comment on table public.notification_suppressions is 'Part O: known-bad recipients (invalid number, repeated permanent failure, opted out, or a manual staff suppression). Checked by the policy evaluation layer before enqueueing -- a suppressed recipient is never queued again automatically. Row presence = suppressed; delete the row to lift a suppression (audited via the standard audit_log, not a soft flag).';

-- ============================================================
-- Parts G/H/I: tenant-level messaging safety settings -- one row per
-- club. Separate table from notification_category_settings (which is
-- per-channel per-category on/off) because these are cross-cutting
-- policy knobs (quiet hours, rate limits) that apply across
-- categories, not a category toggle itself.
-- ============================================================
create table public.messaging_safety_settings (
  club_id uuid primary key references public.clubs(id) on delete cascade,

  -- Part I: quiet hours in the CLUB's own timezone (clubs.timezone
  -- already exists -- reused, not duplicated). Stored as time-of-day
  -- bounds; a window that wraps midnight (e.g. 22:00 -> 08:00) is
  -- valid and expected -- the policy evaluation layer handles the
  -- wrap, this table just stores the two boundaries.
  quiet_hours_enabled boolean not null default true,
  quiet_hours_start time not null default '22:00',
  quiet_hours_end time not null default '08:00',
  -- Part I: "critical operational events can have a separate policy"
  -- -- critical_operational priority messages bypass quiet hours by
  -- default, matching the directive's own example (urgent operational
  -- issues shouldn't wait until 8am). Configurable, not hardcoded.
  quiet_hours_bypass_critical boolean not null default true,

  -- Part G: conservative default rate controls. These are for service
  -- stability and customer protection (per Part A/G explicitly), not
  -- an attempt to compute a "safe" WhatsApp threshold -- there isn't
  -- one, and this schema does not claim there is. Defaults are
  -- deliberately low; a club can raise them, but nothing in this
  -- schema or its UI describes any number as "ban-safe".
  max_sends_per_minute_per_account integer not null default 6 check (max_sends_per_minute_per_account > 0),
  max_sends_per_hour_per_account integer not null default 120 check (max_sends_per_hour_per_account > 0),

  -- Part H: recipient frequency cap -- minimum spacing (minutes)
  -- between two automated messages to the SAME recipient, regardless
  -- of category, as a blunt backstop against a scheduler bug re-firing
  -- repeatedly. Category-specific "once per event" semantics (Part H's
  -- examples) are enforced by dedup_key at the business-RPC layer
  -- (task #93), which already guarantees at-most-one queued message
  -- per logical event -- this column is the additional cross-category
  -- floor.
  min_minutes_between_recipient_sends integer not null default 5 check (min_minutes_between_recipient_sends >= 0),

  -- Part N: circuit breaker thresholds. A failure RATE over a rolling
  -- window, not a raw count, so a quiet night with 2 failures out of 2
  -- attempts doesn't trip the same breaker as 2 failures out of 200.
  circuit_breaker_enabled boolean not null default true,
  circuit_breaker_failure_rate_threshold numeric not null default 0.5 check (circuit_breaker_failure_rate_threshold > 0 and circuit_breaker_failure_rate_threshold <= 1),
  circuit_breaker_min_sample_size integer not null default 5 check (circuit_breaker_min_sample_size > 0),
  circuit_breaker_window_minutes integer not null default 15 check (circuit_breaker_window_minutes > 0),
  -- How long a tripped breaker stays open before the connector is
  -- allowed to try again (Part N: "pause outbound queue", not "stop
  -- forever" -- this is a cooldown, never an auto-hammer retry loop
  -- since the connector only re-evaluates once per cooldown, not
  -- continuously).
  circuit_breaker_cooldown_minutes integer not null default 30 check (circuit_breaker_cooldown_minutes > 0),

  -- Part Q: default language behavior when a customer has no explicit
  -- preferred_language recorded yet.
  default_language text not null default 'ar' check (default_language in ('ar', 'en')),

  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.messaging_safety_settings enable row level security;

create policy "messaging_safety_settings_select_own_club" on public.messaging_safety_settings
  for select using (club_id in (select public.user_club_ids()));

create policy "messaging_safety_settings_write_with_permission" on public.messaging_safety_settings
  for all using (
    club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', club_id)
  )
  with check (
    club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', club_id)
  );

comment on table public.messaging_safety_settings is 'Parts G/H/I/N/Q: per-club messaging safety controls -- quiet hours, rate limits, recipient frequency floor, circuit breaker thresholds, default language. Deliberately named "safety settings" / "delivery controls", never "anti-ban" -- see Part W. No column here encodes or implies a guaranteed-safe send volume.';

-- Auto-provision default settings for every existing club with a
-- whatsapp_accounts row (so existing WhatsApp-connected clubs get
-- protective defaults immediately, not an unprotected gap until they
-- visit Settings) and via trigger for new clubs going forward.
insert into public.messaging_safety_settings (club_id)
select club_id from public.whatsapp_accounts
on conflict (club_id) do nothing;

create or replace function public.ensure_messaging_safety_settings()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.messaging_safety_settings (club_id)
  values (new.club_id)
  on conflict (club_id) do nothing;
  return new;
end;
$$;

create trigger trg_ensure_messaging_safety_settings
  after insert on public.whatsapp_accounts
  for each row execute function public.ensure_messaging_safety_settings();

-- ============================================================
-- Part M/N: extended account health states + circuit breaker state on
-- whatsapp_accounts. The existing status check (disconnected/
-- qr_required/connecting/connected/reconnecting/logged_out/error) is
-- WIDENED (additive, not narrowed) to add 'degraded', 'restricted',
-- 'failed' -- every existing row's status value remains valid under
-- the new constraint, so this is non-destructive.
-- ============================================================
alter table public.whatsapp_accounts drop constraint if exists whatsapp_accounts_status_check;
alter table public.whatsapp_accounts add constraint whatsapp_accounts_status_check
  check (status in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'degraded', 'logged_out', 'restricted', 'failed'
  ));

alter table public.whatsapp_accounts
  add column if not exists circuit_breaker_open_until timestamptz,
  add column if not exists circuit_breaker_reason text,
  add column if not exists last_successful_send_at timestamptz;

comment on column public.whatsapp_accounts.circuit_breaker_open_until is 'Part N: when set and in the future, the connector must not send outbound messages for this account -- queue rows stay pending/retrying, never dropped. Cleared (set null) once the cooldown elapses and a fresh evaluation allows sends again.';
comment on column public.whatsapp_accounts.circuit_breaker_reason is 'Part N/T: human-readable reason the breaker tripped (e.g. "failure rate 71% over 15m, 12 sends"), surfaced in diagnostics -- never a raw error dump.';

-- ============================================================
-- Part T diagnostics support: a narrow, safe view over
-- notification_queue for WhatsApp -- counts only, never message
-- content or recipient PII beyond what notification_queue's own RLS
-- already permits. Reuses the existing notification_queue_select_own_club
-- policy (this is a view, RLS on the base table still applies).
-- ============================================================
create or replace view public.whatsapp_queue_diagnostics as
select
  club_id,
  count(*) filter (where status = 'pending') as pending_count,
  count(*) filter (where status = 'retrying') as retrying_count,
  count(*) filter (where status = 'expired') as expired_count,
  count(*) filter (where status = 'failed') as failed_count,
  count(*) filter (where status = 'sent') as sent_count,
  min(created_at) filter (where status in ('pending', 'retrying')) as oldest_pending_created_at
from public.notification_queue
where channel = 'whatsapp'
group by club_id;

comment on view public.whatsapp_queue_diagnostics is 'Part T: safe, count-only diagnostics for the WhatsApp queue per club. Never exposes message variables, recipient identity, or any secret. Inherits notification_queue''s own RLS (security_invoker view).';

alter view public.whatsapp_queue_diagnostics set (security_invoker = true);
