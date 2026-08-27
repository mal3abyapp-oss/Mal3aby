// fawry-gateway-webhook -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS:
// Fawry Server-to-Server Notification V2 receiver (2026-08-27).
//
// Deployed with verify_jwt=false -- Fawry calls this endpoint directly
// with no Supabase session/JWT at all. Fawry authenticates ITSELF to
// us via SHA-256 over a FIXED, DOCUMENTED ordered concatenation of
// specific notification field VALUES, compared against the
// `messageSignature` field ON THE NOTIFICATION BODY ITSELF (no
// dedicated header, no query param -- confirmed, matches the task
// brief's own existing matrix entry). This mirrors
// stripe-gateway-webhook's / paymob-gateway-webhook's /
// kashier-gateway-webhook's own self-authenticating, session-less
// structure and trust model.
//
// SIGNATURE SCHEME -- OFFICIAL DOC VERIFIED 2026-08-27 (Fawry's own
// "Get Payment Status V2" doc page) AND CODE VERIFIED against the
// real, open-source `fawry-api/fawry` Ruby gem's
// lib/fawry/fawry_callback.rb (fetched verbatim from GitHub raw
// content -- genuine third-party production code, independent
// cross-confirmation of the same field list). See
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Fawry update" section for the
// full source URLs and the verbatim gem source this was reconstructed
// from:
//
//   Digest::SHA256.hexdigest(
//     fawryRefNumber + merchantRefNum + format('%.2f', paymentAmount) +
//     format('%.2f', orderAmount) + orderStatus + paymentMethod +
//     paymentRefrenceNumber + secureKey
//   )
//
// CRITICAL: this is a GENUINELY DIFFERENT field set/order from the
// OUTBOUND charge-request signature computed in
// fawry-create-checkout-session (merchantCode + merchantRefNum +
// customerProfileId + returnUrl + chargeItems... + secureKey) --
// confirmed precisely, not assumed to match, exactly as the task brief
// asked. `paymentRefrenceNumber` (Fawry's own field, note the
// non-standard spelling -- "Refrence", not "Reference" -- preserved
// exactly as documented) is used as an EMPTY STRING when absent (e.g.
// on an order-creation notification with no payment reference yet),
// per the doc's own "(if exist... this element will be empty)" note.
//
// FIELD-NAME INCONSISTENCY, DISCLOSED: different Fawry doc
// pages/examples spell the merchant reference field inconsistently
// (`merchantRefNum` in the signature formula's own prose,
// `merchantRefNumber` in one fetched JSON example, `merchantRefNum` in
// another). This function reads BOTH spellings defensively when
// resolving the merchant reference for transaction lookup, but the
// SIGNATURE computation itself uses `merchantRefNum` specifically
// (matching the verbatim Ruby gem source, which is unambiguous code,
// not doc prose) -- if Fawry's real payload uses the OTHER spelling
// for the field that feeds the signature, verification would fail
// closed (a request that cannot be verified is rejected, never
// silently accepted) rather than silently accepting a wrongly-keyed
// signature.
//
// TRUST MODEL, SPELLED OUT (same discipline as the other three
// webhooks): nothing this function reads from the request is trusted
// for any WRITE decision until the signature has been verified. The
// two service-role RPCs this function calls
// (record_gateway_payment_service / mark_gateway_transaction_failed_service)
// are themselves service_role-only and re-validate everything that
// actually matters (staged transaction state, invoice state,
// amount/currency match) independently of whatever this function
// believes about the payload.
//
// WEBHOOK LOOKUP STRATEGY:
//   1. PRIMARY: merchantRefNum/merchantRefNumber -- this is Fawry's
//      own echo of Mal3aby's `merchantRefNum` request field, which
//      fawry-create-checkout-session sets to the Mal3aby transaction
//      id itself. A DIRECT match against payment_gateway_transactions.id
//      -- no round-trip resolution needed, mirroring
//      Paymob's merchant_order_id / Kashier's merchantOrderId /
//      Stripe's client_reference_id pattern.
//   2. FALLBACK: provider_session_ref = fawryRefNumber (Fawry's own
//      transaction reference) -- covers a later/duplicate delivery
//      once provider_session_ref has already been overwritten with
//      the real fawryRefNumber by a PRIOR successful notification.
//   3. DEFENSIVE FALLBACK: every enabled Fawry connection, trying each
//      one's secure key in turn until one verifies -- a wrong key
//      simply fails to produce a matching signature, it cannot forge
//      one, so this remains safe.
//
// DEDUP: Fawry's `fawryRefNumber` is STABLE across multiple
// notifications for the SAME order as its status changes (e.g. a PAID
// notification and a later REFUNDED notification for the same order
// carry the SAME fawryRefNumber) -- it is NOT a genuine per-event id
// the way Stripe's event.id or Kashier's transactionId are. Dedup is
// therefore content-hash-based, exactly like Paymob:
// payment_gateway_webhook_events(provider_key, payload_hash) via the
// EXISTING `payment_gateway_webhook_events_provider_payload_unique`
// index (UNIQUE (provider_key, payload_hash) WHERE provider_event_id
// IS NULL, added for Paymob in
// 20260827161918_paymob_webhook_events_payload_hash_dedup.sql) -- NO
// NEW MIGRATION NEEDED, confirmed by direct schema inspection before
// writing this function.
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

