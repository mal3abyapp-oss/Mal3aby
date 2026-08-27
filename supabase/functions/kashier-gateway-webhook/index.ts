// kashier-gateway-webhook -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS:
// Kashier payment-event webhook receiver (2026-08-27).
//
// Deployed with verify_jwt=false -- Kashier calls this endpoint
// directly with no Supabase session/JWT at all. Kashier authenticates
// ITSELF to us via HMAC-SHA256 over an ALPHABETICALLY-SORTED subset of
// the payload's own `data` object fields (the exact field names listed
// in `data.signatureKeys`), encoded as an RFC 3986 query string
// (`key1=value1&key2=value2...`), keyed by the per-connection Payment
// API Key stored in Supabase Vault at connect_club_gateway() time,
// compared against the `x-kashier-signature` request HEADER. This
// mirrors stripe-gateway-webhook's and paymob-gateway-webhook's own
// self-authenticating, session-less structure and trust model.
//
// HMAC SCHEME -- OFFICIAL DOC VERIFIED 2026-08-27 against Kashier's
// live "Webhook" page (developers.kashier.io/payment/webhook/, a JS
// SPA -- reached via direct fetch this session, unlike some deep links
// on this same portal which 404 on a cold load; see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Kashier update" section for the
// full source URL and the verbatim official code samples this was
// reconstructed from).
//
// CRITICAL: this is NOT the same construction as Paymob's scheme,
// despite both being described loosely as "concatenate sorted
// fields". Kashier's OWN published Node.js sample is:
//
//   data.signatureKeys.sort();
//   const objectSignaturePayload = _.pick(data, data.signatureKeys);
//   const signaturePayload = queryString.stringify(objectSignaturePayload);
//   const signature = crypto.createHmac('sha256', PaymentApiKey)
//     .update(signaturePayload).digest('hex');
//
// i.e.: (1) take ONLY the fields named in data.signatureKeys (a
// server-supplied allowlist, itself part of the payload), (2) sort
// those KEY NAMES alphabetically, (3) build a REAL RFC 3986
// query-string (`key=value&key2=value2...`, URL-encoded, using the
// SORTED key order) -- not a bare value-only concatenation the way
// Paymob's scheme works -- (4) HMAC-SHA256 that string, hex digest,
// keyed by the Payment API Key. The published PHP sample has a
// visible bug (it query-string-encodes the WHOLE `$data` object
// instead of the picked/sorted subset, inconsistent with its own
// preceding `sort($data_obj['signatureKeys'])` line and with the
// correct JS sample) -- this implementation follows the JS sample's
// (self-consistent, doc-verified-correct) logic: pick only the
// signatureKeys fields, sort by key name, RFC3986-encode as a query
// string.
//
// TRUST MODEL: nothing this function reads from the request is
// trusted for any WRITE decision until the HMAC has been verified.
// The two service-role RPCs this function calls
// (record_gateway_payment_service / mark_gateway_transaction_failed_service)
// are themselves service_role-only and re-validate everything that
// actually matters (staged transaction state, invoice state,
// amount/currency match) independently of whatever this function
// believes about the payload.
//
// WEBHOOK LOOKUP STRATEGY:
//   1. PRIMARY: data.merchantOrderId -- this is Kashier's own echo of
//      the `order` field we set to the Mal3aby transaction id itself
//      at session-creation time (kashier-create-checkout-session). A
//      DIRECT match against payment_gateway_transactions.id -- no
//      round-trip resolution needed, mirroring Paymob's
//      merchant_order_id / Stripe's client_reference_id pattern.
//   2. FALLBACK: provider_session_ref = data.kashierOrderId (Kashier's
//      own order id) or the session id persisted at
//      session-creation time.
//   3. DEFENSIVE FALLBACK: every enabled Kashier connection, trying
//      each one's Payment API Key in turn until one verifies -- a
//      wrong key simply fails to produce a matching signature, it
//      cannot forge one, so this remains safe.
//
// KEY USED: webhook_secret_vault_id holds the Kashier PAYMENT API KEY
// for this adapter (a deliberate, documented mapping -- see
// kashier-create-checkout-session's own header comment for the full
// rationale: Kashier has two genuinely distinct keys, and the Payment
// API Key is the one used for BOTH session creation and webhook HMAC,
// so it is stored in the vault slot this webhook function reads).
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

