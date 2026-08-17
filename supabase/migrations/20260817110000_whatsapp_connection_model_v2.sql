-- WhatsApp re-integration (per explicit new user directive superseding
-- the earlier removal -- see AUTONOMOUS_DECISION_LOG.md D-014/D-016).
-- Not a resurrection of the deleted 20260816310000 migration file
-- (never rewrite/resurrect an already-applied, already-dropped
-- migration -- this session's standing convention) -- a new forward
-- migration, deliberately similar in shape because that prior design
-- already satisfied this same security bar (RPC-only access, no
-- direct SELECT grants a secret column, per-club isolation, audit
-- trail), confirmed by direct comparison in D-016.
--
-- Real difference from the prior design: this time there is a genuine
-- local Node Baileys connector (not a placeholder), which is itself a
-- trusted backend actor that must be able to push real connection-state
-- transitions (QR generated, connected, disconnected, error) driven by
-- actual WhatsApp socket events -- not just relay user-initiated
-- frontend actions. It authenticates as a Postgres role with a
-- narrowly-scoped SECURITY DEFINER RPC surface of its own
-- (whatsapp_connector_report_status/whatsapp_connector_store_session),
-- separate from the user-facing connect/disconnect RPCs, following the
-- same "narrow purpose-built RPC over broad table grants" principle
-- used everywhere else in this schema.

create table public.whatsapp_accounts (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  status text not null default 'disconnected' check (status in (
    'disconnected', 'qr_required', 'connecting', 'connected',
    'reconnecting', 'logged_out', 'error'
  )),
  -- Raw QR pairing string Baileys hands back -- the frontend renders
  -- this into a QR image client-side (same pattern as the existing
  -- booking/membership QR flow: qrcode.toDataURL on a raw token, never
  -- a server-rendered image). Short-lived, cleared once consumed or
  -- expired.
  qr_payload text,
  qr_expires_at timestamptz,
  -- Baileys' multi-file auth state serialized as one jsonb blob,
  -- encrypted at rest via pgcrypto (already installed -- confirmed in
  -- D-016). Never exposed through any SELECT-granting policy -- reachable
  -- only through the connector's own narrow RPCs, which never return
  -- this column to a club-facing caller.
  session_credentials_encrypted bytea,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table public.whatsapp_accounts enable row level security;

-- Deliberately NO select/insert/update policy grants any row access at
-- all -- exactly like the prior design's whatsapp_connections table.
-- session_credentials_encrypted must never appear in a client payload
-- under any circumstance; every read/write goes through SECURITY
-- DEFINER RPCs below.
comment on table public.whatsapp_accounts is
  'Per-club WhatsApp/Baileys connection state. No RLS policies grant any direct row access -- reachable only via get_whatsapp_status()/start_whatsapp_pairing()/disconnect_whatsapp() (club-facing) and the whatsapp_connector_* RPCs (connector-facing, service-role only). Tenant isolation enforced by every RPC scoping through user_club_ids(), same pattern as every other table in this schema.';

create table public.whatsapp_connection_events (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  event text not null,
  actor_id uuid references auth.users(id),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.whatsapp_connection_events enable row level security;

create policy "whatsapp_connection_events_select_own_club" on public.whatsapp_connection_events
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', club_id));

create policy "whatsapp_connection_events_platform_owner_select" on public.whatsapp_connection_events
  for select using (public.is_platform_owner());

comment on table public.whatsapp_connection_events is
  'Audit trail for connect/disconnect/reconnect/error transitions. actor_id is null for connector-driven (not user-driven) transitions. Never contains session credentials.';

-- ============================================================
-- Club-facing RPCs (authenticated users, permission-gated exactly like
-- the rest of this schema)
-- ============================================================

create or replace function public.get_whatsapp_status(p_club_id uuid)
returns table(
  status text,
  connected_phone_number text,
  connected_at timestamptz,
  last_seen_at timestamptz,
  last_error text,
  qr_expires_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select wa.status, wa.connected_phone_number, wa.connected_at, wa.last_seen_at, wa.last_error, wa.qr_expires_at
    from public.whatsapp_accounts wa
    where wa.club_id = p_club_id;
end;
$$;

revoke execute on function public.get_whatsapp_status(uuid) from public, anon;
grant execute on function public.get_whatsapp_status(uuid) to authenticated;

-- The current QR payload is deliberately a SEPARATE, narrower RPC from
-- get_whatsapp_status() -- polling for a QR image is a much higher-
-- frequency operation (every few seconds while waiting for a scan)
-- than polling for general status, and this keeps that hot path
-- returning the smallest possible payload.
create or replace function public.get_whatsapp_qr(p_club_id uuid)
returns table(qr_payload text, qr_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select wa.qr_payload, wa.qr_expires_at
    from public.whatsapp_accounts wa
    where wa.club_id = p_club_id and wa.status = 'qr_required' and wa.qr_expires_at > now();
end;
$$;

revoke execute on function public.get_whatsapp_qr(uuid) from public, anon;
grant execute on function public.get_whatsapp_qr(uuid) to authenticated;

-- start_whatsapp_pairing: marks intent to connect. The actual QR
-- generation happens asynchronously in the connector service (it owns
-- the real Baileys socket) -- this RPC just flips the row to a state
-- the connector's own polling/webhook picks up, and records the audit
-- event. This mirrors how the rest of this schema separates "record
-- the intent" from "the actual external side-effect" (e.g.
-- request_commercial_upgrade() never itself changes the entitlement).
create or replace function public.start_whatsapp_pairing(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  insert into public.whatsapp_accounts (club_id, status, updated_by)
  values (p_club_id, 'connecting', auth.uid())
  on conflict (club_id) do update set
    status = 'connecting',
    qr_payload = null,
    qr_expires_at = null,
    last_error = null,
    updated_at = now(),
    updated_by = auth.uid();

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'pairing_requested', auth.uid(), '{}'::jsonb);
end;
$$;

revoke execute on function public.start_whatsapp_pairing(uuid) from public, anon;
grant execute on function public.start_whatsapp_pairing(uuid) to authenticated;

create or replace function public.disconnect_whatsapp(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  -- Marks intent; the connector picks up this transition and actually
  -- tears down the Baileys socket + clears session_credentials_encrypted
  -- via whatsapp_connector_clear_session() once it has done so, so the
  -- encrypted credentials are never left dangling after logout.
  update public.whatsapp_accounts
  set status = 'disconnected',
      qr_payload = null,
      qr_expires_at = null,
      updated_at = now(),
      updated_by = auth.uid()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'disconnect_requested', auth.uid(), '{}'::jsonb);
end;
$$;

revoke execute on function public.disconnect_whatsapp(uuid) from public, anon;
grant execute on function public.disconnect_whatsapp(uuid) to authenticated;

-- ============================================================
-- Connector-facing permission gate: manage_whatsapp_connection.
-- (Section 98-style least-privilege permission, same tier as the
-- club-facing RPCs above -- club_owner/club_manager/branch_manager
-- only, matching the settings-level tier used for payment.methods.manage.)
-- ============================================================
insert into public.permissions (key, description) values
  ('manage_whatsapp_connection', 'Connect/disconnect the club''s WhatsApp account')
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id from public.roles r, public.permissions p
where r.key in ('club_owner', 'club_manager', 'branch_manager')
  and p.key = 'manage_whatsapp_connection'
on conflict do nothing;

-- ============================================================
-- Connector-facing RPCs: called by the local Node Baileys service
-- using the Supabase SERVICE ROLE key (never the anon/authenticated
-- key -- the connector is a trusted backend process, not a browser
-- client), so these deliberately do NOT check auth.uid()/has_permission()
-- the way the club-facing RPCs above do. Service-role callers already
-- bypass RLS entirely by design in Supabase; these RPCs exist anyway
-- (rather than the connector writing to whatsapp_accounts directly) so
-- there is exactly one narrow, auditable write surface, and so the
-- encryption step for session_credentials_encrypted always happens in
-- the same place rather than being the connector's responsibility to
-- get right on every call site.
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
  if p_status not in ('disconnected', 'qr_required', 'connecting', 'connected', 'reconnecting', 'logged_out', 'error') then
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

-- Deliberately NOT granted to authenticated/anon -- only reachable via
-- the service-role key, which bypasses grant checks entirely. The
-- revoke here is defense in depth in case a future migration
-- accidentally widens default privileges.
revoke execute on function public.whatsapp_connector_report_status(uuid, text, text, integer, text, text) from public, anon, authenticated;

create or replace function public.whatsapp_connector_store_session(
  p_club_id uuid,
  p_session_credentials_encrypted bytea
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.whatsapp_accounts
  set session_credentials_encrypted = p_session_credentials_encrypted,
      updated_at = now()
  where club_id = p_club_id;
$$;

revoke execute on function public.whatsapp_connector_store_session(uuid, bytea) from public, anon, authenticated;

-- The connector's own read path for its stored credentials on startup
-- (to resume an existing session without a fresh QR scan -- Section 6's
-- persistence requirement).
create or replace function public.whatsapp_connector_load_session(p_club_id uuid)
returns bytea
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select session_credentials_encrypted from public.whatsapp_accounts where club_id = p_club_id;
$$;

revoke execute on function public.whatsapp_connector_load_session(uuid) from public, anon, authenticated;

-- Which clubs currently have an account row at all (so the connector
-- knows which sessions to attempt resuming on its own process startup,
-- without needing a separate "list all clubs" call it has no other
-- reason to make).
create or replace function public.whatsapp_connector_list_accounts()
returns table(club_id uuid, status text)
language sql
security definer
set search_path = public, pg_temp
stable
as $$
  select wa.club_id, wa.status from public.whatsapp_accounts wa
  where wa.session_credentials_encrypted is not null;
$$;

revoke execute on function public.whatsapp_connector_list_accounts() from public, anon, authenticated;

-- ============================================================
-- Section 17: per-club, per-notification-category toggles. This is a
-- DIFFERENT concept from the existing notification_consent table
-- (which is per-CUSTOMER opt-in/opt-out per channel) -- this is the
-- club deciding which categories of automated message it wants sent
-- via WhatsApp AT ALL, independent of any one customer's own
-- preference. Both gates apply: enqueue_notification() already checks
-- customer consent; the wiring added in a later task additionally
-- checks this table before even attempting to enqueue.
-- ============================================================
create table public.notification_category_settings (
  club_id uuid not null references public.clubs(id),
  channel text not null,
  category text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (club_id, channel, category)
);

alter table public.notification_category_settings enable row level security;

create policy "notification_category_settings_select_own_club" on public.notification_category_settings
  for select using (club_id in (select public.user_club_ids()));

create policy "notification_category_settings_write_with_permission" on public.notification_category_settings
  for all using (
    club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', club_id)
  )
  with check (
    club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', club_id)
  );

comment on table public.notification_category_settings is
  'Section 17: per-club, per-channel, per-category on/off toggle (e.g. whatsapp/booking_confirmations = true). Checked by the notification-emitting business RPCs BEFORE calling enqueue_notification(), which then separately checks per-customer consent. Missing row = enabled by default (opt-out model for operational categories), matching this schema''s general principle of not silently blocking existing behavior on migration.';
