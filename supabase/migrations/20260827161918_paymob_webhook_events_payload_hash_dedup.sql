-- MULTI-GATEWAY PAYMENTS (Phase 2, Paymob adapter): Paymob's
-- transaction processed callback carries no dedicated event id (unlike
-- Stripe's event.id) -- payment_gateway_webhook_events was already
-- designed to anticipate this ("payload_hash -- the dedup fallback
-- when provider_event_id is absent"), but only had a non-unique INDEX
-- on (provider_key, payload_hash), not a UNIQUE constraint -- so
-- nothing actually enforced the dedup at the database level yet; a
-- caller had to remember to check-then-insert non-atomically. This
-- migration adds the real constraint the paymob-gateway-webhook Edge
-- Function relies on for atomic, race-safe dedup: a genuine duplicate
-- delivery of the SAME callback payload for the SAME provider hits a
-- unique-violation (23505) as the atomic insert-based dedup signal,
-- exactly mirroring how the Stripe webhook already relies on the
-- (provider_key, provider_event_id) unique index for the same
-- purpose.
--
-- NOTE: this is a content-hash of the raw payload, not a logical
-- event id -- Paymob is documented as not guaranteeing exactly-once
-- delivery (PAYMENT_GATEWAY_PROVIDER_MATRIX.md), so a legitimate retry
-- of the identical processed callback (same transaction, same fields,
-- same values) will correctly collide on this index and be treated as
-- a duplicate -- this is the desired behavior, not a bug: Paymob does
-- not document a scenario where the SAME transaction's processed
-- callback payload changes between retries.
create unique index payment_gateway_webhook_events_provider_payload_unique
  on public.payment_gateway_webhook_events(provider_key, payload_hash)
  where provider_event_id is null;
