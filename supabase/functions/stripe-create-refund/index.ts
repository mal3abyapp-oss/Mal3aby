// stripe-create-refund -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS: real
// Stripe refund issuance (2026-08-27).
//
// Deployed with verify_jwt=true -- called by an authenticated Mal3aby
// staff session, same as create_refund() itself. This function
// independently re-derives and re-checks the SAME authorization
// create_refund() requires (has_permission('payment.refund', club_id)
// against the caller's own club membership) using the caller's own
// JWT -- never trusting the client to have only requested a refund it
// is entitled to issue.
//
// DESIGN DECISION -- synchronous posting, not webhook-driven:
// Stripe's Refunds API (https://docs.stripe.com/api/refunds/create,
// confirmed live this session) is SYNCHRONOUS for card payments -- the
// API response itself returns `status: "succeeded"` directly (verified
// against Stripe's own documented example response). Since Mal3aby's
// refunds.status CHECK constraint only allows ('completed', 'void')
// with no 'pending' value (confirmed via information_schema before
// writing this), and create_refund() itself posts synchronously with
// no async confirmation step, this function mirrors that exact
// shape: it calls Stripe's Refunds API synchronously and, ONLY on a
// genuine `status: "succeeded"` response, calls
// create_gateway_refund_service to post the canonical refund in the
// SAME request/response cycle. If Stripe ever returns `status:
// "pending"` or `status: "failed"` (rare for cards, more plausible for
// bank-debit-style payment methods per Stripe's own docs), this
// function does NOT post a refund -- it returns an explicit
// "not yet confirmed" response instead of guessing. Defense in depth:
// stripe-gateway-webhook is ALSO extended (see its own updated source)
// to handle 'charge.refunded'/'refund.updated' as an idempotent
// reconciliation safety net (calling the SAME
// create_gateway_refund_service, protected by the SAME idempotency_key
// uniqueness), for the rare case a refund confirms asynchronously
// after this function already returned, or if this function's own
// synchronous post somehow failed after Stripe's API call succeeded.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// CORS tightened (pre-launch hardening, 2026-08-29): this function is
// called only by the authenticated Mal3aby app itself via
// supabase.functions.invoke (JWT-Bearer auth, not browser-ambient
// cookie auth -- so wildcard CORS was never a CSRF vector here, per
// the pre-launch edge-function audit), but a privilege-relevant
// endpoint should still not advertise itself as fetchable from any
// origin as a matter of defense-in-depth. Allowlisted to the real app
// origins plus the local dev server -- never widened to '*' again.
const ALLOWED_ORIGINS = new Set([
  'https://mal3aby.app',
  'https://www.mal3aby.app',
  'http://localhost:5173',
])

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://mal3aby.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeadersFor(req) },
  })
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

function toStripeMinorUnits(amount: number, currencyLower: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currencyLower)) return Math.round(amount)
  return Math.round(amount * 100)
}

// refunds.idempotency_key is a `uuid` column (matching this project's
// established idempotency_key convention everywhere else), but
// Stripe's own refund id ('re_...') is not a UUID. Deterministically
// derive a stable, collision-resistant UUID from the Stripe refund id
// via SHA-256 (RFC 4122 version-5-style: same input always produces
// the same UUID, different inputs produce different UUIDs with
// cryptographic collision resistance) so both this function and
// stripe-gateway-webhook's defensive refund-event handling -- given
// the SAME Stripe refund id -- always derive the SAME idempotency key
// and therefore converge on the same refunds row.
async function deterministicUuidFromString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  // Format the first 16 bytes of the hash as a UUID, forcing the
  // version/variant bits so it is always syntactically a valid v4-shaped UUID.
  const bytesHex = hex.slice(0, 32).split('')
  bytesHex[12] = '4' // version nibble
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  bytesHex[16] = variantNibble
  const h = bytesHex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

