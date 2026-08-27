-- MULTI-GATEWAY PAYMENTS (Phase 2, item 8): refunds.idempotency_key did
-- not exist before this migration -- confirmed via information_schema
-- before writing this. This mirrors the SAME established pattern
-- already used everywhere else in this project (payments.idempotency_key,
-- shop_sales.idempotency_key, payment_gateway_transactions.idempotency_key):
-- a partial unique index on (payment_id, idempotency_key) where not
-- null, so a retried gateway-refund call (e.g. a webhook redelivery,
-- or a retried Stripe API call after a network timeout where the
-- first attempt actually succeeded) can never create two refund rows
-- for the same logical refund event.
--
-- provider_refund_ref stores the provider's own refund id (e.g.
-- Stripe's re_... id) for reconciliation -- same "store the provider's
-- reference, never re-derive it" convention as
-- payment_gateway_transactions.provider_session_ref.
alter table public.refunds
  add column idempotency_key uuid,
  add column provider_refund_ref text;

create unique index refunds_payment_idempotency_key_unique
  on public.refunds(payment_id, idempotency_key) where idempotency_key is not null;
