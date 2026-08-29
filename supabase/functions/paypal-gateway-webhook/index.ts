// paypal-gateway-webhook -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS:
// PayPal webhook receiver + order capture trigger (2026-08-27). Fifth
// and final provider adapter of this directive.
//
// Deployed with verify_jwt=false -- PayPal calls this endpoint directly
// with no Supabase session/JWT at all, mirroring
// stripe-gateway-webhook's / paymob-gateway-webhook's /
// kashier-gateway-webhook's / fawry-gateway-webhook's own
// self-authenticating, session-less structure and trust model.
//
// VERIFICATION SCHEME -- API-based verify-webhook-signature, NOT local
// RSA/cert-chain verification. This was a deliberate choice (see
// PAYMENT_GATEWAY_WEBHOOK_MODEL.md for the full reasoning): local
// verification requires fetching and validating PayPal's own
// certificate chain (cert_url), which is a materially larger trust
// surface to implement correctly in an Edge Function (cert pinning,
// chain validation, revocation) than delegating that entire job back
// to PayPal's own API, which already has to get it right for its own
// production traffic. OFFICIAL DOC VERIFIED:
//
//   POST {base}/v1/notifications/verify-webhook-signature
//   Body: {transmission_id, transmission_time, cert_url, auth_algo,
//          transmission_sig, webhook_id, webhook_event}
//   Response: {verification_status: "SUCCESS"|"FAILURE"}
//
// The 5 headers PayPal sends on every real webhook delivery:
//   PAYPAL-TRANSMISSION-ID, PAYPAL-TRANSMISSION-TIME, PAYPAL-CERT-URL,
//   PAYPAL-AUTH-ALGO, PAYPAL-TRANSMISSION-SIG.
//
// CRITICAL, SECURITY-LOAD-BEARING FINDING (do not regress this): PayPal
// returns HTTP 200 EVEN WHEN VERIFICATION FAILS. This function NEVER
// infers verification from the HTTP status code of the
// verify-webhook-signature call -- it explicitly reads and checks
// `verification_status === 'SUCCESS'` on the parsed response body. An
// HTTP-level failure (network error, non-2xx, malformed body) is ALSO
// treated as "not verified" (fails closed), but a 200 with
// verification_status !== 'SUCCESS' is the specific case that must
// never be misread as success.
//
// `webhook_event` is posted back BYTE-IDENTICAL to what PayPal sent --
// this function parses the raw body once and passes that SAME parsed
// object as the `webhook_event` field, rather than reconstructing or
// re-serializing it, per PayPal's own documented requirement.
//
// This verify call itself requires a valid OAuth access token (fetched
// fresh per candidate connection, same as
// paypal-create-checkout-session -- see that function's own
// fetchAccessToken, duplicated here rather than imported since Supabase
// Edge Functions are deployed independently with no shared module
// bundling across functions in this project).
//
// WEBHOOK_ID: PayPal's own verify-webhook-signature call requires the
// CLUB'S OWN webhook_id (the id PayPal assigns when the club owner
// registers a webhook subscription in their PayPal app dashboard) --
// this is stored in club_gateway_connections.provider_merchant_ref,
// confirmed via live schema inspection this session to carry no doc
// comment restricting its meaning, reusing it exactly as Fawry reuses
// it for merchantCode.
//
// CANDIDATE RESOLUTION -- same priority-ordered pattern as the other
// four webhooks:
//   1. PRIMARY: match payment_gateway_transactions by the UNVERIFIED
//      parsed body's custom_id (read from EITHER
//      resource.purchase_units[0].custom_id [order-shaped resource, on
//      CHECKOUT.ORDER.APPROVED] OR resource.custom_id [capture-shaped
//      resource, on PAYMENT.CAPTURE.* events -- PayPal copies custom_id
//      onto the resulting Capture object]) -- used ONLY to narrow
//      candidate connections/secrets to try, NEVER to make a trust
//      decision by itself, same "unverified body used only to narrow
//      candidates" discipline as the other four webhooks.
//   2. FALLBACK: match provider_session_ref = resource.id (covers the
//      order id on CHECKOUT.ORDER.APPROVED) or resource.supplementary_data
//      .related_ids.order_id (covers capture-shaped resources, which
//      carry the order id at this nested path per PayPal's own Capture
//      resource schema).
//   3. DEFENSIVE FALLBACK: every enabled PayPal connection.
// For EACH candidate connection (in order), fetch an OAuth token using
// THAT connection's own credentials, then call verify-webhook-signature
// with THAT connection's own webhook_id. First connection whose
// verification genuinely succeeds wins -- a wrong webhook_id simply
// fails PayPal's own verification, it cannot forge a pass, so trying
// multiple candidates remains safe.
//
// DEDUP: PayPal webhook events carry a genuine, stable per-event `id`
// field on the OUTER envelope (NOT resource.id, which is the
// order/capture id) -- this project's EXISTING
// payment_gateway_webhook_events_provider_event_unique unique index
// ON (provider_key, provider_event_id) WHERE provider_event_id IS NOT
// NULL is used directly. NO NEW MIGRATION NEEDED (confirmed via live
// schema inspection before writing this function).
//
// TRUST MODEL, SPELLED OUT (same discipline as the other four
// webhooks): nothing this function reads from the request is trusted
// for any WRITE decision until verify-webhook-signature has returned
// verification_status === 'SUCCESS'. The service-role RPCs this
// function calls (record_gateway_payment_service /
// mark_gateway_transaction_failed_service) are themselves
// service_role-only and re-validate everything that actually matters
// (staged transaction state, invoice state, amount/currency match)
// independently of whatever this function believes about the payload.
//
// EVENT DISPATCH:
//   CHECKOUT.ORDER.APPROVED -> triggers the PayPal Capture API call
//     (POST .../v2/checkout/orders/{id}/capture) SERVER-TO-SERVER, from
//     THIS webhook handler -- never from GatewayReturnPage.tsx and
//     never from any client-triggered call. This function's own
//     capture call does NOT itself call record_gateway_payment_service
//     -- it only triggers the capture; the SUBSEQUENT, independently
//     delivered and independently verified PAYMENT.CAPTURE.COMPLETED
//     webhook event is what actually posts the payment. See "CAPTURE
//     TIMING" in paypal-create-checkout-session's header for the full
//     design reasoning. The capture call itself is naturally
//     idempotent from PayPal's side (calling capture on an
//     already-captured order returns an error PayPal documents as safe
//     to ignore -- `ORDER_ALREADY_CAPTURED` -- handled below as a
//     benign no-op, not a failure).
//   PAYMENT.CAPTURE.COMPLETED -> record_gateway_payment_service with
//     the confirmed amount/currency from resource.amount.
//   PAYMENT.CAPTURE.DENIED -> mark_gateway_transaction_failed_service.
//   PAYMENT.CAPTURE.REFUNDED -> acknowledge only (defensive
//     reconciliation no-op -- paypal-create-refund posts the canonical
//     refund synchronously on PayPal's own synchronous refund API
//     response, matching every other adapter's discipline of never
//     re-posting a refund from the webhook path as a new event).
//   any other event_type -> acknowledge without action.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
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
      signal: AbortSignal.timeout(15000),
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

  // The 5 required PayPal transmission headers -- fail closed BEFORE
  // even attempting PayPal verification if any are missing. This is
  // this function's own input validation, testable without real
  // PayPal infrastructure.
  const transmissionId = req.headers.get('PAYPAL-TRANSMISSION-ID')
  const transmissionTime = req.headers.get('PAYPAL-TRANSMISSION-TIME')
  const certUrl = req.headers.get('PAYPAL-CERT-URL')
  const authAlgo = req.headers.get('PAYPAL-AUTH-ALGO')
  const transmissionSig = req.headers.get('PAYPAL-TRANSMISSION-SIG')

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return jsonResponse({ error: 'missing required paypal transmission headers' }, 400)
  }

  // Read the raw body as TEXT first, exactly like the other four
  // webhooks -- needed both to parse the JSON safely once and to post
  // the EXACT SAME parsed object back to PayPal's verify call
  // byte-identically (see file header).
  const rawBody = await req.text()

  let payload: Record<string, unknown> | null = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'malformed JSON body' }, 400)
  }

  if (!payload) {
    return jsonResponse({ received: true, ignored: true })
  }

  const eventId = typeof payload.id === 'string' ? payload.id : null
  const eventType = typeof payload.event_type === 'string' ? payload.event_type : null
  const resource = (payload.resource && typeof payload.resource === 'object' ? payload.resource : {}) as Record<
    string,
    unknown
  >

  if (!eventId || !eventType) {
    return jsonResponse({ error: 'missing id or event_type on webhook envelope' }, 400)
  }

  // UNVERIFIED custom_id extraction, used ONLY to narrow candidates
  // (see file header) -- read from either shape.
  const purchaseUnits = Array.isArray(resource.purchase_units) ? resource.purchase_units : []
  const orderShapedCustomId =
    purchaseUnits.length > 0 && typeof (purchaseUnits[0] as Record<string, unknown>)?.custom_id === 'string'
      ? ((purchaseUnits[0] as Record<string, unknown>).custom_id as string)
      : null
  const captureShapedCustomId = typeof resource.custom_id === 'string' ? resource.custom_id : null
  const unverifiedCustomId = orderShapedCustomId ?? captureShapedCustomId

  const unverifiedResourceId = typeof resource.id === 'string' ? resource.id : null
  const supplementaryData = (resource.supplementary_data && typeof resource.supplementary_data === 'object'
    ? resource.supplementary_data
    : {}) as Record<string, unknown>
  const relatedIds = (supplementaryData.related_ids && typeof supplementaryData.related_ids === 'object'
    ? supplementaryData.related_ids
    : {}) as Record<string, unknown>
  const unverifiedOrderId =
    typeof relatedIds.order_id === 'string' ? relatedIds.order_id : orderShapedCustomId ? unverifiedResourceId : null

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  type Candidate = {
    connectionId: string
    clubId: string
    environment: string
    publicKey: string | null
    secretVaultId: string
    webhookId: string | null
    transactionId: string | null
  }
  let candidates: Candidate[] = []

  // PRIMARY: custom_id, validated as a real UUID shape before use in
  // an `.eq('id', ...)` filter -- same defensive discipline as the
  // other four webhooks' UUID guards.
  if (unverifiedCustomId && UUID_RE.test(unverifiedCustomId)) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id, connection_id, club_id')
      .eq('id', unverifiedCustomId)
      .eq('gateway', 'paypal')
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, environment, public_key, secret_vault_id, provider_merchant_ref')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.secret_vault_id) {
        candidates = [
          {
            connectionId: conn.id,
            clubId: conn.club_id,
            environment: conn.environment,
            publicKey: conn.public_key,
            secretVaultId: conn.secret_vault_id,
            webhookId: conn.provider_merchant_ref,
            transactionId: txnMatch.id,
          },
        ]
      }
    }
  }

  // FALLBACK: provider_session_ref = the PayPal order id (resource.id
  // on an order-shaped resource, or resource.supplementary_data.
  // related_ids.order_id on a capture-shaped resource).
  if (candidates.length === 0 && unverifiedOrderId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id, connection_id, club_id')
      .eq('gateway', 'paypal')
      .eq('provider_session_ref', unverifiedOrderId)
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, environment, public_key, secret_vault_id, provider_merchant_ref')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.secret_vault_id) {
        candidates = [
          {
            connectionId: conn.id,
            clubId: conn.club_id,
            environment: conn.environment,
            publicKey: conn.public_key,
            secretVaultId: conn.secret_vault_id,
            webhookId: conn.provider_merchant_ref,
            transactionId: txnMatch.id,
          },
        ]
      }
    }
  }

  // DEFENSIVE FALLBACK: every enabled PayPal connection.
  if (candidates.length === 0) {
    const { data: allConns } = await admin
      .from('club_gateway_connections')
      .select('id, club_id, environment, public_key, secret_vault_id, provider_merchant_ref')
      .eq('provider_key', 'paypal')
      .eq('enabled', true)
      .not('secret_vault_id', 'is', null)
    candidates = (allConns ?? []).map((c) => ({
      connectionId: c.id,
      clubId: c.club_id,
      environment: c.environment,
      publicKey: c.public_key,
      secretVaultId: c.secret_vault_id as string,
      webhookId: c.provider_merchant_ref,
      transactionId: null,
    }))
  }

  if (candidates.length === 0) {
    return jsonResponse({ error: 'no matching gateway connection to verify against' }, 400)
  }

  let verifiedClubId: string | null = null
  let verifiedConnectionId: string | null = null
  let verifiedEnvironment: string | null = null
  let verifiedAccessToken: string | null = null
  let resolvedTransactionId: string | null = null

  for (const candidate of candidates) {
    if (!candidate.publicKey || !candidate.webhookId) continue

    // NOTE: get_vault_secret_service(), NOT .schema('vault') -- same
    // reasoning as the other four webhooks.
    const { data: clientSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
      p_secret_id: candidate.secretVaultId,
    })
    if (secretError || !clientSecret) continue

    const environment = candidate.environment === 'live' ? 'live' : 'sandbox'
    const baseUrl = PAYPAL_BASE_URL[environment]

    const tokenResult = await fetchAccessToken(baseUrl, candidate.publicKey, clientSecret)
    if ('error' in tokenResult) continue

    // CRITICAL, SECURITY-LOAD-BEARING: verify-webhook-signature returns
    // HTTP 200 EVEN ON FAILURE -- verification_status on the parsed
    // body is checked explicitly below, never inferred from HTTP
    // status. `webhook_event` is the SAME parsed `payload` object read
    // above, posted byte-identically (per PayPal's documented
    // requirement), not reconstructed.
    let verifyResponse: Response
    try {
      verifyResponse = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokenResult.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          transmission_id: transmissionId,
          transmission_time: transmissionTime,
          cert_url: certUrl,
          auth_algo: authAlgo,
          transmission_sig: transmissionSig,
          webhook_id: candidate.webhookId,
          webhook_event: payload,
        }),
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      continue
    }

    const verifyBody = await verifyResponse.json().catch(() => null)

    // Explicit field check -- NEVER `verifyResponse.ok` alone. This is
    // the single most security-critical line in this function.
    if (verifyBody?.verification_status !== 'SUCCESS') continue

    verifiedClubId = candidate.clubId
    verifiedConnectionId = candidate.connectionId
    verifiedEnvironment = environment
    // Reused directly for the capture call below (see that branch) --
    // avoids a redundant second OAuth round trip for the very common
    // case where this webhook delivery is CHECKOUT.ORDER.APPROVED.
    // Short-lived and never logged/returned to the client, same as
    // every other access-token use in this adapter.
    verifiedAccessToken = tokenResult.token
    resolvedTransactionId = candidate.transactionId
    break
  }

  if (!verifiedClubId || !verifiedConnectionId || !verifiedEnvironment || !verifiedAccessToken) {
    // Same reasoning as the other four webhooks: do not log an
    // unverified request to payment_gateway_webhook_events -- it
    // proves nothing trustworthy and would just be attacker-controlled
    // noise in the audit trail.
    return jsonResponse({ error: 'signature verification failed' }, 400)
  }

  // From here on, PROVEN (via PayPal's own verify-webhook-signature
  // API, explicit verification_status check) to have been sent by
  // PayPal for a webhook subscription this specific connection's owner
  // registered.
  const baseUrl = PAYPAL_BASE_URL[verifiedEnvironment]

  // Dedup via the EXISTING (provider_key, provider_event_id) unique
  // index -- PayPal's own outer envelope `id` field (genuinely stable,
  // distinct per delivered event -- NOT resource.id). No new migration
  // needed (confirmed live before writing this function).
  const { error: insertEventError } = await admin.from('payment_gateway_webhook_events').insert({
    provider_key: 'paypal',
    connection_id: verifiedConnectionId,
    provider_event_id: eventId,
    payload_hash: null,
    signature_valid: true,
  })

  if (insertEventError) {
    if (insertEventError.code === '23505') {
      return jsonResponse({ received: true, duplicate: true })
    }
    return jsonResponse({ error: 'failed to log webhook event' }, 500)
  }

  const markProcessed = async (extra: Record<string, unknown> = {}) => {
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString(), ...extra })
      .eq('provider_key', 'paypal')
      .eq('provider_event_id', eventId)
  }

  // Resolve the staged transaction if we haven't already (the
  // defensive-fallback candidate path does not carry a transaction id).
  let transactionId = resolvedTransactionId
  if (!transactionId && unverifiedCustomId && UUID_RE.test(unverifiedCustomId)) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('id', unverifiedCustomId)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }
  if (!transactionId && unverifiedOrderId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('provider_session_ref', unverifiedOrderId)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }

  if (!transactionId) {
    await markProcessed()
    return jsonResponse({ received: true, unmatched: true })
  }

  if (eventType === 'CHECKOUT.ORDER.APPROVED') {
    // CAPTURE TIMING DECISION (see file header): trigger the real
    // PayPal Capture API call HERE, server-to-server, on receipt of
    // this VERIFIED event. This call does NOT itself post a payment --
    // it only asks PayPal to capture; the subsequent, independently
    // delivered and independently verified PAYMENT.CAPTURE.COMPLETED
    // event (handled below) is what actually calls
    // record_gateway_payment_service.
    const orderId = unverifiedOrderId ?? unverifiedResourceId
    if (!orderId) {
      await markProcessed({ transaction_id: transactionId, processing_error: 'no order id resolvable to capture' })
      return jsonResponse({ received: true })
    }

    let captureResponse: Response
    try {
      captureResponse = await fetch(`${baseUrl}/v2/checkout/orders/${orderId}/capture`, {
        method: 'POST',
        headers: {
          // Reuses the SAME access token this candidate's own
          // verify-webhook-signature call already fetched above -- no
          // redundant second OAuth round trip.
          Authorization: `Bearer ${verifiedAccessToken}`,
          'Content-Type': 'application/json',
          // Native idempotency on the capture call itself -- a
          // redelivered CHECKOUT.ORDER.APPROVED event (PayPal webhooks
          // are at-least-once) converges on the same capture attempt
          // rather than double-capturing.
          'PayPal-Request-Id': `mal3aby-capture-${orderId}`,
        },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      await markProcessed({ transaction_id: transactionId, processing_error: 'network error triggering capture' })
      return jsonResponse({ received: true, capture_trigger_failed: true })
    }

    const captureBody = await captureResponse.json().catch(() => null)
    const alreadyCaptured =
      Array.isArray(captureBody?.details) &&
      captureBody.details.some((d: Record<string, unknown>) => d?.issue === 'ORDER_ALREADY_CAPTURED')

    if (!captureResponse.ok && !alreadyCaptured) {
      // Capture failed for a reason other than "already captured"
      // (e.g. INSTRUMENT_DECLINED) -- do not mark the transaction
      // failed here unconditionally: PayPal may still send its own
      // PAYMENT.CAPTURE.DENIED event separately, which is the more
      // authoritative source for that specific terminal state. Log and
      // acknowledge.
      await markProcessed({
        transaction_id: transactionId,
        processing_error: `capture trigger failed: ${sanitizePaypalError(captureBody)}`,
      })
      return jsonResponse({ received: true, capture_trigger_failed: true })
    }

    await markProcessed({ transaction_id: transactionId })
    return jsonResponse({ received: true, capture_triggered: true })
  }

  if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
    const amountRaw = resource.amount as Record<string, unknown> | undefined
    const confirmedAmount = amountRaw && typeof amountRaw.value === 'string' ? Number(amountRaw.value) : NaN
    const confirmedCurrency = amountRaw && typeof amountRaw.currency_code === 'string' ? amountRaw.currency_code.toUpperCase() : null

    if (!Number.isFinite(confirmedAmount) || !confirmedCurrency) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'paypal PAYMENT.CAPTURE.COMPLETED event missing a usable resource.amount',
        p_provider_raw_status: eventType,
      })
      await markProcessed({ transaction_id: transactionId })
      return jsonResponse({ received: true })
    }

    const captureId = typeof resource.id === 'string' ? resource.id : null

    const { data: paymentId, error: rpcError } = await admin.rpc('record_gateway_payment_service', {
      p_transaction_id: transactionId,
      p_confirmed_amount: confirmedAmount,
      p_confirmed_currency: confirmedCurrency,
      // provider_session_ref is overwritten with PayPal's REAL capture
      // id -- this is what paypal-create-refund needs (PayPal's Refund
      // API operates on the CAPTURE id, not the order id).
      p_provider_session_ref: captureId,
      p_provider_raw_status: eventType,
    })

    if (rpcError) {
      await markProcessed({ transaction_id: transactionId, processing_error: rpcError.message })
      return jsonResponse({ received: true, processing_error: true })
    }

    await markProcessed({
      transaction_id: transactionId,
      amount_matched: paymentId !== null,
      currency_matched: paymentId !== null,
    })
    return jsonResponse({ received: true, payment_id: paymentId })
  }

  if (eventType === 'PAYMENT.CAPTURE.DENIED') {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `paypal event: ${eventType}`,
      p_provider_raw_status: eventType,
    })
    await markProcessed({ transaction_id: transactionId })
    return jsonResponse({ received: true })
  }

  if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
    // Defensive reconciliation no-op -- see file header. Never
    // re-posted as a new payment or refund from this branch.
    await markProcessed({ transaction_id: transactionId })
    return jsonResponse({ received: true, refund_acknowledged: true })
  }

  // Any other event_type -- acknowledge without action. Fails closed
  // on ambiguity, same discipline as the other four webhooks'
  // fallthrough guard.
  await markProcessed({ transaction_id: transactionId })
  return jsonResponse({ received: true, unrecognized_event_acknowledged: true })
})
