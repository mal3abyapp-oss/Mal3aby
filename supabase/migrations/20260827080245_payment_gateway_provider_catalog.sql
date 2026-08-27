-- MULTI-GATEWAY PAYMENTS (Phase 2, Section 27): platform-controlled
-- provider catalog. The platform decides what's SUPPORTED; a club
-- decides what it CONNECTS -- these are deliberately separate
-- concerns (Section 26/28), matching this project's own existing
-- club_modules two-level entitlement pattern (entitled vs active).
create table public.payment_gateway_providers (
  key text primary key,
  display_name text not null,
  -- Real findings from PAYMENT_GATEWAY_PROVIDER_MATRIX.md: Stripe does
  -- not support Egypt as an account country; PayPal does not support
  -- EGP. This is genuine provider-enforced eligibility, not a UI
  -- preference -- club_countries/currencies below are used to filter
  -- what a club is even offered, never a rigid "Egypt vs not" split.
  supported_countries text[] not null default '{}',
  supported_currencies text[] not null default '{}',
  supports_sandbox boolean not null default true,
  supports_live boolean not null default true,
  supports_partial_refund boolean not null default true,
  supports_native_idempotency_key boolean not null default false,
  status text not null default 'active' check (status in ('active', 'disabled')),
  created_at timestamptz not null default now()
);

alter table public.payment_gateway_providers enable row level security;
alter table public.payment_gateway_providers force row level security;

-- Reference/catalog data -- read-only for every authenticated caller
-- (a club owner needs to see what's available to decide what to
-- connect), platform-only for writes via a dedicated RPC (never a
-- direct client table grant -- matches the permission_dependencies
-- lesson from the earlier launch-readiness audit).
create policy payment_gateway_providers_select on public.payment_gateway_providers
  for select to authenticated using (true);

revoke all on public.payment_gateway_providers from public, anon, authenticated;
grant select on public.payment_gateway_providers to authenticated;

insert into public.payment_gateway_providers
  (key, display_name, supported_countries, supported_currencies, supports_sandbox, supports_live, supports_partial_refund, supports_native_idempotency_key)
values
  ('stripe', 'Stripe', array[]::text[], array['USD','EUR','GBP']::text[], true, true, true, true),
  ('paypal', 'PayPal', array[]::text[], array['USD','EUR','GBP']::text[], true, true, true, true),
  ('paymob', 'Paymob', array['EG']::text[], array['EGP']::text[], true, true, true, false),
  ('kashier', 'Kashier', array['EG']::text[], array['EGP','USD','EUR','GBP']::text[], true, true, true, false),
  ('fawry', 'Fawry', array['EG']::text[], array['EGP']::text[], false, true, true, false);
-- fawry.supports_sandbox=false is deliberate: PAYMENT_GATEWAY_PROVIDER_MATRIX.md
-- found Fawry has no self-service developer signup -- sandbox
-- credentials require manual merchant registration/approval, so a
-- club cannot self-serve into a Fawry sandbox the way they can for
-- the other 4 providers. Documented, not silently assumed. (Corrected
-- in the immediately-following migration -- see that file's comment.)
