-- Safe Messaging policy evaluation layer (Parts C/I/J/K/O/Q/R). This
-- migration REPLACES queue_whatsapp_notification() (task #93) with a
-- version that runs every required check before a row is ever queued
-- -- suppression, quiet hours, phone plausibility, preferred language
-- -- rather than adding a second competing entry point. Every business
-- RPC that already calls queue_whatsapp_notification() (booking
-- create/cancel, record_payment, create_refund) is unchanged -- the
-- policy tightening happens entirely inside this one function.

-- ============================================================
-- Part R: minimal phone plausibility check. Deliberately NOT a full
-- E.164/libphonenumber validator (out of scope, and the existing
-- normalize_mobile() limitation -- no country-code handling -- is a
-- pre-existing, separately-tracked issue per D-016). This is a floor:
-- reject obviously-invalid values (too short, too long, non-numeric
-- after normalization) before ever queueing a send, so a send is never
-- attempted against a clearly garbage number.
-- ============================================================
create or replace function public.is_phone_plausible(p_normalized_phone text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_normalized_phone is not null
     and p_normalized_phone ~ '^[0-9]+$'
     and length(p_normalized_phone) between 8 and 15;
$$;

comment on function public.is_phone_plausible(text) is 'Part R: floor-level plausibility check (digits only, 8-15 chars after normalize_mobile()) -- not full E.164 validation. Rejects obviously-invalid numbers before queueing; does not guarantee the number is a real, reachable WhatsApp account.';

-- ============================================================
-- Part I: quiet-hours resolution. Given a club's messaging_safety_settings
-- and the club's own timezone, returns the next timestamptz at or
-- after p_intended_at that falls OUTSIDE the quiet window (or
-- p_intended_at itself if quiet hours don't apply / are disabled /
-- the message is critical and bypass is on). Handles a window that
-- wraps midnight (e.g. 22:00 -> 08:00).
-- ============================================================
create or replace function public.next_eligible_send_time(
  p_club_id uuid,
  p_intended_at timestamptz,
  p_priority text
)
returns timestamptz
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_settings record;
  v_tz text;
  v_local timestamp;
  v_local_time time;
  v_local_date date;
  v_end_dt timestamp;
begin
  select mss.quiet_hours_enabled, mss.quiet_hours_start, mss.quiet_hours_end, mss.quiet_hours_bypass_critical
  into v_settings
  from public.messaging_safety_settings mss
  where mss.club_id = p_club_id;

  -- No settings row, quiet hours disabled, or a critical message with
  -- bypass enabled -- send at the originally intended time.
  if v_settings is null or v_settings.quiet_hours_enabled is not true then
    return p_intended_at;
  end if;
  if p_priority = 'critical_operational' and v_settings.quiet_hours_bypass_critical is true then
    return p_intended_at;
  end if;

  select c.timezone into v_tz from public.clubs c where c.id = p_club_id;
  v_tz := coalesce(v_tz, 'UTC');

  v_local := p_intended_at at time zone v_tz;
  v_local_time := v_local::time;
  v_local_date := v_local::date;

  if v_settings.quiet_hours_start < v_settings.quiet_hours_end then
    -- Simple same-day window (e.g. 13:00 -> 14:00).
    if v_local_time >= v_settings.quiet_hours_start and v_local_time < v_settings.quiet_hours_end then
      v_end_dt := v_local_date + v_settings.quiet_hours_end;
      return v_end_dt at time zone v_tz;
    end if;
  else
    -- Wrapping window (e.g. 22:00 -> 08:00, spans midnight).
    if v_local_time >= v_settings.quiet_hours_start then
      -- Currently in tonight's quiet window -- eligible tomorrow morning.
      v_end_dt := (v_local_date + 1) + v_settings.quiet_hours_end;
      return v_end_dt at time zone v_tz;
    elsif v_local_time < v_settings.quiet_hours_end then
      -- Currently in this morning's tail of last night's window.
      v_end_dt := v_local_date + v_settings.quiet_hours_end;
      return v_end_dt at time zone v_tz;
    end if;
  end if;

  -- Outside the quiet window entirely.
  return p_intended_at;
end;
$$;

comment on function public.next_eligible_send_time(uuid, timestamptz, text) is 'Part I: resolves quiet hours in the club''s own timezone (wrap-safe). critical_operational bypasses when quiet_hours_bypass_critical is true. Returns the original p_intended_at unchanged when quiet hours are off/not applicable -- never silently drops a message, only defers scheduled_at (Part I: "never silently discard postponed messages").';

-- ============================================================
-- queue_whatsapp_notification -- REPLACED (not a new function) to run
-- the full safety policy before enqueueing. Existing call sites
-- (_create_booking_internal, cancel_booking, record_payment,
-- create_refund) need no changes -- same signature, same return
-- contract (queue id or null).
-- ============================================================
create or replace function public.queue_whatsapp_notification(
  p_club_id uuid, p_event_id uuid, p_customer_id uuid,
  p_template_key text, p_category text, p_variables jsonb,
  p_priority text default 'transactional', p_dedup_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category_enabled boolean;
  v_phone text;
  v_language text;
  v_scheduled_at timestamptz;
  v_expires_at timestamptz;
  v_queue_id uuid;
begin
  -- Part B: category must be enabled for this club (missing row =
  -- enabled by default, per the original design -- see
  -- notification_category_settings comment).
  select enabled into v_category_enabled
  from public.notification_category_settings
  where club_id = p_club_id and channel = 'whatsapp' and category = p_category;
  if v_category_enabled is false then
    return null;
  end if;

  -- Part F: WhatsApp must actually be connected -- this never blocks
  -- or fails the calling business transaction, it just means no queue
  -- row is created (the business RPC's own commit already happened
  -- before this function is ever called).
  if not exists (select 1 from public.whatsapp_accounts where club_id = p_club_id and status = 'connected') then
    return null;
  end if;

  -- Part O: a suppressed recipient is never queued again automatically.
  if exists (select 1 from public.notification_suppressions where customer_id = p_customer_id and channel = 'whatsapp') then
    return null;
  end if;

  -- Part C: consent required, with normalized_phone/preferred_language
  -- sourced from the consent record itself (the auditable snapshot),
  -- falling back to the live customer record only for the phone number
  -- when the consent row predates the phone_display/normalized_phone
  -- columns (Part C requires consent to exist at all; it does not
  -- require every historical consent row to have been backfilled).
  select coalesce(nc.normalized_phone, c.normalized_mobile), coalesce(nc.preferred_language, 'ar')
  into v_phone, v_language
  from public.notification_consent nc
  join public.customers c on c.id = p_customer_id
  where nc.customer_id = p_customer_id and nc.channel = 'whatsapp' and nc.enabled = true;

  if v_phone is null then
    return null;
  end if;

  -- Part R: reject obviously-invalid numbers before queueing.
  if not public.is_phone_plausible(v_phone) then
    insert into public.notification_suppressions (club_id, customer_id, channel, reason, detail)
    values (p_club_id, p_customer_id, 'whatsapp', 'invalid_recipient', 'normalized phone failed plausibility check at queue time')
    on conflict (customer_id, channel) do nothing;
    return null;
  end if;

  -- Part I: quiet hours -- critical_operational bypasses by default;
  -- everything else may be deferred to the next eligible window. Never
  -- silently dropped -- scheduled_at simply moves forward.
  v_scheduled_at := public.next_eligible_send_time(p_club_id, now(), p_priority);

  -- Part J: reminders must not be delivered late. No business RPC
  -- currently emits a p_priority='reminder' call (only 'transactional'
  -- is wired as of this migration -- booking-created/confirmed/
  -- cancelled, payment-received/refunded), but this default applies
  -- automatically the moment a reminder IS wired, without needing to
  -- remember to add expiry logic at that call site: a reminder that
  -- couldn't be sent promptly (queue backlog, WhatsApp outage) gets 2
  -- hours past its originally-intended send time, then expires rather
  -- than arriving hours late.
  if p_priority = 'reminder' then
    v_expires_at := now() + interval '2 hours';
  end if;

  v_queue_id := public.enqueue_notification(
    p_club_id, p_event_id, 'whatsapp', p_customer_id, p_template_key,
    v_language, p_variables, p_priority, v_scheduled_at, v_expires_at, p_dedup_key
  );

  return v_queue_id;
end;
$$;

comment on function public.queue_whatsapp_notification(uuid, uuid, uuid, text, text, jsonb, text, text) is 'Safe Messaging policy evaluation (Parts C/I/J/O/Q/R): category toggle, connected-account check, suppression check, consent + preferred_language resolution, phone plausibility, quiet-hours scheduling, category-appropriate expiry -- all evaluated before a row is ever created in notification_queue. Never raises on a policy rejection (returns null), and never blocks/rolls back the calling business transaction, which has already committed by the time this runs (Part F).';

-- ============================================================
-- Part J: sweep pending/retrying rows past their expires_at into a
-- terminal 'expired' status. Called by the connector on each poll
-- tick (cheap: index-backed, bounded by the same partial index used
-- for claiming) -- separate from claim_next_batch so an expired row
-- is never claimed and attempted even once.
-- ============================================================
create or replace function public.whatsapp_connector_expire_stale()
returns integer
language sql
security definer
set search_path = public, pg_temp
as $$
  with expired as (
    update public.notification_queue
    set status = 'expired'
    where channel = 'whatsapp'
      and status in ('pending', 'retrying')
      and expires_at is not null
      and expires_at <= now()
    returning id
  )
  select count(*)::integer from expired;
$$;

revoke execute on function public.whatsapp_connector_expire_stale() from public, anon, authenticated;

comment on function public.whatsapp_connector_expire_stale() is 'Part J: transitions any whatsapp-channel pending/retrying row past its expires_at to status=expired. Connector-only (service-role), called once per poll tick before claiming a batch.';
