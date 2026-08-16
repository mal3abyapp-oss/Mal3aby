-- Gate 7 (Notification Core) -- confirmed via information_schema that
-- ZERO notification/messaging infrastructure exists in this schema
-- today (genuinely new, not a bug fix). Doc 3's explicit requirement:
-- business logic must never call WhatsApp/SMS/Email directly -- a
-- Notification Engine / domain-event abstraction must sit between
-- business transactions and delivery channels, so Gate 8 (WhatsApp)
-- can be built as a connector plugging into this layer without ever
-- touching Booking/Academy/Enrollment/Payment code.
--
-- Architecture (three layers, deliberately kept separate):
--   1. notification_events: WHAT happened (a domain fact) -- written
--      by business RPCs via emit_notification_event(), a single
--      narrow entry point. Never contains channel-specific data.
--   2. notification_queue: WHO gets notified, HOW, and the delivery
--      lifecycle (pending/scheduled/processing/sent/delivered/failed/
--      retrying/cancelled/expired) -- one event can fan out to zero,
--      one, or many queue rows (e.g. a booking-confirmed event might
--      notify the customer AND, for a minor academy enrollment, the
--      guardian). This is where a future queue worker reads from.
--   3. notification_consent: per-customer opt-in/opt-out state, so the
--      queue layer can check consent before ever creating a row for a
--      given channel -- consent is never bypassed by "the event fired,
--      so send it" logic.
-- No channel-specific (WhatsApp/SMS/email) columns exist ANYWHERE in
-- this migration -- that's the whole point of the abstraction. Gate 8
-- adds its own connector-specific tables (session state, templates)
-- that reference notification_queue rows, never the other way around.

-- ============================================================
-- notification_events: an immutable log of domain facts. Never
-- updated after insert (matches this schema's "never erase history"
-- principle) -- if a later event supersedes an earlier one (e.g. a
-- booking is cancelled after a booking-confirmed event already fired),
-- that's a NEW event, not a mutation of the old one.
-- ============================================================
create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  event_type text not null,
  reference_type text not null,
  reference_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index notification_events_club_type_idx on public.notification_events (club_id, event_type);
create index notification_events_reference_idx on public.notification_events (reference_type, reference_id);

alter table public.notification_events enable row level security;

create policy "notification_events_select_own_club" on public.notification_events
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('notification.view', club_id));

create policy "notification_events_platform_owner_select" on public.notification_events
  for select using (public.is_platform_owner());

comment on table public.notification_events is
  'Immutable domain-event log (Gate 7). Written only via emit_notification_event() -- business RPCs never write here directly, and never call any delivery channel directly. One event may fan out to zero/one/many notification_queue rows.';

-- ============================================================
-- notification_queue: the actual per-recipient, per-channel delivery
-- lifecycle. Channel is a free-text slug (e.g. 'whatsapp', 'sms',
-- 'email', 'in_app') so this table needs no migration when a new
-- channel connector is added later -- Gate 8's WhatsApp connector will
-- read/update rows here, never define its own parallel queue.
-- ============================================================
create table public.notification_queue (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  event_id uuid references public.notification_events(id),
  channel text not null,
  recipient_customer_id uuid references public.customers(id),
  recipient_phone text,
  recipient_email text,
  template_key text not null,
  language text not null default 'ar' check (language in ('ar', 'en')),
  variables jsonb not null default '{}'::jsonb,
  priority text not null default 'transactional' check (priority in ('critical_operational', 'transactional', 'reminder', 'informational', 'marketing')),
  status text not null default 'pending' check (status in ('pending', 'scheduled', 'processing', 'sent', 'delivered', 'failed', 'retrying', 'cancelled', 'expired')),
  scheduled_at timestamptz not null default now(),
  expires_at timestamptz,
  attempts int not null default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  dedup_key text,
  provider_reference text,
  created_at timestamptz not null default now(),
  constraint notification_queue_recipient_check check (
    recipient_customer_id is not null or recipient_phone is not null or recipient_email is not null
  )
);

-- Deduplication: the same idempotency key (typically
-- tenant+recipient+event+resource+template_version, per Doc 3's own
-- suggested pattern) may only ever produce one non-terminal queue row
-- -- prevents the same notification firing twice from retries,
-- duplicate webhook deliveries, or worker restarts. Partial (only
-- non-terminal statuses) so a genuinely new notification for the same
-- dedup key IS allowed once the prior one reaches a terminal state.
create unique index notification_queue_dedup_active_idx on public.notification_queue (dedup_key)
  where dedup_key is not null and status in ('pending', 'scheduled', 'processing', 'retrying');

create index notification_queue_club_status_idx on public.notification_queue (club_id, status);
create index notification_queue_scheduled_idx on public.notification_queue (scheduled_at) where status in ('pending', 'scheduled', 'retrying');

alter table public.notification_queue enable row level security;

create policy "notification_queue_select_own_club" on public.notification_queue
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('notification.view', club_id));

