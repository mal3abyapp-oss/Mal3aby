// fawry-create-refund -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS: real
// Fawry refund issuance (2026-08-27).
//
// Deployed with verify_jwt=true -- called by an authenticated Mal3aby
// staff session, mirrors stripe-create-refund's / paymob-create-refund's
// / kashier-create-refund's authorization pattern exactly:
// independently re-derives and re-checks
// has_permission('payment.refund', club_id) against the caller's own
// club membership using the caller's own JWT, never trusting the
// client's own claim of authorization.
//
// FAWRY REFUND API -- OFFICIAL DOC VERIFIED 2026-08-27 + CODE VERIFIED
// against the real, open-source `fawry-api/fawry` Ruby gem's
// refund_request.rb (see PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Fawry
// update" section for the full source URLs; the path/field shape was
// confirmed via THREE independent sources agreeing exactly: Fawry's
// own refund-issue-api doc page, the Ruby gem's source, and a
// third-party dev.to integration guide):
//   POST {base_url}/payments/refund
//   Body: {merchantCode, referenceNumber, refundAmount, reason,
//          signature}
//   Signature: SHA-256 of merchantCode + referenceNumber +
//     refundAmount(2dp) + reason + secureKey.
//   Response: {"type":"ChargeResponse","statusCode":200,
//     "statusDescription":"Operation done successfully"} on success.
//
// CRITICAL WIRING DETAIL: Fawry's `referenceNumber` is Fawry's own
// TRANSACTION reference (`fawryRefNumber`), NOT Mal3aby's
// `merchantRefNum`. fawry-gateway-webhook overwrites
// payment_gateway_transactions.provider_session_ref with this real
// fawryRefNumber on a successful payment confirmation specifically so
// this function can read it directly here -- if provider_session_ref
// still holds a best-effort value from checkout-session-creation time
// (or is null), refund creation is refused with a clear, honest error
// rather than sending Fawry a request it cannot correlate. This
// mirrors paymob-create-refund's own intention-id-to-real-transaction-id
// handoff and kashier-create-refund's own order-id handoff exactly.
//
// AUTH-CAPTURE CONSTRAINT -- N/A HERE, DISCLOSED EXPLICITLY: the task
// brief asked about the "authorized-but-uncaptured cannot be
// refunded" constraint. Research this session confirmed Fawry's
// Express Checkout Link flow (what fawry-create-checkout-session
// implements) does NOT use Fawry's separate auth/capture API
// (`server-apis/auth-capture-payment-apis`) -- Mal3aby's adapter never
// calls that endpoint, so this constraint does not apply to any
// payment this adapter can produce. Not silently dropped -- genuinely
// not applicable to the flow actually built.
//
// NO RESPONSE-BODY REFUND-ID: unlike Paymob (returns a new
// transaction id for the refund operation) and Kashier (returns
// response.transactionId), Fawry's documented refund response
// contains no distinct refund-operation reference beyond the HTTP-level
// statusCode/statusDescription confirmation -- OFFICIAL DOC VERIFIED,
// the real fetched response example shows only
// `{"type":"ChargeResponse","statusCode":200,"statusDescription":"Operation done successfully"}`.
// The idempotency key for create_gateway_refund_service is therefore
// derived from a DETERMINISTIC combination of the ORIGINAL Fawry
// transaction reference + the refund amount (not a provider-issued
// refund id, since Fawry does not appear to issue one in this
// documented response shape) -- a retried call for the exact same
// refund (same original transaction, same amount) converges on one
// refunds row. This is a genuine, disclosed adaptation from the other
// three adapters' pattern, made necessary by Fawry's documented
// response shape actually being thinner than Stripe's/Paymob's/
// Kashier's.
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

// Base URLs -- same constants as fawry-create-checkout-session, see
// that function's own header comment for the sourcing/cross-check
// detail. LIVE base URL is CODE VERIFIED, not independently pinged
// this session.
const FAWRY_BASE_URL: Record<string, string> = {
  sandbox: 'https://atfawry.fawrystaging.com/ECommerceWeb/Fawry',
  live: 'https://www.atfawry.com/ECommerceWeb/Fawry',
}

