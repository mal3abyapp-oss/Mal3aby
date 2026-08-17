-- Part U: audit connect/disconnect, notification preference changes,
-- consent changes, safety controls changed. The finer-grained
-- whatsapp_connection_events table (connect/reconnect/status
-- transitions, including circuit_breaker_opened from 20260818050000)
-- already exists and is NOT duplicated here -- but it is a
-- WhatsApp-specific side table that the staff-facing Settings ->
-- "الأمان وسجل التدقيق" section does NOT read (that UI reads
-- audit_logs via write_audit_log()). This migration adds
-- write_audit_log() calls so staff-initiated connect/disconnect and
-- safety-control edits are visible in the SAME audit trail as every
-- other sensitive action in this app, not off in a separate table only
-- reachable by direct SQL.
--
-- Deliberately NOT audited (Part U: "do not create noisy audit logs
-- for every internal polling tick"): queue claims, per-message send
-- attempts, expire-stale sweeps, circuit-breaker rate/window
-- evaluations that don't trip -- all high-frequency, connector-internal,
-- and already visible in aggregate via whatsapp_queue_diagnostics
-- without flooding the human-facing audit trail.

-- ============================================================
-- start_whatsapp_pairing / disconnect_whatsapp: REPLACED, same
-- signature/contract, to add a write_audit_log() call alongside the
-- existing whatsapp_connection_events insert.
-- ============================================================
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

  perform public.write_audit_log(p_club_id, 'whatsapp.connect_requested', 'whatsapp_accounts', p_club_id, null, jsonb_build_object('status', 'connecting'), null);
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

  update public.whatsapp_accounts
  set status = 'disconnected',
      qr_payload = null,
      qr_expires_at = null,
      updated_at = now(),
      updated_by = auth.uid()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'disconnect_requested', auth.uid(), '{}'::jsonb);

  perform public.write_audit_log(p_club_id, 'whatsapp.disconnect_requested', 'whatsapp_accounts', p_club_id, null, jsonb_build_object('status', 'disconnected'), null);
end;
$$;

revoke execute on function public.disconnect_whatsapp(uuid) from public, anon;
grant execute on function public.disconnect_whatsapp(uuid) to authenticated;

-- ============================================================
-- Part U: audit trigger for messaging_safety_settings changes
-- (quiet hours / rate limits / circuit breaker config / default
-- language). Trigger-based rather than requiring every client call
-- site to remember an audit call, since MessagingSafetyCard.tsx writes
-- via a direct upsert -- the audit guarantee should not depend on
-- every future caller doing the right thing.
-- ============================================================
create or replace function public.audit_messaging_safety_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Only a genuine UPDATE is a "settings changed" event -- the initial
  -- row is system auto-provisioned (ensure_messaging_safety_settings()
  -- trigger, task #98) with no staff actor and default values, not a
  -- staff action worth an audit entry. auth.uid() is also typically
  -- null in that system-provisioning path, so this guard doubles as
  -- avoiding a null-actor audit row.
  if tg_op = 'UPDATE' then
    perform public.write_audit_log(
      new.club_id, 'whatsapp.safety_settings_changed', 'messaging_safety_settings', new.club_id,
      to_jsonb(old), to_jsonb(new), null
    );
  end if;
  return new;
end;
$$;

create trigger trg_audit_messaging_safety_settings
  after update on public.messaging_safety_settings
  for each row execute function public.audit_messaging_safety_settings_change();

-- ============================================================
-- Part U: audit trigger for notification_category_settings changes
-- (per-category WhatsApp toggle -- "notification preferences changed").
-- ============================================================
create or replace function public.audit_notification_category_settings_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.write_audit_log(
    new.club_id, 'notification.category_setting_changed', 'notification_category_settings', new.club_id,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new),
    null
  );
  return new;
end;
$$;

create trigger trg_audit_notification_category_settings
  after insert or update on public.notification_category_settings
  for each row execute function public.audit_notification_category_settings_change();

-- ============================================================
-- Part U: audit trigger for notification_consent changes ("consent
-- changed"). club_id is required by write_audit_log's signature but
-- notification_consent doesn't carry club_id directly on every
-- historical row shape assumption -- it does (added in Gate 7), so
-- this is a direct reference, not a lookup.
-- ============================================================
create or replace function public.audit_notification_consent_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.write_audit_log(
    new.club_id, 'notification.consent_changed', 'notification_consent', new.customer_id,
    case when tg_op = 'UPDATE' then jsonb_build_object('enabled', old.enabled, 'channel', old.channel) else null end,
    jsonb_build_object('enabled', new.enabled, 'channel', new.channel, 'consent_source', new.consent_source),
    null
  );
  return new;
end;
$$;

create trigger trg_audit_notification_consent
  after insert or update on public.notification_consent
  for each row execute function public.audit_notification_consent_change();

comment on function public.audit_messaging_safety_settings_change() is 'Part U: audit trigger, not a noisy per-poll-tick log -- fires only on an actual settings row insert/update, i.e. a real staff-initiated safety-control change.';
comment on function public.audit_notification_category_settings_change() is 'Part U: audit trigger for "notification preferences changed" -- per-category WhatsApp toggle edits.';
comment on function public.audit_notification_consent_change() is 'Part U: audit trigger for "consent changed" -- customer WhatsApp opt-in/opt-out state edits.';
