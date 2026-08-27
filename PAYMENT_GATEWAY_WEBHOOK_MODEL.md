# Payment Gateway Webhook Model

**Status update (2026-08-27, Phase 2 continuation): CODE VERIFIED +
CONTRACT VERIFIED for the checkout-session-creation half; LIVE
VERIFIED (with a disposable, hand-signed test event, NOT a genuine
Stripe-originated delivery) for the webhook's signature verification,
payment-posting, and duplicate-delivery idempotency.** See "What's
ACTUALLY been proven now" below for the exact evidence tier of every
claim. The remaining, honestly-labeled gap is CREDENTIAL-BLOCKED: no
real Stripe account/test-mode keys exist for this project, so a
genuine Stripe-originated webhook delivery (real HMAC secret issued by
Stripe, real Checkout Session completed on Stripe's hosted page) has
never been exercised. Everything this document previously described as
"CODE VERIFIED, not SANDBOX VERIFIED" is superseded by the section
below -- read it first.

## CRITICAL BUG FOUND AND FIXED THIS SESSION: PostgREST does not expose the `vault` schema

Every Edge Function in this integration (`stripe-gateway-webhook`,
`stripe-create-checkout-session`, `stripe-create-refund`) originally
read Vault secrets via `admin.schema('vault').from('decrypted_secrets')`
-- the pattern the PRIOR session's own webhook function used and
believed was live-verified. It was not: live-testing this session (see
"What's ACTUALLY been proven now" below) discovered this call fails
with `"Invalid schema: vault"` on every invocation -- PostgREST does
not expose the `vault` schema to REST/client-library calls in this
project. This is NOT an RLS or permission denial; it is a genuine "this
schema is not queryable via the REST API at all" rejection. The
practical effect: **every webhook signature verification attempt was
silently failing before it could ever succeed**, because the secret
read itself always returned nothing -- independent of whether the HMAC
computation logic was correct (it was, confirmed via an isolated
scratch-function cross-check).

**Fix**: a new `service_role`-only RPC, `get_vault_secret_service(p_secret_id uuid)`
(`language sql`, `security definer`, `set search_path to 'public',
'vault', 'pg_temp'`), that reads `vault.decrypted_secrets` via plain
SQL inside the database -- unaffected by PostgREST's schema-exposure
configuration, since this is a database-side function call, not a REST
request. All three Edge Functions now call
`admin.rpc('get_vault_secret_service', { p_secret_id })` instead of the
broken `.schema('vault')` pattern. Migration:
`20260827093045_fix_vault_secret_read_service_role_rpc.sql`.

## Why a webhook needs its own payment-posting path

The canonical `record_payment(...)` RPC is shaped for an authenticated
staff session: it requires `auth.uid() is not null`, checks
`has_permission('payment.create', club_id)` against the caller's own
club membership, and carries cash-shift/custody and official
government-receipt logic that only applies to in-person cash
collection. A payment gateway webhook has no Supabase Auth session at
all — the provider authenticates itself via a signature scheme over the
raw request body, not a JWT. `record_payment()` can never be called
from a webhook: the `auth.uid()` check would always fail, and even if
it didn't, none of its cash/receipt logic applies to a card payment
collected by a third-party processor.

## The two service-role RPCs

Both are granted **only** to `service_role`; `anon` and `authenticated`
are explicitly revoked and this was confirmed live via
`has_function_privilege(...)` for all three roles. Neither is reachable
from any client-side Supabase call — only from Edge Functions running
with the service-role key.

### `record_gateway_payment_service(p_transaction_id, p_confirmed_amount, p_confirmed_currency, p_provider_session_ref, p_provider_raw_status)`

The only path by which a canonical `public.payments` row may be posted
for a gateway (non-cash) payment. Called by the webhook Edge Function
**after** it has independently verified the provider's signature and
extracted the provider-confirmed amount/currency from the verified
payload.

Order of operations:

1. Locks the staged `payment_gateway_transactions` row (`for update`).
   Not found → raises (nothing written yet, safe to raise).
2. If the transaction is not `'pending'`: an already-`'succeeded'`
   transaction with a linked `payment_id` returns that same
   `payment_id` (idempotent replay — a duplicate webhook delivery is a
   true no-op). Any other non-pending state raises (still nothing
   written).
3. **Amount/currency cross-check.** Compares the caller-supplied
   provider-confirmed amount/currency against what was staged at
   `start_gateway_checkout()` time. Any mismatch marks the transaction
   `'failed'` with a `failure_reason` explaining the mismatch, writes an
   audit log entry, and **returns `NULL`** — it does not raise. No
   payment is ever posted on a mismatch.
4. **Invoice re-validation.** Re-locks the invoice and re-checks it is
   still `'issued'` and that the confirmed amount does not exceed the
   invoice's *current* outstanding balance (via
   `get_invoice_payment_summary`). This closes the race where the
   invoice was already fully or partially settled through a different
   channel (cash, a different gateway, a staff override) between
   checkout-start and webhook-arrival. Any failure here also marks the
   transaction `'failed'` with a reason and returns `NULL`.
