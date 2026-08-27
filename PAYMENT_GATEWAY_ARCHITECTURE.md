# Payment Gateway Architecture — Stripe & Paymob Adapters (end-to-end)

Phase 2 (Multi-Gateway Online Payments), consolidated 2026-08-27,
extended 2026-08-27 with the Paymob adapter. This document is the
single map of the full Stripe and Paymob flows across all their
pieces; the individual docs (`PAYMENT_GATEWAY_PROVIDER_MATRIX.md`,
`PAYMENT_GATEWAY_WEBHOOK_MODEL.md`, `PAYMENT_GATEWAY_RECONCILIATION.md`)
carry the detailed evidence for their own pieces.

Both adapters share the SAME underlying schema
(`club_gateway_connections`, `payment_gateway_transactions`,
`payment_gateway_webhook_events`) and the SAME provider-agnostic
service-role RPCs (`record_gateway_payment_service`,
`mark_gateway_transaction_failed_service`,
`create_gateway_refund_service`, `get_gateway_transaction_status`) —
none of those needed any Paymob-specific change; only the
provider-specific Edge Functions differ (Stripe's HMAC-SHA256
header-based webhook signature vs. Paymob's HMAC-SHA512
query-param/field-concatenation scheme; Stripe's checkout URL returned
directly by the API vs. Paymob's hosted-checkout URL constructed
client-side from a public key + client_secret).

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

## The Paymob flow (2026-08-27)

```
Club Owner connects Paymob
  connect_club_gateway() [authenticated, payment.methods.manage]
    → writes club_gateway_connections row (public_key = Paymob public key,
      provider_merchant_ref = Integration ID(s), secret + HMAC secret
      stored via vault.create_secret())

Staff/customer initiates payment on an issued invoice
  start_gateway_checkout() [authenticated, invoice.view]  -- UNCHANGED, provider-agnostic

Client calls paymob-create-checkout-session { transaction_id }
  [Edge Function, verify_jwt=true]
    → re-derives authorization via get_gateway_transaction_status() (same as Stripe's)
    → reads connection.secret_vault_id via get_vault_secret_service()
    → POST https://accept.paymob.com/v1/intention/
      (amount in CENTS, currency, payment_methods=[Integration ID(s)],
       special_reference=transaction_id, notification_url, redirection_url)
    → UPDATE payment_gateway_transactions.provider_session_ref = intention.id
    → constructs checkout_url = https://eg.checkout.paymob.com/?publicKey=...&clientSecret=...
      (UNLIKE Stripe: Paymob does not return a ready-made checkout URL --
      it must be built client-side from the connection's public key)

Customer completes (or cancels) checkout on Paymob's Unified Checkout page
  → Paymob redirects to redirection_url (GatewayReturnPage, read-only, unchanged)

Paymob delivers the transaction-processed callback (asynchronous, server-to-server)
  paymob-gateway-webhook [Edge Function, verify_jwt=false]
    → reads raw body as text, parses obj (Paymob's transaction object)
    → resolves candidate connection(s): obj.order.merchant_order_id
      (= the Mal3aby transaction_id itself, O(1) DIRECT match -- stronger
      than Stripe's session-id indirection, no round-trip needed) →
      provider_session_ref (intention id or, on a later delivery, the
      real Paymob transaction id) → O(N) fallback (defensive only)
    → verifies HMAC-SHA512 over 20 DOCUMENTED, FIXED-ORDER field VALUES
      (not the raw body -- see PAYMENT_GATEWAY_WEBHOOK_MODEL.md), compared
      against the `hmac` QUERY PARAMETER (not a header, unlike Stripe)
    → dedups via payment_gateway_webhook_events unique (provider_key,
      payload_hash) -- Paymob has no dedicated event id, unlike Stripe's
      event.id, so dedup is content-hash-based (a new unique index added
      specifically for this: 20260827161918_paymob_webhook_events_payload_hash_dedup.sql)
    → obj.is_refunded/is_voided → acknowledged, never re-posted as a payment
    → obj.success === true → record_gateway_payment_service() [service_role-only,
      UNCHANGED from Stripe's usage] -- also overwrites provider_session_ref
      with Paymob's REAL transaction id (obj.id), which the refund endpoint
      requires (see below)
    → otherwise → mark_gateway_transaction_failed_service()

Staff issues a refund on a card payment
  paymob-create-refund { payment_id, amount, reason } [Edge Function, verify_jwt=true]
    → re-derives authorization: has_permission('payment.refund', club_id) -- same as Stripe's
    → FAIL-CLOSED GUARD: refuses if provider_session_ref is not yet a bare
      integer (i.e. the webhook's success handler has not yet overwritten
      the intention id with the real Paymob transaction id)
    → POST https://accept.paymob.com/api/acceptance/void_refund/refund
      { transaction_id: <Paymob transaction id>, amount_cents }
      (synchronous, per Paymob's own docs -- same design as Stripe's
      synchronous-first + webhook-defensive-fallback pattern, though
      Paymob's refund callback shape is the SAME transaction-processed
      callback distinguished by is_refunded=true, not a separate event type)
    → on success:true → posts canonical refund SYNCHRONOUSLY via
      create_gateway_refund_service() [service_role-only, UNCHANGED --
      already provider-agnostic, no Paymob-specific change needed]
```

