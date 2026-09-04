-- Sales Intelligence — provider configuration table (ADR-054, Phase 2/18).
-- Mirrors payment_gateway_configs' shape (public-safe flag columns,
-- secret referenced by vault ID never stored/exposed directly, a
-- has_server_credentials-style boolean the UI reads to show
-- "connected" vs "needs setup") and the vault-row pattern already
-- established for third-party secrets (get_vault_secret_service(),
-- see 20260827093045 + paymob-create-checkout-session's usage).
--
-- This table is what makes "Google API credentials not configured" a
-- CONFIGURATION_BLOCKED classification rather than a hard stop: the
-- adapter, RPCs, and UI all check enabled/secret_vault_id and degrade
-- gracefully rather than assuming a credential exists.

create table public.sales_provider_configs (
  provider_key text primary key check (provider_key in ('google_places', 'ai_offer_generator', 'website_enrichment')),
  enabled boolean not null default false,
  secret_vault_id uuid,               -- references a vault.secrets row; NULL until an operator configures one
  daily_cap int not null default 100, -- mirrors sales_quota_usage.daily_cap default, operator-adjustable per provider
  config jsonb not null default '{}'::jsonb,  -- non-secret provider config, e.g. {"model": "...", "region_bias": "EG"}
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

-- website_enrichment needs no external credential (it's a plain HTTP
-- fetch of public pages), so it's pre-enabled; the other two require an
-- operator to configure a secret_vault_id before they can run.
insert into public.sales_provider_configs (provider_key, enabled) values
  ('website_enrichment', true),
  ('google_places', false),
  ('ai_offer_generator', false);

alter table public.sales_provider_configs enable row level security;
alter table public.sales_provider_configs force row level security;

create policy sales_provider_configs_select on public.sales_provider_configs
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));
create policy sales_provider_configs_write on public.sales_provider_configs
  for update using (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_settings'))
  with check (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_settings'));
-- No insert/delete policy from the client -- the 3 provider rows are fixed by the CHECK constraint's
-- enum and seeded above; an operator only ever updates enabled/secret_vault_id/daily_cap/config.

revoke all on table public.sales_provider_configs from anon;
revoke all on table public.sales_provider_configs from public;

-- ============================================================
-- get_sales_provider_status(): read-only status check the frontend
-- calls to render "connected"/"CONFIGURATION_BLOCKED" per provider,
-- WITHOUT ever returning the vault secret ID itself (only whether one
-- is set) -- same "flag, not secret" shape as
-- payment_gateway_configs.has_server_credentials.
-- ============================================================
create or replace function public.get_sales_provider_status()
returns table(provider_key text, enabled boolean, is_configured boolean, daily_cap int, config jsonb)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select
    spc.provider_key,
    spc.enabled,
    (spc.secret_vault_id is not null or spc.provider_key = 'website_enrichment') as is_configured,
    spc.daily_cap,
    spc.config
  from public.sales_provider_configs spc
  where public.is_platform_owner() or public.has_platform_permission('platform.sales.view')
$$;

revoke all on function public.get_sales_provider_status() from public, anon;
grant execute on function public.get_sales_provider_status() to authenticated;

-- ============================================================
-- set_sales_provider_secret(): the ONLY way to attach a vault secret ID
-- to a provider config. Deliberately takes a p_secret_vault_id (a vault
-- entry the operator creates through Supabase's own vault UI/API
-- separately, exactly like every existing gateway secret in this
-- codebase) -- this RPC never accepts or stores a raw secret value
-- itself, only the reference, matching this codebase's zero-raw-secret-
-- in-application-tables convention throughout.
-- ============================================================
create or replace function public.set_sales_provider_secret(p_provider_key text, p_secret_vault_id uuid, p_enabled boolean default true)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_settings')) then
    raise exception 'not authorized';
  end if;

  update public.sales_provider_configs
  set secret_vault_id = p_secret_vault_id, enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
  where provider_key = p_provider_key;

  if not found then
    raise exception 'unknown provider_key: %', p_provider_key;
  end if;

  perform public.write_audit_log(null, 'sales.provider.configure', 'sales_provider_config', null, null,
    jsonb_build_object('provider_key', p_provider_key, 'enabled', p_enabled), 'Sales Intelligence provider credential configured');
end;
$$;

revoke all on function public.set_sales_provider_secret(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_sales_provider_secret(text, uuid, boolean) to authenticated;
-- Note: grant to authenticated (not service_role-only) because a real platform_owner/platform-staff
-- session calls this directly from the Settings UI -- the function body's own permission check is the
-- actual gate, matching the established pattern for every other platform-owner-facing write RPC in this
-- codebase (e.g. approve_payment_proof, set_club_gateway_enabled) rather than routing through a service role.
