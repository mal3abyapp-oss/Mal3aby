-- Master Payment Directive task #88/#89: Stripe + PayPal gateway
-- ARCHITECTURE (adapter pattern). No prior design doc exists for this
-- in docs/ (confirmed by search -- Stripe/PayPal are only referenced
-- as subscription-billing schema inspiration, never as a planned
-- integration), so this is a genuinely new design, built the same way
-- every other external-service integration in this codebase has been
-- built: a narrow adapter interface first, a real implementation
-- behind it later, and the schema/security model established now so a
-- real gateway can be wired in without a redesign (same shape as
-- WhatsAppProvider/BaileysProvider).
--
-- Scope of THIS migration: schema + security model only. No live
-- Stripe/PayPal account exists for this project, so no real API calls
-- are made anywhere in this phase -- that would be untestable and
-- would risk shipping a payment integration that was never actually
-- exercised against a real gateway. The TypeScript adapter interface
-- (src/lib/payments/PaymentGateway.ts) and a StripeGateway/PayPalGateway
-- skeleton implementation ship alongside this migration, structured so
-- wiring in real API keys and a webhook handler later touches only
-- those files plus a new Edge Function -- never the existing
-- record_payment()/invoices/payment_allocations flow, which continues
-- to be the single source of truth for "is this invoice paid" exactly
-- as it is today.
--
-- Design: gateway payments still ultimately become a REAL row in the
-- existing payments table via record_payment() once confirmed (e.g.
-- from a webhook) -- there is no second, parallel "gateway payment"
-- concept competing with the existing payments/payment_allocations
-- model. What's new is payment_gateway_transactions: a staging record
-- for a gateway payment ATTEMPT (created when a checkout session
-- starts, before the gateway confirms anything), because a gateway
-- payment is asynchronous (the customer may abandon checkout, the
-- webhook may be delayed) in a way record_payment()'s synchronous
-- "staff enters an amount, it's recorded immediately" flow is not.

-- ============================================================
-- payment_gateway_configs: per-club, WHICH gateways are enabled and
-- their PUBLIC-safe fields only (e.g. Stripe's publishable key, which
-- is safe to ship to the browser by Stripe's own design -- the
-- equivalent of this app's own VITE_SUPABASE_ANON_KEY). The real
-- secret key/webhook signing secret are NEVER stored in any table a
-- client can read -- they belong in Supabase Edge Function secrets
-- (server-side only), exactly like SUPABASE_SERVICE_ROLE_KEY never
-- lives in a table either. This table's own RLS reflects that: even
-- club staff only ever see whether a gateway is connected/enabled, not
-- any credential.
-- ============================================================
create table public.payment_gateway_configs (
  club_id uuid not null references public.clubs(id) on delete cascade,
  gateway text not null check (gateway in ('stripe', 'paypal')),
  enabled boolean not null default false,
  -- Public-safe identifiers only. Stripe's publishable key (pk_*) and
  -- PayPal's client ID are BY DESIGN safe to expose to the browser --
  -- this is not a secret leak, it mirrors exactly what Stripe/PayPal's
  -- own official docs say to embed client-side.
  public_key text,
  -- Whether real secret credentials have been configured server-side
  -- (as an Edge Function secret) for this club -- a boolean flag the
  -- UI can show ("Stripe: connected" vs "Stripe: needs setup"),
  -- deliberately NOT the secret itself. Set by a future server-side
  -- setup step, not by any client write.
  has_server_credentials boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (club_id, gateway)
);

alter table public.payment_gateway_configs enable row level security;

create policy "payment_gateway_configs_select_own_club" on public.payment_gateway_configs
  for select using (club_id in (select public.user_club_ids()));

create policy "payment_gateway_configs_write_with_permission" on public.payment_gateway_configs
  for all using (
    club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', club_id)
  )
  with check (
    club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.manage', club_id)
    -- A client can only ever set enabled/public_key -- has_server_credentials
    -- is never true-able from a client write (defense in depth on top
    -- of RLS: even if a client tried to set it, this check blocks it).
    and has_server_credentials = false
  );

alter table public.payment_gateway_configs force row level security;

comment on table public.payment_gateway_configs is
  'Task #88/#89: per-club gateway enablement + PUBLIC-safe identifiers only (publishable/client-side keys, safe by the gateway providers'' own design). Real secret keys and webhook signing secrets NEVER live here or in any client-readable table -- they belong in Supabase Edge Function secrets, set server-side only. has_server_credentials is a status flag a client can read but never set to true.';

-- ============================================================
-- payment_gateway_transactions: staging record for an in-flight
-- gateway checkout attempt. Created when a checkout session starts
-- (status='pending'), updated to 'succeeded'/'failed'/'cancelled' by
-- the (future) webhook handler. A 'succeeded' transaction is what
-- triggers a real record_payment() call -- this table is never itself
-- the source of truth for "is this invoice paid", the existing
-- payments/payment_allocations model still is (Master Payment
-- Directive's own single-source-of-truth rule, unchanged).
-- ============================================================
create table public.payment_gateway_transactions (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  invoice_id uuid not null references public.invoices(id),
  gateway text not null check (gateway in ('stripe', 'paypal')),
  gateway_reference text,
  amount numeric not null check (amount > 0),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'cancelled')),
  -- Set once a 'succeeded' transaction has actually been turned into a
  -- real payments row via record_payment() -- the link back to the
  -- single source of truth, so a succeeded gateway transaction is
  -- never silently disconnected from the real financial record.
  payment_id uuid references public.payments(id),
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index payment_gateway_transactions_invoice_idx on public.payment_gateway_transactions (invoice_id);
create index payment_gateway_transactions_gateway_ref_idx on public.payment_gateway_transactions (gateway, gateway_reference);

alter table public.payment_gateway_transactions enable row level security;

create policy "payment_gateway_transactions_select_own_club" on public.payment_gateway_transactions
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('invoice.view', club_id));