5. Inserts into `public.payments` (`method = 'card'`,
   `received_by = NULL` — there is no staff actor; confirmed nullable
   via `information_schema.columns` and FK-safe since Postgres FK
   constraints never fire on NULL) and `public.payment_allocations`,
   exactly the same target tables `record_payment()` itself writes —
   this RPC does not create a parallel ledger.
6. Updates the transaction to `'succeeded'` with `payment_id` linked.
7. Writes an audit log entry (`payment.gateway_confirmed`).
8. Calls `_apply_gateway_payment_side_effects_internal(...)` — see
   below.

**Why rejections return `NULL` instead of raising an exception:** this
was a genuine bug found and fixed during live verification. A PL/pgSQL
function body executes as a single implicit (sub-)transaction — an
unhandled `raise exception` rolls back *every* statement already
executed inside that function call, including the `update ... set
status = 'failed'` and `write_audit_log(...)` calls meant to durably
record *why* a payment was rejected. The first version of this RPC
raised after writing the rejection state, and live-testing an
amount-mismatch call showed the transaction row was still `'pending'`
with `failure_reason` still `NULL` after the call — the rejection was
silently lost (though no double-post risk existed, since the payment
insert never ran either). The fix
(`20260827083046_fix_record_gateway_payment_no_raise_after_write.sql`):
every rejection path now commits its write and returns `NULL` instead
of raising. `raise exception` is reserved for genuine caller errors
that occur *before* any write in the function (transaction not found,
already-non-pending) where there is no state to lose. Callers must
treat a `NULL` return as "durably marked failed, read
`payment_gateway_transactions.failure_reason` for why" — not as an
unexpected error.

### `mark_gateway_transaction_failed_service(p_transaction_id, p_reason, p_provider_raw_status)`

For signature-verification failure, provider-reported decline/
cancellation, or any other "this checkout did not succeed" outcome.
Never touches `public.payments` or `public.payment_allocations`.

- Already `'succeeded'` → raises, refusing to flip a successful
  payment to failed (defends against a late/out-of-order webhook
  delivery, e.g. a delayed `payment_intent.payment_failed` arriving
  after an earlier `checkout.session.completed` already posted the
  payment).
- `'pending'` → transitions to `'failed'` with the given reason,
  writes an audit log entry.
- Already `'failed'`/`'cancelled'` → harmless no-op (idempotent under
  retry).

### `_apply_gateway_payment_side_effects_internal(p_payment_id, p_invoice_id, p_amount, p_new_outstanding)`

Internal (unprefixed-callable-only, `service_role`-only) helper
reusing this project's own established `_internal`-suffix convention
(`_activate_subscription_if_due_internal`,
`_activate_club_membership_if_due_internal`,
`_mint_invoice_token_internal` — all pre-existing, all called by
`record_payment()` itself). It performs:

