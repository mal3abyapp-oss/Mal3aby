-- MULTI-GATEWAY PAYMENTS (Phase 2, Section 36): extends the EXISTING
-- payment_gateway_transactions table (from the earlier Stripe/PayPal-
-- only architecture) rather than creating a parallel table -- same
-- table, widened. Adds: connection linkage (which club_gateway_connections
-- row this attempt used), idempotency key (Mal3aby-generated -- per
-- PAYMENT_GATEWAY_PROVIDER_MATRIX.md, only Stripe/PayPal have native
-- provider idempotency; Paymob/Kashier/Fawry do not, so Mal3aby's own
-- key is the real dedup mechanism for those three), currency (was
-- implicitly assumed EGP-equivalent before -- now explicit, since
-- Stripe/PayPal transactions may not be EGP), provider session/order
-- reference, and raw-vs-normalized status split (Section 36:
-- "Gateway transaction != revenue").
alter table public.payment_gateway_transactions
  add column connection_id uuid references public.club_gateway_connections(id),
  add column environment text check (environment in ('sandbox', 'live')),
  add column currency text not null default 'EGP',
  add column idempotency_key uuid,
  add column provider_session_ref text, -- the provider's own session/order/intention ID (Stripe Checkout Session id, PayPal Order id, Paymob intention id, etc).
  add column provider_raw_status text, -- the provider's own status string, verbatim, for debugging/reconciliation -- never used for authorization decisions.
  add column correlation_id uuid not null default gen_random_uuid(); -- ties together checkout -> webhook -> canonical payment posting for debugging (Section 74), safe to expose in logs (contains no PII/secrets).

-- Widen the gateway check to all 5 providers (was 'stripe'/'paypal' only).
alter table public.payment_gateway_transactions drop constraint if exists payment_gateway_transactions_gateway_check;
alter table public.payment_gateway_transactions add constraint payment_gateway_transactions_gateway_check
  check (gateway in ('stripe', 'paypal', 'paymob', 'kashier', 'fawry'));

-- Idempotency: same Mal3aby-generated key for the same club never
-- creates two attempts. Partial unique index (mirrors this project's
-- own established idempotency_key pattern everywhere else --
-- payments.idempotency_key, shop_sales.idempotency_key, etc).
create unique index payment_gateway_transactions_club_idempotency_key_unique
  on public.payment_gateway_transactions(club_id, idempotency_key) where idempotency_key is not null;
