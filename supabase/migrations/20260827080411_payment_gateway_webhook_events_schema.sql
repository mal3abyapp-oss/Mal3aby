-- MULTI-GATEWAY PAYMENTS (Phase 2, Section 38/40): raw webhook event
-- log. None of the 5 providers guarantees exactly-once delivery per
-- PAYMENT_GATEWAY_PROVIDER_MATRIX.md (Stripe explicitly warns of
-- duplicates; Kashier/Fawry both retry-until-200) -- deduplication is
-- entirely Mal3aby's own responsibility, enforced here via a unique
-- index on (provider_key, provider_event_id) where the provider
-- supplies a stable event id, falling back to a content-hash for
-- providers whose payload has no separate event id.
create table public.payment_gateway_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null references public.payment_gateway_providers(key),
  connection_id uuid references public.club_gateway_connections(id),
  transaction_id uuid references public.payment_gateway_transactions(id),

  provider_event_id text, -- provider's own event/delivery id if it supplies one (Stripe event.id, PayPal transmission id, etc).
  payload_hash text not null, -- sha256 of the raw normalized payload -- the dedup fallback when provider_event_id is absent (Fawry has no dedicated event id, only messageSignature over the payload).

  signature_valid boolean not null,
  processed boolean not null default false,
  processing_error text, -- sanitized -- never a raw provider payload dump or secret.

  -- Section 42: amount/currency tampering must never post a payment --
  -- this records whether the webhook's claimed amount/currency matched
  -- the expected transaction, as a permanent audit trail even when the
  -- answer is "no, this was rejected".
  amount_matched boolean,
  currency_matched boolean,

  received_at timestamptz not null default now(),
  processed_at timestamptz
);

-- Dedup: same provider + same event id (when the provider supplies
-- one) is processed exactly once. Payload-hash fallback covers
-- providers without a dedicated event id.
create unique index payment_gateway_webhook_events_provider_event_unique
  on public.payment_gateway_webhook_events(provider_key, provider_event_id) where provider_event_id is not null;
create index payment_gateway_webhook_events_payload_hash_idx
  on public.payment_gateway_webhook_events(provider_key, payload_hash);

alter table public.payment_gateway_webhook_events enable row level security;
alter table public.payment_gateway_webhook_events force row level security;

-- Webhook processing itself only ever happens via a service-role Edge
-- Function (never a client call) -- this table's RLS exists purely so
-- staff/platform can VIEW webhook health/reconciliation exceptions
-- (Section 76/77), never so a client can write to it.
create policy payment_gateway_webhook_events_select on public.payment_gateway_webhook_events
  for select to authenticated
  using (
    connection_id in (
      select id from public.club_gateway_connections cgc
      where cgc.club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.view', cgc.club_id)
    )
    or exists (
      select 1 from public.club_gateway_connections cgc
      where cgc.id = payment_gateway_webhook_events.connection_id
        and public.has_platform_support_access(cgc.club_id, false)
    )
  );

revoke all on public.payment_gateway_webhook_events from public, anon, authenticated;
grant select on public.payment_gateway_webhook_events to authenticated;
