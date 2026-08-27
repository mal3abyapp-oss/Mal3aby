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

## Kashier update (2026-08-27) -- the item flagged as "not yet independently re-verified" is now resolved

The existing table row below already correctly summarized Kashier's
shape from secondary sources, and was NOT flagged with the same
"must re-verify" warning Paymob's row carried -- but per this
project's own standing rule (never write signing code from
memory/secondary sources alone), every item was independently
re-fetched against Kashier's live developer portal
(`developers.kashier.io`, a JS SPA like Paymob's -- several deep links
404 on a cold `WebFetch`; the pages below WERE reachable directly this
session, unlike some of Paymob's, so no in-app-search workaround was
needed here) this session before writing the adapter. Two items turned
out to need correction or added precision versus what a plausible
reading of the existing row would suggest:

1. **HMAC signature scheme -- CONFIRMED, and MORE PRECISE than the
   existing row implied.** OFFICIAL DOC VERIFIED against Kashier's live
   "Webhook" page (`developers.kashier.io/payment/webhook/`), including
   the literal published Node.js code sample:
   ```js
   data.signatureKeys.sort();
   const objectSignaturePayload = _.pick(data, data.signatureKeys);
   const signaturePayload = queryString.stringify(objectSignaturePayload);
   const signature = crypto.createHmac('sha256', PaymentApiKey)
     .update(signaturePayload).digest('hex');
   ```
   The "alphabetically-sorted signatureKeys fields" claim in the
   existing row IS correct (unlike Paymob's misleading "sort
   lexicographically" doc heading, Kashier's own prose ("you should
   order only the elements of the signatureKeys array in the data
   payload alphabetically") is genuinely accurate here -- CONFIRMED, not
   just assumed to generalize from the Paymob finding). What the
   existing row did NOT specify precisely enough to implement from: the
   construction is a REAL RFC 3986 URL-encoded query string
   (`key1=value1&key2=value2...`, using Node's `query-string` package /
   PHP's `PHP_QUERY_RFC3986`), built from ONLY the fields named in
   `signatureKeys` (a server-supplied allowlist that is itself part of
   the payload) -- NOT a bare value-only concatenation the way Paymob's
   scheme works. This is a genuine, confirmed STRUCTURAL difference
   between the two providers' schemes, not just a different key list.
   Keyed by the **Payment API Key** specifically (see item 3 below),
   compared against the `x-kashier-signature` request HEADER (not a
   query param, unlike Paymob). The published PHP sample has a visible
   bug (it query-string-encodes the whole `$data` object rather than
   the picked/sorted subset, inconsistent with its own preceding
   `sort()` call and with the correct JS sample) -- disregarded in favor
   of the JS sample's self-consistent logic. **CODE VERIFIED**: an
   independent Python reference implementation (RFC 3986 encoding via
   `urllib.parse.quote`, `hmac.new(..., hashlib.sha256)`) was built
   against Kashier's own published example payload
   (`merchantOrderId: "1642935044835"`, `amount: 11334`, etc.) and cross-
   checked byte-for-byte against the Edge Function's own Web Crypto
   `HMAC-SHA256` output using a real Vault-stored secret (see item 4).
   Source: https://developers.kashier.io/payment/webhook/ (fetched
   directly, no in-app-search workaround needed).

2. **Refund endpoint host -- CORRECTED.** The existing row's "Full/
   partial via `PUT /orders/:orderId/`" claim is directionally right but
   was missing a critical, load-bearing detail: this endpoint lives on
   a **THIRD, distinct subdomain** from both the Payment Sessions API
   (`api.kashier.io`/`test-api.kashier.io`) and the legacy Hosted
   Payment Page host (`iframe.kashier.io`/`test-iframe.kashier.io`) --
   it is `fep.kashier.io`/`test-fep.kashier.io`. This was NOT previously
   documented anywhere in this project and would have been a silent,
   hard-to-debug production break if assumed to share a host with
   either of the other two APIs. `test-fep.kashier.io` was directly
   fetched and OFFICIAL DOC VERIFIED this session
   (https://developers.kashier.io/payment/refund, real cURL example
   shown). The **live** host (`fep.kashier.io`, no `test-` prefix) is
   **PATTERN-INFERRED** from the consistent `test-` prefix convention
   observed across every other confirmed Kashier environment pair --
   it was not independently fetched from a live-mode example this
   session and is flagged as such in the adapter code
   (`kashier-create-refund/index.ts`) for a future session with real
   credentials to re-verify first.
   **CONTRACT-TESTED finding, not previously documented anywhere**: a
   real PUT to `test-fep.kashier.io/orders/:orderId/` with a garbage
   Authorization value and plausible orderId shapes (placeholder
   string, random UUID) consistently returns HTTP 400
   `{"status":"INVALID_REQUEST","error":{"cause":"The URL is invalid",
   "explanation":"Routing key is missing from the URL"}}` -- a
   DIFFERENT error shape from the Payment Sessions endpoint's clean
   auth-specific 401 for the same kind of garbage credential, and
   distinct from a genuine 404 for a deliberately wrong path (both
   contrast-tested the same session). This proves the endpoint is real
   and live-routed, but suggests Kashier's real routing may require an
   additional header or differently-shaped order id not captured by
   this session's research -- **CREDENTIAL-BLOCKED**, disclosed
   explicitly in the adapter code rather than silently assumed correct.