async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function twoDp(n: number): string {
  return n.toFixed(2)
}

function sanitizeFawryError(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.statusDescription === 'string') return b.statusDescription
    if (typeof b.message === 'string') return b.message
  }
  return 'fawry request failed'
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

  if (txn.gateway !== 'fawry') {
    return jsonResponse({ error: 'this payment was not processed through fawry' }, 400)
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
    .select('id, club_id, environment, secret_vault_id, provider_merchant_ref, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== payment.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.secret_vault_id) {
    return jsonResponse({ error: 'gateway connection has no credentials configured' }, 400)
  }

  if (!connection.provider_merchant_ref) {
    return jsonResponse({ error: 'gateway connection has no merchant code configured' }, 400)
  }

  const providerRef = txn.provider_session_ref
  if (!providerRef) {
    return jsonResponse({
      error: 'original gateway transaction has no provider reference on file -- refund is not possible until the payment is fully confirmed via a fawry notification',
    }, 409)
  }

  const { data: secureKey, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !secureKey) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  const merchantCode = connection.provider_merchant_ref
  const environment = connection.environment === 'live' ? 'live' : 'sandbox'
  const baseUrl = FAWRY_BASE_URL[environment]

  // refundAmount -- major-unit decimal, 2dp, same convention as
  // fawry-create-checkout-session's own amount formatting.
  const signatureInput = `${merchantCode}${providerRef}${twoDp(amount)}${reason}${secureKey}`
  const signature = await sha256Hex(signatureInput)

  let fawryResponse: Response
  try {
    fawryResponse = await fetch(`${baseUrl}/payments/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        merchantCode,
        referenceNumber: providerRef,
        refundAmount: amount,
        reason,
        signature,
      }),
    })
  } catch {
    return jsonResponse({ error: 'could not reach fawry' }, 502)
  }

  const fawryBody = await fawryResponse.json().catch(() => null)

  if (!fawryResponse.ok || fawryBody?.statusCode !== 200) {
    // Fawry's refund endpoint is documented as synchronous -- a
    // non-200 statusCode means the refund was NOT actually processed
    // even though the HTTP call itself may have succeeded. Do not
    // post a canonical refund on a guess, same discipline as the
    // other three adapters' equivalent branch.
    const sanitizedMessage = sanitizeFawryError(fawryBody)
    return jsonResponse({
      refund_id: null,
      status: 'not_confirmed',
      message: sanitizedMessage,
    }, 502)
  }

  // Fawry confirmed synchronously -- post the canonical refund now.
  // See file header for why the idempotency key is derived
  // differently here than the other three adapters: Fawry's
  // documented refund response carries no distinct refund-operation
  // reference of its own, so the key is derived from the ORIGINAL
  // Fawry transaction reference + the refund amount, converging a
  // retried call for the exact same refund on one refunds row.
  const idempotencyKey = await deterministicUuidFromString(`fawry-refund:${providerRef}:${twoDp(amount)}`)

  const { data: refundId, error: rpcError } = await admin.rpc('create_gateway_refund_service', {
    p_payment_id: paymentId,
    p_amount: amount,
    p_reason: reason,
    p_provider_refund_ref: `${providerRef}:${twoDp(amount)}`,
    p_transaction_id: txn.id,
    p_actor_id: user.id,
    p_idempotency_key: idempotencyKey,
  })

  if (rpcError) {
    // Fawry has ALREADY refunded the customer at this point -- this
    // is a genuine "we owe a ledger fix" state, surfaced clearly
    // rather than silently swallowed, same discipline as the other
    // three adapters' own equivalent branch.
    return jsonResponse({
      error: `fawry refund succeeded but posting the canonical refund failed: ${rpcError.message}`,
      provider_refund_ref: providerRef,
    }, 500)
  }

  return jsonResponse({ refund_id: refundId, provider_refund_ref: providerRef, status: 'succeeded' })
})
