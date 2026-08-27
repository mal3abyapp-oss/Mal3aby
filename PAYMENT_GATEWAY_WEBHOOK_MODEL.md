# Payment Gateway Webhook Model

**Status: CODE VERIFIED, not SANDBOX VERIFIED.** Every SQL RPC below was
live-tested against the real hosted project (`gxkrtlvpjwxhcqdisyob`)
with disposable test fixtures. The Stripe webhook Edge Function's
cryptographic logic (HMAC-SHA256 signing/verification, constant-time
comparison) was cross-checked against an independent reference
implementation and matched exactly. Its HTTP-level rejection paths
(missing header, malformed/expired timestamp, no matching connection)
were exercised live against the deployed function. What has **not**
been tested: a genuine, correctly-signed webhook delivery from Stripe's
own infrastructure, end-to-end through a real Checkout Session. The
user has stated they do not currently have real Stripe test-mode
credentials. Closing that gap requires: a Stripe account (test mode is
free to create), a connected `club_gateway_connections` row with a real
`sk_test_...` secret and `whsec_...` webhook secret in Vault, and either
a real Checkout Session completed in Stripe's test mode or the Stripe
CLI's `stripe trigger` / `stripe listen --forward-to` tooling.

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

## Known gap: checkout-session-creation is not yet built

This phase built the payment-**posting** half of the flow
(`start_gateway_checkout` stages a transaction; the webhook confirms
and posts it) but not the Stripe **Checkout Session creation** Edge
Function that would call Stripe's API, receive back a real Checkout
Session id, and write that id onto
`payment_gateway_transactions.provider_session_ref` (and/or Stripe
Checkout Session metadata) at creation time.

Without that piece, the webhook function has no clean O(1) way to look
up "which `club_gateway_connections` row (and therefore which webhook
secret) does this incoming event belong to" before it can even attempt
signature verification. The interim strategy implemented and
documented in the function's own header comment: extract the Stripe
object id from the **unverified** request body (safe — this is
read-only and used only to narrow the candidate list, never to make a
trust or payment decision), try an exact `provider_session_ref` match
first, then a `metadata.mal3aby_transaction_id` match, and only if
both come up empty, fall back to trying every enabled Stripe
connection's webhook secret in turn until one produces a matching
HMAC. This is O(connections-per-club) instead of O(1) and is a real
efficiency/clarity gap — but it is not a security gap: an incorrect
secret simply fails to produce a matching signature, it cannot forge
one. Building the checkout-session-creation Edge Function (and having
it populate `provider_session_ref`/metadata up front) is the clear next
step to close this gap properly.

## What's needed before this is SANDBOX VERIFIED

- A real Stripe account with test-mode API keys and a webhook signing
  secret (`whsec_...`), connected via `connect_club_gateway(...)` to a
  real test club.
- The checkout-session-creation Edge Function (not yet built — see the
  gap above), so `provider_session_ref` is populated and a genuine
  Stripe Checkout Session can be completed in test mode.
- A real signed webhook delivery from Stripe (either through
  `stripe listen --forward-to` + `stripe trigger checkout.session.completed`,
  or a genuine completed test-mode Checkout) reaching the deployed
  `stripe-gateway-webhook` function and being verified, processed, and
  reflected in `public.payments`.

## Other providers (PayPal, Paymob, Kashier, Fawry) — not yet implemented

Each provider in `PAYMENT_GATEWAY_PROVIDER_MATRIX.md` uses a
structurally different signature scheme:

- **PayPal** — 5 headers (`PAYPAL-TRANSMISSION-*`, `PAYPAL-CERT-URL`,
  `PAYPAL-AUTH-ALGO`), RSA-SHA256, verifiable locally or via PayPal's
  own `verify-webhook-signature` API.
- **Paymob** — HMAC-SHA512 over an ordered field concatenation (exact
  field order needs re-confirmation against the live dashboard before
  implementation — flagged as unconfirmed in the provider matrix).
- **Kashier** — `x-kashier-signature` header, HMAC-SHA256 over
  alphabetically-sorted `signatureKeys` fields.
- **Fawry** — `messageSignature` body field (not a header), SHA-256
  over a fixed field concatenation.

Each needs its own dedicated Edge Function (the shared
`record_gateway_payment_service` / `mark_gateway_transaction_failed_service`
RPCs are provider-agnostic and already reusable by all of them — only
the *verification* layer is provider-specific). None of these four are
built in this phase.
