# Payment Gateway Architecture — Stripe Reference Adapter (end-to-end)

Phase 2 (Multi-Gateway Online Payments), consolidated 2026-08-27. This
document is the single map of the full Stripe flow across all its
pieces; the individual docs (`PAYMENT_GATEWAY_PROVIDER_MATRIX.md`,
`PAYMENT_GATEWAY_WEBHOOK_MODEL.md`, `PAYMENT_GATEWAY_RECONCILIATION.md`)
carry the detailed evidence for their own pieces.

## Constraints this design honors throughout

- **Mal3aby is never the merchant of record.** Stripe Checkout is
  hosted — the card number never touches Mal3aby's frontend or
  backend at any point in this flow.
- **Redirect result is never authoritative.** `GatewayReturnPage`
  contains zero write path; only the webhook (after independent
  signature verification) can ever change `payment_gateway_transactions.status`
  or post to `public.payments`.
- **Finance is never duplicated.** `gateway_reconciliation_report` is
  read-only visibility over Finance's own tables, never a parallel
  ledger.
- **Secrets never reach client-reachable code.** Every Stripe secret
  key lives in Supabase Vault, read only by `service_role` via
  `get_vault_secret_service` — never returned to, or derivable by, an
  `authenticated` or `anon` caller.

## The full flow, piece by piece

```
Club Owner connects Stripe
  connect_club_gateway() [authenticated, payment.methods.manage]
    → writes club_gateway_connections row
    → secret + webhook secret stored via vault.create_secret()

Staff/customer initiates payment on an issued invoice
  start_gateway_checkout() [authenticated, invoice.view]
    → validates amount ≤ outstanding, resolves connection
    → INSERT payment_gateway_transactions (status='pending')
    → returns transaction_id (no outbound HTTP call, no vault read)

Client calls stripe-create-checkout-session { transaction_id }
  [Edge Function, verify_jwt=true]
    → re-derives authorization via get_gateway_transaction_status()
      (same invoice.view/user_club_ids check start_gateway_checkout used)
    → reads connection.secret_vault_id via get_vault_secret_service()
    → POST https://api.stripe.com/v1/checkout/sessions
      (mode=payment, line_items[...], metadata.mal3aby_transaction_id,
       client_reference_id, Idempotency-Key header)
    → UPDATE payment_gateway_transactions.provider_session_ref = session.id
    → returns { checkout_url } to redirect the browser to Stripe

Customer completes (or cancels) checkout on Stripe's hosted page
  → Stripe redirects to /app/finance/gateway-return?transaction_id=...&outcome=...
  → GatewayReturnPage polls get_gateway_transaction_status() (READ-ONLY)
    → NEVER writes; outcome= is a display hint only, never trusted

Stripe delivers a webhook (checkout.session.completed / payment_intent.succeeded /
charge.refunded / refund.updated / any other event type)
  stripe-gateway-webhook [Edge Function, verify_jwt=false]
    → reads raw body as text FIRST (signature computed over raw bytes)
    → resolves candidate connection(s): provider_session_ref exact match
      (O(1), the common case now that checkout-session-creation populates
      it) → metadata.mal3aby_transaction_id → O(N) fallback (defensive only)
    → verifies HMAC-SHA256 via get_vault_secret_service() + constant-time compare
    → dedups via payment_gateway_webhook_events unique (provider_key, provider_event_id)
    → success event type → record_gateway_payment_service() [service_role-only]
        - re-validates staged amount/currency, invoice still issued+outstanding
        - INSERT payments + payment_allocations, atomically
        - calls _apply_gateway_payment_side_effects_internal (activation,
          booking auto-confirm, notifications)
    → refund event type → create_gateway_refund_service() [defensive reconciliation]
    → any other event type → mark_gateway_transaction_failed_service()

Staff issues a refund on a card payment
  stripe-create-refund { payment_id, amount, reason } [Edge Function, verify_jwt=true]
    → re-derives authorization: has_permission('payment.refund', club_id)
    → resolves the ORIGINAL payment_gateway_transactions row (same-provider
      invariant enforced downstream by create_gateway_refund_service)
    → POST https://api.stripe.com/v1/refunds (synchronous for card payments)
    → on Stripe status:"succeeded" (the common case) → posts canonical
      refund SYNCHRONOUSLY via create_gateway_refund_service() [service_role-only]
    → on any other status → returns "not yet confirmed", relies on the
      webhook's defensive charge.refunded/refund.updated handling
  stripe-gateway-webhook's refund branch is a DEFENSIVE reconciliation
  safety net for the (rare, for cards) async-confirmation case, or for
  a refund created directly in Stripe's own Dashboard — idempotent with
  the synchronous path via a shared deterministic-UUID-from-Stripe-refund-id
  derivation, so whichever path processes a given real refund first,
  the other is a safe no-op.

Anyone with payment.methods.view can pull
  gateway_reconciliation_report(club_id, from, to) [authenticated, read-only]
    → operational visibility only, never a second ledger
```

