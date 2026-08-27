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

## Other providers (PayPal, Kashier, Fawry) — not yet implemented

Each remaining provider in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` uses a
structurally different signature scheme:

- **PayPal** — 5 headers (`PAYPAL-TRANSMISSION-*`, `PAYPAL-CERT-URL`,
  `PAYPAL-AUTH-ALGO`), RSA-SHA256, verifiable locally or via PayPal's
  own `verify-webhook-signature` API.
- **Kashier** — `x-kashier-signature` header, HMAC-SHA256 over
  alphabetically-sorted `signatureKeys` fields.
- **Fawry** — `messageSignature` body field (not a header), SHA-256
  over a fixed field concatenation.

Each needs its own dedicated Edge Function (the shared
`record_gateway_payment_service` / `mark_gateway_transaction_failed_service`
RPCs are provider-agnostic and already reusable by all of them — only
the *verification* layer is provider-specific, as demonstrated by the
Paymob adapter reusing all four shared RPCs completely unchanged).
None of these three are built in this phase.