async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const messageBytes = new TextEncoder().encode(message)
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageBytes)
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Constant-time hex-string comparison -- same timing-side-channel
// defense as stripe-gateway-webhook / paymob-gateway-webhook's own
// constantTimeHexEqual.
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// RFC 3986 percent-encoding for a query-string component -- JavaScript's
// built-in encodeURIComponent already RFC-3986-encodes everything
// except `!'()*` (RFC 3986 "unreserved" is actually narrower than what
// encodeURIComponent leaves alone), so those four characters are
// additionally escaped to match Node's `query-string` package /
// PHP's PHP_QUERY_RFC3986 encoding_type exactly (both of which Kashier's
// own published examples use). This matters because an under-encoded
// character would change the exact bytes being HMAC'd, silently
// breaking verification for any payload containing one of these
// characters in a value (e.g. an apostrophe in a name field passed
// through untouched fields is not signed here since only
// signatureKeys fields are picked -- but amount/currency/status
// values are plain enough that this is a defensive-correctness
// measure, not something expected to bite in practice for THIS
// specific field set).
function rfc3986EncodeComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

// Builds the exact HMAC input string: pick only `signatureKeys`
// fields from `data`, sort key NAMES alphabetically, RFC3986
// query-string-encode as key=value pairs joined by `&`.
function buildSignaturePayload(data: Record<string, unknown>, signatureKeys: string[]): string {
  const sortedKeys = [...signatureKeys].sort()
  const parts: string[] = []
  for (const key of sortedKeys) {
    if (!(key in data)) continue // a listed key genuinely absent from data -- skip, matches _.pick's own behavior.
    const rawValue = data[key]
    const stringValue = rawValue === null || rawValue === undefined ? '' : String(rawValue)
    parts.push(`${rfc3986EncodeComponent(key)}=${rfc3986EncodeComponent(stringValue)}`)
  }
  return parts.join('&')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  const claimedSignature = req.headers.get('x-kashier-signature')
  if (!claimedSignature) {
    return jsonResponse({ error: 'missing x-kashier-signature header' }, 400)
  }

  // Read the raw body as TEXT first, exactly like stripe-gateway-webhook
  // and paymob-gateway-webhook -- needed both for a durable
  // payload_hash dedup key and to parse the JSON safely once. The HMAC
  // itself is computed over VALUES EXTRACTED FROM THE PARSED payload
  // (per Kashier's own documented scheme), not the raw body bytes --
  // same genuine per-provider difference already documented in
  // paymob-gateway-webhook's own header comment.
  const rawBody = await req.text()

  let payload: { event?: string; data?: Record<string, unknown> } | null = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'malformed JSON body' }, 400)
  }

  if (!payload || typeof payload.data !== 'object' || payload.data === null) {
    return jsonResponse({ received: true, ignored: true })
  }

  const data = payload.data as Record<string, unknown>
  const signatureKeysRaw = data.signatureKeys
  if (!Array.isArray(signatureKeysRaw) || signatureKeysRaw.length === 0) {
    // Kashier's own scheme REQUIRES signatureKeys to be present on
    // every genuine callback -- a payload missing it cannot be
    // verified at all. Fail closed rather than guessing a field list.
    return jsonResponse({ error: 'missing signatureKeys on payload' }, 400)
  }
  const signatureKeys = signatureKeysRaw.filter((k): k is string => typeof k === 'string')

  const signaturePayload = buildSignaturePayload(data, signatureKeys)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Candidate resolution, in priority order (see file header).
  type Candidate = { connectionId: string; clubId: string; paymentApiKeyVaultId: string; transactionId: string | null }
  let candidates: Candidate[] = []

  // merchantOrderId must be validated as a real UUID shape BEFORE using
  // it in an `.eq('id', ...)` filter against a `uuid` column -- same
  // defensive discipline as paymob-gateway-webhook's own UUID_RE guard
  // (a malformed UUID literal raises a hard Postgres type-cast error
  // via PostgREST rather than gracefully returning zero rows).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const rawMerchantOrderId = typeof data.merchantOrderId === 'string' ? data.merchantOrderId : null
  const merchantOrderId = rawMerchantOrderId && UUID_RE.test(rawMerchantOrderId) ? rawMerchantOrderId : null
  const kashierOrderId = typeof data.kashierOrderId === 'string' ? data.kashierOrderId : null
  const transactionIdRef = typeof data.transactionId === 'string' ? data.transactionId : null

  if (merchantOrderId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id, connection_id, club_id')
      .eq('id', merchantOrderId)
      .eq('gateway', 'kashier')
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, webhook_secret_vault_id')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.webhook_secret_vault_id) {
        candidates = [{ connectionId: conn.id, clubId: conn.club_id, paymentApiKeyVaultId: conn.webhook_secret_vault_id, transactionId: txnMatch.id }]
      }
    }
  }

  if (candidates.length === 0 && (kashierOrderId || transactionIdRef)) {
    // provider_session_ref may hold the session id persisted at
    // session-creation time -- kashierOrderId is a distinct value from
    // the session id, so both are tried, same defensive pattern as
    // paymob-gateway-webhook trying both transaction id and order id.
    const refCandidates = [kashierOrderId, transactionIdRef].filter((v): v is string => !!v)
    for (const ref of refCandidates) {
      const { data: txnMatch } = await admin
        .from('payment_gateway_transactions')
        .select('id, connection_id, club_id')
        .eq('gateway', 'kashier')
        .eq('provider_session_ref', ref)
        .maybeSingle()
      if (txnMatch?.connection_id) {
        const { data: conn } = await admin
          .from('club_gateway_connections')
          .select('id, club_id, webhook_secret_vault_id')
          .eq('id', txnMatch.connection_id)
          .maybeSingle()
        if (conn?.webhook_secret_vault_id) {
          candidates = [{ connectionId: conn.id, clubId: conn.club_id, paymentApiKeyVaultId: conn.webhook_secret_vault_id, transactionId: txnMatch.id }]
          break
        }
      }
    }
  }

  if (candidates.length === 0) {
    const { data: allConns } = await admin
      .from('club_gateway_connections')
      .select('id, club_id, webhook_secret_vault_id')
      .eq('provider_key', 'kashier')
      .eq('enabled', true)
      .not('webhook_secret_vault_id', 'is', null)
    candidates = (allConns ?? []).map((c) => ({
      connectionId: c.id,
      clubId: c.club_id,
      paymentApiKeyVaultId: c.webhook_secret_vault_id as string,
      transactionId: null,
    }))
  }

  if (candidates.length === 0) {
    return jsonResponse({ error: 'no matching gateway connection to verify against' }, 400)
  }

  let verifiedClubId: string | null = null
  let verifiedConnectionId: string | null = null
  let resolvedTransactionId: string | null = null

  for (const candidate of candidates) {
    const { data: decryptedKey, error: keyError } = await admin.rpc('get_vault_secret_service', {
      p_secret_id: candidate.paymentApiKeyVaultId,
    })

    if (keyError || !decryptedKey) continue

    const expectedSignature = await hmacSha256Hex(decryptedKey, signaturePayload)

    if (constantTimeHexEqual(expectedSignature, claimedSignature)) {
      verifiedClubId = candidate.clubId
      verifiedConnectionId = candidate.connectionId
      resolvedTransactionId = candidate.transactionId
      break
    }
  }

  if (!verifiedClubId || !verifiedConnectionId) {
    // Same reasoning as stripe-gateway-webhook / paymob-gateway-webhook:
    // do not log an unverified request to payment_gateway_webhook_events
    // -- it proves nothing trustworthy and would just be
    // attacker-controlled noise in the audit trail.
    return jsonResponse({ error: 'signature verification failed' }, 400)
  }

  // From here on, PROVEN to have been sent by Kashier (or by someone
  // holding this specific connection's Payment API Key).
  const payloadHash = await sha256Hex(rawBody)

  // Dedup via payment_gateway_webhook_events. Kashier's own
  // `transactionId` field (e.g. "TX-249893122") is a genuine
  // per-event identifier documented on every callback -- UNLIKE
  // Paymob, which has no dedicated event id at all. This lets Kashier
  // use the EXISTING (provider_key, provider_event_id) unique index
  // (already present, previously used only by Stripe's event.id) --
  // no new payload-hash-only migration needed, as anticipated by the
  // task brief. A payload lacking transactionId (should not happen on
  // a genuine callback, but defensively handled) falls back to the
  // existing (provider_key, payload_hash) unique index for
  // provider_event_id IS NULL rows.
  const providerEventId = transactionIdRef

  const { error: insertEventError } = await admin.from('payment_gateway_webhook_events').insert({
    provider_key: 'kashier',
    connection_id: verifiedConnectionId,
    provider_event_id: providerEventId,
    payload_hash: payloadHash,
    signature_valid: true,
  })

  if (insertEventError) {
    if (insertEventError.code === '23505') {
      return jsonResponse({ received: true, duplicate: true })
    }
    return jsonResponse({ error: 'failed to log webhook event' }, 500)
  }

  // Resolve the staged transaction if we haven't already.
  let transactionId = resolvedTransactionId
  if (!transactionId && merchantOrderId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('id', merchantOrderId)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }
  if (!transactionId && (kashierOrderId || transactionIdRef)) {
    const refCandidates = [kashierOrderId, transactionIdRef].filter((v): v is string => !!v)
    for (const ref of refCandidates) {
      const { data: txnMatch } = await admin
        .from('payment_gateway_transactions')
        .select('id')
        .eq('provider_session_ref', ref)
        .eq('connection_id', verifiedConnectionId)
        .maybeSingle()
      if (txnMatch?.id) {
        transactionId = txnMatch.id
        break
      }
    }
  }

  if (!transactionId) {
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('provider_key', 'kashier')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, unmatched: true })
  }

  const status = typeof data.status === 'string' ? data.status.toUpperCase() : ''

  // REFUND EVENTS: Kashier's documented `event` field on the webhook
  // envelope distinguishes callback types (e.g. "pay" for a payment
  // event). A refund performed via kashier-create-refund is posted
  // SYNCHRONOUSLY from that endpoint's own response (mirroring
  // Stripe's and Paymob's synchronous-first design) -- this webhook
  // acknowledges any refund-shaped event defensively without ever
  // re-posting it as a new payment, guarding on both the envelope
  // `event` field and a REFUNDED-shaped status, since Kashier's exact
  // refund-webhook event-name value was not independently confirmed
  // this session (not exercised in the fetched docs' visible webhook
  // section, which showed only the "pay" event example) -- fail
  // CLOSED on ambiguity by treating anything not begins with
  // SUCCESS/FAILED/PENDING as a non-payment event to acknowledge only.
  const isPaymentSuccessEvent = status === 'SUCCESS'
  const isPaymentPendingEvent = status === 'PENDING' || status === 'PROCESSING'
  const isPaymentFailureEvent = status === 'FAILED' || status === 'DECLINED' || status === 'CANCELLED' || status === 'EXPIRED'

  if (!isPaymentSuccessEvent && !isPaymentPendingEvent && !isPaymentFailureEvent) {
    // Includes refund/void/unknown-status events -- acknowledge only,
    // never posted as a payment. A genuine Kashier refund-confirmation
    // webhook (event name not independently confirmed this session --
    // CREDENTIAL-BLOCKED, no real Kashier account exists) would land
    // here and be a safe no-op, exactly like paymob-gateway-webhook's
    // own is_refunded/is_voided guard.
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'kashier')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, non_payment_event_acknowledged: true })
  }

  if (isPaymentPendingEvent) {
    // Genuinely still in-flight (e.g. an async payment method) -- do
    // not mark failed OR succeeded; acknowledge and wait for a later
    // terminal callback. Never posts a payment on a non-terminal status.
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'kashier')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, pending: true })
  }

  if (isPaymentSuccessEvent) {
    const rawAmount = data.amount
    const currencyRaw = typeof data.currency === 'string' ? data.currency : null

    if ((typeof rawAmount !== 'number' && typeof rawAmount !== 'string') || !currencyRaw) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'kashier success callback missing amount/currency fields',
        p_provider_raw_status: status,
      })
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
        .eq('provider_key', 'kashier')
        .eq('payload_hash', payloadHash)
      return jsonResponse({ received: true })
    }

    // Kashier's `amount` on the webhook payload -- OFFICIAL DOC
    // VERIFIED example shows a plain decimal number (e.g. 11334 in one
    // published example represents major units directly per Kashier's
    // own documented request-side convention of "amount": "1.00"
    // strings for major units, NOT minor-unit cents like Paymob's
    // amount_cents). Parsed as a plain decimal, no /100 conversion --
    // this is a genuine per-provider difference from Paymob, confirmed
    // by Kashier's request-side example using "1.00" for a 1 EGP
    // transaction (not "100").
    const confirmedAmount = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount)
    const confirmedCurrency = currencyRaw.toUpperCase()

    if (!Number.isFinite(confirmedAmount)) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'kashier success callback had a non-numeric amount field',
        p_provider_raw_status: status,
      })
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
        .eq('provider_key', 'kashier')
        .eq('payload_hash', payloadHash)
      return jsonResponse({ received: true })
    }

    // provider_session_ref is overwritten with Kashier's real
    // transactionId -- this is what kashier-create-refund needs (the
    // refund endpoint's URL path uses the Kashier ORDER id, but the
    // request also requires the transaction id -- see
    // kashier-create-refund's own comment for exactly how both are used).
    const { data: paymentId, error: rpcError } = await admin.rpc('record_gateway_payment_service', {
      p_transaction_id: transactionId,
      p_confirmed_amount: confirmedAmount,
      p_confirmed_currency: confirmedCurrency,
      p_provider_session_ref: kashierOrderId ?? transactionIdRef,
      p_provider_raw_status: status,
    })

    if (rpcError) {
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: false, processing_error: rpcError.message })
        .eq('provider_key', 'kashier')
        .eq('payload_hash', payloadHash)
      return jsonResponse({ received: true, processing_error: true })
    }

    await admin
      .from('payment_gateway_webhook_events')
      .update({
        processed: true,
        transaction_id: transactionId,
        amount_matched: paymentId !== null,
        currency_matched: paymentId !== null,
        processed_at: new Date().toISOString(),
      })
      .eq('provider_key', 'kashier')
      .eq('payload_hash', payloadHash)

    return jsonResponse({ received: true, payment_id: paymentId })
  }

  // isPaymentFailureEvent -- mark the staged transaction failed so it
  // does not sit in 'pending' forever.
  // mark_gateway_transaction_failed_service is idempotent/no-op-safe
  // if the transaction already reached a terminal state.
  await admin.rpc('mark_gateway_transaction_failed_service', {
    p_transaction_id: transactionId,
    p_reason: `kashier transaction status: ${status}`,
    p_provider_raw_status: status,
  })

  await admin
    .from('payment_gateway_webhook_events')
    .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
    .eq('provider_key', 'kashier')
    .eq('payload_hash', payloadHash)

  return jsonResponse({ received: true })
})
