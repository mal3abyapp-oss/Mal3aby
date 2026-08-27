# Payment Gateway Architecture — Stripe, Paymob, Kashier & Fawry Adapters (end-to-end)

Phase 2 (Multi-Gateway Online Payments), consolidated 2026-08-27,
extended 2026-08-27 with the Paymob adapter, extended again 2026-08-27
with the Kashier adapter, extended again 2026-08-27 with the Fawry
adapter (the fourth and, per the standing directive's own scope, final
provider built this phase — PayPal remains unbuilt). This document is
the single map of the full Stripe, Paymob, Kashier, and Fawry flows
across all their pieces; the individual docs
(`PAYMENT_GATEWAY_PROVIDER_MATRIX.md`, `PAYMENT_GATEWAY_WEBHOOK_MODEL.md`,
`PAYMENT_GATEWAY_RECONCILIATION.md`) carry the detailed evidence for
their own pieces.

All four adapters share the SAME underlying schema
(`club_gateway_connections`, `payment_gateway_transactions`,
`payment_gateway_webhook_events`) and the SAME provider-agnostic
service-role RPCs (`record_gateway_payment_service`,
`mark_gateway_transaction_failed_service`,
`create_gateway_refund_service`, `get_gateway_transaction_status`) —
none of those needed any Paymob-, Kashier-, or Fawry-specific change;
only the provider-specific Edge Functions differ (Stripe's HMAC-SHA256
header-based webhook signature vs. Paymob's HMAC-SHA512
query-param/field-concatenation scheme vs. Kashier's HMAC-SHA256
header-based-but-query-string-encoded scheme vs. Fawry's SHA-256
body-field scheme over a differently-ordered field set for its outbound
vs. inbound directions; Stripe's and Kashier's checkout URLs returned
directly by the API vs. Paymob's hosted-checkout URL constructed
client-side from a public key + client_secret vs. Fawry's own
directly-returned redirect URL, whose exact response field name is a
disclosed, genuine documentation gap — see the Fawry section below).

**Fawry's evidence ceiling is deliberately lower than the other three
adapters'.** No self-service sandbox exists for this provider (manual
merchant registration, ~2 business days, re-confirmed live this
session) — every Fawry claim below is OFFICIAL DOC VERIFIED and/or CODE
VERIFIED (including live tests of THIS PROJECT'S OWN deployed webhook
function using a hand-signed test vector cross-checked against an
independent Python implementation and a real third-party open-source
Ruby gem), never SANDBOX VERIFIED or LIVE-VERIFIED-against-Fawry's-own-
infrastructure. This is disclosed explicitly throughout, not glossed
over.

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
| Other 3 providers (PayPal, Kashier, Fawry) | Kashier and Fawry now built (see below); PayPal not built this phase — architecture documented in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` |

### What a future session needs to reach SANDBOX VERIFIED for Paymob

A real Paymob merchant account (test/sandbox credentials, same base URL
as live per this session's confirmed finding — mode is entirely
key-driven), its secret key, public key, HMAC secret, and Integration
ID(s) connected via `connect_club_gateway(...)` to a real test club,
then a genuinely completed test-mode Unified Checkout transaction to
generate a real Paymob-signed callback against the deployed
`paymob-gateway-webhook` function.

## The Kashier flow (2026-08-27)

```
Club Owner connects Kashier
  connect_club_gateway() [authenticated, payment.methods.manage]
    → writes club_gateway_connections row
    → provider_merchant_ref = Kashier Merchant ID (MID-XXXX-XXX)
    → secret_vault_id       = Kashier SECRET KEY (refund auth only)
    → webhook_secret_vault_id = Kashier PAYMENT API KEY (session
      creation `api-key` header AND webhook HMAC -- a DELIBERATE,
      DOCUMENTED deviation from Paymob's single-key mapping, since
      Kashier genuinely has two independent keys serving disjoint
      purposes -- see kashier-create-checkout-session's own header
      comment for the full rationale)

Staff/customer initiates payment on an issued invoice
  start_gateway_checkout() [authenticated, invoice.view]  -- UNCHANGED, provider-agnostic

