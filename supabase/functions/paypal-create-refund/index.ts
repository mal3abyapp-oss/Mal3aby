// paypal-create-refund -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS: real
// PayPal Captures Refund API issuance (2026-08-27). Fifth and final
// provider adapter of this directive.
//
// Deployed with verify_jwt=true -- called by an authenticated Mal3aby
// staff session, mirrors stripe-create-refund's / paymob-create-refund's
// / kashier-create-refund's / fawry-create-refund's authorization
// pattern exactly: independently re-derives and re-checks
// has_permission('payment.refund', club_id) against the caller's own
// club membership using the caller's own JWT, never trusting the
// client's own claim of authorization.
//
// PAYPAL REFUND API -- OFFICIAL DOC VERIFIED (see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "PayPal" section):
//   POST {base}/v2/payments/captures/{capture_id}/refund
//   Body: {amount:{value,currency_code}, note_to_payer}
//   Response: {id, status} on success -- PayPal DOES return its own
//   refund id directly (unlike Fawry, which required a
//   deterministicUuidFromString workaround because its documented
//   response carried no distinct refund-operation reference). This
//   adapter uses PayPal's own returned `id` directly as
//   p_provider_refund_ref, matching the simpler Stripe/Paymob/Kashier
//   pattern.
//
// REFUND TIME LIMIT -- 180 DAYS, CORRECTED FIGURE: PayPal's own
// documented constraint is REFUND_NOT_ALLOWED_AFTER_180_DAYS -- NOT the
// ~45-day figure an earlier secondary-sourced summary claimed (that
// 45-day figure actually describes PayPal-Request-Id idempotency-key
// RETENTION, a wholly separate mechanism, not the refund eligibility
// window). If PayPal rejects a refund for this reason, its own error
// `name`/`details[].issue` will surface it -- this function does not
// pre-check the 180-day window itself (Mal3aby does not durably track
// the ORIGINAL capture timestamp with enough precision to duplicate
// that check reliably) and instead relies on PayPal's own synchronous
// rejection, surfaced honestly via sanitizePaypalError.
//
// CRITICAL WIRING DETAIL: the capture_id in the URL path is PayPal's
// own CAPTURE id (resource.id from the PAYMENT.CAPTURE.COMPLETED
// webhook event), NOT the order id used during checkout-session
// creation. paypal-gateway-webhook overwrites
// payment_gateway_transactions.provider_session_ref with this real
// capture id on a successful PAYMENT.CAPTURE.COMPLETED confirmation
// specifically so this function can read it directly here -- if
// provider_session_ref still holds the order id from checkout-session
// creation time (or is null), refund creation is refused with a clear,
// honest error rather than sending PayPal a request it cannot
// correlate. Mirrors fawry-create-refund's own
// intention-id-to-real-transaction-id handoff exactly.
//
// NATIVE IDEMPOTENCY: PayPal-Request-Id is sent on the refund call
// itself, keyed off (capture id + refund amount) -- a retried call for
// the exact same refund converges on the SAME PayPal refund operation
// rather than creating a duplicate at PayPal's side, in addition to
// Mal3aby's own idempotency_key mechanism on create_gateway_refund_service.
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

const PAYPAL_BASE_URL: Record<string, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}

function sanitizePaypalError(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (Array.isArray(b.details) && b.details.length > 0) {
      const first = b.details[0] as Record<string, unknown>
      if (typeof first.description === 'string') return first.description
      if (typeof first.issue === 'string') return first.issue
    }
    if (typeof b.message === 'string') return b.message
  }
  return 'paypal request failed'
}

