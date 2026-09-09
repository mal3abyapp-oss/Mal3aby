-- PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 1: WhatsApp
-- Connection Control.
--
-- CONFIRMED GAP (architecture inspection, 2026-09-09): a Platform Owner
-- can currently only SEE WhatsApp connection state (get_platform_whatsapp_health,
-- get_whatsapp_usage_platform_wide, both read-only, already shipped) but has
-- NO way to connect/disconnect/reconnect/view-QR for a club they do not
-- personally own -- every existing mutating RPC
-- (start_whatsapp_pairing/disconnect_whatsapp/get_whatsapp_qr,
-- 20260817110000_whatsapp_connection_model_v2.sql) is gated on
-- `p_club_id in (select user_club_ids())`, which structurally excludes a
-- platform staff/owner account that is not itself a club member.
--
-- FIX: new, SEPARATE platform_* RPCs, mirroring the exact intent-flag /
-- audit-event pattern the existing club-facing RPCs already use (this is
-- NOT a redesign -- same whatsapp_accounts/whatsapp_connection_events
-- tables, same "record intent, the connector's own 3s poll picks it up"
-- model, same status enum). The only thing that changes is the
-- authorization check: is_platform_owner() OR
-- has_platform_permission('platform.whatsapp.manage') instead of
-- club membership. Every action also writes to the platform-wide
-- audit_logs table (via write_audit_log), matching every other
-- platform_* RPC's convention -- the existing club-facing RPCs only
-- write to whatsapp_connection_events, not audit_logs, since a club
-- owner acting on their own account isn't a platform-level event; a
-- platform staff member acting on someone else's tenant is.
--
-- New permission key: platform.whatsapp.manage (connect/disconnect/
-- reconnect a club's WhatsApp session on their behalf). Read access
-- reuses the existing platform.club.view permission (already required
-- by get_platform_whatsapp_health) -- no new read-only permission key
-- needed, consistent with how Tenant 360's other operational cards work.
--
-- Reason REQUIRED (not optional-with-default-null) for
-- platform_disconnect_whatsapp -- this is exactly the class of
-- destructive/reversible-but-disruptive action (directive's own
-- language: "add reason/confirmation for destructive actions such as
-- disconnect/reset session") that this codebase's own established
-- pattern (platform_suspend_club, 20260817100225) already requires a
-- reason for. platform_start_whatsapp_pairing/platform_retry_whatsapp_connection
-- are NOT destructive (they only ever move toward a connection, never
-- away from one) so reason stays optional there, matching
-- start_whatsapp_pairing's own club-facing precedent.

insert into public.platform_permissions (key, group_key) values
  ('platform.whatsapp.manage', 'clubs')
on conflict (key) do nothing;

-- Grant to platform_owner (every permission, already covered by the
-- cross-join-all-permissions seed in 20260826121055) and to
-- platform_operations, which already holds platform.club.manage --
-- WhatsApp connection management is an operational, not financial or
-- staff-administration, concern, matching that role's existing scope.
insert into public.platform_role_permissions (platform_role_id, platform_permission_id)
select r.id, p.id from public.platform_roles r join public.platform_permissions p
  on p.key = 'platform.whatsapp.manage'
where r.key = 'platform_operations'
on conflict do nothing;

-- ============================================================
-- platform_get_whatsapp_qr: narrow QR-only read, mirrors get_whatsapp_qr's
-- own separation-of-concerns rationale (QR polling is high-frequency,
-- keep the payload minimal). Read-only, platform.club.view is sufficient
-- (same tier as get_platform_whatsapp_health).
-- ============================================================
create or replace function public.platform_get_whatsapp_qr(p_club_id uuid)
returns table(qr_payload text, qr_expires_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  return query
    select wa.qr_payload, wa.qr_expires_at
    from public.whatsapp_accounts wa
    where wa.club_id = p_club_id and wa.status = 'qr_required' and wa.qr_expires_at > now();
end;
$$;

revoke execute on function public.platform_get_whatsapp_qr(uuid) from public, anon;
grant execute on function public.platform_get_whatsapp_qr(uuid) to authenticated;

-- ============================================================
-- platform_start_whatsapp_pairing: Platform Owner-initiated connect.
-- Not destructive -- reason optional. Records BOTH the existing
-- whatsapp_connection_events row (so the connector's own event log and
-- the club's own connection-history view stay consistent with a
-- club-owner-initiated connect) AND a platform-wide audit_logs row
-- (so this shows up in Platform Owner's own Audit Log page, since this
-- action was taken on the club's behalf, not by the club itself).
-- ============================================================
create or replace function public.platform_start_whatsapp_pairing(p_club_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp.manage')) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select to_jsonb(wa) into v_before from public.whatsapp_accounts wa where wa.club_id = p_club_id;

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
  values (p_club_id, 'pairing_requested', auth.uid(), jsonb_build_object('initiated_by', 'platform_owner'));

  perform public.write_audit_log(
    p_club_id, 'platform_whatsapp.pairing_requested', 'whatsapp_accounts', p_club_id,
    v_before, jsonb_build_object('status', 'connecting'), p_reason
  );
end;
$$;

revoke execute on function public.platform_start_whatsapp_pairing(uuid, text) from public, anon;
grant execute on function public.platform_start_whatsapp_pairing(uuid, text) to authenticated;

-- ============================================================
-- platform_retry_whatsapp_connection: identical mechanics to
-- platform_start_whatsapp_pairing (start_whatsapp_pairing's own
-- club-facing RPC is already idempotent/reused for retry, per
-- WhatsAppConnectionCard.tsx's own "retry -> same RPC again" comment) --
-- a separate name/function body (not a call-through to
-- platform_start_whatsapp_pairing, to avoid a fragile post-hoc row
-- rename) only so the frontend and audit trail can distinguish
-- "first connect" from "retry after failure" intent for a clearer
-- Audit Log entry.
-- ============================================================
create or replace function public.platform_retry_whatsapp_connection(p_club_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp.manage')) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select to_jsonb(wa) into v_before from public.whatsapp_accounts wa where wa.club_id = p_club_id;

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
  values (p_club_id, 'retry_requested', auth.uid(), jsonb_build_object('initiated_by', 'platform_owner'));

  perform public.write_audit_log(
    p_club_id, 'platform_whatsapp.retry_requested', 'whatsapp_accounts', p_club_id,
    v_before, jsonb_build_object('status', 'connecting'), coalesce(p_reason, 'retry after failed connection')
  );
end;
$$;

revoke execute on function public.platform_retry_whatsapp_connection(uuid, text) from public, anon;
grant execute on function public.platform_retry_whatsapp_connection(uuid, text) to authenticated;

-- ============================================================
-- platform_disconnect_whatsapp: THE destructive action. Reason
-- REQUIRED (raises if null/empty/whitespace-only), matching
-- platform_suspend_club's exact validation shape
-- (20260817100225_platform_suspend_reactivate_club_with_reason.sql).
-- ============================================================
create or replace function public.platform_disconnect_whatsapp(p_club_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp.manage')) then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to disconnect a club''s WhatsApp connection';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select to_jsonb(wa) into v_before from public.whatsapp_accounts wa where wa.club_id = p_club_id;
  if v_before is null then
    raise exception 'this club has no WhatsApp connection to disconnect';
  end if;

  -- Marks intent; the connector picks up this transition and actually
  -- tears down the Baileys socket + clears session_credentials_encrypted
  -- once it has done so -- identical mechanics to the club-facing
  -- disconnect_whatsapp(), just a different caller identity.
  update public.whatsapp_accounts
  set status = 'disconnected',
      qr_payload = null,
      qr_expires_at = null,
      updated_at = now(),
      updated_by = auth.uid()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'disconnect_requested', auth.uid(), jsonb_build_object('initiated_by', 'platform_owner', 'reason', p_reason));

  perform public.write_audit_log(
    p_club_id, 'platform_whatsapp.disconnected', 'whatsapp_accounts', p_club_id,
    v_before, jsonb_build_object('status', 'disconnected'), p_reason
  );
end;
$$;

revoke execute on function public.platform_disconnect_whatsapp(uuid, text) from public, anon;
grant execute on function public.platform_disconnect_whatsapp(uuid, text) to authenticated;

-- ============================================================
-- platform_restart_whatsapp_container: the one action that maps to the
-- Cloudflare Worker's /manage/:clubId/restart route (WhatsAppAccountObject
-- .stop(), a container-level restart, NOT a WhatsApp logout -- the
-- encrypted session is untouched, matching the Worker's own
-- disconnectGracefully-on-SIGTERM semantics documented in
-- TenantConnectionManager.ts). This RPC does NOT call the Worker itself
-- (no Supabase-to-Cloudflare-Worker HTTP path exists in this schema) --
-- it records the request as an audited intent for a human operator (or
-- a future automation) to action via the Worker's own
-- MANAGEMENT_API_TOKEN-gated /manage/:clubId/restart route, exactly
-- mirroring how start_whatsapp_pairing/disconnect_whatsapp already only
-- ever record intent for the connector's own poller to pick up -- no
-- RPC in this entire schema calls out to Cloudflare directly, and this
-- one does not become the first exception.
-- ============================================================
create or replace function public.platform_flag_whatsapp_container_restart(p_club_id uuid, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp.manage')) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'container_restart_flagged', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    p_club_id, 'platform_whatsapp.container_restart_flagged', 'whatsapp_accounts', p_club_id,
    null, null, p_reason
  );
end;
$$;

revoke execute on function public.platform_flag_whatsapp_container_restart(uuid, text) from public, anon;
grant execute on function public.platform_flag_whatsapp_container_restart(uuid, text) to authenticated;

-- ============================================================
-- platform_get_whatsapp_recent_events: recent connection-event history
-- for one club (the "view recent failures" / "view recent delivery
-- state" surface the directive asks for), platform-scoped read via the
-- existing platform-owner RLS policy on whatsapp_connection_events
-- (whatsapp_connection_events_platform_owner_select,
-- 20260817110000_whatsapp_connection_model_v2.sql) -- this RPC widens
-- that existing platform-owner-only read to also accept
-- platform.club.view staff, matching the read-tier used by
-- get_platform_whatsapp_health.
-- ============================================================
create or replace function public.platform_get_whatsapp_recent_events(p_club_id uuid, p_limit int default 20)
returns table(
  id uuid,
  event text,
  actor_id uuid,
  actor_name text,
  detail jsonb,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  return query
    select e.id, e.event, e.actor_id, p.full_name as actor_name, e.detail, e.created_at
    from public.whatsapp_connection_events e
    left join public.profiles p on p.user_id = e.actor_id
    where e.club_id = p_club_id
    order by e.created_at desc
    limit least(greatest(p_limit, 1), 100);
end;
$$;

revoke execute on function public.platform_get_whatsapp_recent_events(uuid, int) from public, anon;
grant execute on function public.platform_get_whatsapp_recent_events(uuid, int) to authenticated;

comment on function public.platform_start_whatsapp_pairing(uuid, text) is
  'Platform Owner/staff-initiated WhatsApp connect for any club (not just clubs they own). Mirrors start_whatsapp_pairing() mechanics exactly; authorization is is_platform_owner() OR platform.whatsapp.manage instead of club membership. Also writes to platform-wide audit_logs.';
comment on function public.platform_disconnect_whatsapp(uuid, text) is
  'Platform Owner/staff-initiated WhatsApp disconnect for any club. Destructive -- requires a real non-empty reason, matching platform_suspend_club''s validation shape. Mirrors disconnect_whatsapp() mechanics exactly.';
comment on function public.platform_retry_whatsapp_connection(uuid, text) is
  'Same mechanics as platform_start_whatsapp_pairing, distinct name/audit event for a clearer Audit Log entry when retrying after a failure.';
comment on function public.platform_flag_whatsapp_container_restart(uuid, text) is
  'Records an audited request for a human operator to restart a club''s WhatsApp container via the Cloudflare Worker''s MANAGEMENT_API_TOKEN-gated /manage/:clubId/restart route -- no RPC in this schema calls Cloudflare directly, this one does not become the first exception.';
comment on function public.platform_get_whatsapp_recent_events(uuid, int) is
  'Recent whatsapp_connection_events for one club, widened to platform.club.view staff (not just is_platform_owner(), which the existing RLS policy alone would require).';
