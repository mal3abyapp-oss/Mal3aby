-- PRODUCTION RELEASE VERIFICATION -- genuine bug found and fixed during
-- live post-deploy testing (PR #28's migrations had already been
-- applied to production when this was caught).
--
-- ROOT CAUSE: every function that updates the singleton
-- platform_whatsapp_account table wrote an unconditional
-- `UPDATE public.platform_whatsapp_account SET ...` with no WHERE
-- clause. Semantically this was intentional and safe -- the table has
-- exactly one row, guaranteed by the singleton_guard CHECK constraint
-- -- but this Supabase project's Postgres session has a safe-updates
-- guard enabled that rejects ANY UPDATE/DELETE without an explicit
-- WHERE clause, regardless of the target table's actual cardinality.
-- Confirmed live: calling platform_start_whatsapp_own_pairing() as the
-- real, authenticated platform owner returned a genuine
-- "UPDATE requires a WHERE clause" (SQLSTATE 21000) error, not an
-- authorization rejection.
--
-- FIX: add `where singleton_guard = 1` to every UPDATE on this table --
-- harmless (matches the only row that can ever exist, exactly as
-- before) and satisfies the safety guard. Every other line of business
-- logic in each function is byte-for-byte unchanged from the version
-- already live in production (20260909200000_platform_whatsapp_
-- domain.sql / 20260910120000_sales_platform_whatsapp_send_enabled.sql).

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
  from public.platform_whatsapp_account where singleton_guard = 1 for update;

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
      updated_at = now()
  where singleton_guard = 1;

  insert into public.platform_whatsapp_connection_events (event, actor_id, detail)
  values ('status_' || p_status, null, jsonb_build_object('error', p_error));
end;
$$;

create or replace function public.whatsapp_connector_store_platform_session(p_session_credentials_encrypted bytea)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.platform_whatsapp_account
  set session_credentials_encrypted = p_session_credentials_encrypted, updated_at = now()
  where singleton_guard = 1;
$$;

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
    update public.platform_whatsapp_account set last_successful_send_at = now() where singleton_guard = 1;
  end if;
end;
$$;

comment on function public.platform_start_whatsapp_own_pairing(text) is
  'Fixed 2026-09-10 (post-deploy verification): the UPDATE now has an explicit WHERE singleton_guard=1 clause -- harmless (matches the only row that can ever exist) but required by this project''s Postgres safe-updates guard, which rejects any UPDATE without a WHERE clause regardless of table cardinality. All other logic unchanged from 20260909200000_platform_whatsapp_domain.sql.';
