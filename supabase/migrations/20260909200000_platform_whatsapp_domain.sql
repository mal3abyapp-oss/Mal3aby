-- MAL3ABY PLATFORM OWNER OPERATIONAL GAP CLOSURE -- ARCHITECTURE
-- CORRECTION: Platform WhatsApp as a strictly-separated domain from
-- Tenant/Club WhatsApp.
--
-- WHY A NEW TABLE, NOT A ROW IN whatsapp_accounts: whatsapp_accounts.
-- club_id is a hard `primary key references public.clubs(id) on delete
-- cascade` (20260817110000_whatsapp_connection_model_v2.sql:24) --
-- confirmed by direct read before writing this migration. Forcing the
-- platform account into that table would require either (a) a fake
-- clubs row (explicitly forbidden by the correction: "do not force the
-- Platform account into a fake club/tenant record"), or (b) relaxing
-- club_id to nullable + an is_platform boolean, which blurs the two
-- domains in one table and risks a real accidental cross-domain query
-- bug (a forgotten `where club_id is not null`). A genuinely separate,
-- singleton table is the smallest CLEAN extension, matching the
-- correction's own explicit instruction.
--
-- WHY THE CONNECTOR/WORKER CODE NEEDS NO STRUCTURAL CHANGE: confirmed
-- by reading whatsapp-connector/src/{ConnectionRequestPoller,
-- TenantConnectionManager,SessionStore}.ts and cloudflare/whatsapp-
-- worker/src/{index,WhatsAppAccountObject}.ts before writing this
-- migration -- every one of them treats "clubId" as an OPAQUE STRING
-- KEY (a map key, a Durable Object name, a sha256'd directory name),
-- never as a validated foreign key at the connector/Worker layer (the
-- FK constraint only exists in Postgres). This means the exact same
-- session-management machinery (Baileys provider lifecycle, encrypted
-- session persistence, reconnect backoff, Durable Object per-name
-- singleton guarantee) can safely manage a second, non-club session
-- identified by a RESERVED SENTINEL KEY, without duplicating a single
-- line of connector/Worker code. Only the SQL layer needs new,
-- separate tables/RPCs, plus one new poller query the connector calls
-- alongside its existing whatsapp_connector_list_accounts() call.
--
-- SENTINEL KEY: '00000000-0000-0000-0000-000000000001'::uuid --
-- deliberately NOT gen_random_uuid() (must be stable/hardcoded so the
-- connector, Worker, and every RPC agree on it byte-for-byte across
-- restarts) and deliberately NOT the nil UUID
-- ('00000000-0000-0000-0000-000000000000', which some libraries treat
-- as a sentinel for "no value" and could cause a silent
-- misinterpretation bug). This value never appears in public.clubs
-- (confirmed: clubs.id is gen_random_uuid()-generated, astronomically
-- unlikely to collide, and this migration adds no clubs row at all).

-- ============================================================
-- 1. platform_whatsapp_account: singleton (enforced via a CHECK on a
--    constant + unique index, the standard Postgres singleton-table
--    pattern -- not enforced via application logic alone). Mirrors
--    whatsapp_accounts' column shape exactly (status enum,
--    qr_payload/qr_expires_at, session_credentials_encrypted,
--    connected_phone_number, connected_at, last_seen_at, last_error,
--    write-fencing columns, circuit-breaker columns) so the connector's
--    existing report/store/load logic ports over with zero conceptual
--    change, only a different target table.
-- ============================================================
create table public.platform_whatsapp_account (
  -- Singleton enforcement: this column can only ever hold the literal
  -- value 1, and a unique constraint on it means a second row can never
  -- be inserted -- the standard, well-known Postgres singleton pattern.
  singleton_guard int primary key default 1 check (singleton_guard = 1),

  session_key uuid not null default '00000000-0000-0000-0000-000000000001'::uuid,

  status text not null default 'disconnected' check (status in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'degraded', 'logged_out', 'restricted', 'failed', 'error'
  )),
  qr_payload text,
  qr_expires_at timestamptz,
  session_credentials_encrypted bytea,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  last_generation integer not null default 0,
  last_state_seq integer not null default 0,
  circuit_breaker_open_until timestamptz,
  circuit_breaker_reason text,
  last_successful_send_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- Exactly one row always exists (never zero, never more than one) --
-- every RPC below can therefore assume a row is present, matching how
-- whatsapp_accounts callers already assume a row exists once
-- start_whatsapp_pairing has run once. Seeded here so a fresh
-- production apply never has a zero-row gap.
insert into public.platform_whatsapp_account (singleton_guard) values (1)
on conflict (singleton_guard) do nothing;

comment on table public.platform_whatsapp_account is
  'The Mal3aby platform''s own WhatsApp session, structurally separate from every club''s whatsapp_accounts row (not a fake club, not a shared row). Singleton -- exactly one row, enforced by a CHECK on singleton_guard=1. Used by Sales Intelligence outreach and platform-initiated tenant communication, never by any club-facing flow.';

alter table public.platform_whatsapp_account enable row level security;
alter table public.platform_whatsapp_account force row level security;

-- Read: platform owner, or staff holding the new platform.whatsapp_platform.manage
-- permission (same tier as tenant WhatsApp management -- one platform
-- permission key governs both domains, since the same operational role
-- plausibly manages both).
create policy platform_whatsapp_account_select on public.platform_whatsapp_account
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage'));

-- No direct INSERT/UPDATE/DELETE policy -- exactly like whatsapp_accounts,
-- deliberately RPC-only (rls_enabled_no_policy is the documented,
-- intentional pattern this whole schema already uses for every
-- WhatsApp-adjacent table).

-- ============================================================
-- 2. platform_whatsapp_connection_events: mirrors
--    whatsapp_connection_events exactly (audit trail, actor_id null
--    for connector-driven transitions).
-- ============================================================
create table public.platform_whatsapp_connection_events (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  actor_id uuid references auth.users(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.platform_whatsapp_connection_events is
  'Audit trail for the platform WhatsApp account''s connect/disconnect/reconnect/error transitions. Structurally separate from whatsapp_connection_events (which is per-club). Never contains session credentials.';

alter table public.platform_whatsapp_connection_events enable row level security;
alter table public.platform_whatsapp_connection_events force row level security;

create policy platform_whatsapp_connection_events_select on public.platform_whatsapp_connection_events
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage'));

-- ============================================================
-- 3. platform_whatsapp_queue: a dedicated, DELIBERATELY SIMPLER queue
--    for platform-initiated sends (Sales Intelligence outreach, lead
--    follow-up, demo/trial communication, commercial/customer-success
--    communication). NOT a reuse of notification_queue -- confirmed by
--    reading whatsapp_connector_claim_next_batch()'s full body
--    (20260821123500_whatsapp_consent_identity_queue_snapshot.sql)
--    before writing this: that queue's claim logic is deeply built
--    around PER-CUSTOMER, PER-CLUB regulatory consent
--    (notification_consent joined to a real customers row) and
--    per-club messaging_safety_settings -- machinery built for
--    consumer-to-club messaging compliance. A sales lead has no
--    customers row and no notification_consent row (leads are
--    prospects, sourced/enriched under Sales Intelligence's own
--    existing scope and permission model, not consumer WhatsApp
--    messaging subject to the same per-customer consent schema) --
--    forcing outreach through that machinery would either silently
--    fail every consent check (since no matching customers/
--    notification_consent row would ever exist for a lead) or require
--    weakening that check in a way that would ALSO weaken it for real
--    club-customer messaging. A separate, smaller queue with its own
--    lightweight rate limiting is the correct, safe, isolated design.
-- ============================================================
create table public.platform_whatsapp_queue (
  id uuid primary key default gen_random_uuid(),
  -- Links to the sales domain this queue exists to serve -- nullable
  -- so this table is not hard-coupled to Sales Intelligence forever
  -- (the platform account's other stated uses -- support, commercial
  -- communication -- may enqueue without a lead_id in a future pass),
  -- but every row created by this pass's Sales Intelligence integration
  -- always sets it.
  lead_id uuid references public.sales_leads(id) on delete set null,
  outreach_message_id uuid references public.sales_outreach_messages(id) on delete set null,
  recipient_phone text not null,
  message_body text not null,
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'sent', 'delivered', 'failed', 'retrying', 'cancelled', 'expired'
  )),
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error text,
  provider_reference text,
  requested_by uuid references auth.users(id),
  scheduled_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index platform_whatsapp_queue_status_idx on public.platform_whatsapp_queue (status, scheduled_at) where status in ('pending', 'retrying');
create index platform_whatsapp_queue_lead_idx on public.platform_whatsapp_queue (lead_id);

comment on table public.platform_whatsapp_queue is
  'Send queue for the platform WhatsApp account, structurally separate from notification_queue (which is per-club, per-customer, and built around consent machinery a sales lead does not have). Populated only by sales_queue_platform_whatsapp_message() (Sales Intelligence outreach), claimed only by whatsapp_connector_claim_next_platform_batch() (connector-facing, service_role only).';

alter table public.platform_whatsapp_queue enable row level security;
alter table public.platform_whatsapp_queue force row level security;

create policy platform_whatsapp_queue_select on public.platform_whatsapp_queue
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));

