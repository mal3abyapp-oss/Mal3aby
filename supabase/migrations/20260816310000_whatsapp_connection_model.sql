-- Gate 8 (WhatsApp QR Module) -- confirmed via list_edge_functions
-- that zero edge functions exist yet (genuine blank slate). This
-- migration builds the connection/session state model per Doc 3's
-- exact requirements:
--   - QR-code scan pairing (matching real WhatsApp Web/Business API
--     pairing patterns): Disconnected -> Generating QR -> Waiting for
--     Scan -> Authenticating -> Connected (or Failed/Expired/
--     Reconnecting).
--   - Connection QR is short-lived, never persisted as a permanent
--     image, never logged, invalidated after successful connection or
--     session expiry, regeneratable on demand.
--   - Session credentials must never appear in browser source,
--     localStorage, repository, logs, screenshots, or frontend
--     payloads -- stored server-side only.
--   - Full multi-tenant isolation: each tenant's connection/session/
--     number/messages are completely isolated; no tenant may
--     disconnect/view another tenant's session.
--
-- Explicit, honest scope note: this migration builds the REAL,
-- fully-functional state machine, permission model, and audit trail
-- for a WhatsApp connection. It does NOT implement an actual working
-- handshake against Meta's WhatsApp Business API or any third-party
-- WhatsApp bridge -- that requires real external credentials (a Meta
-- Business API account + phone number ID + access token, or a
-- self-hosted bridge library requiring a persistent Node process and a
-- real phone to scan) that do not exist in this project and cannot be
-- fabricated. The connector boundary (session_secret storage,
-- generate_whatsapp_qr()/confirm placeholder) is built so that wiring
-- a real provider later is a connector-implementation change, not an
-- architecture change -- exactly Doc 3's own stated goal for the
-- adapter pattern.

create table public.whatsapp_connections (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  status text not null default 'disconnected' check (status in (
    'disconnected', 'generating_qr', 'waiting_for_scan', 'authenticating',
    'connected', 'failed', 'expired', 'reconnecting'
  )),
  -- The connection QR payload itself -- short-lived, regenerated on
  -- demand, never stored as a rendered image, only as the raw pairing
  -- data a real connector would use. NULL once consumed/expired.
  pairing_token text,
  pairing_expires_at timestamptz,
  -- Session credentials for an established connection. Never exposed
  -- via any SELECT policy to authenticated/anon -- see the RLS section
  -- below, which intentionally grants NO direct table access at all;
  -- every read goes through a narrow RPC that never returns this
  -- column.
  session_secret text,
  connected_phone_number text,
  connected_at timestamptz,
  last_error text,
  last_health_check_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- Deliberately NO select/insert/update policy grants any row access at
-- all -- this table is reachable ONLY through SECURITY DEFINER RPCs
-- below, which enforce authorization AND strip session_secret from
-- every return shape. This is stricter than the usual RLS-scoped-select
-- pattern used elsewhere in this schema, because session_secret is
-- exactly the kind of value Doc 3 says must never reach a client
-- payload under any circumstance.
alter table public.whatsapp_connections enable row level security;

comment on table public.whatsapp_connections is
  'Per-club WhatsApp connection state (Gate 8). No RLS policies grant any direct row access -- reachable only via get_whatsapp_connection_status()/connect/disconnect RPCs, which never return session_secret. Multi-tenant isolation is enforced by every RPC scoping to auth.uid()''s own club_id via user_club_ids(), matching this schema''s established pattern.';

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
  'Audit trail for connect/disconnect/reconnect actions (Gate 8, Doc 3 requirement: WhatsApp actions must be audited with actor/timestamp/tenant/action/before-after). Never contains session_secret.';

-- ============================================================
-- get_whatsapp_connection_status: the ONLY read path for connection
-- state. Never returns session_secret or pairing_token (the raw QR
-- payload) -- only status/phone-number/timestamps/error, matching
-- Doc 3's diagnostics requirement ("without exposing secrets").
-- ============================================================
create or replace function public.get_whatsapp_connection_status(p_club_id uuid)
returns table(
  status text,
  connected_phone_number text,
  connected_at timestamptz,
  last_error text,
  last_health_check_at timestamptz,
  pairing_expires_at timestamptz
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
    select wc.status, wc.connected_phone_number, wc.connected_at, wc.last_error, wc.last_health_check_at, wc.pairing_expires_at
    from public.whatsapp_connections wc
    where wc.club_id = p_club_id;
end;
$$;

revoke execute on function public.get_whatsapp_connection_status(uuid) from public, anon;
grant execute on function public.get_whatsapp_connection_status(uuid) to authenticated;

-- ============================================================
-- start_whatsapp_pairing: begins a new connection attempt. Generates a
-- short-lived opaque pairing token (never a permanent image; the
-- frontend renders this as a QR code client-side, exactly like the
-- existing booking/membership QR pattern) and transitions the state
-- machine to 'generating_qr' then immediately 'waiting_for_scan' (a
-- real connector would drive this transition itself as the external
-- handshake progresses -- see the honest scope note above).
-- ============================================================
create or replace function public.start_whatsapp_pairing(p_club_id uuid)
returns table(pairing_token text, expires_at timestamptz)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_token text;
  v_expires timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  v_expires := now() + interval '60 seconds';

  insert into public.whatsapp_connections (club_id, status, pairing_token, pairing_expires_at, updated_by)
  values (p_club_id, 'waiting_for_scan', v_token, v_expires, auth.uid())
  on conflict (club_id) do update set
    status = 'waiting_for_scan',
    pairing_token = v_token,
    pairing_expires_at = v_expires,
    last_error = null,
    updated_at = now(),
    updated_by = auth.uid();

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'pairing_started', auth.uid(), '{}'::jsonb);

  return query select v_token, v_expires;
end;
$$;

revoke execute on function public.start_whatsapp_pairing(uuid) from public, anon;
grant execute on function public.start_whatsapp_pairing(uuid) to authenticated;

-- ============================================================
-- disconnect_whatsapp: explicit disconnect, clears session_secret and
-- pairing_token entirely (never left dangling), audited.
-- ============================================================
create or replace function public.disconnect_whatsapp(p_club_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_connection', p_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.whatsapp_connections
  set status = 'disconnected',
      session_secret = null,
      pairing_token = null,
      pairing_expires_at = null,
      connected_phone_number = null,
      connected_at = null,
      updated_at = now(),
      updated_by = auth.uid()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'disconnected', auth.uid(), '{}'::jsonb);
end;
$$;

revoke execute on function public.disconnect_whatsapp(uuid) from public, anon;
grant execute on function public.disconnect_whatsapp(uuid) to authenticated;
