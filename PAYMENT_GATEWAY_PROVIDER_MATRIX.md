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

## Fawry update (2026-08-27) — researched and built this session, lower evidence ceiling by design

Fawry has NO self-service sandbox (re-confirmed live this session at
`developer.fawrystaging.com/docs/get-started`: "our team is working on
your request and will be contacting you within a maximum of two days"
— unchanged from the prior finding). This means the adapter below is
built entirely from OFFICIAL DOC VERIFIED + CODE VERIFIED evidence — no
CONTRACT VERIFIED test against Fawry's real live API was attempted for
the charge/refund endpoints (see "What genuinely could not be tested"
below for exactly why, including one endpoint that WAS reachable).

### Fawry has (at least) THREE structurally different payment products — this matters

Research this session (`developer.fawrystaging.com`, a REAL, directly
`WebFetch`-able documentation portal — unlike Paymob/Kashier's JS SPAs,
no in-app-search workaround was needed) surfaced a genuine architectural
fork the task brief anticipated but could not resolve in advance:

1. **Server-to-server raw-card charge API** (`POST
   {base}/ECommerceWeb/Fawry/payments/charge` with
   `paymentMethod: "CARD"`, `cardNumber`/`cardExpiryYear`/
   `cardExpiryMonth`/`cvv` in the REQUEST body) — REJECTED for Mal3aby's
   use outright: Fawry's own docs state plainly that collecting raw
   card data this way requires the merchant to be PCI-DSS compliant
   ("In order to collect raw card payment details, your application
   has to be fully PCI compliant"). Mal3aby never handles raw card
   data (a hard project constraint) — this path was never a candidate.
2. **`PAYATFAWRY` reference-number charge** (same endpoint, different
   `paymentMethod` value) — returns a `referenceNumber` the customer
   pays later at a physical Fawry retail/kiosk point; genuinely NOT a
   real-time online redirect flow, confirmed via a real documented
   example response (`orderStatus: "PENDING"`, no redirect URL of any
   kind). This is the "kiosk/cash-voucher" shape the task brief
   explicitly flagged as a possibility — it is real, but it is not
   what Mal3aby's online-gateway architecture needs, and is NOT what
   this adapter implements.
3. **Express Checkout Link** (`developer.fawrystaging.com/docs/express-checkout/fawrypay-hosted-checkout`)
   — CONFIRMED, via VERBATIM quoted sentences re-fetched from the live
   page this session (not paraphrase — quoted directly): *"trigger
   FawryPay API below with the Charge Request, Fawry will respond with
   a redirect URL to redirect your customer to"* and *"Whenever you
   call FawryPay Express Checkout Link API, Fawry will respond to you
   with the redirect URL that you have to redirect your customer to."*
   This is a genuine SERVER-TO-SERVER call-and-get-a-redirect-URL flow
   — the SAME shape as Stripe's and Kashier's checkout-session
   creation, NOT a client-side JS widget. **This is the flow the
   adapter implements.** It is distinct from Fawry's separate
   "Checkout Button" product (`self-hosted-checkout` doc page), which
   IS a client-side `<script>`/`FawryPay.checkout(...)` JS SDK embed —
   confirmed as genuinely different by that page's own explicit
   `FawryPay.checkout(buildChargeRequest(), configuration)` call and
   "import our FawryPay JavaScript and CSS libraries into the header
   of your checkout page" instruction, which Express Checkout Link's
   own page never mentions. Mal3aby's adapter uses Express Checkout
   Link specifically because it needs zero Fawry JS embedded in
   Mal3aby's own frontend, matching the Stripe/Paymob/Kashier pattern
   of "backend calls provider, gets a URL, frontend redirects to it."

**Genuine, disclosed documentation gap**: the exact JSON field name
inside the Express Checkout Link's charge-request RESPONSE that holds
the redirect URL is NOT shown in any code block on the fetched
Express-Checkout-Link doc page (multiple direct re-fetches this
session, including a verbatim-quote-only pass, confirm no response
JSON example is present on that specific page — the page shows the
REQUEST shape and the POST-REDIRECT-BACK response shape in detail, but
not the initial trigger-call's own response). The adapter code
therefore accepts EITHER of the two field shapes documented elsewhere
in Fawry's own docs for a redirect-producing charge response
(`nextAction.redirectUrl` — CONFIRMED verbatim on the separate 3DS
card-charge doc page, `create-payment-3ds-apis`, real example:
`{"type":"ChargeResponse","nextAction":{"type":"THREE_D_SECURE","redirectUrl":"https://atfawry.fawrystaging.com/atfawry/plugin/3ds/7104048097"},"statusCode":200,...}`
— and a plain top-level `redirectUrl`, in case Express Checkout Link's
own response omits the `nextAction` nesting), and fails closed with an
explicit, honest error if NEITHER shape is present in the response
body — rather than guessing a field name and silently sending a
customer to `undefined`. This is flagged explicitly in
`fawry-create-checkout-session/index.ts`'s own header comment as the
first thing a future session with real credentials must confirm.

### The outbound Charge Request signature (Mal3aby → Fawry) — OFFICIAL DOC VERIFIED

Confirmed via a verbatim-quote-only re-fetch of the live
`fawrypay-hosted-checkout` doc page this session: *"concatenate the
following elements on the same order and hash the result using
SHA-256: merchantCode + merchantRefNum + customerProfileId (if exists,
otherwise insert "") + returnUrl + itemId + quantity + Price (in two
decimal format like '10.00') + Secure hash key"*, with multi-item
carts sorted by `itemId` and each item's `itemId+quantity+price`
concatenated in that per-item order before moving to the next item.
**This is a DIFFERENT field set from the raw-charge API's own signature**
(`merchantCode + merchantRefNum + customerProfileId + paymentMethod +
amount + secureKey`, confirmed via the `fawry-api/fawry` open-source
Ruby gem's `charge_request.rb` — see below) — genuine, confirmed
structural proof that Express Checkout Link and the raw charge API are
different request shapes with different signing rules, not the same
request with a cosmetic field added. Mal3aby's own invoice-payment
flow always sends exactly ONE `chargeItems` entry (the invoice's own
transaction id and amount), so the multi-item sort-by-itemId rule is
implemented for correctness but is not exercised by any current
Mal3aby call site.

### The inbound Notification/Callback signature (Fawry → Mal3aby) — OFFICIAL DOC VERIFIED + CODE VERIFIED against real third-party source

Confirmed via TWO independent sources agreeing exactly: (1) Fawry's own
"Get Payment Status V2" doc page, and (2) the real, MIT-style
open-source `fawry-api/fawry` Ruby gem's `lib/fawry/fawry_callback.rb`
(fetched verbatim from GitHub raw content this session — genuine
third-party production code, not Fawry's own docs, giving true
independent cross-confirmation of the same field list):

```ruby
def signature
  Digest::SHA256.hexdigest("#{callback_params[:fawryRefNumber]}#{callback_params[:merchantRefNum]}"\
                           "#{format('%<paymentAmount>.2f', paymentAmount: callback_params[:paymentAmount])}"\
                           "#{format('%<orderAmount>.2f', orderAmount: callback_params[:orderAmount])}"\
                           "#{callback_params[:orderStatus]}#{callback_params[:paymentMethod]}"\
                           "#{callback_params[:paymentRefrenceNumber]}#{fawry_secure_key}")
end
```

i.e.: `fawryRefNumber + merchantRefNum + paymentAmount(2dp) +
orderAmount(2dp) + orderStatus + paymentMethod + paymentRefrenceNumber
(empty string if absent) + secureKey`, SHA-256, compared against the
`messageSignature` field ON THE NOTIFICATION BODY ITSELF (confirmed:
no dedicated header, no query param — the request brief's existing
matrix entry was correct on this point). **This is genuinely a
DIFFERENT field list/order from the outbound charge-request
signature** — confirmed precisely as the task brief asked, not
assumed to match. Notably `merchantRefNum` (request-signature naming)
and `merchantRefNumber`/`merchantRefNum` appear inconsistently named
across different Fawry doc pages/response shapes — the adapter reads
both key spellings defensively when parsing the inbound payload (see
`fawry-gateway-webhook/index.ts`'s own comment on this).

The real Notification V2 payload shape (`server-notification-v2` doc
page, real fetched JSON example) confirms the full field set:
`requestId, fawryRefNumber, merchantRefNumber, customerName,
customerMobile, customerMail, customerMerchantId, paymentAmount,
orderAmount, fawryFees, shippingFees, orderStatus
(NEW|PAID|CANCELED|REFUNDED|EXPIRED|PARTIAL_REFUNDED|FAILED),
paymentMethod, paymentTime, authNumber, paymentRefrenceNumber,
orderExpiryDate, orderItems, failureErrorCode, failureReason,
messageSignature, threeDSInfo, invoiceInfo, command, message`. There is
NO dedicated per-event id field distinct from `fawryRefNumber` (Fawry's
own transaction reference, which is STABLE across multiple
notifications for the SAME order as its status changes — e.g. a PAID
notification and a later REFUNDED notification for the same order
would carry the SAME `fawryRefNumber`) — so, like Paymob, dedup cannot
key on `(provider_key, provider_event_id)` alone using `fawryRefNumber`
as the "event id" (that would wrongly collapse a genuine PAID event and
a later, genuinely different REFUNDED event for the same order into
"the same event"). **No new migration was needed**: the EXISTING
`payment_gateway_webhook_events_provider_payload_unique` index
(`UNIQUE (provider_key, payload_hash) WHERE provider_event_id IS NULL`
— added for Paymob, `20260827161918_paymob_webhook_events_payload_hash_dedup.sql`)
already covers exactly this shape for any provider with no per-event
id, so Fawry reuses it directly with `provider_event_id = NULL`,
exactly like Paymob — CODE VERIFIED by inspection before writing any
migration, confirming the task brief's own anticipation that this
might already be resolved.

### The Refund signature — OFFICIAL DOC VERIFIED + CODE VERIFIED against the same third-party source

```ruby
def refund_request_signature
  Digest::SHA256.hexdigest("#{fawry_merchant_code}#{request_params[:reference_number]}"\
                           "#{format('%<refund_amount>.2f', refund_amount: request_params[:refund_amount])}"\
                           "#{request_params[:reason]}#{fawry_secure_key}")
end
```

i.e.: `merchantCode + referenceNumber + refundAmount(2dp) + reason +
secureKey`, SHA-256. Endpoint: `POST
{base}/ECommerceWeb/Fawry/payments/refund` — CONFIRMED identical path
from THREE independent sources agreeing exactly (Fawry's own
`refund-issue-api` doc page, the `fawry-api/fawry` gem's
`refund_request.rb`, and cross-referenced against the gem's
`connection.rb` base-URL constants). `referenceNumber` here is Fawry's
own `fawryRefNumber` (the REAL Fawry-assigned transaction reference
returned in a successful charge/notification), NOT Mal3aby's
`merchantRefNum` — mirroring the same "webhook must hand off the
provider's real reference before a refund becomes possible" pattern
already established by Paymob (transaction id) and Kashier (order id)
in this project. The "authorized-but-uncaptured cannot be refunded"
constraint mentioned in the task brief was NOT independently
re-confirmed this session (Fawry's Express Checkout Link path as built
here does not use a separate auth/capture step at all — that is a
distinct, separate documented API,
`server-apis/auth-capture-payment-apis`, which Mal3aby's adapter does
not call) — this constraint is therefore not applicable to the flow
actually implemented and is noted as N/A rather than silently dropped.

### Base URLs — CODE VERIFIED against the real, open-source `fawry-api/fawry` Ruby gem's `connection.rb`

```ruby
FAWRY_BASE_URL = 'https://www.atfawry.com/ECommerceWeb/Fawry/'
FAWRY_SANDBOX_BASE_URL = 'https://atfawry.fawrystaging.com//ECommerceWeb/Fawry/'
```

(the sandbox constant's real double-slash is preserved verbatim from
the gem's own source — likely a harmless typo in the gem, but resolved
in the adapter by using Fawry's own documented single-slash form,
`https://atfawry.fawrystaging.com/ECommerceWeb/Fawry/`, which the
`refund-issue-api` doc page's own example URL confirms independently
as the correct, singly-slashed form: `https://atfawry.fawrystaging.com/ECommerceWeb/Fawry/payments/refund`).
Cross-confirmed against THREE independent sources landing on the exact
same base path (`ECommerceWeb/Fawry/`): Fawry's own refund-endpoint doc
page, the open-source Ruby gem, and a third-party dev.to integration
guide. **CODE VERIFIED, not LIVE VERIFIED**: no real request was
attempted against `www.atfawry.com` (the live/production host) this
session — see "What genuinely could not be tested" below.

### Currency/amount encoding — OFFICIAL DOC VERIFIED

Decimal STRING/number in MAJOR units, 2 decimal places (e.g. `580.55`
for 580.55 EGP) — confirmed via every fetched request/response example
across the charge, refund, and notification payloads. NOT minor-unit
cents like Paymob. Same convention as Kashier's `amount` field (both
use major-unit decimals, though Kashier's is always sent as a STRING
and Fawry's examples show a mix of raw JSON numbers and strings across
different doc pages — the adapter formats outbound amounts as a
2-decimal-place value consistent with the signature's own `%.2f`
requirement, sent as a JSON number, matching the majority of Fawry's
own examples).

### What genuinely could not be tested (CREDENTIAL-BLOCKED, disclosed honestly)

- No real Fawry merchant account/staging credentials exist for this
  project (re-confirmed: manual registration, ~2 business days,
  unchanged from the prior session's finding) — the SAME constraint
  that blocks Stripe/Paymob/Kashier's genuine end-to-end verification
  also blocks Fawry's. A `payments/charge` or `payments/refund` call
  with a garbage `merchantCode` was NOT attempted this session as a
  contract test, because Fawry's charge/refund endpoints require a
  `signature` field computed from a (necessarily fake, since no
  secureKey exists) secure key — a garbage-secured request could
  plausibly return either a generic "Invalid Signature" auth-shaped
  error (useful, like Paymob's/Kashier's contract tests) OR silently
  200 with a business-logic-shaped rejection depending on how Fawry
  validates request order (merchant-code lookup first vs.
  signature-check first) — this project's own standing rule is to not
  fabricate a claimed evidence tier by guessing which failure mode
  would occur. This is disclosed as NOT ATTEMPTED rather than claimed
  as CONTRACT VERIFIED or falsely claimed as impossible — a future
  session with real (or even garbage-but-registered) credentials
  should attempt this first, following the exact pattern Paymob's and
  Kashier's adapters used successfully.
- A genuine Fawry-originated Notification V2 delivery, and a genuine
  Express Checkout Link redirect-URL response, have never been seen —
  the exact response field name for the redirect URL (see "genuine,
  disclosed documentation gap" above) is the single highest-value
  thing a future session with real credentials should confirm first,
  since the adapter's dual-field-name fallback is a defensive
  best-effort, not a confirmed fact.
- The live-mode base URL `https://www.atfawry.com/ECommerceWeb/Fawry/`
  is CODE VERIFIED (matches the gem's own constant and is structurally
  consistent with the sandbox host's own path shape) but was not
  independently fetched/pinged this session to confirm it currently
  resolves and serves the same API shape as the sandbox host — flagged
  in the adapter code for a future live-mode connection to re-confirm
  first.

## PayPal update (2026-08-27) — fifth and final adapter of this directive, built this session

OFFICIAL DOC VERIFIED, cross-checked across developer.paypal.com and
docs.paypal.ai mirrors.

### OAuth2 + Orders API v2 — the core request/response shape

- `POST https://api-m.sandbox.paypal.com/v1/oauth2/token` (sandbox) /
  `https://api-m.paypal.com/v1/oauth2/token` (live) — Basic auth of
  `client_id:client_secret`, body `grant_type=client_credentials`,
  response `{access_token, token_type:"Bearer", expires_in, scope,
  app_id, nonce}`. CONTRACT VERIFIED this session: a real request with
  garbage Basic-auth credentials against the real sandbox endpoint
  returned `401 {"error":"invalid_client","error_description":"Client
  Authentication failed"}` — confirms the endpoint, grant type, and
  error shape.
- `POST /v2/checkout/orders` — `purchase_units[].amount.
  {currency_code,value}`, `purchase_units[].custom_id`,
  `payment_source.paypal.experience_context.{return_url,cancel_url}`.
  Response: `id`, `status`
  (`CREATED|SAVED|APPROVED|VOIDED|COMPLETED|PAYER_ACTION_REQUIRED`),
  `links[]` with `rel:"approve"` (or `"payer-action"` on newer
  responses) as the customer redirect.
- `POST /v2/checkout/orders/{id}/capture` — explicit second step,
  structurally distinct from every other adapter's direct
  create-and-confirm flow. See "Capture timing" below for how Mal3aby
  sequences this.

### Capture timing — design decision, and why

PayPal's checkout flow is genuinely two-step: (1) create an order, get
an approve link; (2) the customer approves on PayPal's own site; (3)
Mal3aby must call the separate Capture API to actually complete the
payment. This adapter triggers the capture call from
**`paypal-gateway-webhook` on receipt of a verified `CHECKOUT.ORDER.
APPROVED` event** — never from the client-facing return page, and
never as a client-triggered call. Reasoning: `CHECKOUT.ORDER.APPROVED`
is a standard webhook event PayPal fires server-to-server the moment
the buyer completes approval, independent of whether the buyer's
browser ever successfully redirects back to Mal3aby — this keeps with
the project's hard rule that a redirect landing page is never
authoritative for payment state. The capture call itself does **not**
post a payment; only a *subsequent*, independently verified `PAYMENT.
CAPTURE.COMPLETED` event calls `record_gateway_payment_service`. The
capture call carries its own `PayPal-Request-Id` for idempotency, and
an `ORDER_ALREADY_CAPTURED` response from a redelivered
`CHECKOUT.ORDER.APPROVED` event (PayPal webhooks are at-least-once) is
treated as a benign no-op, not a failure.

### Webhook verification — API-based `verify-webhook-signature`, not local RSA/cert-chain

`POST /v1/notifications/verify-webhook-signature`, body
`{transmission_id, transmission_time, cert_url, auth_algo,
transmission_sig, webhook_id, webhook_event}`, response
`{verification_status:"SUCCESS"|"FAILURE"}`. The 5 headers PayPal
sends on every real delivery: `PAYPAL-TRANSMISSION-ID`,
`PAYPAL-TRANSMISSION-TIME`, `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`,
`PAYPAL-TRANSMISSION-SIG`. See PAYMENT_GATEWAY_WEBHOOK_MODEL.md for the
full reasoning on choosing the API-based path over local
certificate-chain verification.

**Security-load-bearing finding**: PayPal returns **HTTP 200 even when
verification fails** — the deployed `paypal-gateway-webhook` explicitly
checks `verification_status === 'SUCCESS'` on the parsed response
body and never infers verification from the HTTP status code alone.
`webhook_event` must be posted back byte-identical to the parsed body
Mal3aby received — the deployed function passes the same parsed
`payload` object through, never reconstructing/re-serializing it.

### Refund window — CORRECTED to 180 days

PayPal's own documented constraint is `REFUND_NOT_ALLOWED_AFTER_180_
DAYS`. An earlier secondary-sourced summary (see the comparison table
row prior to this session) stated ~45 days — that figure actually
describes `PayPal-Request-Id` idempotency-key *retention*, a wholly
separate mechanism, not the refund eligibility window. Corrected
throughout this document and in `paypal-create-refund`'s own header
comment.

### Credential mapping — two genuinely different-sensitivity values

- `public_key` = PayPal Client ID (not secret; PayPal routinely shows
  it in its own dashboard UI, and OAuth still requires the secret
  alongside it) — mirrors Stripe's publishable-key placement.
- `secret_vault_id` = PayPal Client Secret (used for OAuth Basic auth
  by all three PayPal functions).
- `provider_merchant_ref` = PayPal Webhook ID (the id PayPal assigns
  when the club owner registers a webhook subscription in their own
  PayPal app dashboard; required by `verify-webhook-signature`).
  Confirmed via live schema inspection this session that this column
  carries no doc comment restricting its meaning — reused exactly as
  Fawry reuses it for `merchantCode`.
- `webhook_secret_vault_id` = unused for PayPal (left null) — PayPal
  verification is API-based against a `webhook_id`, not a
  locally-held HMAC secret, so there is no second "secret" value that
  belongs in this slot.

### `custom_id` vs `invoice_id` — correlation field choice

`purchase_units[0].custom_id` (not `invoice_id`) is set to the Mal3aby
transaction id. PayPal copies `custom_id` from the purchase unit onto
the resulting Capture resource (confirmed on the Captures resource
schema), so both order-shaped (`CHECKOUT.ORDER.APPROVED`) and
capture-shaped (`PAYMENT.CAPTURE.*`) webhook events expose it at a
stable, predictable path. `invoice_id` was considered and rejected: it
carries stricter PayPal-side uniqueness/format expectations across the
merchant account that are unnecessary overhead here.

### Native idempotency

PayPal is one of only two of Mal3aby's five providers (alongside
Stripe) with genuine native idempotency support
(`payment_gateway_providers.paypal.supports_native_idempotency_key =
true`, confirmed live). `PayPal-Request-Id` is sent on the Orders
create call (keyed off the Mal3aby transaction id), the capture call
(keyed off the order id), and the refund call (keyed off capture id +
amount) — in addition to, not instead of, Mal3aby's own
`idempotency_key` mechanism.

### What genuinely could not be tested (CREDENTIAL-BLOCKED, disclosed honestly)

Unlike the other four adapters, whose HMAC schemes could be locally
reproduced and tested end-to-end without real credentials, PayPal's
webhook trust model calls PayPal's own real `verify-webhook-signature`
API — there is no way to construct a request that passes that check
without a real PayPal-issued signature from a real registered webhook
subscription. This session therefore has:

- CONTRACT TEST VERIFIED: the real OAuth token endpoint correctly
  rejects garbage credentials (see above).
- LIVE VERIFIED: the deployed `paypal-gateway-webhook` correctly
  rejects a request missing the 5 transmission headers (HTTP 400,
  before ever attempting to contact PayPal) and correctly reports "no
  matching gateway connection" when no PayPal connection exists yet
  in this project (there is genuinely none configured).
- LIVE VERIFIED: the deployed `paypal-create-checkout-session` and
  `paypal-create-refund` both return a real HTTP 401 when called
  without an `Authorization` bearer token, confirming `verify_jwt=true`
  is actually enforced by the platform gateway.
- CREDENTIAL-BLOCKED: the full success path (real order creation, real
  buyer approval, real capture, real `verify-webhook-signature` pass,
  duplicate-delivery idempotency, amount-mismatch rejection) requires
  a real PayPal sandbox app with a registered webhook subscription and
  real Client ID/Secret/webhook_id — none of which exist in this
  project yet. Building a disposable `club_gateway_connections` test
  row was considered and rejected: `connect_club_gateway()` requires a
  real authenticated caller context this session does not have, and
  writing directly into `club_gateway_connections` via `execute_sql`
  would bypass that table's own intentional no-direct-write design
  (verified live: it carries no INSERT/UPDATE/DELETE grant for any
  role, all writes are RPC-gated) rather than exercising a path a real
  caller could ever take. This is a genuine, disclosed ceiling, not a
  gap papered over with a fake-passing test.

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
| **PayPal** | Orders API v2 | Orders API + approve link (`rel: "approve"`/`"payer-action"`) | 5 headers (`PAYPAL-TRANSMISSION-*`, `PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`), RSA-SHA256, verified via the API-based `verify-webhook-signature` endpoint (see "PayPal update" section below for why API-based over local cert-chain verification) | Native `PayPal-Request-Id` header on both Orders create and Captures refund calls | EGP absent from documented currency list; supports USD/EUR/GBP | `POST /v2/payments/captures/{capture_id}/refund`, `{amount:{value,currency_code},note_to_payer}`, returns `{id,status}` directly — CORRECTED 2026-08-27: refund eligibility window is **180 days** (`REFUND_NOT_ALLOWED_AFTER_180_DAYS`), not the ~45-day figure this row previously stated (that 45-day figure actually described `PayPal-Request-Id` idempotency-key *retention*, an unrelated mechanism, not the refund window) | Distinct host `api-m.sandbox.paypal.com`, self-service sandbox accounts |
| **Paymob** | Intentions API (v1), `POST /v1/intention/` | Unified Checkout (redirect, `{region}.checkout.paymob.com`) / Pixel (embedded) via `client_secret` + `public_key` | HMAC-SHA512 over 20 fixed-order field VALUES (documented list, not generic lexicographic sort — see "Paymob update" section above), dashboard-issued HMAC secret, hex lowercase, sent as `hmac` query param — CONFIRMED against Paymob's own worked example (2026-08-27) | Not documented — dedup via merchant `special_reference` (echoed as `order.merchant_order_id` in the callback, not a top-level field) | Yes — core EGP gateway | `POST /api/acceptance/void_refund/refund`, `{transaction_id, amount_cents}` body, `Token` auth header — CONFIRMED 2026-08-27 | Same base URL (`accept.paymob.com`) for sandbox and live — mode is entirely determined by which secret/public key pair and Integration ID(s) are used — CONFIRMED 2026-08-27 |
| **Kashier** | No global version string; `v3` in the Payment Sessions endpoint path | Payment Sessions (`POST /v3/payment/sessions`, `sessionUrl` returned directly) | `x-kashier-signature` header, HMAC-SHA256 over an RFC 3986 query-string of alphabetically-sorted `signatureKeys` fields (`key=value&...`, not bare concatenation), keyed by the **Payment API Key** — CONFIRMED against Kashier's own published code sample and cross-checked byte-for-byte with an independent Python implementation (2026-08-27) | Kashier's own `transactionId` field is a genuine per-callback event id — dedup via the EXISTING `(provider_key, provider_event_id)` unique index, no new migration needed | Yes — EGP native; also USD/EUR/GBP (secondary-sourced) | `PUT {fep.kashier.io}/orders/:orderId/` (`apiOperation: REFUND`); synchronous JSON response — CONTRACT VERIFIED live-routed, real end-to-end success CREDENTIAL-BLOCKED (see "Kashier update" section) | Distinct `test-` prefixed base URL PER SUBDOMAIN (3 separate subdomain families: sessions, legacy iframe, refunds) + separate Payment-API-Key/Secret-Key pairs per environment — CONFIRMED code-example-level 2026-08-27 |
| **Fawry (FawryPay)** | No unified version; per-endpoint (e.g. Notification V2) | Express Checkout Link (`POST .../payments/charge`, server-to-server, returns a redirect URL) — CONFIRMED genuinely server-to-server, not a JS widget, via verbatim-quoted doc text 2026-08-27 | `messageSignature` BODY field (not a header, not a query param — CONFIRMED), SHA-256 over `fawryRefNumber+merchantRefNum+paymentAmount(2dp)+orderAmount(2dp)+orderStatus+paymentMethod+paymentRefrenceNumber+secureKey` — CONFIRMED via Fawry's own docs AND independently cross-checked against the real open-source `fawry-api/fawry` Ruby gem's source 2026-08-27; genuinely DIFFERENT field set from the outbound charge signature (`merchantCode+merchantRefNum+customerProfileId+returnUrl+itemId+quantity+price...+secureKey`) | No dedicated per-event id (`fawryRefNumber` is stable across multiple status-change notifications for the same order, unlike a true event id) — dedup via the EXISTING `(provider_key, payload_hash) WHERE provider_event_id IS NULL` index, same mechanism as Paymob, no new migration needed | Yes — EGP-only in every documented example | Full/partial via `POST /payments/refund`, `{merchantCode, referenceNumber, refundAmount, reason, signature}` — CODE VERIFIED path/fields against 3 independent sources 2026-08-27; auth-capture-uncaptured constraint N/A (adapter does not use the separate auth/capture API) | Staging domain (`atfawry.fawrystaging.com`) exists and IS directly reachable/documentable, but **credentials require manual merchant registration (~2 business days), not instant signup** — re-confirmed live 2026-08-27, unchanged |

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
- As of 2026-08-27, all 5 adapters this table documents (Stripe,
  Paymob, Kashier, Fawry, PayPal) have real Edge Function
  implementations committed — this table is no longer research-only.
  See PAYMENT_GATEWAY_ARCHITECTURE.md's closing "Five-provider
  evidence summary" section for the honest, side-by-side evidence-tier
  status of each.