-- No direct client INSERT/UPDATE policy -- written only by
-- start_gateway_checkout() (creates the pending row) and a future
-- webhook-driven RPC (transitions it to succeeded/failed), both
-- SECURITY DEFINER. A client never marks its own gateway transaction
-- succeeded -- that must come from the gateway's own server-to-server
-- webhook, never a client callback (which is trivially spoofable).
alter table public.payment_gateway_transactions force row level security;

comment on table public.payment_gateway_transactions is
  'Task #88/#89: staging record for an in-flight gateway checkout (Stripe/PayPal). NEVER the source of truth for invoice payment status -- a succeeded transaction here is what triggers a real record_payment() call against the existing payments/payment_allocations model, which remains the single source of truth. status can only be set to succeeded/failed by a future server-side webhook handler, never by a client callback.';

-- ============================================================
-- start_gateway_checkout: staff/customer-initiated, creates the
-- pending staging row. Does NOT call any external gateway API itself
-- (no real gateway account exists for this project yet) -- returns the
-- transaction id a future Edge Function would use to actually create a
-- Stripe Checkout Session / PayPal order and return a redirect URL.
-- Deliberately validates against the real outstanding balance via the
-- same get_invoice_payment_summary() every other payment path uses.
-- ============================================================
create or replace function public.start_gateway_checkout(
  p_invoice_id uuid,
  p_gateway text,
  p_amount numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_status text;
  v_outstanding numeric;
  v_gateway_enabled boolean;
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_gateway not in ('stripe', 'paypal') then
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

  if v_status <> 'issued' then
    raise exception 'can only start a checkout for an issued invoice';
  end if;

  select enabled into v_gateway_enabled from public.payment_gateway_configs where club_id = v_club_id and gateway = p_gateway;
  if v_gateway_enabled is not true then
    raise exception '% is not enabled for this club', p_gateway;
  end if;

  select outstanding into v_outstanding from public.get_invoice_payment_summary(array[p_invoice_id]::uuid[]);
  if p_amount > v_outstanding then
    raise exception 'checkout amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payment_gateway_transactions (club_id, invoice_id, gateway, amount, status)
  values (v_club_id, p_invoice_id, p_gateway, p_amount, 'pending')
  returning id into v_id;

  return v_id;
end;
$$;

revoke execute on function public.start_gateway_checkout(uuid, text, numeric) from public, anon;
grant execute on function public.start_gateway_checkout(uuid, text, numeric) to authenticated;

comment on function public.start_gateway_checkout(uuid, text, numeric) is
  'Task #88/#89: creates a pending payment_gateway_transactions row after validating the gateway is enabled and the amount does not exceed the real outstanding balance (get_invoice_payment_summary(), same single source of truth every payment path uses). Does not call any external API -- that is the responsibility of a future Edge Function, which would use the returned id to create the real Stripe Checkout Session / PayPal order.';
