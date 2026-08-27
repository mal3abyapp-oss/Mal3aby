# Payment Gateway Provider Matrix

Research conducted August 2026 against each provider's live official
documentation (fetched directly, not recalled from training data).
Full per-provider detail with source URLs is preserved in this
session's research artifact; this document summarizes what shapes the
Mal3aby integration design.

## Paymob update (2026-08-27) -- previously-flagged items resolved

The three items the prior research pass explicitly flagged as
"secondary-sourced, must be re-verified against live docs before
writing production signing code" were re-fetched directly against
Paymob's current live developer portal (`developers.paymob.com`,
OFFICIAL DOC VERIFIED via rendered browser fetch -- this portal is a
JS SPA that 404s/loading-shells on direct `WebFetch`, confirmed again
this session; the in-app search + rendered navigation was required to
reach real content). All three are now resolved:

1. **HMAC field order (Paymob HMAC Transaction Callback page, "Last
   Updated Date - June 1, 2026")** -- CONFIRMED as a fixed,
   documented order (not simply "lexicographic" despite the page's own
   "Sort... Lexicographically" heading -- the published key list is
   the actual order to use, and it does not itself sort
   alphabetically, e.g. `obj.id`/`id` appears before `integration_id`
   which appears before `is_3d_secure`). The 20 keys, concatenated as
   **values only** (no separators, no key names) in this exact order:
   `amount_cents, created_at, currency, error_occured,
   has_parent_transaction, obj.id (POST) / id (GET), integration_id,
   is_3d_secure, is_auth, is_capture, is_refunded,
   is_standalone_payment, is_voided, order.id (POST) / order_id (GET),
   owner, pending, source_data.pan, source_data.sub_type,
   source_data.type, success`. Booleans render as literal `true`/
   `false` strings. SHA-512 HMAC of that string, keyed by the
   dashboard-issued HMAC secret, hex-encoded lowercase, compared
   against the `hmac` **query parameter** on the callback URL (not a
   header, not a body field). **CODE VERIFIED**: reconstructing the
   concatenation from the documented key list against Paymob's own
   published worked example (`obj.id=192036465`,
   `amount_cents=100000`, etc.) reproduces their exact documented
   concatenated string byte-for-byte
   (`1000002024-06-13T11:33:44.592345EGPfalsefalse...cardtrue`) -- see
   the Edge Function implementation comment for the reproducible
   Python cross-check. Source:
   https://developers.paymob.com/paymob-docs/developers/webhook-callbacks-and-hmac/hmac/hmac-for-transactions
   (reached via in-app search, not the direct deep link, which
   redirects to the SPA shell on a cold load).

2. **Refund endpoint** -- CONFIRMED: `POST
   https://accept.paymob.com/api/acceptance/void_refund/refund`
   (Egypt base URL), header `Authorization: Token {secret_key}`, JSON
   body `{"transaction_id": "<paymob transaction id, integer>",
   "amount_cents": "<integer>"}`. Response mirrors the transaction
   object shape with `is_refund: true`. Important wiring detail: the
   `transaction_id` here is Paymob's own **transaction** id (the
   `obj.id` from the processed-callback payload / the top-level `id`
   in a transaction lookup), not the Intention id (`pi_...`) returned
   at checkout-creation time -- the adapter must persist the real
   Paymob transaction id from the successful webhook callback, not
   just the intention/session reference, for refunds to be possible
   later. Source:
   https://developers.paymob.com/paymob-docs/developers/refund
   ("Last Updated Date - June 28, 2026").