-- ============================================================
-- 4. platform_whatsapp_safety_settings: a lighter analog of
--    messaging_safety_settings, singleton like
--    platform_whatsapp_account, rate limits only (no quiet-hours/
--    consent machinery -- sales outreach is business-hours,
--    owner-authorized-send, not an automated consumer notification
--    stream).
-- ============================================================
create table public.platform_whatsapp_safety_settings (
  singleton_guard int primary key default 1 check (singleton_guard = 1),
  max_sends_per_minute integer not null default 3 check (max_sends_per_minute > 0),
  max_sends_per_hour integer not null default 30 check (max_sends_per_hour > 0),
  min_minutes_between_recipient_sends integer not null default 60 check (min_minutes_between_recipient_sends >= 0),
  circuit_breaker_failure_rate_threshold numeric not null default 0.5 check (circuit_breaker_failure_rate_threshold > 0 and circuit_breaker_failure_rate_threshold <= 1),
  circuit_breaker_min_sample_size integer not null default 5 check (circuit_breaker_min_sample_size > 0),
  circuit_breaker_window_minutes integer not null default 30 check (circuit_breaker_window_minutes > 0),
  circuit_breaker_cooldown_minutes integer not null default 30 check (circuit_breaker_cooldown_minutes > 0)
);

insert into public.platform_whatsapp_safety_settings (singleton_guard) values (1)
on conflict (singleton_guard) do nothing;