// Constant-time hex-string comparison -- same timing-side-channel
// defense as stripe-gateway-webhook / paymob-gateway-webhook /
// kashier-gateway-webhook's own constantTimeHexEqual.
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function twoDp(n: number): string {
  return n.toFixed(2)
}

// Builds the exact signature input string per Fawry's documented
// Notification V2 scheme + the independently cross-checked Ruby gem
// source (see file header). Amount fields are formatted to 2 decimal
// places exactly like the gem's own `format('%.2f', ...)` calls.
function buildSignatureInput(payload: Record<string, unknown>, merchantRefNum: string): string {
  const fawryRefNumber = String(payload.fawryRefNumber ?? '')
  const paymentAmount = Number(payload.paymentAmount ?? 0)
  const orderAmount = Number(payload.orderAmount ?? 0)
  const orderStatus = String(payload.orderStatus ?? '')
  const paymentMethod = String(payload.paymentMethod ?? '')
  // Note the non-standard Fawry spelling, preserved exactly as
  // documented ("paymentRefrenceNumber", not "paymentReferenceNumber").
  const paymentRefrenceNumber =
    payload.paymentRefrenceNumber != null ? String(payload.paymentRefrenceNumber) : ''

  return (
    fawryRefNumber +
    merchantRefNum +
    twoDp(paymentAmount) +
    twoDp(orderAmount) +
    orderStatus +
    paymentMethod +
    paymentRefrenceNumber
  )
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  // Read the raw body as TEXT first, exactly like the other three
  // webhooks -- needed both for a durable payload_hash dedup key and
  // to parse the JSON safely once. The signature itself is computed
  // over VALUES EXTRACTED FROM THE PARSED payload (per Fawry's own
  // documented scheme, matching Paymob's/Kashier's own
  // extracted-field approach), not the raw body bytes.
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

  const claimedSignature = typeof payload.messageSignature === 'string' ? payload.messageSignature : null
  if (!claimedSignature) {
    return jsonResponse({ error: 'missing messageSignature field on notification body' }, 400)
  }

  // FIELD-NAME INCONSISTENCY (see file header): read both spellings
  // defensively for LOOKUP purposes; the SIGNATURE computation itself
  // always uses merchantRefNum specifically (matching the verbatim
  // Ruby gem source).
  const rawMerchantRefRaw =
    typeof payload.merchantRefNum === 'string'
      ? payload.merchantRefNum
      : typeof payload.merchantRefNumber === 'string'
        ? payload.merchantRefNumber
        : null

  const fawryRefNumberRaw = payload.fawryRefNumber != null ? String(payload.fawryRefNumber) : null

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Candidate resolution, in priority order (see file header).
  //
  // merchantRefNum must be validated as a real UUID shape BEFORE using
  // it in an `.eq('id', ...)` filter against a `uuid` column -- same
  // defensive discipline as paymob-gateway-webhook's own UUID_RE guard
  // / kashier-gateway-webhook's own merchantOrderId guard (a malformed
  // UUID literal raises a hard Postgres type-cast error via PostgREST
  // rather than gracefully returning zero rows).
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const merchantRefNum = rawMerchantRefRaw && UUID_RE.test(rawMerchantRefRaw) ? rawMerchantRefRaw : null

  if (!merchantRefNum) {
    // The signature cannot even be meaningfully computed without a
    // real merchantRefNum to feed into it (it is part of the signed
    // string) -- fail closed with a clear, honest error rather than
    // attempting a signature check against a garbled/absent value.
    return jsonResponse({ error: 'missing or malformed merchantRefNum on notification body' }, 400)
  }

  type Candidate = { connectionId: string; clubId: string; secretVaultId: string; transactionId: string | null }
  let candidates: Candidate[] = []

  {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id, connection_id, club_id')
      .eq('id', merchantRefNum)
      .eq('gateway', 'fawry')
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, secret_vault_id')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.secret_vault_id) {
        candidates = [{ connectionId: conn.id, clubId: conn.club_id, secretVaultId: conn.secret_vault_id, transactionId: txnMatch.id }]
      }
    }
  }

  if (candidates.length === 0 && fawryRefNumberRaw) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id, connection_id, club_id')
      .eq('gateway', 'fawry')
      .eq('provider_session_ref', fawryRefNumberRaw)
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, secret_vault_id')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.secret_vault_id) {
        candidates = [{ connectionId: conn.id, clubId: conn.club_id, secretVaultId: conn.secret_vault_id, transactionId: txnMatch.id }]
      }
    }
  }

  if (candidates.length === 0) {
    const { data: allConns } = await admin
      .from('club_gateway_connections')
      .select('id, club_id, secret_vault_id')
      .eq('provider_key', 'fawry')
      .eq('enabled', true)
      .not('secret_vault_id', 'is', null)
    candidates = (allConns ?? []).map((c) => ({
      connectionId: c.id,
      clubId: c.club_id,
      secretVaultId: c.secret_vault_id as string,
      transactionId: null,
    }))
  }

  if (candidates.length === 0) {
    return jsonResponse({ error: 'no matching gateway connection to verify against' }, 400)
  }

  const signatureInputBase = buildSignatureInput(payload, merchantRefNum)

  let verifiedClubId: string | null = null
  let verifiedConnectionId: string | null = null
  let resolvedTransactionId: string | null = null

  for (const candidate of candidates) {
    // NOTE: get_vault_secret_service(), NOT .schema('vault') -- same
    // reasoning as the other three webhooks (PostgREST does not
    // expose the vault schema on this project).
    const { data: secureKey, error: secretError } = await admin.rpc('get_vault_secret_service', {
      p_secret_id: candidate.secretVaultId,
    })

    if (secretError || !secureKey) continue

    const expectedSignature = await sha256Hex(`${signatureInputBase}${secureKey}`)

    if (constantTimeHexEqual(expectedSignature, claimedSignature)) {
      verifiedClubId = candidate.clubId
      verifiedConnectionId = candidate.connectionId
      resolvedTransactionId = candidate.transactionId
      break
    }
  }

  if (!verifiedClubId || !verifiedConnectionId) {
    // Same reasoning as the other three webhooks: do not log an
    // unverified request to payment_gateway_webhook_events -- it
    // proves nothing trustworthy and would just be attacker-controlled
    // noise in the audit trail.
    return jsonResponse({ error: 'signature verification failed' }, 400)
  }

  // From here on, PROVEN to have been sent by Fawry (or by someone
  // holding this specific connection's secure key).
  const payloadHash = await sha256Hex(rawBody)

  // Dedup via payment_gateway_webhook_events' EXISTING
  // (provider_key, payload_hash) WHERE provider_event_id IS NULL
  // unique index -- Fawry has no genuine per-event id (fawryRefNumber
  // is stable across multiple status-change notifications for the
  // same order), same shape as Paymob. No new migration needed.
  const { error: insertEventError } = await admin.from('payment_gateway_webhook_events').insert({
    provider_key: 'fawry',
    connection_id: verifiedConnectionId,
    provider_event_id: null,
    payload_hash: payloadHash,
    signature_valid: true,
  })

  if (insertEventError) {
    if (insertEventError.code === '23505') {
      return jsonResponse({ received: true, duplicate: true })
    }
    return jsonResponse({ error: 'failed to log webhook event' }, 500)
  }

  // Resolve the staged transaction if we haven't already (the
  // defensive-fallback candidate path does not carry a transaction id).
  let transactionId = resolvedTransactionId
  if (!transactionId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('id', merchantRefNum)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }
  if (!transactionId && fawryRefNumberRaw) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('provider_session_ref', fawryRefNumberRaw)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }

  if (!transactionId) {
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, processed_at: new Date().toISOString() })
      .eq('provider_key', 'fawry')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, unmatched: true })
  }

  const orderStatus = typeof payload.orderStatus === 'string' ? payload.orderStatus.toUpperCase() : ''

  // orderStatus values per Fawry's own documented Notification V2
  // payload: NEW|PAID|CANCELED|REFUNDED|EXPIRED|PARTIAL_REFUNDED|FAILED.
  const isPaymentSuccessEvent = orderStatus === 'PAID'
  const isPaymentPendingEvent = orderStatus === 'NEW'
  const isPaymentFailureEvent = orderStatus === 'CANCELED' || orderStatus === 'EXPIRED' || orderStatus === 'FAILED'
  const isRefundEvent = orderStatus === 'REFUNDED' || orderStatus === 'PARTIAL_REFUNDED'

  if (isRefundEvent) {
    // Fawry sends refund confirmation via the SAME Notification V2
    // shape, distinguished by orderStatus -- NOT a "payment succeeded"
    // event even though it shares the envelope. Mal3aby's own
    // fawry-create-refund (below) already posts the canonical refund
    // SYNCHRONOUSLY on Fawry's own synchronous Refund API response
    // (mirroring the other three adapters' design) -- this branch is
    // a defensive reconciliation no-op today, logged and acknowledged
    // only, exactly like paymob-gateway-webhook's is_refunded guard
    // and kashier-gateway-webhook's non-payment-event guard. Never
    // re-posted as a NEW payment.
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'fawry')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, refund_acknowledged: true })
  }

  if (isPaymentPendingEvent) {
    // Genuinely still in-flight (order created, not yet paid) -- do
    // not mark failed OR succeeded; acknowledge and wait for a later
    // terminal notification. Never posts a payment on a non-terminal
    // status, same discipline as kashier-gateway-webhook's own
    // PENDING/PROCESSING guard.
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'fawry')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, pending: true })
  }

  if (isPaymentSuccessEvent) {
    const paymentAmountRaw = payload.paymentAmount
    const currencyRaw = typeof payload.currency === 'string' ? payload.currency : 'EGP' // Fawry's Notification V2 example payload does not include a currency field -- EGP is the only currency this provider's catalog entry supports, so it is used as the documented, safe default when absent rather than failing closed on a field Fawry may simply never send for this always-EGP provider.

    if (paymentAmountRaw === undefined || paymentAmountRaw === null) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'fawry PAID notification missing paymentAmount field',
        p_provider_raw_status: orderStatus,
      })
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
        .eq('provider_key', 'fawry')
        .eq('payload_hash', payloadHash)
      return jsonResponse({ received: true })
    }

    const confirmedAmount = typeof paymentAmountRaw === 'number' ? paymentAmountRaw : Number(paymentAmountRaw)
    const confirmedCurrency = currencyRaw.toUpperCase()

    if (!Number.isFinite(confirmedAmount)) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'fawry PAID notification had a non-numeric paymentAmount field',
        p_provider_raw_status: orderStatus,
      })
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
        .eq('provider_key', 'fawry')
        .eq('payload_hash', payloadHash)
      return jsonResponse({ received: true })
    }

    // provider_session_ref is overwritten with Fawry's REAL
    // fawryRefNumber -- this is what fawry-create-refund needs
    // (Fawry's refund endpoint's `referenceNumber` field IS the
    // fawryRefNumber, not Mal3aby's own merchantRefNum) -- mirrors
    // Paymob's/Kashier's own "webhook hands off the real provider
    // reference" pattern exactly.
    const { data: paymentId, error: rpcError } = await admin.rpc('record_gateway_payment_service', {
      p_transaction_id: transactionId,
      p_confirmed_amount: confirmedAmount,
      p_confirmed_currency: confirmedCurrency,
      p_provider_session_ref: fawryRefNumberRaw,
      p_provider_raw_status: orderStatus,
    })

    if (rpcError) {
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: false, processing_error: rpcError.message })
        .eq('provider_key', 'fawry')
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
      .eq('provider_key', 'fawry')
      .eq('payload_hash', payloadHash)

    return jsonResponse({ received: true, payment_id: paymentId })
  }

  if (isPaymentFailureEvent) {
    // mark_gateway_transaction_failed_service is idempotent/no-op-safe
    // if the transaction already reached a terminal state.
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `fawry order status: ${orderStatus}`,
      p_provider_raw_status: orderStatus,
    })

    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'fawry')
      .eq('payload_hash', payloadHash)

    return jsonResponse({ received: true })
  }

  // Any other/unrecognized orderStatus -- acknowledge only, never
  // posted as a payment. Fails closed on ambiguity, same discipline as
  // kashier-gateway-webhook's own fallthrough guard.
  await admin
    .from('payment_gateway_webhook_events')
    .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
    .eq('provider_key', 'fawry')
    .eq('payload_hash', payloadHash)

  return jsonResponse({ received: true, unrecognized_status_acknowledged: true })
})