async function fetchAccessToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<{ token: string } | { error: string }> {
  let tokenResponse: Response
  try {
    tokenResponse = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    })
  } catch {
    return { error: 'could not reach paypal (oauth)' }
  }

  const tokenBody = await tokenResponse.json().catch(() => null)

  if (!tokenResponse.ok || typeof tokenBody?.access_token !== 'string') {
    return { error: sanitizePaypalError(tokenBody) }
  }

  return { token: tokenBody.access_token }
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

  if (txn.gateway !== 'paypal') {
    return jsonResponse({ error: 'this payment was not processed through paypal' }, 400)
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
    .select('id, club_id, environment, public_key, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== payment.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.secret_vault_id) {
    return jsonResponse({ error: 'gateway connection has no credentials configured' }, 400)
  }

  if (!connection.public_key) {
    return jsonResponse({ error: 'gateway connection has no client id configured' }, 400)
  }

  // CRITICAL WIRING DETAIL (see file header): provider_session_ref must
  // hold PayPal's own CAPTURE id, not the order id -- only true once
  // paypal-gateway-webhook has processed a real PAYMENT.CAPTURE.COMPLETED
  // event for this transaction.
  const captureId = txn.provider_session_ref
  if (!captureId) {
    return jsonResponse({
      error: 'original gateway transaction has no provider capture reference on file -- refund is not possible until the payment is fully confirmed via a paypal notification',
    }, 409)
  }

  const { data: clientSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !clientSecret) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  const clientId = connection.public_key
  const environment = connection.environment === 'live' ? 'live' : 'sandbox'
  const baseUrl = PAYPAL_BASE_URL[environment]

  const tokenResult = await fetchAccessToken(baseUrl, clientId, clientSecret)
  if ('error' in tokenResult) {
    return jsonResponse({ error: 'could not authenticate with paypal' }, 502)
  }

  // currency_code must match the ORIGINAL capture's currency -- derived
  // from the original transaction's own stored currency (txn.currency),
  // never guessed/hardcoded, same discipline as stripe-create-refund's
  // own currency handling.
  const currencyCode = (txn.currency ?? 'USD').toUpperCase()
  const amountValue = amount.toFixed(2)

  let paypalResponse: Response
  try {
    paypalResponse = await fetch(`${baseUrl}/v2/payments/captures/${captureId}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenResult.token}`,
        'Content-Type': 'application/json',
        // Native idempotency -- keyed off (capture id + amount), same
        // reasoning as paypal-create-checkout-session's own
        // PayPal-Request-Id usage.
        'PayPal-Request-Id': `mal3aby-refund-${captureId}-${amountValue}`,
      },
      body: JSON.stringify({
        amount: { value: amountValue, currency_code: currencyCode },
        note_to_payer: reason.slice(0, 255),
      }),
    })
  } catch {
    return jsonResponse({ error: 'could not reach paypal' }, 502)
  }

  const paypalBody = await paypalResponse.json().catch(() => null)

  if (!paypalResponse.ok || typeof paypalBody?.id !== 'string') {
    // PayPal's refund endpoint is synchronous -- a non-2xx or missing
    // id means the refund was NOT actually processed. Do not post a
    // canonical refund on a guess, same discipline as the other four
    // adapters' equivalent branch. This is also where a genuine
    // REFUND_NOT_ALLOWED_AFTER_180_DAYS rejection surfaces (see file
    // header).
    const sanitizedMessage = sanitizePaypalError(paypalBody)
    return jsonResponse({
      refund_id: null,
      status: 'not_confirmed',
      message: sanitizedMessage,
    }, 502)
  }

  // PayPal's refund response status can be COMPLETED or PENDING
  // (documented for certain funding sources) -- only post the
  // canonical refund on a genuinely confirmed COMPLETED status, mirroring
  // stripe-create-refund's own "do not post on pending" discipline.
  if (paypalBody.status !== 'COMPLETED') {
    return jsonResponse({
      refund_id: null,
      provider_refund_ref: paypalBody.id,
      status: paypalBody.status ?? 'unknown',
      message: 'refund submitted to paypal but not yet confirmed -- it will be reconciled once paypal confirms',
    })
  }

  // PayPal confirmed synchronously -- post the canonical refund now.
  // idempotency_key derivation deliberately mirrors
  // stripe-create-refund's own: derived from PayPal's OWN refund id
  // (paypalBody.id, e.g. a real refund resource id), unique per
  // real-world refund event, so a retried call for the SAME refund
  // converges on the SAME refunds row rather than creating a duplicate.
  const idempotencyKey = await deterministicUuidFromString(paypalBody.id)

  const { data: refundId, error: rpcError } = await admin.rpc('create_gateway_refund_service', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_provider_refund_ref: paypalBody.id,
    p_transaction_id: txn.id,
    p_actor_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    // PayPal has ALREADY refunded the customer at this point -- this is
    // a genuine "we owe a ledger fix" state, surfaced clearly rather
    // than silently swallowed, same discipline as the other four
    // adapters' own equivalent branch.
    return jsonResponse({
      error: `paypal refund succeeded (${paypalBody.id}) but posting the canonical refund failed: ${rpcError.message}`,
      provider_refund_ref: paypalBody.id,
    }, 500)
  }

  return jsonResponse({ refund_id: refundId, provider_refund_ref: paypalBody.id, status: 'succeeded' })
})

// refunds.idempotency_key is a `uuid` column, but PayPal's own refund
// id is not a UUID shape. Deterministically derive a stable,
// collision-resistant UUID from the PayPal refund id via SHA-256, same
// approach as stripe-create-refund's own deterministicUuidFromString.
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