- subscription activation (via `_activate_subscription_if_due_internal`)
- club membership activation (via `_activate_club_membership_if_due_internal`)
- booking auto-confirm when the invoice reaches zero outstanding
- `payment.received` notification event emission
- WhatsApp + email notification queuing (academy vs. venue template
  branching, exactly matching `record_payment()`'s own branching)

**Deliberate design choice — not a refactor of `record_payment()`
itself:** `record_payment()` is a production-critical, heavily-iterated
function (cash custody, official government receipt validation,
academy/venue notification branching). Gateway payments never touch
cash-shift or official-receipt logic (those are cash/in-person-only
concerns). Rather than extracting a shared "post-payment side effects"
helper out of `record_payment()`'s own body — a higher-risk change to
an already-proven function — this migration adds a new,
gateway-specific helper that reuses the *same* already-shared
`_internal` activation primitives `record_payment()` calls. This gets
real code reuse where it matters (activation, booking confirm,
notifications) without adding gateway-specific branching risk into
`record_payment()`'s dense body.

Live-verified: a real WhatsApp/email notification was queued and
(email) actually delivered during the happy-path test below — payload
matched exactly (`method: 'card'`, correct `payment_status`, correct
`remaining_outstanding`).

## Idempotency guarantee (two independent layers)

1. **Webhook-event layer** — `payment_gateway_webhook_events` has a
   unique index on `(provider_key, provider_event_id)`. A duplicate
   Stripe delivery of the same `event.id` hits this constraint; the
   Edge Function catches the `23505` violation and returns `200`
   immediately without calling either RPC again.
2. **Payment-RPC layer** — `record_gateway_payment_service` itself is
   idempotent independent of layer 1: a transaction already
   `'succeeded'` with a linked `payment_id` returns that same id rather
   than reprocessing. Live-tested: calling the RPC twice with the same
   `p_transaction_id` produced exactly one `payments` row and exactly
   one `payment_allocations` row — confirmed via direct count queries
   after the second call.

Both layers exist deliberately (belt-and-braces) — even if the Edge
Function's dedup insert were ever bypassed or raced, the RPC's own
pending-status guard still prevents a double-post.

## Amount/currency mismatch defense

`record_gateway_payment_service` never trusts the confirmed
amount/currency it's given without comparing it against what was
staged at `start_gateway_checkout()` time. Live-tested: calling the RPC
with a confirmed amount (999.00) that did not match the staged amount
(150.00) resulted in **zero** rows in `public.payments`, the
transaction durably marked `'failed'` with
`failure_reason = 'amount mismatch: staged=150.00 confirmed=999.00'`,
and a `payment.gateway_rejected` audit log entry recorded.

## Gap CLOSED: checkout-session-creation now exists

`stripe-create-checkout-session` (verify_jwt=true, deployed 2026-08-27)
now calls Stripe's real Checkout Sessions API
(`POST https://api.stripe.com/v1/checkout/sessions`) and, on success,
writes `payment_gateway_transactions.provider_session_ref` = the real
Stripe Checkout Session id (plus `metadata.mal3aby_transaction_id` and
`client_reference_id` on the Stripe object itself) at session-creation
time, before the customer ever reaches Stripe's hosted checkout page.
This means the webhook's exact-match candidate-resolution strategy
(`provider_session_ref` lookup) now succeeds in the COMMON CASE with a
single indexed query — genuinely O(1), not O(N) — for any transaction
created through the normal checkout flow. The O(N) "try every enabled
Stripe connection's webhook secret" path is retained in
`stripe-gateway-webhook` as a defensive fallback only (e.g. a
transaction whose session-creation call created the Stripe session but
failed to persist `provider_session_ref` afterward — a narrow,
explicitly-handled failure window documented in that function's own
comment, where the webhook's secondary `metadata.mal3aby_transaction_id`
match still resolves it without falling all the way to O(N)). This was
never a security gap in either state — an incorrect secret simply
fails to produce a matching signature, it cannot forge one — only an
efficiency/clarity one, and it is now closed for the common case.

Request-shape correctness for the Stripe Checkout Sessions API call
was CONTRACT VERIFIED this session: a real HTTP request built with the
function's exact parameter shape, sent to `api.stripe.com` with a
syntactically-valid-but-fake `sk_test_...` key, returned Stripe's
`"Invalid API Key provided"` (`invalid_request_error`, HTTP 401) —
an AUTHENTICATION error, not a parameter-validation error. This proves
the request shape itself (nested `line_items[0][price_data][...]`
params, `metadata[mal3aby_transaction_id]`, `success_url`/`cancel_url`,
the `Idempotency-Key` header) would be accepted by Stripe if the key
were real.

## What's ACTUALLY been proven now (2026-08-27 live verification)

A full, disposable test fixture was created against the real hosted
project (`gxkrtlvpjwxhcqdisyob`): a real `club_gateway_connections` row
(Stripe/sandbox) with two REAL Supabase Vault secrets
(`vault.create_secret`, not fabricated placeholders), a staged
`payment_gateway_transactions` row, and a genuinely HMAC-SHA256-signed
webhook payload — signed with the SAME secret stored in Vault, using
the exact `timestamp.raw_body` construction Stripe's own signature
scheme specifies, independently cross-checked against an isolated
scratch Edge Function's `hmacSha256Hex` output before use.

- **Signature verification: LIVE VERIFIED.** The genuinely-signed
  request was POSTed to the real deployed `stripe-gateway-webhook`
  function. It correctly verified the signature (after the
  `get_vault_secret_service` fix above), resolved the transaction via
  the `metadata.mal3aby_transaction_id` candidate path, and returned
  `{"received":true,"payment_id":"<real uuid>"}` with HTTP 200.
- **End-to-end payment posting: LIVE VERIFIED.** The database was
  queried directly afterward: the transaction was `succeeded` with a
  linked `payment_id`; exactly one `public.payments` row existed with
  `method='card'`, the correct amount; exactly one
  `public.payment_allocations` row existed.
- **Duplicate webhook idempotency (governing directive item 7): LIVE
  VERIFIED.** The IDENTICAL signed request (same event id, same
  signature, same timestamp) was POSTed a second time. Response:
  `{"received":true,"duplicate":true}`, HTTP 200. A direct count query
  afterward confirmed exactly one `payments` row, one
  `payment_allocations` row, and one `payment_gateway_webhook_events`
  row — the second delivery was a true no-op, not a second post.
- **Amount/currency mismatch defense (item 6): RE-VERIFIED LIVE** after
  all of this session's changes. A second disposable transaction staged
  at 300.00, confirmed at 999.00 via a direct `record_gateway_payment_service`
  call: returned `NULL`, `payments` unaffected, transaction durably
  marked `'failed'` with `failure_reason = 'amount mismatch: staged=300.00
  confirmed=999.00'`.
- **NOT proven, and cannot be without real credentials**: that a
  request bearing this exact shape, sent by Stripe's own
  infrastructure with a secret Stripe itself generated, would be
  accepted — i.e., that this project's webhook secret configuration
  and Stripe's real signing behavior actually agree. The HMAC algorithm
  itself is per Stripe's own published spec and was applied correctly,
  but "the algorithm is right" and "Stripe's production signer produces
  bytes this verifies" are different claims; only the second is
  CREDENTIAL-BLOCKED.

All disposable test fixtures (connection, both vault secrets, both
transactions, the payment, its allocation, the webhook event row) were
deleted after verification; restored-state queries confirmed zero
remaining rows.

## What's needed before this is SANDBOX VERIFIED

- A real Stripe account with test-mode API keys and a webhook signing
  secret (`whsec_...`) actually issued by Stripe, connected via
  `connect_club_gateway(...)` to a real test club.
- A genuine Checkout Session completed on Stripe's own hosted page
  (via `stripe-create-checkout-session`, now built) so a real
  Stripe-originated `checkout.session.completed` event reaches the
  deployed `stripe-gateway-webhook` function — this is the one
  remaining link this session's disposable-but-hand-signed test cannot
  stand in for.

## Paymob webhook verification (2026-08-27) — built this session

Paymob's webhook model differs from Stripe's in three structural ways,
each confirmed against Paymob's live documentation this session (see
`PAYMENT_GATEWAY_PROVIDER_MATRIX.md` "Paymob update" section for
source URLs):

