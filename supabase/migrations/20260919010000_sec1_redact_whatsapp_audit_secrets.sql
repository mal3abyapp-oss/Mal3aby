-- SEC-1 fix at the write source (2026-09-19, owner brief): six RPCs
-- across the club and platform WhatsApp domains captured a full
-- `to_jsonb(row)` snapshot of whatsapp_accounts/platform_whatsapp_account
-- as audit_logs.before -- including qr_payload (a live WhatsApp
-- pairing link with real key material embedded, confirmed live) and
-- session_credentials_encrypted (bytea key material, encrypted at
-- rest but still has no reason to ever appear in a plaintext audit
-- row). Historical rows already redacted + hash-chain recomputed
-- separately (see scripts/sec1-redact-audit-qr-payloads.sql) -- this
-- migration is the forward-looking fix so no future row leaks the
-- same way.
--
-- public._redact_whatsapp_audit_snapshot() is a single shared helper
-- (one source of truth, matching this codebase's own established
-- convention) that strips exactly the two sensitive keys and nothing
-- else -- every other field (status, last_error, timestamps,
-- connected_phone_number, circuit breaker state, etc.) stays fully
-- visible in the audit trail, since none of that is a secret and all
-- of it is genuinely useful for the exact kind of investigation this
-- audit log exists for.

create or replace function public._redact_whatsapp_audit_snapshot(p_row jsonb)
returns jsonb
language sql
immutable
set search_path to 'public', 'pg_temp'
as $$
  select case
    when p_row is null then null
    else p_row - 'qr_payload' - 'session_credentials_encrypted'
  end;
$$;

revoke all on function public._redact_whatsapp_audit_snapshot(jsonb) from public;
revoke all on function public._redact_whatsapp_audit_snapshot(jsonb) from anon;
revoke all on function public._redact_whatsapp_audit_snapshot(jsonb) from authenticated;
grant execute on function public._redact_whatsapp_audit_snapshot(jsonb) to service_role;

-- Six call sites updated to redact before the value ever reaches
-- write_audit_log(). Every other line in each function is byte-for-byte
-- unchanged from its live definition (confirmed by reading each one in
-- full before writing this migration) -- only the `to_jsonb(...)` call
-- site itself is wrapped.

create or replace function public.platform_start_whatsapp_pairing(p_club_id uuid, p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_tenant.manage')) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select public._redact_whatsapp_audit_snapshot(to_jsonb(wa)) into v_before from public.whatsapp_accounts wa where wa.club_id = p_club_id;

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

create or replace function public.platform_retry_whatsapp_connection(p_club_id uuid, p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_tenant.manage')) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select public._redact_whatsapp_audit_snapshot(to_jsonb(wa)) into v_before from public.whatsapp_accounts wa where wa.club_id = p_club_id;

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

create or replace function public.platform_disconnect_whatsapp(p_club_id uuid, p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_tenant.manage')) then
    raise exception 'not authorized';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to disconnect a club''s WhatsApp connection';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select public._redact_whatsapp_audit_snapshot(to_jsonb(wa)) into v_before from public.whatsapp_accounts wa where wa.club_id = p_club_id;
  if v_before is null then
    raise exception 'this club has no WhatsApp connection to disconnect';
  end if;

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

create or replace function public.platform_start_whatsapp_own_pairing(p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  select public._redact_whatsapp_audit_snapshot(to_jsonb(pa)) into v_before from public.platform_whatsapp_account pa;

  update public.platform_whatsapp_account
  set status = 'connecting', qr_payload = null, qr_expires_at = null, last_error = null,
      updated_at = now(), updated_by = auth.uid()
  where singleton_guard = 1;

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('pairing_requested', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.pairing_requested', 'platform_whatsapp_account', null,
    v_before, jsonb_build_object('status', 'connecting'), p_reason
  );
end;
$$;

create or replace function public.platform_retry_whatsapp_own_connection(p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before jsonb;
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.whatsapp_platform.manage')) then
    raise exception 'not authorized';
  end if;

  select public._redact_whatsapp_audit_snapshot(to_jsonb(pa)) into v_before from public.platform_whatsapp_account pa;

  update public.platform_whatsapp_account
  set status = 'connecting', qr_payload = null, qr_expires_at = null, last_error = null,
      updated_at = now(), updated_by = auth.uid()
  where singleton_guard = 1;

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('retry_requested', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.retry_requested', 'platform_whatsapp_account', null,
    v_before, jsonb_build_object('status', 'connecting'), coalesce(p_reason, 'retry after failed connection')
  );
end;
$$;

create or replace function public.platform_disconnect_whatsapp_own(p_reason text DEFAULT NULL::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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

  select public._redact_whatsapp_audit_snapshot(to_jsonb(pa)) into v_before from public.platform_whatsapp_account pa;

  update public.platform_whatsapp_account
  set status = 'disconnected', qr_payload = null, qr_expires_at = null,
      updated_at = now(), updated_by = auth.uid()
  where singleton_guard = 1;

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('disconnect_requested', auth.uid(), jsonb_build_object('reason', p_reason));

  perform public.write_audit_log(
    null, 'platform_whatsapp_own.disconnected', 'platform_whatsapp_account', null,
    v_before, jsonb_build_object('status', 'disconnected'), p_reason
  );
end;
$$;