3. **Two distinct keys, and which one does what -- NEWLY DOCUMENTED
   (the existing row did not distinguish these at all).** OFFICIAL DOC
   VERIFIED (`developers.kashier.io/dashboardapi/apibasics` and
   corroborating search-result snippets of the same page): Kashier
   issues a **Payment API Key** (`api-key` header; used for creating a
   Payment Session AND for HMAC webhook signature verification) and a
   separate **Secret Key** (`Authorization` header; used ONLY for the
   refund endpoint's server-to-server auth) -- "Each account has a
   total of four keys: a Payment Api Key and Secret Key pair for test
   mode and live mode." These are genuinely different values, not two
   names for the same secret. This is a structural difference from
   Paymob (one secret key serves every purpose there) that the adapter
   handles by deliberately mapping Kashier's Secret Key onto
   `club_gateway_connections.secret_vault_id` and the Payment API Key
   onto `webhook_secret_vault_id` -- documented in full in
   `kashier-create-checkout-session/index.ts`'s own header comment.

4. **Payment Sessions request/response shape -- CONFIRMED with real
   field names.** OFFICIAL DOC VERIFIED
   (`developers.kashier.io/payment/payment-sessions`, real JSON request
   example fetched directly): `POST {base_url}/v3/payment/sessions`,
   `merchantId` (format `MID-XXXX-XXX`) and `order` (merchant's own
   order reference) as REQUEST body fields -- `order` is echoed back on
   the webhook payload as `merchantOrderId` (a DIFFERENT field name on
   the response/webhook side, mirroring Paymob's
   `special_reference`/`order.merchant_order_id` split). `amount` is a
   plain DECIMAL STRING in major units (e.g. `"1.00"` for 1.00 EGP),
   NOT minor-unit cents like Paymob's `amount_cents` -- a genuine
   per-provider difference the adapter handles explicitly (no `/100`
   conversion). Response returns `sessionUrl` DIRECTLY (like Stripe,
   unlike Paymob, which requires client-side URL construction from a
   separate public key).

5. **Sandbox vs. live base URL -- CONFIRMED, code-example-level (not
   just prose).** The existing row's "Distinct `test-` prefixed base
   URL" claim is correct and now has a real basis: the Payment Sessions
   documentation page's own "Create" example uses `api.kashier.io`
   while its "Get payment session" example uses `test-api.kashier.io`
   for the identical endpoint shape -- genuinely different hostnames per
   environment, unlike both Stripe and Paymob (same host, different key
   prefix). Cross-confirmed independently via a second source
   (`test-iframe.kashier.io` for the legacy Hosted Payment Page,
   consistent with the same convention).

**Live/contract verification performed this session** (see
`PAYMENT_GATEWAY_WEBHOOK_MODEL.md`'s Kashier section for full detail):
a disposable test connection with two real `vault.create_secret()`
entries was used to LIVE VERIFY the deployed `kashier-gateway-webhook`
function accepts a correctly-signed callback and rejects an incorrectly-
signed one, that duplicate deliveries are idempotent, and that an
amount-mismatch is rejected fail-closed -- all against the REAL deployed
function, not a local unit test. The Payment Sessions and Refund
endpoints were CONTRACT VERIFIED against Kashier's real live API with
garbage credentials (see items 2 and 4 above for the exact responses).
All test fixtures were deleted afterward; a follow-up query confirmed
zero rows remain and both borrowed invoices' outstanding balances were
restored to their pre-test values.

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
| **Kashier** | No global version string; `v3` in the Payment Sessions endpoint path | Payment Sessions (`POST /v3/payment/sessions`, `sessionUrl` returned directly) | `x-kashier-signature` header, HMAC-SHA256 over an RFC 3986 query-string of alphabetically-sorted `signatureKeys` fields (`key=value&...`, not bare concatenation), keyed by the **Payment API Key** — CONFIRMED against Kashier's own published code sample and cross-checked byte-for-byte with an independent Python implementation (2026-08-27) | Kashier's own `transactionId` field is a genuine per-callback event id — dedup via the EXISTING `(provider_key, provider_event_id)` unique index, no new migration needed | Yes — EGP native; also USD/EUR/GBP (secondary-sourced) | `PUT {fep.kashier.io}/orders/:orderId/` (`apiOperation: REFUND`); synchronous JSON response — CONTRACT VERIFIED live-routed, real end-to-end success CREDENTIAL-BLOCKED (see "Kashier update" section) | Distinct `test-` prefixed base URL PER SUBDOMAIN (3 separate subdomain families: sessions, legacy iframe, refunds) + separate Payment-API-Key/Secret-Key pairs per environment — CONFIRMED code-example-level 2026-08-27 |
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
  production signing code for that provider. UPDATE 2026-08-27: for
  Kashier specifically, the Payment Sessions, Webhook, and Refund pages
  WERE directly fetchable this session (unlike several Paymob deep
  links) — resolved with real OFFICIAL DOC VERIFIED source content, see
  "Kashier update" section above. The one remaining genuine gap is the
  refund endpoint's exact routing requirement (CREDENTIAL-BLOCKED, not
  a docs-portal artifact — see item 2 in that section).
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