1. **Signature location**: the `hmac` value is a QUERY PARAMETER on the
   callback URL (`?hmac=...`), never a request header. `paymob-gateway-webhook`
   reads it via `new URL(req.url).searchParams.get('hmac')` before
   touching the body at all.
2. **What gets hashed**: NOT the raw request body bytes (unlike
   Stripe's `timestamp.payload` scheme) — Paymob's own docs specify
   concatenating the VALUES of 20 specific, fixed-order fields (listed
   in full in `paymob-gateway-webhook`'s own header comment and in the
   architecture doc). This means the raw body is still read as text
   FIRST (for the `payload_hash` dedup key and to parse the JSON
   safely once), but the HMAC computation itself operates on values
   extracted from the parsed object, not the raw bytes — a genuine
   per-provider difference in mechanism, not an inconsistency with the
   Stripe function's own raw-body-first discipline.
3. **No dedicated event id**: Stripe supplies `event.id`; Paymob's
   transaction-processed callback has no equivalent field. Dedup is
   therefore content-hash-based:
   `payment_gateway_webhook_events(provider_key, payload_hash)` now has
   a real UNIQUE index (added via
   `20260827161918_paymob_webhook_events_payload_hash_dedup.sql` — the
   column existed before this session but only had a non-unique index,
   so nothing actually enforced atomic dedup at the database level for
   any provider lacking an event id until this migration).

**HMAC field order — CODE VERIFIED against Paymob's own worked
example.** Reconstructing the concatenation from Paymob's documented
key list (`amount_cents, created_at, currency, error_occured,
has_parent_transaction, obj.id, integration_id, is_3d_secure, is_auth,
is_capture, is_refunded, is_standalone_payment, is_voided, order.id,
owner, pending, source_data.pan, source_data.sub_type,
source_data.type, success`) reproduces Paymob's own published
concatenated string byte-for-byte
(`1000002024-06-13T11:33:44.592345EGPfalsefalse...cardtrue`). A second,
independent hand-rolled RFC-2104 HMAC-SHA512 construction (not using
Python's `hmac` module) was cross-checked against the module's own
output and matched exactly, confirming the algorithm itself.

**What's ACTUALLY been proven for Paymob (LIVE VERIFIED, this
session)**: a disposable test connection (real `vault.create_secret()`
entries, a real `club_gateway_connections` row on the pre-existing
"Mala3by Verification Club") was created, and:
- A hand-signed callback with the CORRECT HMAC (computed independently
  in Python against the real vaulted secret, fetched by the Edge
  Function via `get_vault_secret_service()`) was accepted — proving
  the Edge Function's Web Crypto `HMAC-SHA512` computation matches an
  independent reference implementation using a REAL secret round-tripped
  through Vault, not just a hypothetical test vector.
- The SAME payload with an incorrect HMAC was rejected (400) —
  negative evidence, proving the check discriminates rather than
  accepting everything.
- A staged transaction's merchant_order_id was resolved in O(1) via
  the direct UUID match against `payment_gateway_transactions.id`, and
  a webhook claiming a matching amount correctly posted a real
  `payments` row via the UNCHANGED `record_gateway_payment_service`.
- A webhook claiming a DIFFERENT (mismatched) confirmed amount against
  a second staged transaction was correctly rejected — the transaction
  was marked `failed` with reason `"amount mismatch: staged=500
  confirmed=1000"`, and no payment was posted — proving the existing
  fail-closed protection works unchanged when exercised through the
  new Paymob code path.
- The identical valid payload replayed a second time returned
  `duplicate:true` rather than reprocessing — the new
  `payload_hash` unique index works end-to-end.
- All test fixtures (connection, vault secrets, staged transactions,
  the posted payment and its allocations/tokens, the disposable
  invoice) were deleted afterward; a follow-up query confirmed zero
  rows remain.

**What remains CREDENTIAL-BLOCKED**: a genuine Paymob-originated
callback (real merchant account, real HMAC secret issued by Paymob,
real Unified Checkout transaction completed on Paymob's hosted page)
has never been exercised — no real Paymob account exists for this
project (confirmed: "محدش عندي حسابات"). The Refund endpoint's
synchronous-success path (`paymob-create-refund`) was similarly never
exercised end-to-end for the same reason, though its request shape was
CONTRACT VERIFIED (see the architecture doc) via a real HTTP request
to Paymob's live API with a garbage token, which returned a genuine
`{"detail":"Invalid token."}` 401 rather than a 404 or validation
error.

## Kashier webhook verification (2026-08-27) — built this session

Kashier's webhook model differs from BOTH Stripe's and Paymob's in
several structural ways, each confirmed against Kashier's live
documentation this session (see `PAYMENT_GATEWAY_PROVIDER_MATRIX.md`
"Kashier update" section for source URLs and Kashier's own published
code sample):

1. **Signature location**: `x-kashier-signature` is a request HEADER
   (like Stripe, unlike Paymob's query parameter).
2. **What gets hashed — genuinely different from BOTH other
   providers**: NOT the raw request body bytes (unlike Stripe), and
   NOT a bare value-only concatenation (unlike Paymob) — Kashier's own
   published Node.js sample builds a REAL RFC 3986 URL-encoded
   query-string (`key1=value1&key2=value2...`, using Node's
   `query-string` package / PHP's `PHP_QUERY_RFC3986`) from ONLY the
   fields named in the payload's own `data.signatureKeys` array
   (itself part of the payload — a server-supplied allowlist), with
   those key NAMES sorted alphabetically before building the query
   string. `kashier-gateway-webhook` reads the raw body as text first
   (for the `payload_hash` used in the durable audit trail and to
   parse the JSON safely once), then computes the HMAC over the
   RFC3986-encoded query string built from the PARSED `data` object —
   not the raw bytes, and not a bare concatenation.
3. **Dedicated event id EXISTS, unlike Paymob**: Kashier's own
   `transactionId` field (e.g. `"TX-249893122"`) is a genuine
   per-callback identifier documented on every callback. This means
   Kashier's dedup uses the EXISTING `(provider_key, provider_event_id)`
   unique index — the SAME one Stripe's `event.id` already used — with
   NO new migration required, resolving the task brief's own explicit
   anticipation of this possibility before any Kashier-specific
   migration was considered.

**HMAC construction — OFFICIAL DOC VERIFIED against Kashier's own
published code sample.** The literal, verbatim JavaScript sample from
`developers.kashier.io/payment/webhook/`:
```js
data.signatureKeys.sort();
const objectSignaturePayload = _.pick(data, data.signatureKeys);
const signaturePayload = queryString.stringify(objectSignaturePayload);
const signature = crypto.createHmac('sha256', PaymentApiKey)
  .update(signaturePayload).digest('hex');
```
The accompanying PHP sample has a visible bug (it query-string-encodes
the WHOLE `$data` object instead of the picked/sorted subset,
inconsistent with its own preceding `sort($data_obj['signatureKeys'])`
line and with the correct JS sample) — `kashier-gateway-webhook`
follows the JS sample's self-consistent, doc-verified-correct logic.
**CODE VERIFIED**: an independent Python reference implementation
(`urllib.parse.quote` for RFC3986 encoding, `hmac.new(..., sha256)`)
was built against Kashier's own published example payload
(`merchantOrderId: "1642935044835"`, `kashierOrderId:
"efb3d440-e3bf-4c86-b98e-c7bb1cbbcca1"`, `amount: 11334`, etc.) and,
separately, a full signed test callback for a REAL disposable
transaction was cross-checked byte-for-byte against the Edge
Function's own Web Crypto `HMAC-SHA256` output using a REAL secret
round-tripped through Supabase Vault — matching exactly.

**What's ACTUALLY been proven for Kashier (LIVE VERIFIED, this
session)**: a disposable test connection (real `vault.create_secret()`
entries for both the Payment API Key and Secret Key, a real
`club_gateway_connections` row on the pre-existing "Mala3by
Verification Club") was created, and:
- A hand-signed callback with the CORRECT HMAC (computed independently
  in Python against the real vaulted Payment API Key, fetched by the
  Edge Function via `get_vault_secret_service()`) was accepted —
  proving the Edge Function's Web Crypto `HMAC-SHA256` computation
  matches an independent reference implementation using a REAL secret,
  not just a hypothetical test vector. The transaction's
  `merchantOrderId` was resolved in O(1) via the direct UUID match
  against `payment_gateway_transactions.id`, and correctly posted a
  real `payments` row (`method='card'`, amount 100.00) via the
  UNCHANGED `record_gateway_payment_service`, with
  `provider_session_ref` correctly overwritten to Kashier's real order
  id.
- The SAME payload with an incorrect HMAC was rejected (400) —
  negative evidence, proving the check discriminates rather than
  accepting everything. A request with NO `x-kashier-signature` header
  at all was also rejected (400).
- A webhook claiming a DIFFERENT (mismatched) confirmed amount (999)
  against a second staged transaction (staged at 300.00) was correctly
  rejected — `payment_id: null` returned, the transaction was marked
  `failed` with reason `"amount mismatch: staged=300.00
  confirmed=999"`, and no payment was posted — proving the existing
  fail-closed protection works unchanged when exercised through the
  new Kashier code path.
- The identical valid payload replayed a second time returned
  `duplicate:true` rather than reprocessing — the EXISTING
  `(provider_key, provider_event_id)` unique index works end-to-end
  for Kashier's `transactionId`, with no new migration.
- `verify_jwt=true` was LIVE VERIFIED on both
  `kashier-create-checkout-session` and `kashier-create-refund` via a
  real 401 (`UNAUTHORIZED_NO_AUTH_HEADER`) with no Authorization header.
- The Payment Sessions API's request shape was CONTRACT VERIFIED: a
  real HTTP request to `test-api.kashier.io/v3/payment/sessions` with a
  garbage key returned Kashier's own genuine, path-specific
  `{"error":"Authorization error","message":"Invalid token"}` (401) —
  contrasted against a deliberately wrong path (a real Kashier-branded
  404), proving the 401 is not a generic catch-all.
- The Refund API's endpoint was CONTRACT VERIFIED as live-routed but
  NOT auth-confirmed: real requests to `test-fep.kashier.io/orders/:orderId/`
  with a garbage key and plausible orderId shapes consistently
  returned a genuine, endpoint-specific `"Routing key is missing from
  the URL"` error (400) — distinct from both the Sessions endpoint's
  clean 401 and a genuine 404 for a deliberately wrong path — proving
  the endpoint exists and is live-routed, but leaving open whether the
  exact request shape used here would succeed with real Kashier
  credentials (disclosed explicitly as CREDENTIAL-BLOCKED in
  `kashier-create-refund/index.ts`'s own header comment).
- All test fixtures (connection, both vault secrets, both staged
  transactions, the posted payment and its allocation, the webhook
  event rows) were deleted afterward; a follow-up query confirmed zero
  rows remain and both borrowed invoices' outstanding balances were
  restored to their pre-test values (400.00 and 500.00 respectively,
  both `unpaid`).

**What remains CREDENTIAL-BLOCKED**: a genuine Kashier-originated
callback (real merchant account, real Payment API Key issued by
Kashier, real Payment Session transaction completed on Kashier's
hosted page) has never been exercised — no real Kashier account exists
for this project. The Refund endpoint's request shape is built exactly
per Kashier's documented example, but whether it succeeds against a
REAL Kashier order is unproven — the contract test above proves the
endpoint is live and distinctly-routed, not that this exact request
shape is complete (see the "Routing key is missing" finding above).
The live-mode refund base URL (`fep.kashier.io`, no `test-` prefix) is
PATTERN-INFERRED from the consistent `test-` prefix convention seen
everywhere else on this provider, not independently doc-confirmed this
session.

## Fawry webhook verification (2026-08-27) — built this session

Fawry's webhook model (Server-to-Server Notification V2) differs from
all three other providers in its signature MECHANISM, while sharing
Paymob's content-hash dedup shape. Each finding below was confirmed
against Fawry's live documentation this session (see
`PAYMENT_GATEWAY_PROVIDER_MATRIX.md` "Fawry update" section for source
URLs and the verbatim real, open-source `fawry-api/fawry` Ruby gem
source this was cross-checked against):

1. **Signature location**: `messageSignature` is a BODY FIELD on the
   notification payload itself — no dedicated header (unlike Stripe's
   `Stripe-Signature` and Kashier's `x-kashier-signature`), no query
   parameter (unlike Paymob's `hmac`). A fourth, distinct location
   among the four providers built this phase.
2. **What gets hashed**: NOT HMAC at all — a plain, keyed-by-
   concatenation SHA-256 (`hashlib.sha256`/`Digest::SHA256`, not
   `hmac.new`/`OpenSSL::HMAC`) over 7 documented notification fields
   plus the secure key appended at the end:
   `fawryRefNumber + merchantRefNum + paymentAmount(2dp) +
   orderAmount(2dp) + orderStatus + paymentMethod +
   paymentRefrenceNumber + secureKey`. `fawry-gateway-webhook` reads
   the raw body as text first (for the `payload_hash` dedup key and to
   parse the JSON safely once), then computes the hash over VALUES
   extracted from the parsed object — same "extract fields from the
   parsed payload, not raw bytes" discipline as Paymob's and Kashier's
   own webhooks.
3. **GENUINELY DIFFERENT field set from the OUTBOUND charge-request
   signature** (`merchantCode + merchantRefNum + customerProfileId +
   returnUrl + chargeItems... + secureKey`) — confirmed precisely, not
   assumed to match, exactly as the task brief asked. Fawry is the
   first of the four providers built this phase where the SAME secret
   is genuinely used with two DIFFERENT field-concatenation formulas
   depending on direction (Stripe/Kashier/Paymob's outbound calls use
   entirely different auth mechanisms — an API key header — not a
   signature at all, so this particular "two different signature
   formulas, one secret" shape is new to Fawry specifically).
4. **No dedicated event id, like Paymob**: Fawry's `fawryRefNumber` is
   STABLE across multiple notifications for the SAME order as its
   status changes (e.g. a PAID notification and a later REFUNDED
   notification for the same order carry the SAME `fawryRefNumber`) —
   using it as a "provider_event_id" would wrongly collapse two
   genuinely different events into one. Dedup is therefore
   content-hash-based, reusing the EXISTING
   `payment_gateway_webhook_events_provider_payload_unique` index
   (`UNIQUE (provider_key, payload_hash) WHERE provider_event_id IS
   NULL`, added for Paymob in
   `20260827161918_paymob_webhook_events_payload_hash_dedup.sql`) — NO
   NEW MIGRATION NEEDED, confirmed by direct schema inspection before
   writing any code, resolving the task brief's own anticipation of
   this possibility.
5. **Field-name inconsistency, disclosed**: different Fawry doc
   pages/examples spell the merchant reference field inconsistently
   (`merchantRefNum` in the signature formula's own prose,
   `merchantRefNumber` in one fetched JSON example). The webhook reads
   BOTH spellings defensively for transaction LOOKUP, but the
   SIGNATURE computation always uses `merchantRefNum` specifically —
   matching the verbatim, unambiguous Ruby gem source rather than doc
   prose. If Fawry's real payload uses the other spelling for the
   signed field, verification fails closed (rejects) rather than
   silently accepting a wrongly-keyed signature.

**HMAC-free SHA-256 construction — OFFICIAL DOC VERIFIED + CODE
VERIFIED against a real, independent third-party open-source Ruby
gem's verbatim source** (`fawry-api/fawry`, `lib/fawry/fawry_callback.rb`,
fetched from GitHub raw content this session):
```ruby
def signature
  Digest::SHA256.hexdigest("#{callback_params[:fawryRefNumber]}#{callback_params[:merchantRefNum]}"\
                           "#{format('%<paymentAmount>.2f', paymentAmount: callback_params[:paymentAmount])}"\
                           "#{format('%<orderAmount>.2f', orderAmount: callback_params[:orderAmount])}"\
                           "#{callback_params[:orderStatus]}#{callback_params[:paymentMethod]}"\
                           "#{callback_params[:paymentRefrenceNumber]}#{fawry_secure_key}")
end
```
An independent Python reference implementation (`hashlib.sha256`, no
`hmac` module involved — Fawry's own scheme is not HMAC) was built
from this exact formula and Fawry's own doc prose (which agree
exactly), then used to hand-sign a real test notification.

**What's ACTUALLY been proven for Fawry (LIVE VERIFIED, this
session)**: a disposable test connection (a real `vault.create_secret()`
entry, a real `club_gateway_connections` row on the pre-existing "Mala3by
Verification Club") was created, and:
- A hand-signed notification with the CORRECT signature (computed
  independently in Python against the real vaulted secret, fetched by
  the Edge Function via `get_vault_secret_service()`) was accepted —
  proving the Edge Function's Web Crypto SHA-256 computation matches
  an independent reference implementation using a REAL secret
  round-tripped through Vault, not just a hypothetical test vector.
  The transaction's `merchantRefNum` was resolved in O(1) via the
  direct UUID match against `payment_gateway_transactions.id`, and
  correctly posted a real `payments` row (`method='card'`, amount
  250.50) via the UNCHANGED `record_gateway_payment_service`, with
  `provider_session_ref` correctly overwritten to Fawry's real
  `fawryRefNumber`.
- The IDENTICAL valid payload replayed a second time returned
  `duplicate:true` rather than reprocessing — the EXISTING
  `(provider_key, payload_hash) WHERE provider_event_id IS NULL`
  unique index works end-to-end for Fawry, with no new migration.
- The SAME payload shape with an INCORRECT signature was rejected
  (400) — negative evidence, proving the check discriminates rather
  than accepting everything. A request with NO `messageSignature`
  field at all was also rejected (400).
- A notification claiming a DIFFERENT (mismatched) confirmed amount
  (999) against a second staged transaction (staged at 300.00) was
  correctly rejected — `payment_id: null` returned, the transaction
  was marked `failed` with reason `"amount mismatch: staged=300.00
  confirmed=999"`, and no payment was posted — proving the existing
  fail-closed protection works unchanged when exercised through the
  new Fawry code path.
- `verify_jwt=true` was LIVE VERIFIED on both
  `fawry-create-checkout-session` and `fawry-create-refund` via a real
  401 (`UNAUTHORIZED_NO_AUTH_HEADER`) with no Authorization header.
- All test fixtures (connection, vault secret, both staged
  transactions, the posted payment and its allocation, the webhook
  event rows) were deleted afterward; a follow-up query confirmed zero
  rows remain and both borrowed invoices' outstanding balances were
  restored to their pre-test values (500.00 and 400.00 respectively,
  both `issued`, zero allocated).

**What remains genuinely NOT ATTEMPTED (not CREDENTIAL-BLOCKED in the
same sense as the other three)**: unlike Stripe/Paymob/Kashier, where a
CONTRACT VERIFIED test (a real request to the provider's live API with
a garbage key, confirming an auth-specific error) was successfully
performed, no such test was attempted against Fawry's real
`payments/charge`/`payments/refund` endpoints this session. Reasoning
disclosed in full in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` "What
genuinely could not be tested": Fawry's endpoints require a `signature`
field computed from a secure key that, without a real merchant
account, can only ever be fake — and whether Fawry's real API responds
to a garbage-signed request with a clean, useful auth-specific error
(like Paymob's/Kashier's own contract tests found) or some other
failure mode was not established, so no CONTRACT VERIFIED claim is
made. This is a real, disclosed gap for a future session with either
real or garbage-but-registered credentials to close.

**What remains CREDENTIAL-BLOCKED**: a genuine Fawry-originated
notification (real merchant account, real Secure Hash Key issued by
Fawry, real Express Checkout Link transaction completed on Fawry's
hosted page) has never been exercised — no real Fawry account exists
for this project, and Fawry specifically cannot issue one quickly even
if requested (manual registration, ~2 business days, re-confirmed live
this session). The Refund endpoint's synchronous-success path
(`fawry-create-refund`) was similarly never exercised end-to-end for
the same reason.

## Other provider (PayPal) — not yet implemented

PayPal uses a structurally different signature scheme from all four
providers built this phase: 5 headers (`PAYPAL-TRANSMISSION-*`,
`PAYPAL-CERT-URL`, `PAYPAL-AUTH-ALGO`), RSA-SHA256, verifiable locally
or via PayPal's own `verify-webhook-signature` API.

It needs its own dedicated Edge Function (the shared
`record_gateway_payment_service` / `mark_gateway_transaction_failed_service`
RPCs are provider-agnostic and already reusable by it — only the
*verification* layer is provider-specific, as demonstrated by the
Paymob, Kashier, and Fawry adapters all reusing every shared RPC
completely unchanged). Not built in this phase.