create policy "notification_queue_platform_owner_select" on public.notification_queue
  for select using (public.is_platform_owner());

comment on table public.notification_queue is
  'Per-recipient, per-channel delivery lifecycle (Gate 7). Channel is free-text so new connectors (Gate 8 WhatsApp, future SMS/email) need no schema change here. A queue worker (not yet built) reads pending/retrying rows and updates status -- this migration only establishes the data model and enqueue path, not the worker itself.';

-- ============================================================
-- notification_consent: per-customer, per-channel opt-in state.
-- Never messages a number just because it exists on a customer record
-- -- Doc 3's explicit requirement. One row per (customer, channel).
-- ============================================================
create table public.notification_consent (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  customer_id uuid not null references public.customers(id),
  channel text not null,
  enabled boolean not null default false,
  consent_source text,
  consent_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (customer_id, channel)
);

alter table public.notification_consent enable row level security;

create policy "notification_consent_select_own_club" on public.notification_consent
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('notification.view', club_id));

create policy "notification_consent_update_own_club" on public.notification_consent
  for update using (club_id in (select public.user_club_ids()) and public.has_permission('customer.update', club_id));

create policy "notification_consent_insert_own_club" on public.notification_consent
  for insert with check (club_id in (select public.user_club_ids()) and public.has_permission('customer.update', club_id));

-- A customer may also manage their own notification preferences via
-- the self-service portal (Gate 3's customers.user_id link).
create policy "notification_consent_self_service_select" on public.notification_consent
  for select using (customer_id in (select id from public.customers where user_id = auth.uid()));

create policy "notification_consent_self_service_update" on public.notification_consent
  for update using (customer_id in (select id from public.customers where user_id = auth.uid()))
  with check (customer_id in (select id from public.customers where user_id = auth.uid()));

comment on table public.notification_consent is
  'Per-customer, per-channel opt-in state (Gate 7). enqueue_notification() must check this before creating a queue row for a given channel -- a customer existing does not imply consent to message them.';

-- ============================================================
-- emit_notification_event: the single, narrow entry point business
-- RPCs call to record a domain fact. Deliberately does NOT enqueue any
-- delivery on its own -- that's a separate, explicit step (see
-- enqueue_notification below) so the event log and the delivery queue
-- can evolve independently (e.g. re-processing historical events
-- through new automation rules later, without re-firing already-sent
-- notifications).
-- ============================================================
create or replace function public.emit_notification_event(
  p_club_id uuid,
  p_event_type text,
  p_reference_type text,
  p_reference_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_event_id uuid;
begin
  insert into public.notification_events (club_id, event_type, reference_type, reference_id, payload, created_by)
  values (p_club_id, p_event_type, p_reference_type, p_reference_id, p_payload, auth.uid())
  returning id into v_event_id;

  return v_event_id;
end;
$$;

revoke execute on function public.emit_notification_event(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
-- Intentionally NOT granted to authenticated -- this is called
-- internally by other SECURITY DEFINER business RPCs (e.g.
-- create_booking, record_payment), never directly by a client. Matches
-- this codebase's _internal-suffix convention for functions that
-- should never be directly RPC-callable, even though this one doesn't
-- carry that suffix (its name is meant to read naturally from calling
-- code, but its access is exactly as restricted).

-- ============================================================
-- enqueue_notification: creates (or, if an active dedup match exists,
-- silently no-ops on) a delivery queue row. Checks consent for the
-- given channel before creating a row -- if consent is not explicitly
-- enabled, this returns null and creates nothing, rather than queueing
-- a message the customer opted out of (or never opted into).
-- ============================================================
create or replace function public.enqueue_notification(
  p_club_id uuid,
  p_event_id uuid,
  p_channel text,
  p_recipient_customer_id uuid,
  p_template_key text,
  p_language text,
  p_variables jsonb,
  p_priority text default 'transactional',
  p_scheduled_at timestamptz default now(),
  p_expires_at timestamptz default null,
  p_dedup_key text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_queue_id uuid;
  v_consent boolean;
begin
  select enabled into v_consent
  from public.notification_consent
  where customer_id = p_recipient_customer_id and channel = p_channel;

  if v_consent is not true then
    return null;
  end if;

  insert into public.notification_queue (
    club_id, event_id, channel, recipient_customer_id, template_key,
    language, variables, priority, scheduled_at, expires_at, dedup_key
  )
  values (
    p_club_id, p_event_id, p_channel, p_recipient_customer_id, p_template_key,
    p_language, p_variables, p_priority, p_scheduled_at, p_expires_at, p_dedup_key
  )
  on conflict (dedup_key) where dedup_key is not null and status in ('pending', 'scheduled', 'processing', 'retrying')
  do nothing
  returning id into v_queue_id;

  return v_queue_id;
end;
$$;

revoke execute on function public.enqueue_notification(uuid, uuid, text, uuid, text, text, jsonb, text, timestamptz, timestamptz, text) from public, anon, authenticated;