## Evidence-level summary (honest, per the project's taxonomy)

| Piece | Evidence level |
|---|---|
| `start_gateway_checkout`, `record_gateway_payment_service`, `mark_gateway_transaction_failed_service` | LIVE VERIFIED (prior session + re-confirmed this session) |
| Checkout Sessions API request shape (`stripe-create-checkout-session`) | OFFICIAL DOC VERIFIED (endpoint/params against live Stripe docs) + CONTRACT VERIFIED (fake-key auth-error test) |
| EGP/zero-decimal currency handling | OFFICIAL DOC VERIFIED (Stripe's currencies doc fetched live; EGP confirmed NOT zero-decimal/special-cased) |
| Webhook signature verification, end-to-end payment posting | LIVE VERIFIED (disposable hand-signed test event against the real deployed function and real Vault secrets) |
| Duplicate webhook idempotency (item 7) | LIVE VERIFIED (identical signed request sent twice, DB-confirmed single post) |
| Amount/currency mismatch defense (item 6) | LIVE VERIFIED, re-confirmed after this session's changes |
| Fake-success-redirect cannot mark paid (item 5) | LIVE VERIFIED by construction (zero write RPCs in `GatewayReturnPage`) AND by live query (transaction remained `pending`, zero new payments, after simulated repeated visits) |
| `get_vault_secret_service` fix | LIVE VERIFIED — the bug this fixed was itself found via live testing this session (see `PAYMENT_GATEWAY_WEBHOOK_MODEL.md`) |
| Refunds API request shape (`stripe-create-refund`) | OFFICIAL DOC VERIFIED + CONTRACT VERIFIED (fake-key auth-error test); NOT exercised end-to-end (no real payment existed to refund without a genuine Stripe checkout — see item 9) |
| `create_gateway_refund_service` invariants (same-provider, refundable-balance, idempotency) | CODE VERIFIED by inspection against `create_refund()`'s own proven shape; not independently live-exercised with a real refund this session |
| `gateway_reconciliation_report` | LIVE VERIFIED grant matrix; join logic CODE VERIFIED by inspection, not exercised against a hand-broken exception fixture |
| Genuine Stripe-originated webhook delivery, genuine Stripe-hosted checkout completion | CREDENTIAL-BLOCKED — no real Stripe account exists for this project (confirmed: "محدش عندي حسابات") |
| Other 4 providers (PayPal, Paymob, Kashier, Fawry) | Not built this phase — architecture documented in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` |

## What a future session needs to reach SANDBOX VERIFIED

A real Stripe account (test mode, free to create), its `sk_test_...`
secret key and `whsec_...` webhook signing secret connected via
`connect_club_gateway(...)` to a real test club, and then either a
genuinely completed test-mode Checkout Session or the Stripe CLI's
`stripe trigger`/`stripe listen --forward-to` tooling to generate a
real Stripe-signed delivery against the deployed
`stripe-gateway-webhook` function.