3. **Sandbox vs. live base URL** -- CONFIRMED: **same regional base
   URL for both** ("Test and live use the same regional base URL for
   each region. The mode is controlled by the keys and integration IDs
   you use." -- Paymob Overview page). Egypt base URL:
   `https://accept.paymob.com/`. The distinguishing factor is entirely
   the secret/public key pair used (`sk_test_...`/`sk_live_...` per
   the documented cURL examples) and which Integration ID(s) are
   passed in `payment_methods` -- there is no separate staging
   hostname for the Intentions/Refund APIs themselves (unlike Kashier,
   which genuinely does use a distinct `test-` prefixed base URL, per
   the existing table below -- the two providers are NOT the same
   shape here, confirmed by direct primary-source comparison, not
   assumed to generalize from one to the other).

Additional facts confirmed while resolving the above (not previously
flagged, but load-bearing for the adapter):

- **Create Intention**: `POST https://accept.paymob.com/v1/intention/`,
  header `Authorization: Token {secret_key}`, body requires `amount`
  (integer, cents), `currency`, `payment_methods` (array of Integration
  IDs). `special_reference` (optional, merchant-supplied) is echoed
  back in the Create Intention response's own `special_reference`
  field, but on the **transaction processed callback** it surfaces
  under `order.merchant_order_id` -- not as a top-level
  `special_reference` key on the callback payload. The adapter's
  webhook lookup-by-merchant-reference must read
  `obj.order.merchant_order_id`, not a nonexistent
  `obj.special_reference`. Response returns `client_secret`
  (region-prefixed, e.g. `egy_csk_test_...`), `id` (Paymob's
  intention id, `pi_...`), and `intention_order_id` (Paymob's numeric
  order id, which also appears as `order.id` in the later transaction
  callback -- a second, redundant correlation path alongside
  `merchant_order_id`). Source:
  https://developers.paymob.com/paymob-docs/developers/intention-apis/create-intention
  ("Last Updated Date - June 1, 2026").
- **Unified Checkout redirect URL**: region-specific hosted checkout
  host, distinct from the API base URL --
  `https://eg.checkout.paymob.com/?publicKey={public_key}&clientSecret={client_secret}`
  for Egypt (UAE/Oman/KSA have their own `{region}.checkout.paymob.com`
  hosts). Requires the connection's **public key** (client-safe,
  already a `club_gateway_connections.public_key` column) in addition
  to the `client_secret` from Create Intention -- unlike Stripe, where
  the checkout URL is returned directly by the API and no separate
  public-key-in-URL construction is needed. Source:
  https://developers.paymob.com/paymob-docs/developers/unified-checkout
  ("Last Updated Date - July 22, 2026").

## Critical business-model fact (affects which providers are viable per club)

**Stripe does not support Egypt as an account country** — a club would
need a legal entity in a Stripe-supported country to connect Stripe at
all. **PayPal does not support EGP** — PayPal transactions for an
Egypt-based club would settle in a different currency (USD etc.), not
EGP. This means, in practice:

- **Egypt-native EGP settlement**: Paymob, Kashier, Fawry.
- **International/foreign-currency**: Stripe, PayPal — usable only by
  a club with the legal/business standing each provider requires, not
  universally available to every Mal3aby club.

This is exactly why the architecture (Section 26/30) must never assume
"every club can connect every provider" — provider eligibility is a
real, provider-enforced constraint, not just a UI preference.

## Comparison table

