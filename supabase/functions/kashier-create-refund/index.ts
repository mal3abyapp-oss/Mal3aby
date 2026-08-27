// kashier-create-refund -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS: real
// Kashier refund issuance (2026-08-27).
//
// Deployed with verify_jwt=true -- called by an authenticated Mal3aby
// staff session, mirrors stripe-create-refund's and
// paymob-create-refund's authorization pattern exactly: independently
// re-derives and re-checks has_permission('payment.refund', club_id)
// against the caller's own club membership using the caller's own JWT.
//
// KASHIER REFUND API -- OFFICIAL DOC VERIFIED 2026-08-27 (see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Kashier update" section):
//   PUT {base_url}/orders/:orderId/
//   Headers: Authorization: {{secret_key}}, Accept: application/json,
//     Content-Type: application/json
//   Body: {"apiOperation": "REFUND", "reason": "<text>",
//          "transaction": {"amount": <numeric, major units>}}
//   Response: {"status": "SUCCESS", "response": {"gatewayCode": ...,
//     "transactionId": "TX-...", "amount": ..., "operation": "refund"},
//     "messages": {...}}
//
// HONEST GAP, DISCLOSED: Kashier's own docs describe passing "the
// Kashier Order ID and transaction ID as parameters in the URL", but
// the only concrete example fetched this session shows a SINGLE
// `:orderId` path segment (`/orders/:orderId/`), with no visible
// `:transactionId` segment or body field referencing a specific
// transaction attempt. This implementation follows the CONCRETE,
// documented example (single orderId path segment).
//
// CONTRACT-TESTED FINDING (2026-08-27, real HTTP requests to
// test-fep.kashier.io): a PUT to `/orders/:orderId/` with a garbage
// Authorization value and various plausible orderId shapes (a literal
// placeholder string, a random UUID) consistently returns HTTP 400
// `{"status":"INVALID_REQUEST","error":{"cause":"The URL is invalid",
// "explanation":"Routing key is missing from the URL"}}` -- this is a
// DIFFERENT error shape from both (a) the clean auth-specific 401
// `{"error":"Authorization error","message":"Invalid token"}` the
// Payment Sessions endpoint returns for the exact same kind of garbage
// credential, and (b) a genuine 404 for a deliberately wrong path
// (confirmed distinct, contrast-tested the same session). This proves
// `/orders/:orderId/` IS a real, live-routed endpoint on Kashier's
// infrastructure (not a 404) but suggests Kashier's real routing
// requires something this implementation does not yet send -- likely a
// routing key/header this session could not discover without a real
// merchant account issuing a real, correctly-shaped order id to test
// against. THIS IS CREDENTIAL-BLOCKED, not silently assumed correct:
// the request SHAPE (headers, body fields, HTTP method) is built
// exactly per the documented example, but end-to-end success against a
// REAL Kashier order has never been exercised. A future session with
// real Kashier credentials should treat this as the first thing to
// verify -- if "Routing key is missing from the URL" recurs with a
// REAL order id and REAL secret key, the request needs an additional
// header or path element not captured in this session's research.
//
// THE ORDER ID USED HERE IS KASHIER'S OWN ORDER ID (`kashierOrderId`
// from the webhook payload / the session response's own order
// reference), NOT Mal3aby's transaction id and NOT the merchant
// `order` reference sent at session-creation time --
// kashier-gateway-webhook overwrites
// payment_gateway_transactions.provider_session_ref with
// data.kashierOrderId specifically so this function can read it
// directly (mirrors paymob-create-refund's own
// intention-id-to-real-transaction-id handoff pattern, adapted to
// Kashier's id naming).
//
// KEY USED: secret_vault_id holds the Kashier SECRET KEY here (see
// kashier-create-checkout-session's header comment for the full
// rationale on why Kashier's two keys are split across the two vault
// slots differently than Paymob's single-key mapping) -- the refund
// endpoint's Authorization header requires the Secret Key specifically,
// not the Payment API Key used for sessions/webhook HMAC.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

// Refund API base URL -- CONFIRMED distinct subdomain from BOTH the
// Payment Sessions host (api.kashier.io / test-api.kashier.io) AND the
// legacy iframe host (iframe.kashier.io) -- a THIRD family of
// hostnames for this provider. test-fep.kashier.io was directly
// fetched and confirmed this session; the LIVE host is inferred by the
// consistent `test-` prefix convention observed across every other
// Kashier environment pair (api/test-api, iframe/test-iframe) rather
// than independently confirmed by a fetched example -- this specific
// inference is flagged honestly (OFFICIAL DOC VERIFIED for the TEST
// host only; the LIVE host is PATTERN-INFERRED, not directly sourced).
// If this project ever connects a real live-mode Kashier account, this
// single constant is the first thing to re-verify against the
// merchant's own dashboard/live docs before relying on it.
const KASHIER_ORDERS_BASE_URL: Record<string, string> = {
  sandbox: 'https://test-fep.kashier.io',
  live: 'https://fep.kashier.io', // PATTERN-INFERRED, not directly doc-confirmed this session -- see comment above.
}

function sanitizeKashierError(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string') return b.message
    if (typeof b.error === 'string') return b.error
    if (Array.isArray(b.messages) && b.messages.length > 0) return String(b.messages[0])
  }
  return 'kashier request failed'
}