### Paymob vs. Stripe: what genuinely differs

| Aspect | Stripe | Paymob |
|---|---|---|
| Checkout URL | Returned directly by the Checkout Sessions API | Constructed client-side: `{region}.checkout.paymob.com/?publicKey=...&clientSecret=...` |
| Webhook signature location | `Stripe-Signature` HEADER | `hmac` QUERY PARAMETER |
| Webhook signature scheme | HMAC-SHA256 over raw body bytes (`timestamp.payload`) | HMAC-SHA512 over 20 documented field VALUES (not raw bytes) |
| Webhook dedup key | `event.id` (Stripe supplies one) | content hash of the payload (Paymob supplies none) |
| Merchant-reference echo | `metadata.mal3aby_transaction_id` + `client_reference_id` on the Stripe object | `special_reference` request field echoed as `order.merchant_order_id` on the callback |
| Refund identifier | Stripe PaymentIntent id (`pi_...`), resolved from the Checkout Session if needed | Paymob's own numeric TRANSACTION id (distinct from the Intention id `pi_...` used at checkout time) -- requires the webhook to hand off the real id post-confirmation |
| Sandbox vs. live | Distinguished by `sk_test_`/`sk_live_` key prefix, same API host | Same base URL AND same key-prefix-driven mode -- CONFIRMED identical mechanism to Stripe's, not a separate staging host (unlike Kashier) |

## Evidence-level summary — Paymob adapter (2026-08-27)

| Piece | Evidence level |
|---|---|
| Intentions API request/response shape, Unified Checkout URL shape, Refund endpoint shape, sandbox/live base-URL mechanism | OFFICIAL DOC VERIFIED (all four previously-flagged-unconfirmed items re-fetched against Paymob's live docs this session, with real source URLs — see `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` "Paymob update" section) |
| HMAC-SHA512 field order and concatenation | OFFICIAL DOC VERIFIED + CODE VERIFIED (independent Python reconstruction reproduces Paymob's own published worked-example concatenated string byte-for-byte, and a second, hand-rolled RFC-2104 HMAC-SHA512 implementation cross-checks the algorithm) |
| Webhook HMAC verification, end-to-end payment posting | LIVE VERIFIED — a hand-signed test callback against the real deployed `paymob-gateway-webhook` function and a real Supabase Vault secret produced a real `payments` row; verified by direct query afterward |
| Webhook signature REJECTION (negative evidence) | LIVE VERIFIED — an incorrect signature against the same real connection/secret was rejected (400), proving the check genuinely discriminates |
| Duplicate webhook idempotency | LIVE VERIFIED — the identical signed payload replayed against the live function returned `duplicate:true` rather than reprocessing |
| Amount-mismatch fail-closed rejection | LIVE VERIFIED — a webhook claiming a different confirmed amount than the staged transaction was rejected; the transaction was marked `failed` with an explicit reason, no payment was posted |
| `record_gateway_payment_service`, `mark_gateway_transaction_failed_service`, `create_gateway_refund_service`, `get_gateway_transaction_status` reused as-is for Paymob | CODE VERIFIED (all four were already provider-agnostic by construction; confirmed by reading each function's body before reuse — no Paymob-specific change was needed or made) |
| Intentions API and Refund API request-shape correctness (no real credentials) | CONTRACT VERIFIED — real HTTP requests to Paymob's live production API with a garbage token returned genuine, path-specific 401 auth errors (`{"detail":"Authentication credentials were not provided."}` for `/v1/intention/`, `{"detail":"Invalid token."}` for `/api/acceptance/void_refund/refund`) — contrasted against a deliberately wrong path, which returned a real 404, proving the 401s are not a generic catch-all |
| Grant hygiene on the new dedup index / `get_vault_secret_service` reuse | LIVE VERIFIED — queried `information_schema` directly; `service_role`-only on the vault RPC, `authenticated`-SELECT-only (RLS-gated) on the webhook events table, unchanged from the Stripe baseline |
| Cross-tenant / grant checks on new service-role RPCs | N/A — no new service-role RPCs were created for Paymob; all reused Stripe's existing, already-tested RPCs unchanged |
| Genuine Paymob-originated webhook delivery, genuine Paymob-hosted checkout completion | CREDENTIAL-BLOCKED — no real Paymob merchant account exists for this project (confirmed: "محدش عندي حسابات") |
| Other 3 providers (PayPal, Kashier, Fawry) | Not built this phase — architecture documented in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` |

### What a future session needs to reach SANDBOX VERIFIED for Paymob

A real Paymob merchant account (test/sandbox credentials, same base URL
as live per this session's confirmed finding — mode is entirely
key-driven), its secret key, public key, HMAC secret, and Integration
ID(s) connected via `connect_club_gateway(...)` to a real test club,
then a genuinely completed test-mode Unified Checkout transaction to
generate a real Paymob-signed callback against the deployed
`paymob-gateway-webhook` function.

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