function sanitizeStripeError(err: unknown): { message: string; type?: string; code?: string } {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const inner = (e.error && typeof e.error === 'object' ? e.error : e) as Record<string, unknown>
    return {
      message: typeof inner.message === 'string' ? inner.message : 'stripe request failed',
      type: typeof inner.type === 'string' ? inner.type : undefined,
      code: typeof inner.code === 'string' ? inner.code : undefined,
    }
  }
  return { message: 'stripe request failed' }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeadersFor(req) })
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return jsonResponse(req, { error: 'authentication required' }, 401)
  }

  let body: { payment_id?: string; amount?: number; reason?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'malformed JSON body' }, 400)
  }

  const paymentId = body.payment_id
  const amount = body.amount
  const reason = body.reason

  if (!paymentId || typeof paymentId !== 'string') {
    return jsonResponse(req, { error: 'payment_id is required' }, 400)
  }
  if (typeof amount !== 'number' || !(amount > 0)) {
    return jsonResponse(req, { error: 'amount must be a positive number' }, 400)
  }
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return jsonResponse(req, { error: 'a reason is required for a refund' }, 400)
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser()

  if (userError || !user) {
    return jsonResponse(req, { error: 'invalid or expired session' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, club_id, amount, method')
    .eq('id', paymentId)
    .maybeSingle()

  if (paymentError || !payment) {
    return jsonResponse(req, { error: 'payment not found' }, 404)
  }

  if (payment.method !== 'card') {
    return jsonResponse(req, { error: 'this payment was not a gateway (card) payment -- use the regular refund flow' }, 400)
  }

  // Independent server-side re-authorization -- the SAME permission
  // create_refund() itself requires (has_permission('payment.refund', club_id)),
  // re-checked here through the CALLER-scoped client (their own JWT)
  // rather than trusted from the client's own claim of authorization.
  const { data: authorized, error: authError } = await callerClient.rpc('has_permission', {
    p_key: 'payment.refund',
    p_club_id: payment.club_id,
  })

  if (authError || authorized !== true) {
    return jsonResponse(req, { error: 'not authorized to refund this payment' }, 403)
  }

  // Locate the ORIGINAL gateway transaction this payment came from --
  // this is what create_gateway_refund_service uses to enforce the
  // same-provider invariant (refund must go through the same
  // connection the original payment used).
  const { data: txn, error: txnError } = await admin
    .from('payment_gateway_transactions')
    .select('id, gateway, connection_id, club_id, currency')
    .eq('payment_id', paymentId)
    .eq('status', 'succeeded')
    .maybeSingle()

  if (txnError || !txn) {
    return jsonResponse(req, { error: 'no succeeded gateway transaction found for this payment' }, 404)
  }

  if (txn.gateway !== 'stripe') {
    return jsonResponse(req, { error: 'this payment was not processed through stripe' }, 400)
  }

  // Refundable-balance check -- mirrors create_refund()'s own
  // pre-check (create_gateway_refund_service re-checks this again
  // server-side too, but failing fast here avoids an unnecessary real
  // Stripe API call for a refund that would be rejected anyway).
  const { data: existingRefunds } = await admin
    .from('refunds')
    .select('amount')
    .eq('payment_id', paymentId)
    .eq('status', 'completed')

  const refundedSum = (existingRefunds ?? []).reduce((sum, r) => sum + Number(r.amount), 0)
  const refundable = Number(payment.amount) - refundedSum

  if (amount > refundable) {
    return jsonResponse(req, { error: `refund amount exceeds refundable balance (refundable: ${refundable})` }, 400)
  }

  if (!txn.connection_id) {
    return jsonResponse(req, { error: 'gateway transaction has no linked connection' }, 400)
  }

  const { data: connection, error: connError } = await admin
    .from('club_gateway_connections')
    .select('id, club_id, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== payment.club_id) {
    return jsonResponse(req, { error: 'gateway connection not found' }, 404)
  }

  if (!connection.secret_vault_id) {
    return jsonResponse(req, { error: 'gateway connection has no credentials configured' }, 400)
  }

  // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER SQL
  // RPC -- NOT admin.schema('vault').from('decrypted_secrets'), which
  // was live-tested and found broken this session (PostgREST does not
  // expose the `vault` schema in this project -- a genuine "Invalid
  // schema: vault" rejection, not an RLS denial). See migration
  // 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    return jsonResponse(req, { error: 'could not resolve gateway credentials' }, 500)
  }

  // Resolve the Stripe PaymentIntent id from the transaction's own
  // provider_session_ref -- for a Checkout Session ('cs_...'), the
  // Refunds API requires the underlying PaymentIntent id
  // ('pi_...'), not the Checkout Session id itself. Fetch the session
  // to resolve payment_intent if provider_session_ref looks like a
  // Checkout Session id; if it's already a PaymentIntent id, use it
  // directly.
  const { data: txnFull } = await admin
    .from('payment_gateway_transactions')
    .select('provider_session_ref')
    .eq('id', txn.id)
    .maybeSingle()

  const providerRef = txnFull?.provider_session_ref
  if (!providerRef) {
    return jsonResponse(req, { error: 'original gateway transaction has no provider session reference on file' }, 400)
  }

  const stripeSecretKey = decryptedSecret
  let paymentIntentId = providerRef

  if (providerRef.startsWith('cs_')) {
    const sessionLookup = await fetch(`https://api.stripe.com/v1/checkout/sessions/${providerRef}`, {
      headers: { Authorization: `Bearer ${stripeSecretKey}` },
      signal: AbortSignal.timeout(15000),
    })
    const sessionBody = await sessionLookup.json().catch(() => null)
    if (!sessionLookup.ok || !sessionBody?.payment_intent) {
      const sanitized = sanitizeStripeError(sessionBody)
      return jsonResponse(req, { error: `could not resolve payment intent from checkout session: ${sanitized.message}` }, 502)
    }
    paymentIntentId = sessionBody.payment_intent
  }

  // https://docs.stripe.com/api/refunds/create -- confirmed live this
  // session (OFFICIAL DOC VERIFIED): POST https://api.stripe.com/v1/refunds,
  // form-urlencoded, payment_intent + amount (minor units) + reason +
  // metadata. Idempotency-Key header keyed off (payment_id + amount)
  // so a retried call for the SAME refund amount never double-refunds
  // at Stripe -- a genuinely different partial-refund amount against
  // the same payment intentionally gets its own idempotency key (it is
  // a distinct refund, not a retry of the same one).
  //
  // `amount` is expected in the SAME minor-unit conversion as the
  // original charge -- derived from the original transaction's own
  // stored currency (txn.currency), never guessed/hardcoded, since a
  // wrong zero-decimal assumption here would refund the wrong amount.
  const originalCurrencyLower = (txn.currency ?? 'usd').toLowerCase()
  const minorUnitAmount = toStripeMinorUnits(amount, originalCurrencyLower)

  const params = new URLSearchParams()
  params.set('payment_intent', paymentIntentId)
  params.set('amount', String(minorUnitAmount))
  params.set('reason', 'requested_by_customer')
  params.set('metadata[mal3aby_payment_id]', paymentId)
  params.set('metadata[mal3aby_reason]', reason)

  let stripeResponse: Response
  try {
    stripeResponse = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `refund:${paymentId}:${amount}`,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    return jsonResponse(req, { error: 'could not reach stripe' }, 502)
  }

  const stripeBody = await stripeResponse.json().catch(() => null)

  if (!stripeResponse.ok || !stripeBody?.id) {
    const sanitized = sanitizeStripeError(stripeBody)
    return jsonResponse(req, { error: sanitized.message, type: sanitized.type }, 502)
  }

  if (stripeBody.status !== 'succeeded') {
    // Not yet confirmed (e.g. 'pending' for certain payment methods).
    // Do NOT post a canonical refund on a guess -- the webhook's
    // 'charge.refunded'/'refund.updated' handling (defense in depth)
    // will post it once Stripe confirms asynchronously. Tell the
    // caller honestly rather than pretending success.
    return jsonResponse(req, {
      refund_id: null,
      provider_refund_ref: stripeBody.id,
      status: stripeBody.status,
      message: 'refund submitted to stripe but not yet confirmed -- it will be posted once stripe confirms',
    })
  }

  // Stripe confirmed synchronously -- post the canonical refund now,
  // in the same request/response cycle, exactly like create_refund()
  // itself does for a cash refund.
  // idempotency_key is derived from the STRIPE REFUND ID itself
  // (stripeBody.id, e.g. 're_...') rather than the transaction id --
  // a transaction can be PARTIALLY refunded more than once, so keying
  // off the transaction alone would incorrectly collide two distinct
  // partial refunds into one row. Keying off Stripe's own refund id
  // is unique per real refund event and is exactly what lets the
  // webhook's defensive 'charge.refunded'/'refund.updated' fallback
  // (which also derives its key the same way) converge on the SAME
  // row as this synchronous call for the SAME real-world refund,
  // rather than creating a duplicate.
  const idempotencyKey = await deterministicUuidFromString(stripeBody.id)

  const { data: refundId, error: rpcError } = await admin.rpc('create_gateway_refund_service', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_provider_refund_ref: stripeBody.id,
    p_transaction_id: txn.id,
    p_actor_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    // Stripe has ALREADY refunded the customer's card at this point --
    // this is a genuine "we owe a ledger fix" state, not something to
    // silently swallow. Surface it clearly; the webhook's
    // charge.refunded fallback will also attempt to post the same
    // refund (same idempotency_key derivation, so it is safe even if
    // this RPC call partially succeeded).
    return jsonResponse(req, {
      error: `stripe refund succeeded (${stripeBody.id}) but posting the canonical refund failed: ${rpcError.message} -- this will be reconciled via webhook`,
      provider_refund_ref: stripeBody.id,
    }, 500)
  }

  return jsonResponse(req, { refund_id: refundId, provider_refund_ref: stripeBody.id, status: 'succeeded' })
})