Client calls kashier-create-checkout-session { transaction_id }
  [Edge Function, verify_jwt=true]
    → re-derives authorization via get_gateway_transaction_status() (same as Stripe's/Paymob's)
    → reads BOTH connection.secret_vault_id (Secret Key) and
      connection.webhook_secret_vault_id (Payment API Key) via
      get_vault_secret_service() -- Kashier's own documented example
      sends both `Authorization: {{secret_key}}` and
      `api-key: {{payment_api_key}}` headers on the SAME request
    → selects the base URL from connection.environment (sandbox ->
      test-api.kashier.io, live -> api.kashier.io) -- Kashier genuinely
      uses a DIFFERENT HOST per environment, unlike Stripe/Paymob
    → POST {base_url}/v3/payment/sessions
      (amount as a DECIMAL STRING in major units e.g. "100.00" -- NOT
       minor-unit cents like Paymob's amount_cents, currency,
       merchantId, order=transaction_id, merchantRedirect, serverWebhook)
    → UPDATE payment_gateway_transactions.provider_session_ref = session._id
    → returns { checkout_url: sessionUrl } DIRECTLY from Kashier's
      response (like Stripe, UNLIKE Paymob's client-side URL construction)

Customer completes (or cancels) checkout on Kashier's hosted Payment Session page
  → Kashier redirects to merchantRedirect (GatewayReturnPage, read-only, unchanged)

Kashier delivers the server-to-server webhook (asynchronous)
  kashier-gateway-webhook [Edge Function, verify_jwt=false]
    → reads the `x-kashier-signature` HEADER (not a query param, unlike
      Paymob) and the raw body as text
    → resolves candidate connection(s): data.merchantOrderId (= the
      Mal3aby transaction_id itself, O(1) DIRECT match, echoed back
      from the `order` field sent at session-creation time -- same
      strength as Paymob's special_reference pattern) →
      provider_session_ref (data.kashierOrderId or the session id) →
      O(N) fallback (defensive only)
    → verifies HMAC-SHA256 over an RFC 3986 query-string built from
      ONLY the fields named in data.signatureKeys, sorted
      alphabetically by key name -- NOT bare value concatenation like
      Paymob's scheme (see PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Kashier
      update" section for the exact construction and Kashier's own
      published code sample this was built from), keyed by the Payment
      API Key
    → dedups via payment_gateway_webhook_events using the EXISTING
      (provider_key, provider_event_id) unique index -- Kashier's own
      transactionId field is a genuine per-callback event id, unlike
      Paymob, so NO new migration was needed (confirming the task
      brief's own anticipation of this)
    → status === 'SUCCESS' → record_gateway_payment_service()
      [service_role-only, UNCHANGED from Stripe's/Paymob's usage] --
      also overwrites provider_session_ref with Kashier's real
      kashierOrderId, which the refund endpoint requires
    → status is PENDING/PROCESSING → acknowledged, no state change
      (genuinely still in-flight, never posts a payment on a
      non-terminal status)
    → status is FAILED/DECLINED/CANCELLED/EXPIRED →
      mark_gateway_transaction_failed_service()
    → any other/unrecognized status (including a possible refund
      event, whose exact event-name value was not independently
      confirmed this session -- CREDENTIAL-BLOCKED) → acknowledged
      only, never posted as a new payment (fails closed on ambiguity)

Staff issues a refund on a card payment
  kashier-create-refund { payment_id, amount, reason } [Edge Function, verify_jwt=true]
    → re-derives authorization: has_permission('payment.refund', club_id) -- same as Stripe's/Paymob's
    → reads connection.secret_vault_id (the Kashier SECRET KEY, not the
      Payment API Key -- the refund endpoint's Authorization header
      requires the Secret Key specifically)
    → PUT {fep.kashier.io or test-fep.kashier.io}/orders/:orderId/
      { apiOperation: "REFUND", reason, transaction: { amount } }
      -- a THIRD, distinct subdomain family from BOTH the Payment
      Sessions host AND the legacy iframe host (newly discovered this
      session, not previously documented anywhere in this project)
    → on response.status === "SUCCESS" → posts canonical refund
      SYNCHRONOUSLY via create_gateway_refund_service()
      [service_role-only, UNCHANGED -- already provider-agnostic]
    → CONTRACT-TESTED but end-to-end success CREDENTIAL-BLOCKED: real
      requests to test-fep.kashier.io with a garbage key/orderId
      consistently return a "Routing key is missing from the URL"
      error distinct from both a clean 401 and a genuine 404, proving
      the endpoint is live-routed but leaving open whether a real
      order id/header requirement this session could not discover is
      needed -- disclosed explicitly in the function's own comment for
      a future session with real credentials to resolve first
```

### Kashier vs. Paymob vs. Stripe: what genuinely differs

| Aspect | Stripe | Paymob | Kashier |
|---|---|---|---|
| Checkout URL | Returned directly by the API | Constructed client-side from public key + client_secret | Returned directly by the API (`sessionUrl`) |
| Webhook signature location | `Stripe-Signature` HEADER | `hmac` QUERY PARAMETER | `x-kashier-signature` HEADER |
| Webhook signature scheme | HMAC-SHA256 over raw body bytes | HMAC-SHA512 over 20 documented field VALUES (bare concatenation) | HMAC-SHA256 over an RFC 3986 query-string of `signatureKeys` fields (key=value pairs) |
| Webhook dedup key | `event.id` | content hash of the payload (no event id) | `transactionId` (a genuine per-callback event id, like Stripe) |
| Merchant-reference echo | `metadata.mal3aby_transaction_id` / `client_reference_id` | `special_reference` → `order.merchant_order_id` | `order` (request) → `merchantOrderId` (webhook) |
| Amount units | Integer minor units (with zero-decimal currency exceptions) | Integer minor units (`amount_cents`) always | Decimal STRING in major units (e.g. `"100.00"`) -- no minor-unit conversion |
| Refund identifier | Stripe PaymentIntent id | Paymob's own numeric transaction id (distinct from the Intention id) | Kashier's own order id (`kashierOrderId`, handed off via the webhook, distinct from the merchant's `order` reference) |
| Number of distinct provider secrets | One (`sk_...`) + one webhook secret | One secret key serves every purpose | TWO genuinely distinct keys (Payment API Key for sessions+webhook HMAC; Secret Key for refunds only) — a structural difference from both other providers |
| Sandbox vs. live | Same host, `sk_test_`/`sk_live_` prefix | Same host, key-prefix-driven | DIFFERENT HOST per environment (`api.kashier.io` vs `test-api.kashier.io`), AND across THREE separate subdomain families (sessions/iframe/refunds) |

## Evidence-level summary — Kashier adapter (2026-08-27)

| Piece | Evidence level |
|---|---|
| Payment Sessions API request/response shape, webhook HMAC scheme, two-key model | OFFICIAL DOC VERIFIED (all fetched directly against Kashier's live docs this session — see `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` "Kashier update" section for source URLs and the verbatim published code sample) |
| HMAC-SHA256 query-string construction (pick signatureKeys, sort, RFC3986-encode) | OFFICIAL DOC VERIFIED + CODE VERIFIED (independent Python reference implementation matches Kashier's own published example and the Edge Function's Web Crypto output byte-for-byte) |
| Webhook signature verification, end-to-end payment posting | LIVE VERIFIED — a hand-signed test callback against the real deployed `kashier-gateway-webhook` function and a real Supabase Vault secret produced a real `payments` row (`method='card'`, amount 100.00), one `payment_allocations` row, `provider_session_ref` correctly overwritten to Kashier's order id; confirmed by direct query afterward |
| Webhook signature REJECTION (negative evidence) | LIVE VERIFIED — an incorrect signature and a missing signature header against the same real connection/secret were both rejected (400) |
| Duplicate webhook idempotency | LIVE VERIFIED — the identical signed payload replayed against the live function returned `duplicate:true`; a direct count confirmed exactly one webhook event row, one payment, one allocation |
| Amount-mismatch fail-closed rejection | LIVE VERIFIED — a webhook claiming a different confirmed amount (999) than the staged transaction (300.00) was rejected; `payment_id: null` returned, transaction durably marked `failed` with `failure_reason = 'amount mismatch: staged=300.00 confirmed=999'`, zero payments posted |
| `record_gateway_payment_service`, `mark_gateway_transaction_failed_service`, `create_gateway_refund_service`, `get_gateway_transaction_status` reused as-is for Kashier | CODE VERIFIED (all four already provider-agnostic; confirmed no Kashier-specific change was needed or made) |
| `verify_jwt=true` gate on the two authenticated functions | LIVE VERIFIED — real 401 (`UNAUTHORIZED_NO_AUTH_HEADER`) from both `kashier-create-checkout-session` and `kashier-create-refund` with no Authorization header |
| Payment Sessions API request-shape correctness (no real credentials) | CONTRACT VERIFIED — a real HTTP request to `test-api.kashier.io/v3/payment/sessions` with a garbage key returned a genuine, path-specific `{"error":"Authorization error","message":"Invalid token"}` (401) — contrasted against a deliberately wrong path, which returned a real Kashier-branded 404, proving the 401 is not a generic catch-all |
| Refund API request-shape / endpoint-liveness | CONTRACT VERIFIED as LIVE-ROUTED but NOT as auth-confirmed — real requests to `test-fep.kashier.io/orders/:orderId/` with a garbage key returned a genuine, endpoint-specific `"Routing key is missing from the URL"` error (400) distinct from both the Sessions endpoint's clean 401 and a genuine 404 — proves the endpoint exists and is live, but whether the exact request shape used here would succeed with real credentials is CREDENTIAL-BLOCKED and disclosed explicitly in the adapter's own code comment |
| Live refund base URL (`fep.kashier.io`, no `test-` prefix) | PATTERN-INFERRED, not independently doc-confirmed this session — flagged explicitly in code for re-verification before any live-mode Kashier connection is made |
| No new migration needed (`kashier` already in the `gateway` CHECK constraint; existing `(provider_key, provider_event_id)` unique index reused for dedup) | CODE VERIFIED by direct schema inspection before writing any migration — confirmed the task brief's own anticipation that Kashier's dedicated event id might make a new payload-hash migration unnecessary |
| Grant hygiene (`get_vault_secret_service` service_role-only, `payment_gateway_webhook_events` authenticated-SELECT-only) | LIVE VERIFIED — queried `information_schema`/`has_function_privilege` directly; unchanged from the Stripe/Paymob baseline since no new grants were introduced |
| Genuine Kashier-originated webhook delivery, genuine Kashier-hosted checkout completion | CREDENTIAL-BLOCKED — no real Kashier merchant account exists for this project |
| Other providers (PayPal, Fawry) | Fawry now built (see below); PayPal not built this phase — architecture documented in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` |

### What a future session needs to reach SANDBOX VERIFIED for Kashier

A real Kashier merchant account (test-mode Payment API Key, Secret Key,
and Merchant ID), connected via `connect_club_gateway(...)` to a real
test club (Payment API Key into `webhook_secret_vault_id`, Secret Key
into `secret_vault_id`, Merchant ID into `provider_merchant_ref` — see
the deliberate key-mapping rationale in
`kashier-create-checkout-session/index.ts`), then a genuinely completed
test-mode Payment Session transaction to generate a real
Kashier-signed webhook delivery against the deployed
`kashier-gateway-webhook` function. A real refund attempt against a
real Kashier order would also resolve the one remaining open question
(the "Routing key is missing" contract-test finding above).

## The Fawry flow (2026-08-27)

```
Club Owner connects Fawry
  connect_club_gateway() [authenticated, payment.methods.manage]
    → writes club_gateway_connections row
    → provider_merchant_ref = Fawry Merchant Code
    → secret_vault_id       = Fawry Secure Hash Key (the ONE secret
      Fawry uses for every purpose -- charge signing, refund signing,
      notification verification -- same single-secret shape as Paymob,
      unlike Kashier's genuine two-key split)

Staff/customer initiates payment on an issued invoice
  start_gateway_checkout() [authenticated, invoice.view]  -- UNCHANGED, provider-agnostic

Client calls fawry-create-checkout-session { transaction_id }
  [Edge Function, verify_jwt=true]
    → re-derives authorization via get_gateway_transaction_status() (same as the other three)
    → reads connection.secret_vault_id via get_vault_secret_service()
    → POST {base_url}/payments/charge -- Fawry's "Express Checkout
      Link" product: a genuine SERVER-TO-SERVER call (CONFIRMED via
      verbatim-quoted doc text, not Fawry's separate client-side
      "Checkout Button" JS-widget product), amount as a major-unit
      decimal (NOT cents), chargeItems=[{itemId, quantity, price}],
      merchantRefNum=transaction_id, returnUrl, orderWebHookUrl,
      signature (SHA-256 over merchantCode+merchantRefNum+
      customerProfileId(or "")+returnUrl+itemId+qty+price(2dp)+secureKey
      -- a DIFFERENT field set from the inbound notification signature,
      confirmed precisely)
    → UPDATE payment_gateway_transactions.provider_session_ref = best-effort referenceNumber (if present on this response)
    → returns { checkout_url } -- accepts EITHER nextAction.redirectUrl
      OR a plain redirectUrl (GENUINE, DISCLOSED DOC GAP: the exact
      response field name for this specific endpoint was never shown
      in Fawry's own fetched docs -- fails closed if neither shape is
      present, never guesses)

Customer completes (or cancels) checkout on Fawry's hosted page
  → Fawry redirects to returnUrl (GatewayReturnPage, read-only, unchanged)

Fawry delivers the Server-to-Server Notification V2 (asynchronous)
  fawry-gateway-webhook [Edge Function, verify_jwt=false]
    → reads the `messageSignature` BODY FIELD (no header, no query
      param, unlike all three other providers each using a different
      mechanism) and the raw body as text
    → resolves candidate connection(s): merchantRefNum/merchantRefNumber
      (= the Mal3aby transaction_id itself, O(1) DIRECT match -- same
      strength as Paymob's/Kashier's/Stripe's own merchant-reference
      patterns; BOTH spellings read defensively for lookup, though the
      SIGNATURE always uses merchantRefNum specifically, per the
      verbatim third-party Ruby gem source) → provider_session_ref
      (fawryRefNumber) → O(N) fallback (defensive only)
    → verifies SHA-256 over fawryRefNumber+merchantRefNum+
      paymentAmount(2dp)+orderAmount(2dp)+orderStatus+paymentMethod+
      paymentRefrenceNumber+secureKey -- OFFICIAL DOC VERIFIED AND
      CODE VERIFIED against a real third-party open-source Ruby gem's
      verbatim signature-building source, independently agreeing with
      Fawry's own docs
    → dedups via payment_gateway_webhook_events using the EXISTING
      (provider_key, payload_hash) WHERE provider_event_id IS NULL
      unique index -- Fawry's fawryRefNumber is STABLE across multiple
      notifications for the same order (not a genuine per-event id),
      same shape as Paymob -- NO NEW MIGRATION NEEDED, confirmed by
      direct schema inspection before writing any code
    → orderStatus REFUNDED/PARTIAL_REFUNDED → acknowledged, never
      re-posted as a payment
    → orderStatus NEW → acknowledged, still in-flight, no state change
    → orderStatus PAID → record_gateway_payment_service() [service_role-only,
      UNCHANGED from the other three] -- also overwrites
      provider_session_ref with Fawry's REAL fawryRefNumber, which the
      refund endpoint requires
    → orderStatus CANCELED/EXPIRED/FAILED → mark_gateway_transaction_failed_service()
    → any other/unrecognized orderStatus → acknowledged only, fails
      closed on ambiguity

Staff issues a refund on a card payment
  fawry-create-refund { payment_id, amount, reason } [Edge Function, verify_jwt=true]
    → re-derives authorization: has_permission('payment.refund', club_id) -- same as the other three
    → FAIL-CLOSED GUARD: refuses if provider_session_ref is not yet
      set (i.e. the webhook's success handler has not yet overwritten
      it with the real fawryRefNumber)
    → POST {base_url}/payments/refund
      { merchantCode, referenceNumber: fawryRefNumber, refundAmount,
        reason, signature } (SHA-256 over merchantCode+referenceNumber+
      refundAmount(2dp)+reason+secureKey -- CODE VERIFIED against the
      same third-party Ruby gem's refund_request.rb) -- synchronous,
      per Fawry's own docs -- same design as the other three adapters'
      synchronous-first pattern
    → on statusCode:200 → posts canonical refund SYNCHRONOUSLY via
      create_gateway_refund_service() [service_role-only, UNCHANGED --
      already provider-agnostic, no Fawry-specific change needed].
      GENUINE ADAPTATION, DISCLOSED: Fawry's documented refund response
      carries no distinct refund-operation reference of its own (unlike
      Paymob's/Kashier's own new-transaction-id), so the idempotency
      key is derived from the ORIGINAL Fawry transaction reference +
      the refund amount instead
```

### Fawry vs. the other three: what genuinely differs

| Aspect | Stripe | Paymob | Kashier | Fawry |
|---|---|---|---|---|
| Checkout URL | Returned directly by the API | Constructed client-side from public key + client_secret | Returned directly by the API (`sessionUrl`) | Returned directly by the API (exact field name a disclosed doc gap — accepts `nextAction.redirectUrl` or plain `redirectUrl`) |
| Webhook signature location | `Stripe-Signature` HEADER | `hmac` QUERY PARAMETER | `x-kashier-signature` HEADER | `messageSignature` BODY FIELD (a fourth, distinct mechanism) |
| Webhook signature scheme | HMAC-SHA256 over raw body bytes | HMAC-SHA512 over 20 documented field VALUES (bare concatenation) | HMAC-SHA256 over an RFC 3986 query-string of `signatureKeys` fields | SHA-256 (no HMAC — a plain, keyed-by-concatenation hash) over 7 documented fields + secureKey, DIFFERENT field set from the outbound charge signature |
| Webhook dedup key | `event.id` | content hash of the payload (no event id) | `transactionId` (a genuine per-callback event id, like Stripe) | content hash of the payload (`fawryRefNumber` is stable across multiple status-change notifications, not a genuine event id — same shape as Paymob) |
| Merchant-reference echo | `metadata.mal3aby_transaction_id` / `client_reference_id` | `special_reference` → `order.merchant_order_id` | `order` (request) → `merchantOrderId` (webhook) | `merchantRefNum` (request) → `merchantRefNum`/`merchantRefNumber` (webhook, spelling inconsistent across Fawry's own docs — read defensively) |
| Amount units | Integer minor units (with zero-decimal currency exceptions) | Integer minor units (`amount_cents`) always | Decimal STRING in major units (e.g. `"100.00"`) | Major-unit decimal, 2dp (e.g. `580.55`) — same convention family as Kashier, not Paymob |
| Refund identifier | Stripe PaymentIntent id | Paymob's own numeric transaction id (distinct from the Intention id) | Kashier's own order id (`kashierOrderId`) | Fawry's own `fawryRefNumber`, handed off via the webhook exactly like the other two |
| Number of distinct provider secrets | One (`sk_...`) + one webhook secret | One secret key serves every purpose | TWO genuinely distinct keys | ONE secure key serves every purpose (charge signing, refund signing, notification verification) — same single-secret shape as Paymob |
| Sandbox vs. live | Same host, `sk_test_`/`sk_live_` prefix | Same host, key-prefix-driven | DIFFERENT HOST per environment, THREE subdomain families | DIFFERENT HOST per environment (`atfawry.fawrystaging.com` vs `www.atfawry.com`), ONE host family — live host CODE VERIFIED but not independently pinged this session |
| Self-service sandbox | Yes, instant | Yes, instant | Yes, instant | **NO — manual merchant registration, ~2 business days, re-confirmed live this session** |

## Evidence-level summary — Fawry adapter (2026-08-27)

| Piece | Evidence level |
|---|---|
| Which of Fawry's (at least) three payment products fits Mal3aby's architecture (Express Checkout Link, a genuine server-to-server redirect flow) vs. the two rejected alternatives (raw-card charge — PCI scope Mal3aby cannot take on; PAYATFAWRY — a kiosk/reference-number flow, not real-time online) | OFFICIAL DOC VERIFIED via verbatim-quoted live doc text, cross-checked against a real third-party integration guide and the real open-source `fawry-api/fawry` Ruby gem, which itself implements the (rejected-for-Mal3aby) raw-card/reference-number server API, giving independent confirmation these are genuinely different products, not assumption |
| Outbound charge-request signature (7-field concatenation incl. sorted chargeItems) | OFFICIAL DOC VERIFIED (verbatim-quoted live doc text, re-fetched specifically to avoid paraphrase risk) |
| Inbound notification signature (8-field concatenation, DIFFERENT field set from outbound) | OFFICIAL DOC VERIFIED + CODE VERIFIED (Fawry's own "Get Payment Status V2" doc page AND a real, independent third-party open-source Ruby gem's verbatim source agree exactly) |
| Refund signature (5-field concatenation) | OFFICIAL DOC VERIFIED + CODE VERIFIED against the same third-party Ruby gem, cross-confirmed by a third independent source (a dev.to integration guide) landing on the identical endpoint path |
| Base URLs (sandbox/live) | CODE VERIFIED against the real open-source Ruby gem's `connection.rb`, cross-confirmed against Fawry's own refund-endpoint doc page's real example URL; the LIVE host specifically was not independently pinged this session |
| Webhook HMAC verification, end-to-end payment posting | LIVE VERIFIED — a hand-signed test notification (built from an independent Python SHA-256 reference implementation) against the real deployed `fawry-gateway-webhook` function and a real Supabase Vault secret produced a real `payments` row (`method='card'`, amount 250.50), one `payment_allocations` row, `provider_session_ref` correctly overwritten to Fawry's real `fawryRefNumber`; confirmed by direct query afterward |
| Webhook signature REJECTION (negative evidence) | LIVE VERIFIED — an incorrect signature and a request missing `messageSignature` entirely were both rejected (400) against the same real connection/secret |
| Duplicate webhook idempotency | LIVE VERIFIED — the identical signed payload replayed against the live function returned `duplicate:true`; a direct count confirmed exactly one webhook event row, one payment, one allocation |
| Amount-mismatch fail-closed rejection | LIVE VERIFIED — a webhook claiming a different confirmed amount (999) than the staged transaction (300.00) was rejected; `payment_id: null` returned, transaction durably marked `failed` with `failure_reason = 'amount mismatch: staged=300.00 confirmed=999'`, zero payments posted |
| `record_gateway_payment_service`, `mark_gateway_transaction_failed_service`, `create_gateway_refund_service`, `get_gateway_transaction_status` reused as-is for Fawry | CODE VERIFIED (all four already provider-agnostic; confirmed no Fawry-specific change was needed or made) |
| `verify_jwt=true` gate on the two authenticated functions | LIVE VERIFIED — real 401 (`UNAUTHORIZED_NO_AUTH_HEADER`) from both `fawry-create-checkout-session` and `fawry-create-refund` with no Authorization header |
| Charge/Refund API request-shape correctness against Fawry's REAL live API (no real credentials) | **NOT ATTEMPTED**, disclosed honestly rather than force-labeled — see `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` "What genuinely could not be tested" for the specific reasoning (a garbage-secured request's failure mode against Fawry's real API was not confirmed in research, so a CONTRACT VERIFIED label was not claimed rather than guessed at) |
| No new migration needed (`fawry` already in the `gateway` CHECK constraint from a prior session's provider-catalog work; existing `(provider_key, payload_hash) WHERE provider_event_id IS NULL` unique index reused for dedup) | CODE VERIFIED by direct schema inspection before writing any code — confirmed the task brief's own anticipation that this might already be resolved |
| Grant hygiene (`get_vault_secret_service` service_role-only, `payment_gateway_webhook_events` authenticated-SELECT-only) | LIVE VERIFIED — queried `has_function_privilege` directly; unchanged from the Stripe/Paymob/Kashier baseline since no new grants were introduced; `get_advisors` security scan run after deployment shows zero Fawry-related findings |
| Genuine Fawry-originated webhook delivery, genuine Fawry-hosted checkout completion | CREDENTIAL-BLOCKED — no real Fawry merchant account exists for this project, and none can be obtained quickly (manual registration, ~2 business days) |
| Other provider (PayPal) | Not built this phase — architecture documented in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` |

### What a future session needs to reach SANDBOX VERIFIED for Fawry

A real Fawry merchant account (requires manual registration with
Fawry, ~2 business days per their own docs — this cannot be
shortcut), its Merchant Code and Secure Hash Key, connected via
`connect_club_gateway(...)` to a real test club, then a genuinely
completed test-mode Express Checkout Link transaction to generate a
real Fawry-signed Notification V2 delivery against the deployed
`fawry-gateway-webhook` function. This would also resolve the two
genuine open questions disclosed in this session's research: the exact
response field name for the checkout-session-creation redirect URL,
and whether a real Fawry API rejects a garbage-signed request with a
generic auth-error (making a CONTRACT VERIFIED test possible) or some
other failure mode.

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
| Other providers | Paymob, Kashier, and Fawry now built (see their own sections above); PayPal not built this phase — architecture documented in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` |

## What a future session needs to reach SANDBOX VERIFIED

A real Stripe account (test mode, free to create), its `sk_test_...`
secret key and `whsec_...` webhook signing secret connected via
`connect_club_gateway(...)` to a real test club, and then either a
genuinely completed test-mode Checkout Session or the Stripe CLI's
`stripe trigger`/`stripe listen --forward-to` tooling to generate a
real Stripe-signed delivery against the deployed
`stripe-gateway-webhook` function.