| Provider | API version | Hosted checkout | Webhook signature | Idempotency key | EGP support | Refund model | Sandbox |
|---|---|---|---|---|---|---|---|
| **Stripe** | Dated release (e.g. `2026-08-26`), header-overridable | Checkout Sessions (hosted/embedded/Elements) | `Stripe-Signature` header, HMAC-SHA256 over `timestamp.payload` | Native `Idempotency-Key` header, 24h window | Not in documented currency list; Egypt not a supported account country | Full/partial via Refunds API; sync object + async `refund.*` webhook confirmation | Same base URL, `sk_test_`/`pk_test_` keys, instant self-service |
| **PayPal** | Orders API v2 | Orders API + approve link / JS SDK buttons | 5 headers (`PAYPAL-TRANSMISSION-*`, `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`), RSA-SHA256, verifiable locally or via `verify-webhook-signature` | Native `PayPal-Request-Id` header, ~45-day retention for refunds | EGP absent from documented currency list | `POST /v2/payments/captures/{id}/refund`; partial/time-limit specifics not fully confirmed from fetched docs | Distinct host `api-m.sandbox.paypal.com`, self-service sandbox accounts |
| **Paymob** | Intentions API (v1), `POST /v1/intention/` | Unified Checkout (redirect, `{region}.checkout.paymob.com`) / Pixel (embedded) via `client_secret` + `public_key` | HMAC-SHA512 over 20 fixed-order field VALUES (documented list, not generic lexicographic sort — see "Paymob update" section above), dashboard-issued HMAC secret, hex lowercase, sent as `hmac` query param — CONFIRMED against Paymob's own worked example (2026-08-27) | Not documented — dedup via merchant `special_reference` (echoed as `order.merchant_order_id` in the callback, not a top-level field) | Yes — core EGP gateway | `POST /api/acceptance/void_refund/refund`, `{transaction_id, amount_cents}` body, `Token` auth header — CONFIRMED 2026-08-27 | Same base URL (`accept.paymob.com`) for sandbox and live — mode is entirely determined by which secret/public key pair and Integration ID(s) are used — CONFIRMED 2026-08-27 |
| **Kashier** | No global version string; `v3` in the Payment Sessions endpoint path | Payment Sessions (`sessionUrl`) / Hosted Checkout Page | `x-kashier-signature` header, HMAC-SHA256 over alphabetically-sorted `signatureKeys` fields, keyed by the Payment API Key | Not documented — order-hash + merchant Order ID for integrity/dedup | Yes — EGP native; also USD/EUR/GBP (secondary-sourced) | Full/partial via `PUT /orders/:orderId/` (REFUND op); synchronous JSON response | Distinct `test-` prefixed base URL + separate test/live key pairs |
| **Fawry (FawryPay)** | No unified version; per-endpoint (e.g. Notification V2) | Express Checkout Link (hosted redirect) | `messageSignature` body field, SHA-256 over fixed field concatenation — no dedicated header | Not documented — relies on merchant `merchantRefNum` uniqueness | Yes — EGP-only in every documented example | Full/partial via `POST /payments/refund`; sync JSON; authorized-but-uncaptured cannot be refunded | Staging domain exists but **credentials require manual merchant registration (~2 business days), not instant signup** |

## Documentation gaps, disclosed honestly

- **Rate limits**: only Stripe documents them explicitly (100 req/s
  live / 25 req/s sandbox + per-resource caps). PayPal, Paymob,
  Kashier, and Fawry document none — treat as undocumented and
  implement conservative client-side backoff regardless.
- **Paymob and Kashier's docs portals are JS SPAs** that 404 on many
  direct deep-link fetches; several secondary details (Paymob's exact
  HMAC field order, Paymob's programmatic refund endpoint URL,
  Kashier's full country/currency list) came from search-result
  synthesis rather than a directly-fetched primary page this session
  — flagged individually, and must be re-verified against each
  provider's live dashboard/API Explorer immediately before writing
  production signing code for that provider.
- **Fawry has no self-service developer signup.** Real sandbox
  credentials require merchant registration and manual approval
  (~2 business days per the docs). This is a real lead-time
  dependency, not something this session can shortcut.

## What this means for the adapter architecture

- Every adapter's `verifyWebhook()` must implement a **provider-specific**
  signature scheme — there is no shared algorithm across providers
  (HMAC-SHA256 header-based for Stripe/Kashier, RSA-SHA256
  multi-header for PayPal, HMAC-SHA512 field-concatenation for
  Paymob, SHA-256 body-field for Fawry). The common `PaymentGatewayAdapter`
  contract abstracts the *interface*, never the *algorithm*.
- Idempotency-key support is genuinely native only for Stripe and
  PayPal. For Paymob/Kashier/Fawry, Mal3aby's own
  `payment_gateway_transactions.idempotency_key` (a Mal3aby-generated
  value checked before creating a new gateway attempt) is the real
  dedup mechanism — not something to assume the provider guarantees.
- None of the 5 providers documents guaranteed exactly-once webhook
  delivery — Stripe explicitly warns of duplicates, and Kashier/Fawry
  both describe retry-until-200 behavior. Webhook idempotency
  (Section 40 of the directive) must be enforced entirely on Mal3aby's
  side for every provider, not assumed from any provider's own claims.