comment on table public.platform_whatsapp_safety_settings is
  'Rate-limit configuration for the platform WhatsApp queue. Deliberately simpler than messaging_safety_settings (no quiet-hours/consent fields -- sales outreach is owner-authorized-send, not an automated consumer notification stream). Conservative defaults, same "not a claim of ban-safety" caveat as messaging_safety_settings.';

alter table public.platform_whatsapp_safety_settings enable row level security;
alter table public.platform_whatsapp_safety_settings force row level security;

create policy platform_whatsapp_safety_settings_select on public.platform_whatsapp_safety_settings
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage'));

-- ============================================================
-- 5. Permission: a genuinely SEPARATE key from the tenant-club domain's
--    platform.whatsapp_tenant.manage (20260909150000_platform_owner_
--    whatsapp_connection_control.sql). Originally these two domains
--    shared one key (platform.whatsapp.manage); the owner explicitly
--    rejected that (decision #21) -- a staff member trusted to support
--    a club's WhatsApp connection must NOT automatically gain
--    permission to control Mal3aby's own Platform WhatsApp account or
--    send Mal3aby sales outreach, and vice versa. Neither key is a
--    superset of the other; only is_platform_owner() always holds both
--    (the existing owner-is-unrestricted bridge, unchanged).
insert into public.platform_permissions (key, group_key) values
  ('platform.whatsapp_platform.manage', 'clubs')
on conflict (key) do nothing;

-- Grant to platform_owner (every permission, already covered by the
-- cross-join-all-permissions seed in 20260826121055). Deliberately NOT
-- granted to platform_operations by default (unlike
-- platform.whatsapp_tenant.manage) -- operating Mal3aby's own sales/
-- commercial WhatsApp channel is a narrower, more sensitive capability
-- than supporting a club's connection, and the owner's decision #21
-- specifically calls out that these must not be implicitly linked. A
-- role needing both must be granted both explicitly, e.g. via a custom
-- platform role -- not by holding either seeded role.
-- ============================================================

-- ============================================================
-- 6. Platform-owner-facing RPCs -- mirror the exact
--    platform_start_whatsapp_pairing/platform_disconnect_whatsapp/
--    platform_retry_whatsapp_connection/platform_get_whatsapp_qr shape
--    from 20260909150000, operating on platform_whatsapp_account
--    instead of whatsapp_accounts, with NO p_club_id parameter (there
--    is exactly one platform account, never ambiguous which one).
-- ============================================================

create or replace function public.platform_get_whatsapp_own_qr()
returns table(qr_payload text, qr_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  return query
    select pa.qr_payload, pa.qr_expires_at
    from public.platform_whatsapp_account pa
    where pa.status = 'qr_required' and pa.qr_expires_at > now();
end;
$$;

revoke execute on function public.platform_get_whatsapp_own_qr() from public, anon;
grant execute on function public.platform_get_whatsapp_own_qr() to authenticated;

create or replace function public.platform_get_whatsapp_status()
returns table(
  status text,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  qr_expires_at timestamptz,
  circuit_breaker_open_until timestamptz,
  last_successful_send_at timestamptz
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
           pa.last_error, pa.qr_expires_at, pa.circuit_breaker_open_until, pa.last_successful_send_at
    from public.platform_whatsapp_account pa;
end;
$$;

revoke execute on function public.platform_get_whatsapp_status() from public, anon;
grant execute on function public.platform_get_whatsapp_status() to authenticated;

create or replace function public.platform_start_whatsapp_own_pairing(p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  select to_jsonb(pa) into v_before from public.platform_whatsapp_account pa;

  update public.platform_whatsapp_account
  set status = 'connecting', qr_payload = null, qr_expires_at = null, last_error = null,
      updated_at = now(), updated_by = auth.uid();

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('pairing_requested', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.pairing_requested', 'platform_whatsapp_account', null,
    v_before, jsonb_build_object('status', 'connecting'), p_reason
  );
end;
$$;

revoke execute on function public.platform_start_whatsapp_own_pairing(text) from public, anon;
grant execute on function public.platform_start_whatsapp_own_pairing(text) to authenticated;

create or replace function public.platform_retry_whatsapp_own_connection(p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  select to_jsonb(pa) into v_before from public.platform_whatsapp_account pa;

  update public.platform_whatsapp_account
  set status = 'connecting', qr_payload = null, qr_expires_at = null, last_error = null,
      updated_at = now(), updated_by = auth.uid();

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('retry_requested', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.retry_requested', 'platform_whatsapp_account', null,
    v_before, jsonb_build_object('status', 'connecting'), coalesce(p_reason, 'retry after failed connection')
  );
end;
$$;

revoke execute on function public.platform_retry_whatsapp_own_connection(text) from public, anon;
grant execute on function public.platform_retry_whatsapp_own_connection(text) to authenticated;

-- Destructive -- reason REQUIRED, same validation shape as
-- platform_disconnect_whatsapp/platform_suspend_club.
create or replace function public.platform_disconnect_whatsapp_own(p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to disconnect the platform WhatsApp connection';
  end if;

  select to_jsonb(pa) into v_before from public.platform_whatsapp_account pa;

  update public.platform_whatsapp_account
  set status = 'disconnected', qr_payload = null, qr_expires_at = null,
      updated_at = now(), updated_by = auth.uid();

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('disconnect_requested', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.disconnected', 'platform_whatsapp_account', null,
    v_before, jsonb_build_object('status', 'disconnected'), p_reason
  );
end;
$$;

revoke execute on function public.platform_disconnect_whatsapp_own(text) from public, anon;
grant execute on function public.platform_disconnect_whatsapp_own(text) to authenticated;

create or replace function public.platform_get_whatsapp_own_recent_events(p_limit int default 20)
returns table(id uuid, event text, actor_id uuid, actor_name text, detail jsonb, created_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  return query
    select e.id, e.event, e.actor_id, p.full_name as actor_name, e.detail, e.created_at
    from public.platform_whatsapp_connection_events e
    left join public.profiles p on p.user_id = e.actor_id
    order by e.created_at desc
    limit least(greatest(p_limit, 1), 100);
end;
$$;

revoke execute on function public.platform_get_whatsapp_own_recent_events(int) from public, anon;
grant execute on function public.platform_get_whatsapp_own_recent_events(int) to authenticated;

-- "TEST CONNECTION" action from the correction's UI requirements --
-- mirrors the existing /manage/:clubId/diagnostic-send Worker route's
-- own safety shape (hardcoded QA-safe target, no arbitrary recipient,
-- no template/media) rather than inventing a new send path. This RPC
-- does NOT itself send anything (no RPC in this schema calls Cloudflare
-- directly, per the same rationale as
-- platform_flag_whatsapp_container_restart in the tenant-WhatsApp
-- migration) -- it records an audited test-request intent, the same
-- "record intent, a human/connector-side action fulfills it" pattern
-- every other mutating RPC in this whole WhatsApp schema already uses.
create or replace function public.platform_flag_whatsapp_own_test_connection(p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('test_connection_flagged', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.test_connection_flagged', 'platform_whatsapp_account', null,
    null, null, p_reason
  );
end;
$$;

revoke execute on function public.platform_flag_whatsapp_own_test_connection(text) from public, anon;
grant execute on function public.platform_flag_whatsapp_own_test_connection(text) to authenticated;

-- ============================================================
-- 7. Connector-facing RPCs -- service_role only (deliberately no grant
--    to authenticated/anon, defense-in-depth revoke, matching every
--    whatsapp_connector_* RPC's own convention exactly).
-- ============================================================

create or replace function public.whatsapp_connector_report_platform_status(
  p_status text,
  p_qr_payload text default null,
  p_qr_ttl_seconds integer default null,
  p_connected_phone_number text default null,
  p_error text default null,
  p_generation integer default 0,
  p_state_seq integer default 0
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current_generation integer;
  v_current_state_seq integer;
begin
  if p_status not in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'degraded', 'logged_out', 'restricted', 'failed', 'error'
  ) then
    raise exception 'invalid status';
  end if;

  select last_generation, last_state_seq into v_current_generation, v_current_state_seq
  from public.platform_whatsapp_account for update;

  if p_generation < v_current_generation
    or (p_generation = v_current_generation and p_state_seq <= v_current_state_seq)
  then
    insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
    values ('status_write_rejected_stale', null, jsonb_build_object(
      'attempted_status', p_status, 'attempted_generation', p_generation, 'attempted_state_seq', p_state_seq,
      'current_generation', v_current_generation, 'current_state_seq', v_current_state_seq
    ));
    return;
  end if;

  update public.platform_whatsapp_account
  set status = p_status,
      qr_payload = case when p_status = 'qr_required' then p_qr_payload else null end,
      qr_expires_at = case when p_status = 'qr_required' and p_qr_ttl_seconds is not null then now() + make_interval(secs => p_qr_ttl_seconds) else null end,
      connected_phone_number = case when p_status = 'connected' then coalesce(p_connected_phone_number, connected_phone_number) when p_status in ('disconnected', 'logged_out') then null else connected_phone_number end,
      connected_at = case when p_status = 'connected' and connected_at is null then now() when p_status in ('disconnected', 'logged_out') then null else connected_at end,
      last_seen_at = case when p_status = 'connected' then now() else last_seen_at end,
      last_error = p_error,
      last_generation = p_generation,
      last_state_seq = p_state_seq,
      updated_at = now();

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('status_' || p_status, null, jsonb_build_object('error', p_error));
end;
$$;

revoke execute on function public.whatsapp_connector_report_platform_status(text, text, integer, text, text, integer, integer) from public, anon, authenticated;

create or replace function public.whatsapp_connector_store_platform_session(p_session_credentials_encrypted bytea)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.platform_whatsapp_account
  set session_credentials_encrypted = p_session_credentials_encrypted, updated_at = now();
$$;

revoke execute on function public.whatsapp_connector_store_platform_session(bytea) from public, anon, authenticated;

create or replace function public.whatsapp_connector_load_platform_session()
returns bytea
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select session_credentials_encrypted from public.platform_whatsapp_account;
$$;

revoke execute on function public.whatsapp_connector_load_platform_session() from public, anon, authenticated;

-- The connector's second discovery point, called alongside its existing
-- whatsapp_connector_list_accounts() -- deliberately a SEPARATE RPC,
-- not a UNION ALL widening of the existing one, so the connector's
-- session_key (a real UUID, but never a public.clubs.id) can never be
-- silently treated as a club_id anywhere downstream in the connector's
-- own per-club business logic (e.g. TenantConnectionManager's maps are
-- keyed by whatever string this returns -- the platform sentinel key
-- flows through the exact same opaque-key machinery as any club_id,
-- but the connector never needs to know it isn't one).
create or replace function public.whatsapp_connector_get_platform_session_key()
returns table(session_key uuid, status text)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select pa.session_key, pa.status from public.platform_whatsapp_account pa
  where pa.session_credentials_encrypted is not null or pa.status = 'connecting';
$$;

revoke execute on function public.whatsapp_connector_get_platform_session_key() from public, anon, authenticated;

-- Mirrors whatsapp_connector_claim_next_batch()'s rate-limiting shape
-- but against platform_whatsapp_safety_settings/platform_whatsapp_queue
-- instead of messaging_safety_settings/notification_queue -- no
-- consent-table join (a lead has no customers/notification_consent
-- row, by design, per this migration's own header comment).
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
        pa.status = 'connected' as is_connected
      from public.platform_whatsapp_account pa
    ),
    recent_activity as (
      select
        count(*) filter (where last_attempt_at > now() - interval '1 minute') as sent_last_minute,
        count(*) filter (where last_attempt_at > now() - interval '1 hour') as sent_last_hour
      from public.platform_whatsapp_queue
      where status in ('processing', 'sent')
    ),
    settings as (select * from public.platform_whatsapp_safety_settings),
    candidates as (
      select q.id, q.scheduled_at, q.recipient_phone
      from public.platform_whatsapp_queue q, breaker b, recent_activity ra, settings s
      where b.is_open and b.is_connected
        and q.status in ('pending', 'retrying')
        and q.scheduled_at <= now()
        and (q.next_attempt_at is null or q.next_attempt_at <= now())
        and coalesce(ra.sent_last_minute, 0) < s.max_sends_per_minute
        and coalesce(ra.sent_last_hour, 0) < s.max_sends_per_hour
        and not exists (
          select 1 from public.platform_whatsapp_queue q2
          where q2.recipient_phone = q.recipient_phone
            and q2.status in ('processing', 'sent')
            and q2.last_attempt_at > now() - make_interval(mins => s.min_minutes_between_recipient_sends)
        )
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

create or replace function public.whatsapp_connector_report_platform_send_result(
  p_id uuid,
  p_success boolean,
  p_error text default null,
  p_provider_reference text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.platform_whatsapp_queue
  set status = case when p_success then 'sent' else 'retrying' end,
      last_error = p_error,
      provider_reference = coalesce(p_provider_reference, provider_reference)
  where id = p_id;

  if p_success then
    update public.platform_whatsapp_account set last_successful_send_at = now();
  end if;
end;
$$;

revoke execute on function public.whatsapp_connector_report_platform_send_result(uuid, boolean, text, text) from public, anon, authenticated;

-- ============================================================
-- 8. sales_queue_platform_whatsapp_message: the Sales Intelligence
--    integration point -- FLAGGED, DELIBERATELY NOT WIRED TO A REAL
--    CHANNEL YET. Read this comment in full before removing the guard
--    below.
--
--    A genuine, pre-existing, documented product-policy conflict was
--    found while building this and is recorded here rather than
--    silently resolved, per this mission's own instruction ("if current
--    architecture differs, document it clearly before changing
--    behavior") and the earlier Sales Intelligence mission's own
--    explicit rule: sales_queue_outreach_message()
--    (20260904090400_sales_intelligence_scoring_outreach_conversion.
--    sql:277-283) has a hardcoded, commented rejection of any non-email
--    channel, citing "the mission's Phase 11 hard rule: DO NOT
--    IMPLEMENT AUTOMATED COLD WHATSAPP OUTREACH... do not touch the
--    existing WhatsApp subsystem." The one non-email channel that could
--    plausibly map to a WhatsApp send, whatsapp_talking_points,
--    generates a multi-section HUMAN CALL/CHAT SCRIPT (opening,
--    discovery questions, objection handling, CTA -- confirmed by
--    reading its exact generation prompt, sales-ai-offer-generator/
--    index.ts:292-317) explicitly meant "for a salesperson to use when
--    calling/messaging a real prospect," not literal ready-to-send
--    message text. Queuing that raw text as one automated WhatsApp
--    message would be both a UX defect (a labeled multi-section script
--    sent as one message) and a reversal of a documented prior product
--    decision this mission was not explicitly asked to reverse.
--
--    This function is written and correctly scoped/permissioned/
--    isolated (platform_whatsapp_queue only, no club_id anywhere, human
--    approval required upstream) but is LEFT DISABLED via the raise
--    exception below until the owner makes an explicit decision,
--    recorded in FINAL_OWNER_DECISIONS_REQUIRED.md: either (a) add a
--    genuinely new outreach channel/generation prompt purpose-built for
--    a single, literal, send-ready WhatsApp message (distinct from the
--    call-script-shaped whatsapp_talking_points), or (b) confirm
--    whatsapp_talking_points itself should be sent as-is and this guard
--    should be removed. The rest of this migration (the platform
--    WhatsApp connection itself, its QR/connect/disconnect/status
--    control surface) is fully built and independent of this one
--    unresolved question -- Platform WhatsApp is usable today for
--    manual, human-composed messages via its own connection; only the
--    AI-draft-to-automated-WhatsApp-send pipeline is paused pending
--    that decision.
-- ============================================================
create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_message public.sales_outreach_messages;
  v_lead public.sales_leads;
  v_phone text;
  v_queue_id uuid;
begin
  if not (
    auth.uid() is null
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.send_outreach')
  ) then
    raise exception 'not authorized';
  end if;

  select * into v_message from public.sales_outreach_messages where id = p_message_id;
  if v_message.id is null then
    raise exception 'outreach message not found';
  end if;

  if v_message.status <> 'approved' then
    raise exception 'only an approved message can be queued for sending';
  end if;

  -- DELIBERATELY DISABLED -- see the migration-level comment above this
  -- function. whatsapp_talking_points is a human call/chat script, not
  -- send-ready message text; there is no channel value today that
  -- represents a literal, single, send-ready WhatsApp message. Do not
  -- remove this guard without the explicit owner decision documented
  -- above.
  raise exception 'automated WhatsApp send from an AI-generated draft is not yet enabled -- whatsapp_talking_points drafts are human call/chat scripts, not send-ready message text (see this function''s migration-level comment for the full product-policy question this raises, recorded in FINAL_OWNER_DECISIONS_REQUIRED.md). The platform WhatsApp CONNECTION is fully available for manual, human-composed messages.';

  select * into v_lead from public.sales_leads where id = v_message.lead_id;
  v_phone := coalesce(v_lead.whatsapp_public_number, v_lead.public_phone);
  if v_phone is null then
    raise exception 'this lead has no phone number on file to send WhatsApp to';
  end if;

  insert into public.platform_whatsapp_queue (lead_id, outreach_message_id, recipient_phone, message_body, requested_by)
  values (v_message.lead_id, v_message.id, v_phone, coalesce(v_message.body, ''), auth.uid())
  returning id into v_queue_id;

  update public.sales_outreach_messages set status = 'queued' where id = p_message_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (v_message.lead_id, 'message_queued', jsonb_build_object('message_id', p_message_id, 'queue_id', v_queue_id, 'via', 'platform_whatsapp'), auth.uid());

  return v_queue_id;
end;
$$;

revoke execute on function public.sales_queue_platform_whatsapp_message(uuid) from public, anon;
grant execute on function public.sales_queue_platform_whatsapp_message(uuid) to authenticated;

comment on function public.sales_queue_platform_whatsapp_message(uuid) is
  'DELIBERATELY DISABLED (raises unconditionally) pending an explicit owner decision -- see this function''s own body comment and FINAL_OWNER_DECISIONS_REQUIRED.md. Correctly scoped/isolated/permissioned once enabled: queues an approved outreach message for sending through the PLATFORM WhatsApp account only -- never a club''s, no p_club_id parameter exists on this function at all.';
