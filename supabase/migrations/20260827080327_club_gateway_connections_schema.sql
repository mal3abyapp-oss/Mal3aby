-- MULTI-GATEWAY PAYMENTS (Phase 2, Section 28): a club may connect
-- MULTIPLE providers, and (in principle) both a sandbox and a live
-- connection per provider at different times -- one row per
-- (club_id, provider_key, environment). Distinguishes SUPPORTED
-- (payment_gateway_providers row exists, platform allows it) from
-- CONNECTED (this row exists with real credentials) from HEALTHY
-- (last_verified_at recent, last_error_at absent/old) from ENABLED
-- (club owner has switched it on for customer-facing checkout) from
-- DEFAULT (at most one enabled connection per club is the default,
-- Section 45).
create table public.club_gateway_connections (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id) on delete cascade,
  provider_key text not null references public.payment_gateway_providers(key),
  environment text not null check (environment in ('sandbox', 'live')),

  -- CONNECTED: true once real credentials have been saved (secrets
  -- live in Supabase Vault, never in this table -- see
  -- club_gateway_credentials below). This table only ever stores a
  -- REFERENCE (vault secret id), never a secret value itself.
  public_key text, -- publishable/client-safe key (e.g. Stripe pk_..., PayPal client ID) -- not sensitive, safe to read client-side.
  secret_vault_id uuid, -- references vault.secrets.id; the actual secret is never queryable through this table.
  webhook_secret_vault_id uuid, -- separate secret for webhook signature verification, same vault pattern.
  provider_merchant_ref text, -- provider's own merchant/account identifier (e.g. Paymob integration ID, Kashier MID) -- not sensitive on its own.

  enabled boolean not null default false, -- club owner has switched this on for customer checkout.
  is_default boolean not null default false, -- Section 45: zero or one default connection per club (enforced below).

  -- HEALTH (Section 57): reflects reality, not merely "credentials exist".
  last_verified_at timestamptz, -- last successful testConnection() call.
  last_verification_error text, -- sanitized (Section 55): "Connected"/"Invalid credentials"/"Invalid configuration"/"Provider unavailable" -- never a raw provider error dump.
  last_webhook_at timestamptz,
  last_webhook_error text,
  last_success_at timestamptz,
  last_failure_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),

  unique (club_id, provider_key, environment)
);

-- Section 45: at most one default connection per club, across all providers/environments.
create unique index club_gateway_connections_one_default_per_club
  on public.club_gateway_connections(club_id) where is_default = true;

alter table public.club_gateway_connections enable row level security;
alter table public.club_gateway_connections force row level security;

-- Reads never expose secret_vault_id/webhook_secret_vault_id as
-- decoded values -- they're opaque UUID references in this table;
-- actual vault reads are gated separately (service-role/Edge Function
-- only, see PAYMENT_GATEWAY_SECURITY_MODEL.md). SELECT here is safe:
-- it's connection status/health, not the secret itself.
create policy club_gateway_connections_select on public.club_gateway_connections
  for select to authenticated
  using (
    (club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.view', club_id))
    or public.has_platform_support_access(club_id, false)
  );

-- No direct INSERT/UPDATE/DELETE grant -- every write goes through
-- SECURITY DEFINER RPCs (connect/test/enable/disable/set-default/
-- disconnect), matching this project's RPC-only convention and this
-- session's own launch-readiness-audit fix for the prior single-config
-- table.
revoke all on public.club_gateway_connections from public, anon, authenticated;
grant select on public.club_gateway_connections to authenticated;
