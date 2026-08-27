// paymob-create-refund -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS: real
// Paymob refund issuance (2026-08-27).
//
// Deployed with verify_jwt=true -- called by an authenticated Mal3aby
// staff session, mirrors stripe-create-refund's authorization pattern
// exactly: independently re-derives and re-checks
// has_permission('payment.refund', club_id) against the caller's own
// club membership using the caller's own JWT, never trusting the
// client's own claim of authorization.
//
// PAYMOB REFUND API -- OFFICIAL DOC VERIFIED 2026-08-27 (see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Paymob update" section, item 2):
//   POST {base_url}/api/acceptance/void_refund/refund
//   Header: Authorization: Token {secret_key}
//   Body: {"transaction_id": "<paymob transaction id, integer>",
//          "amount_cents": "<integer>"}
//   Response: mirrors the transaction object shape, with
//   is_refund: true on success.
//
// CRITICAL WIRING DETAIL: Paymob's `transaction_id` is Paymob's own
// TRANSACTION id (the numeric obj.id from the processed callback),
// NOT the Intention id (pi_...) returned at checkout-creation time.
// paymob-gateway-webhook overwrites
// payment_gateway_transactions.provider_session_ref with this real
// transaction id on a successful payment confirmation specifically so
// this function can read it directly here -- if provider_session_ref
// still looks like an intention id (starts with "pi_"), refund
// creation is refused with a clear, honest error rather than sending
// Paymob a nonsensical transaction_id it would reject anyway (this
// is a deliberate fail-closed guard, not a real production gap: if a
// payment succeeded through the normal webhook path, provider_session_ref
// is unconditionally overwritten to the real transaction id --
// see record_gateway_payment_service's own p_provider_session_ref
// coalesce, and paymob-gateway-webhook's success branch, which always
// passes the real paymobTransactionId).
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

const PAYMOB_API_BASE_URL: Record<string, string> = {
  EG: 'https://accept.paymob.com',
}

function sanitizePaymobError(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.detail === 'string') return b.detail
    if (typeof b.message === 'string') return b.message
  }
  return 'paymob request failed'
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

  if (txn.gateway !== 'paymob') {
    return jsonResponse({ error: 'this payment was not processed through paymob' }, 400)
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
    .select('id, club_id, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== payment.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.secret_vault_id) {
    return jsonResponse({ error: 'gateway connection has no credentials configured' }, 400)
  }

  const providerRef = txn.provider_session_ref
  if (!providerRef) {
    return jsonResponse({ error: 'original gateway transaction has no provider reference on file' }, 400)
  }

  // Fail-closed guard: Paymob's Intention id is prefixed "pi_" (a
  // string), while Paymob's real TRANSACTION id (required by the
  // refund endpoint) is always a bare integer. If provider_session_ref
  // still looks like an intention id, the webhook's success handler
  // never ran its overwrite -- refuse rather than sending Paymob a
  // request it would reject with a confusing error.
  if (!/^\d+$/.test(providerRef)) {
    return jsonResponse({
      error: 'gateway transaction does not have a resolved paymob transaction id yet -- refund is not possible until the payment is fully confirmed',
    }, 409)
  }

  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  const paymobSecretKey = decryptedSecret
  const region = 'EG' // Mirrors paymob-create-checkout-session's own region resolution -- see that function's TODO for widening beyond EG.
  const apiBaseUrl = PAYMOB_API_BASE_URL[region]

  // amount_cents -- same 2-decimal EGP-only conversion as
  // paymob-create-checkout-session; derived from the ORIGINAL
  // transaction's own stored currency, never guessed.
  const amountCents = Math.round(amount * 100)

  let paymobResponse: Response
  try {
    paymobResponse = await fetch(`${apiBaseUrl}/api/acceptance/void_refund/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${paymobSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        transaction_id: providerRef,
        amount_cents: String(amountCents),
      }),
    })
  } catch {
    return jsonResponse({ error: 'could not reach paymob' }, 502)
  }

  const paymobBody = await paymobResponse.json().catch(() => null)

  if (!paymobResponse.ok || !paymobBody?.id) {
    const sanitizedMessage = sanitizePaymobError(paymobBody)
    return jsonResponse({ error: sanitizedMessage }, 502)
  }

  if (paymobBody.success !== true) {
    // Paymob's refund endpoint is documented as synchronous -- a
    // non-success response body (success: false) means the refund was
    // NOT actually processed even though the HTTP call itself
    // succeeded. Do not post a canonical refund on a guess.
    return jsonResponse({
      refund_id: null,
      provider_refund_ref: String(paymobBody.id),
      status: 'not_confirmed',
      message: 'refund submitted to paymob but was not confirmed successful',
    }, 502)
  }

  // Paymob confirmed synchronously -- post the canonical refund now.
  // idempotency_key derived from PAYMOB'S OWN refund transaction id
  // (paymobBody.id, the NEW transaction id Paymob creates for the
  // refund operation itself -- distinct from the original payment's
  // transaction id) so a retried call for the exact same refund
  // converges on one refunds row rather than creating a duplicate,
  // same derivation stripe-create-refund uses for the same purpose.
  const idempotencyKey = await deterministicUuidFromString(String(paymobBody.id))

  const { data: refundId, error: rpcError } = await admin.rpc('create_gateway_refund_service', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_provider_refund_ref: String(paymobBody.id),
    p_transaction_id: txn.id,
    p_actor_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    // Paymob has ALREADY refunded the customer at this point -- this
    // is a genuine "we owe a ledger fix" state, surfaced clearly
    // rather than silently swallowed, same discipline as
    // stripe-create-refund's own equivalent branch.
    return jsonResponse({
      error: `paymob refund succeeded (${paymobBody.id}) but posting the canonical refund failed: ${rpcError.message}`,
      provider_refund_ref: String(paymobBody.id),
    }, 500)
  }

  return jsonResponse({ refund_id: refundId, provider_refund_ref: String(paymobBody.id), status: 'succeeded' })
})
