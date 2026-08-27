-- connect_club_gateway: creates/updates a connection row AND the
-- secret in Vault, in one call. p_secret/p_webhook_secret are the raw
-- secret values -- passed once, at save time, over the same TLS
-- connection as every other authenticated RPC call (this project's
-- established transport), stored via vault.create_secret() (real
-- envelope encryption at rest), and this function's own RETURN never
-- includes them again. A club owner re-saving overwrites the vault
-- secret via vault.update_secret() rather than leaking the old value
-- to decide whether to keep it.
create or replace function public.connect_club_gateway(
  p_club_id uuid, p_provider_key text, p_environment text,
  p_public_key text default null, p_secret text default null,
  p_webhook_secret text default null, p_provider_merchant_ref text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp', 'vault'
as $function$
declare
  v_connection_id uuid;
  v_secret_vault_id uuid;
  v_webhook_secret_vault_id uuid;
  v_existing public.club_gateway_connections;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', p_club_id)) then
    raise exception 'not authorized';
  end if;
  if p_environment not in ('sandbox', 'live') then
    raise exception 'invalid environment';
  end if;
  if not exists (select 1 from public.payment_gateway_providers where key = p_provider_key and status = 'active') then
    raise exception 'unknown or disabled provider';
  end if;

  select * into v_existing from public.club_gateway_connections
  where club_id = p_club_id and provider_key = p_provider_key and environment = p_environment;

  if p_secret is not null then
    if v_existing.secret_vault_id is not null then
      perform vault.update_secret(v_existing.secret_vault_id, p_secret);
      v_secret_vault_id := v_existing.secret_vault_id;
    else
      v_secret_vault_id := vault.create_secret(p_secret, p_club_id::text || ':' || p_provider_key || ':' || p_environment || ':secret');
    end if;
  else
    v_secret_vault_id := v_existing.secret_vault_id;
  end if;

  if p_webhook_secret is not null then
    if v_existing.webhook_secret_vault_id is not null then
      perform vault.update_secret(v_existing.webhook_secret_vault_id, p_webhook_secret);
      v_webhook_secret_vault_id := v_existing.webhook_secret_vault_id;
    else
      v_webhook_secret_vault_id := vault.create_secret(p_webhook_secret, p_club_id::text || ':' || p_provider_key || ':' || p_environment || ':webhook_secret');
    end if;
  else
    v_webhook_secret_vault_id := v_existing.webhook_secret_vault_id;
  end if;

  insert into public.club_gateway_connections (
    club_id, provider_key, environment, public_key, secret_vault_id, webhook_secret_vault_id,
    provider_merchant_ref, updated_at, updated_by
  ) values (
    p_club_id, p_provider_key, p_environment, p_public_key, v_secret_vault_id, v_webhook_secret_vault_id,
    p_provider_merchant_ref, now(), auth.uid()
  )
  on conflict (club_id, provider_key, environment) do update
    set public_key = coalesce(excluded.public_key, club_gateway_connections.public_key),
        secret_vault_id = excluded.secret_vault_id,
        webhook_secret_vault_id = excluded.webhook_secret_vault_id,
        provider_merchant_ref = coalesce(excluded.provider_merchant_ref, club_gateway_connections.provider_merchant_ref),
        updated_at = now(), updated_by = auth.uid()
  returning id into v_connection_id;

  perform public.write_audit_log(
    p_club_id, 'payment_gateway.connected', 'club_gateway_connection', v_connection_id,
    null, jsonb_build_object('provider_key', p_provider_key, 'environment', p_environment), null
  );

  return v_connection_id;
end;
$function$;

revoke all on function public.connect_club_gateway(uuid, text, text, text, text, text, text) from public, anon;
grant execute on function public.connect_club_gateway(uuid, text, text, text, text, text, text) to authenticated;

create or replace function public.set_club_gateway_enabled(p_connection_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_conn public.club_gateway_connections;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_conn from public.club_gateway_connections where id = p_connection_id;
  if v_conn.id is null then
    raise exception 'connection not found';
  end if;
  if not (v_conn.club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', v_conn.club_id)) then
    raise exception 'not authorized';
  end if;
  if p_enabled and v_conn.secret_vault_id is null then
    raise exception 'cannot enable a connection with no saved credentials';
  end if;

  update public.club_gateway_connections set enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
  where id = p_connection_id;

  -- Section 45: if disabling the current default, clear default too
  -- (never leave a disabled connection marked default).
  if not p_enabled and v_conn.is_default then
    update public.club_gateway_connections set is_default = false, updated_at = now() where id = p_connection_id;
  end if;

  perform public.write_audit_log(
    v_conn.club_id, case when p_enabled then 'payment_gateway.enabled' else 'payment_gateway.disabled' end,
    'club_gateway_connection', p_connection_id, null, jsonb_build_object('provider_key', v_conn.provider_key), null
  );
end;
$function$;

revoke all on function public.set_club_gateway_enabled(uuid, boolean) from public, anon;
grant execute on function public.set_club_gateway_enabled(uuid, boolean) to authenticated;

create or replace function public.set_club_gateway_default(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_conn public.club_gateway_connections;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_conn from public.club_gateway_connections where id = p_connection_id;
  if v_conn.id is null then
    raise exception 'connection not found';
  end if;
  if not (v_conn.club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', v_conn.club_id)) then
    raise exception 'not authorized';
  end if;
  if not v_conn.enabled then
    raise exception 'cannot set a disabled connection as default -- enable it first';
  end if;

  -- Clear any prior default for this club (Section 45: zero or one).
  update public.club_gateway_connections set is_default = false, updated_at = now()
  where club_id = v_conn.club_id and is_default = true;

  update public.club_gateway_connections set is_default = true, updated_at = now(), updated_by = auth.uid()
  where id = p_connection_id;

  perform public.write_audit_log(
    v_conn.club_id, 'payment_gateway.default_changed', 'club_gateway_connection', p_connection_id,
    null, jsonb_build_object('provider_key', v_conn.provider_key), null
  );
end;
$function$;

revoke all on function public.set_club_gateway_default(uuid) from public, anon;
grant execute on function public.set_club_gateway_default(uuid) to authenticated;

create or replace function public.disconnect_club_gateway(p_connection_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp', 'vault'
as $function$
declare
  v_conn public.club_gateway_connections;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  select * into v_conn from public.club_gateway_connections where id = p_connection_id;
  if v_conn.id is null then
    raise exception 'connection not found';
  end if;
  if not (v_conn.club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', v_conn.club_id)) then
    raise exception 'not authorized';
  end if;

  -- Delete the vault secrets (real credential removal, not just a
  -- flag flip) -- but the connection ROW itself is preserved for
  -- audit/history rather than hard-deleted, matching this project's
  -- established "never hard-delete history" convention. Existing
  -- payment_gateway_transactions rows keep their connection_id
  -- reference intact (FK is not cascading).
  if v_conn.secret_vault_id is not null then
    delete from vault.secrets where id = v_conn.secret_vault_id;
  end if;
  if v_conn.webhook_secret_vault_id is not null then
    delete from vault.secrets where id = v_conn.webhook_secret_vault_id;
  end if;

  update public.club_gateway_connections
  set enabled = false, is_default = false, secret_vault_id = null, webhook_secret_vault_id = null,
      public_key = null, provider_merchant_ref = null, updated_at = now(), updated_by = auth.uid()
  where id = p_connection_id;

  perform public.write_audit_log(
    v_conn.club_id, 'payment_gateway.disconnected', 'club_gateway_connection', p_connection_id,
    null, jsonb_build_object('provider_key', v_conn.provider_key), null
  );
end;
$function$;

revoke all on function public.disconnect_club_gateway(uuid) from public, anon;
grant execute on function public.disconnect_club_gateway(uuid) to authenticated;
