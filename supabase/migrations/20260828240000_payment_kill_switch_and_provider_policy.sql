-- PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 5 (P2).
-- PLATFORM_OWNER_COMPLETE_CONTROL_AUDIT.md finding: no per-club payment
-- kill switch exists independent of full club suspension, and no
-- per-club/provider allowlist exists (any club can connect any of the
-- catalog's providers unconditionally). Both additive-only, per the
-- implementation plan's explicit non-destructive requirement -- neither
-- disconnects any existing gateway connection or touches credentials.

-- Step 1: kill switch. Placed on commercial_entitlements -- already the
-- platform-owner-only-write per-club commercial config table (same
-- table the branch/field/academy limits live on), so this reuses an
-- existing, already-locked-down RLS surface rather than introducing a
-- new one. Default false = today's behavior for every club.
alter table public.commercial_entitlements
  add column if not exists payments_platform_disabled boolean not null default false;

comment on column public.commercial_entitlements.payments_platform_disabled is
  'Platform-Owner-only kill switch: when true, start_gateway_checkout() rejects new checkout attempts for this club, independent of the club''s own gateway configuration. Historical payments/refunds are unaffected. Does not suspend the club as a whole -- see platform_suspend_club for that.';

-- Step 2: optional per-club/provider policy table. A club+provider pair
-- with no row here defaults to "allowed" (today's behavior, unchanged)
-- -- this is purely additive and never retroactively disconnects an
-- existing connection. 'policy_blocked' prevents a NEW connection or
-- re-enabling an existing one; it never auto-disables an already-
-- enabled connection (directive Section 21's explicit "do not
-- disconnect existing providers destructively" requirement).
create table public.club_gateway_provider_policy (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  provider_key text not null references public.payment_gateway_providers(key),
  status text not null default 'allowed' check (status in ('allowed', 'policy_blocked')),
  reason text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique (club_id, provider_key)
);

alter table public.club_gateway_provider_policy enable row level security;
alter table public.club_gateway_provider_policy force row level security;

-- Read: club staff (so the club's own gateway-connection UI can show
-- why a provider is blocked) or platform owner/support.
create policy club_gateway_provider_policy_select
  on public.club_gateway_provider_policy for select
  to authenticated
  using (
    club_id in (select public.user_club_ids())
    or public.is_platform_owner()
    or public.has_platform_permission('platform.club.view')
    or public.has_platform_support_access(club_id, false)
  );

-- Write is deliberately NOT granted via a blanket RLS policy -- routed
-- through set_club_gateway_provider_policy() below, matching the
-- club_modules table's own "every mutation goes through an RPC, no
-- direct INSERT/UPDATE policy" convention.

comment on table public.club_gateway_provider_policy is
  'Platform-Owner-controlled per-club payment-provider allowlist. No row for a club+provider pair = allowed (today''s default behavior). policy_blocked prevents NEW connections/re-enabling, never auto-disconnects an existing one.';

create or replace function public.set_club_payments_enabled(p_club_id uuid, p_enabled boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before boolean;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  select payments_platform_disabled into v_before from public.commercial_entitlements where club_id = p_club_id;

  insert into public.commercial_entitlements (club_id, payments_platform_disabled, updated_at, updated_by)
  values (p_club_id, not p_enabled, now(), auth.uid())
  on conflict (club_id) do update set
    payments_platform_disabled = not p_enabled,
    updated_at = now(),
    updated_by = auth.uid();

  perform public.write_audit_log(
    p_club_id,
    case when p_enabled then 'club_payments.enabled' else 'club_payments.disabled' end,
    'commercial_entitlements', p_club_id,
    jsonb_build_object('payments_platform_disabled', coalesce(v_before, false)),
    jsonb_build_object('payments_platform_disabled', not p_enabled),
    p_reason
  );
end;
$$;

revoke all on function public.set_club_payments_enabled(uuid, boolean, text) from public;
revoke all on function public.set_club_payments_enabled(uuid, boolean, text) from anon;
grant execute on function public.set_club_payments_enabled(uuid, boolean, text) to authenticated;

create or replace function public.set_club_gateway_provider_policy(p_club_id uuid, p_provider_key text, p_status text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.club_gateway_provider_policy;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  if p_status not in ('allowed', 'policy_blocked') then
    raise exception 'invalid status';
  end if;

  if not exists (select 1 from public.payment_gateway_providers where key = p_provider_key) then
    raise exception 'unknown provider';
  end if;

  select * into v_before from public.club_gateway_provider_policy
  where club_id = p_club_id and provider_key = p_provider_key;

  insert into public.club_gateway_provider_policy (club_id, provider_key, status, reason, updated_by)
  values (p_club_id, p_provider_key, p_status, p_reason, auth.uid())
  on conflict (club_id, provider_key) do update set
    status = p_status,
    reason = p_reason,
    updated_at = now(),
    updated_by = auth.uid();

  perform public.write_audit_log(
    p_club_id, 'club_gateway_provider_policy.updated', 'club_gateway_provider_policy',
    coalesce(v_before.id, p_club_id),
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', p_status, 'provider_key', p_provider_key),
    p_reason
  );
end;
$$;

revoke all on function public.set_club_gateway_provider_policy(uuid, text, text, text) from public;
revoke all on function public.set_club_gateway_provider_policy(uuid, text, text, text) from anon;
grant execute on function public.set_club_gateway_provider_policy(uuid, text, text, text) to authenticated;

-- Step 3: wire both checks into start_gateway_checkout() -- the sole
-- write chokepoint for every online payment attempt (confirmed via
-- direct call-graph inspection: no other RPC stages a
-- payment_gateway_transactions row). Body otherwise byte-identical to
-- the current live definition
-- (20260827080948_extend_start_gateway_checkout_multi_provider.sql).
create or replace function public.start_gateway_checkout(
  p_invoice_id uuid, p_provider_key text, p_amount numeric,
  p_connection_id uuid default null, p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_status text;
  v_outstanding numeric;
  v_connection public.club_gateway_connections;
  v_id uuid;
  v_existing_id uuid;
  v_payments_disabled boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not exists (select 1 from public.payment_gateway_providers where key = p_provider_key and status = 'active') then
    raise exception 'invalid gateway';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  select club_id, status into v_club_id, v_status from public.invoices where id = p_invoice_id;
  if v_club_id is null then
    raise exception 'invoice not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('invoice.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce(payments_platform_disabled, false) into v_payments_disabled
  from public.commercial_entitlements where club_id = v_club_id;
  if coalesce(v_payments_disabled, false) then
    raise exception 'online payments are currently disabled for this club -- contact platform support';
  end if;

  if exists (
    select 1 from public.club_gateway_provider_policy
    where club_id = v_club_id and provider_key = p_provider_key and status = 'policy_blocked'
  ) then
    raise exception '% is not an allowed payment provider for this club', p_provider_key;
  end if;

  if v_status <> 'issued' then
    raise exception 'can only start a checkout for an issued invoice';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_id from public.payment_gateway_transactions
    where club_id = v_club_id and idempotency_key = p_idempotency_key;
    if v_existing_id is not null then
      return v_existing_id;
    end if;
  end if;

  if p_connection_id is not null then
    select * into v_connection from public.club_gateway_connections
    where id = p_connection_id and club_id = v_club_id and provider_key = p_provider_key;
    if v_connection.id is null then
      raise exception 'connection not found for this club/provider';
    end if;
  else
    select * into v_connection from public.club_gateway_connections
    where club_id = v_club_id and provider_key = p_provider_key and enabled = true
    order by is_default desc, environment = 'live' desc
    limit 1;
    if v_connection.id is null then
      raise exception '% is not enabled for this club', p_provider_key;
    end if;
  end if;

  if not v_connection.enabled then
    raise exception '% is not enabled for this club', p_provider_key;
  end if;
  if v_connection.secret_vault_id is null then
    raise exception '% has no credentials configured for this club', p_provider_key;
  end if;

  select outstanding into v_outstanding from public.get_invoice_payment_summary(array[p_invoice_id]::uuid[]);
  if p_amount > v_outstanding then
    raise exception 'checkout amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payment_gateway_transactions (
    club_id, invoice_id, gateway, amount, status, connection_id, environment, idempotency_key
  ) values (
    v_club_id, p_invoice_id, p_provider_key, p_amount, 'pending', v_connection.id, v_connection.environment, p_idempotency_key
  )
  returning id into v_id;

  return v_id;
end;
$function$;

revoke all on function public.start_gateway_checkout(uuid, text, numeric, uuid, uuid) from public;
revoke all on function public.start_gateway_checkout(uuid, text, numeric, uuid, uuid) from anon;
grant execute on function public.start_gateway_checkout(uuid, text, numeric, uuid, uuid) to authenticated;

-- Step 4: also gate connect_club_gateway() (a NEW connection) and
-- set_club_gateway_enabled() when re-enabling (p_enabled=true) against
-- a policy_blocked provider -- matches this migration's own design:
-- policy_blocked prevents NEW connections/re-enabling, never touches an
-- already-enabled connection. Bodies otherwise byte-identical to the
-- current live definitions
-- (20260827080508_gateway_connection_write_rpcs.sql).
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
  if exists (
    select 1 from public.club_gateway_provider_policy
    where club_id = p_club_id and provider_key = p_provider_key and status = 'policy_blocked'
  ) then
    raise exception '% is not an allowed payment provider for this club', p_provider_key;
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
  if p_enabled and exists (
    select 1 from public.club_gateway_provider_policy
    where club_id = v_conn.club_id and provider_key = v_conn.provider_key and status = 'policy_blocked'
  ) then
    raise exception '% is not an allowed payment provider for this club', v_conn.provider_key;
  end if;

  update public.club_gateway_connections set enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
  where id = p_connection_id;

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