async function deterministicUuidFromString(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const bytesHex = hex.slice(0, 32).split('')
  bytesHex[12] = '4'
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  bytesHex[16] = variantNibble
  const h = bytesHex.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return jsonResponse({ error: 'authentication required' }, 401)
  }

  let body: { payment_id?: string; amount?: number; reason?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'malformed JSON body' }, 400)
  }

  const paymentId = body.payment_id
  const amount = body.amount
  const reason = body.reason

  if (!paymentId || typeof paymentId !== 'string') {
    return jsonResponse({ error: 'payment_id is required' }, 400)
  }
  if (typeof amount !== 'number' || !(amount > 0)) {
    return jsonResponse({ error: 'amount must be a positive number' }, 400)
  }
  if (!reason || typeof reason !== 'string' || reason.trim() === '') {
    return jsonResponse({ error: 'a reason is required for a refund' }, 400)
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser()

  if (userError || !user) {
    return jsonResponse({ error: 'invalid or expired session' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, club_id, amount, method')
    .eq('id', paymentId)
    .maybeSingle()

  if (paymentError || !payment) {
    return jsonResponse({ error: 'payment not found' }, 404)
  }

  if (payment.method !== 'card') {
    return jsonResponse({ error: 'this payment was not a gateway (card) payment -- use the regular refund flow' }, 400)
  }

  const { data: authorized, error: authError } = await callerClient.rpc('has_permission', {
    p_key: 'payment.refund',
    p_club_id: payment.club_id,
  })

  if (authError || authorized !== true) {
    return jsonResponse({ error: 'not authorized to refund this payment' }, 403)
  }

  const { data: txn, error: txnError } = await admin
    .from('payment_gateway_transactions')
    .select('id, gateway, connection_id, club_id, currency, provider_session_ref')
    .eq('payment_id', paymentId)
    .eq('status', 'succeeded')
    .maybeSingle()

  if (txnError || !txn) {
    return jsonResponse({ error: 'no succeeded gateway transaction found for this payment' }, 404)
  }

  if (txn.gateway !== 'kashier') {
    return jsonResponse({ error: 'this payment was not processed through kashier' }, 400)
  }

  const { data: existingRefunds } = await admin
    .from('refunds')
    .select('amount')
    .eq('payment_id', paymentId)
    .eq('status', 'completed')

  const refundedSum = (existingRefunds ?? []).reduce((sum, r) => sum + Number(r.amount), 0)
  const refundable = Number(payment.amount) - refundedSum

  if (amount > refundable) {
    return jsonResponse({ error: `refund amount exceeds refundable balance (refundable: ${refundable})` }, 400)
  }

  if (!txn.connection_id) {
    return jsonResponse({ error: 'gateway transaction has no linked connection' }, 400)
  }

  const { data: connection, error: connError } = await admin
    .from('club_gateway_connections')
    .select('id, club_id, environment, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== payment.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.secret_vault_id) {
    // secret_vault_id holds the Kashier SECRET KEY (see file header) --
    // required for the refund endpoint's Authorization header.
    return jsonResponse({ error: 'gateway connection has no credentials configured' }, 400)
  }

  const providerRef = txn.provider_session_ref
  if (!providerRef) {
    return jsonResponse({ error: 'original gateway transaction has no provider reference on file' }, 400)
  }

  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  const kashierSecretKey = decryptedSecret
  const environment = connection.environment === 'live' ? 'live' : 'sandbox'
  const baseUrl = KASHIER_ORDERS_BASE_URL[environment]

  let kashierResponse: Response
  try {
    kashierResponse = await fetch(`${baseUrl}/orders/${encodeURIComponent(providerRef)}/`, {
      method: 'PUT',
      headers: {
        Authorization: kashierSecretKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiOperation: 'REFUND',
        reason,
        transaction: { amount },
      }),
    })
  } catch {
    return jsonResponse({ error: 'could not reach kashier' }, 502)
  }

  const kashierBody = await kashierResponse.json().catch(() => null)

  if (!kashierResponse.ok || kashierBody?.status !== 'SUCCESS') {
    // Kashier's refund endpoint is documented as synchronous -- a
    // non-"SUCCESS" status body means the refund was NOT actually
    // processed even though the HTTP call itself may have succeeded.
    // Do not post a canonical refund on a guess.
    const sanitizedMessage = sanitizeKashierError(kashierBody)
    return jsonResponse({
      refund_id: null,
      status: 'not_confirmed',
      message: sanitizedMessage,
    }, 502)
  }

  const kashierTransactionId = kashierBody?.response?.transactionId
  if (!kashierTransactionId || typeof kashierTransactionId !== 'string') {
    // Kashier confirmed SUCCESS but did not return the shape we expect
    // to derive an idempotency key from -- surfaced explicitly rather
    // than posting a canonical refund with a guessed/missing reference.
    return jsonResponse({
      error: 'kashier confirmed the refund but did not return a recognizable transaction id',
      status: 'not_confirmed',
    }, 502)
  }

  // idempotency_key derived from KASHIER'S OWN refund transaction id
  // (the NEW transaction id Kashier creates for the refund operation
  // itself, distinct from the original payment's transaction id) so a
  // retried call for the exact same refund converges on one refunds
  // row rather than creating a duplicate -- same derivation
  // stripe-create-refund and paymob-create-refund use for the same
  // purpose.
  const idempotencyKey = await deterministicUuidFromString(kashierTransactionId)

  const { data: refundId, error: rpcError } = await admin.rpc('create_gateway_refund_service', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_provider_refund_ref: kashierTransactionId,
    p_transaction_id: txn.id,
    p_actor_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    // Kashier has ALREADY refunded the customer at this point -- this
    // is a genuine "we owe a ledger fix" state, surfaced clearly
    // rather than silently swallowed, same discipline as
    // stripe-create-refund's / paymob-create-refund's own equivalent branch.
    return jsonResponse({
      error: `kashier refund succeeded (${kashierTransactionId}) but posting the canonical refund failed: ${rpcError.message}`,
      provider_refund_ref: kashierTransactionId,
    }, 500)
  }

  return jsonResponse({ refund_id: refundId, provider_refund_ref: kashierTransactionId, status: 'succeeded' })
})
