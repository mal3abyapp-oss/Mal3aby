// paymob-gateway-webhook -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS:
// Paymob transaction-processed callback receiver (2026-08-27).
//
// Deployed with verify_jwt=false -- Paymob calls this endpoint
// directly with no Supabase session/JWT at all. Paymob authenticates
// ITSELF to us via HMAC-SHA512 over a FIXED, DOCUMENTED ordered
// concatenation of specific field VALUES (not a generic "sort the
// body alphabetically" scheme, despite the docs' own "sort
// lexicographically" heading -- the published field list is the real
// order and is not itself alphabetical), keyed by a per-connection
// HMAC secret stored in Supabase Vault at connect_club_gateway() time,
// compared against the `hmac` QUERY PARAMETER on the callback URL
// (Paymob-specific -- unlike Stripe, which sends its signature as a
// request HEADER). This mirrors stripe-gateway-webhook's own
// self-authenticating, session-less structure and trust model.
//
// HMAC SCHEME -- OFFICIAL DOC VERIFIED 2026-08-27 against Paymob's
// live "HMAC Transaction Callback" page (developers.paymob.com,
// reached via in-app search -- the direct deep link 404s/redirects to
// the SPA shell on a cold fetch, confirmed again this session; see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Paymob update" section for the
// full source URL and independent reproduction of Paymob's own worked
// example). The 20 keys, in this EXACT order (concatenate VALUES only,
// no separators, no key names; booleans render as literal
// "true"/"false"):
//   amount_cents, created_at, currency, error_occured,
//   has_parent_transaction, obj.id (POST)/id (GET), integration_id,
//   is_3d_secure, is_auth, is_capture, is_refunded,
//   is_standalone_payment, is_voided, order.id (POST)/order_id (GET),
//   owner, pending, source_data.pan, source_data.sub_type,
//   source_data.type, success
// SHA-512 HMAC of that concatenated string, hex-encoded lowercase,
// compared against the `hmac` query parameter.
//
// CODE VERIFIED cross-check performed this session: reconstructing the
// above concatenation from Paymob's own published transaction object
// example (obj.id=192036465, amount_cents=100000, etc.) reproduces
// Paymob's own documented concatenated string byte-for-byte:
//   "1000002024-06-13T11:33:44.592345EGPfalsefalse192036465..."
// (see the Python reproduction in this session's research -- omitted
// here to keep this file focused on the production implementation.)
//
// TRUST MODEL, SPELLED OUT (same discipline as stripe-gateway-webhook):
// nothing this function reads from the request is trusted for any
// WRITE decision until the HMAC has been verified. The two
// service-role RPCs this function calls (record_gateway_payment_service /
// mark_gateway_transaction_failed_service) are themselves
// service_role-only and re-validate everything that actually matters
// (staged transaction state, invoice state, amount/currency match)
// independently of whatever this function believes about the payload.
//
// WEBHOOK LOOKUP STRATEGY (stronger than Stripe's, by construction):
//   1. PRIMARY: obj.order.merchant_order_id -- this is Paymob's own
//      echo of the `special_reference` we set to the Mal3aby
//      transaction id itself at checkout-creation time
//      (paymob-create-checkout-session). A DIRECT match against
//      payment_gateway_transactions.id -- no round-trip resolution
//      needed at all, unlike Stripe's provider_session_ref indirection.
//   2. FALLBACK: provider_session_ref = obj.id (Paymob's transaction
//      id) or intention id persisted at checkout-creation time --
//      covers the case special_reference was somehow stripped/not
//      echoed.
//   3. DEFENSIVE FALLBACK: every enabled Paymob connection, trying
//      each one's HMAC secret in turn until one verifies -- a wrong
//      secret simply fails to produce a matching signature, it cannot
//      forge one, so this remains safe.
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

async function hmacSha512Hex(key: string, message: string): Promise<string> {
  const keyBytes = new TextEncoder().encode(key)
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-512' },
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
// defense as stripe-gateway-webhook's own constantTimeHexEqual.
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Same deterministic string->UUID derivation stripe-create-refund /
// stripe-gateway-webhook use, for refund-idempotency-key convergence
// (not exercised by this function directly today since Paymob has no
// separate async refund-confirmation callback type documented distinct
// from the transaction-processed shape -- kept for structural parity
// and because paymob-create-refund's own synchronous posting uses the
// SAME derivation for the SAME Paymob transaction id, so if Paymob
// ever sends a refund-shaped processed callback for the SAME
// transaction id, this function's normal success/failure path would
// otherwise attempt to re-post a payment for what is actually a
// refund -- the is_refunded/is_refund guard below prevents that).
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

function boolStr(v: unknown): string {
  return v === true ? 'true' : 'false'
}

// Builds the exact HMAC concatenation string for a POST ("Processed")
// callback from the parsed `obj` (Paymob's transaction object) plus
// its nested `order`/`source_data`, in the DOCUMENTED field order.
function buildHmacConcatString(obj: Record<string, unknown>): string {
  const order = (obj.order ?? {}) as Record<string, unknown>
  const sourceData = (obj.source_data ?? {}) as Record<string, unknown>

  const parts = [
    String(obj.amount_cents ?? ''),
    String(obj.created_at ?? ''),
    String(obj.currency ?? ''),
    boolStr(obj.error_occured),
    boolStr(obj.has_parent_transaction),
    String(obj.id ?? ''), // obj.id for POST/Processed callbacks.
    String(obj.integration_id ?? ''),
    boolStr(obj.is_3d_secure),
    boolStr(obj.is_auth),
    boolStr(obj.is_capture),
    boolStr(obj.is_refunded),
    boolStr(obj.is_standalone_payment),
    boolStr(obj.is_voided),
    String(order.id ?? ''), // order.id for POST/Processed callbacks.
    String(obj.owner ?? ''),
    boolStr(obj.pending),
    String(sourceData.pan ?? ''),
    String(sourceData.sub_type ?? ''),
    String(sourceData.type ?? ''),
    boolStr(obj.success),
  ]

  return parts.join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  const url = new URL(req.url)
  const claimedHmac = url.searchParams.get('hmac')
  if (!claimedHmac) {
    return jsonResponse({ error: 'missing hmac query parameter' }, 400)
  }

  // CRITICAL ORDERING: read the raw body as TEXT first, exactly like
  // stripe-gateway-webhook -- we need the raw bytes both to compute a
  // durable payload_hash for dedup AND to parse the JSON safely once,
  // never re-serializing for any part of the trust decision (the HMAC
  // is computed over documented FIELD VALUES extracted from the parsed
  // object, per Paymob's own documented scheme -- not over the raw
  // body bytes the way Stripe's scheme works. This is a genuine
  // per-provider difference, not an inconsistency: Paymob's own docs
  // specify "concatenate the VALUES of these fields", not "hash the
  // raw request body").
  const rawBody = await req.text()

  let payload: Record<string, unknown> | null = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'malformed JSON body' }, 400)
  }

  if (!payload || payload.type !== 'TRANSACTION' || typeof payload.obj !== 'object' || payload.obj === null) {
    // Not a transaction-processed callback shape we handle (Paymob
    // also sends "TOKEN" callbacks for saved-card tokenization, which
    // Mal3aby does not use -- acknowledge without processing rather
    // than erroring, since retrying will not change the shape).
    return jsonResponse({ received: true, ignored: true })
  }

  const obj = payload.obj as Record<string, unknown>
  const order = (obj.order ?? {}) as Record<string, unknown>

  const concatString = buildHmacConcatString(obj)

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Candidate resolution, in priority order (see file header):
  //   1. merchant_order_id (= our special_reference = Mal3aby
  //      transaction id) -- DIRECT match, O(1), no indirection.
  //   2. provider_session_ref (Paymob transaction/intention id).
  //   3. Defensive fallback: every enabled Paymob connection.
  type Candidate = { connectionId: string; clubId: string; webhookSecretVaultId: string; transactionId: string | null }
  let candidates: Candidate[] = []

  // merchant_order_id must be validated as a real UUID shape BEFORE
  // using it in an `.eq('id', ...)` filter against a `uuid` column --
  // Postgres/PostgREST raises a type-cast error (not a graceful "no
  // rows") for a malformed UUID literal, which would turn an
  // attacker-controlled or simply garbled merchant_order_id into a
  // hard failure instead of falling through to the next lookup
  // strategy. Mal3aby's own transaction ids are always real UUIDs
  // (gen_random_uuid()), so anything else here can never be a genuine
  // match anyway.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const rawMerchantOrderId = typeof order.merchant_order_id === 'string' ? order.merchant_order_id : null
  const merchantOrderId = rawMerchantOrderId && UUID_RE.test(rawMerchantOrderId) ? rawMerchantOrderId : null
  const paymobTransactionId = obj.id != null ? String(obj.id) : null
  const paymobOrderId = order.id != null ? String(order.id) : null

  if (merchantOrderId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id, connection_id, club_id')
      .eq('id', merchantOrderId)
      .eq('gateway', 'paymob')
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, webhook_secret_vault_id')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.webhook_secret_vault_id) {
        candidates = [{ connectionId: conn.id, clubId: conn.club_id, webhookSecretVaultId: conn.webhook_secret_vault_id, transactionId: txnMatch.id }]
      }
    }
  }

  if (candidates.length === 0 && (paymobTransactionId || paymobOrderId)) {
    // provider_session_ref may hold either the intention id (persisted
    // at checkout-creation time, before the transaction id exists) or
    // the Paymob transaction id (persisted on a PRIOR successful
    // webhook, e.g. a duplicate delivery) -- try the transaction id
    // first since that's what a genuinely later/duplicate delivery
    // would match. A fresh query builder is constructed from `admin`
    // on EACH iteration -- reusing one builder instance across
    // multiple `.eq()` calls in a loop is not a safe pattern with the
    // supabase-js query builder (each call should chain off a fresh
    // base, not accumulate onto a shared instance from a prior
    // iteration).
    const refCandidates = [paymobTransactionId, paymobOrderId].filter((v): v is string => !!v)
    for (const ref of refCandidates) {
      const { data: txnMatch } = await admin
        .from('payment_gateway_transactions')
        .select('id, connection_id, club_id')
        .eq('gateway', 'paymob')
        .eq('provider_session_ref', ref)
        .maybeSingle()
      if (txnMatch?.connection_id) {
        const { data: conn } = await admin
          .from('club_gateway_connections')
          .select('id, club_id, webhook_secret_vault_id')
          .eq('id', txnMatch.connection_id)
          .maybeSingle()
        if (conn?.webhook_secret_vault_id) {
          candidates = [{ connectionId: conn.id, clubId: conn.club_id, webhookSecretVaultId: conn.webhook_secret_vault_id, transactionId: txnMatch.id }]
          break
        }
      }
    }
  }

  if (candidates.length === 0) {
    const { data: allConns } = await admin
      .from('club_gateway_connections')
      .select('id, club_id, webhook_secret_vault_id')
      .eq('provider_key', 'paymob')
      .eq('enabled', true)
      .not('webhook_secret_vault_id', 'is', null)
    candidates = (allConns ?? []).map((c) => ({
      connectionId: c.id,
      clubId: c.club_id,
      webhookSecretVaultId: c.webhook_secret_vault_id as string,
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
    // NOTE: get_vault_secret_service(), NOT .schema('vault') -- same
    // reasoning as stripe-gateway-webhook (PostgREST does not expose
    // the vault schema on this project).
    const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
      p_secret_id: candidate.webhookSecretVaultId,
    })

    if (secretError || !decryptedSecret) continue

    const expectedHmac = await hmacSha512Hex(decryptedSecret, concatString)

    if (constantTimeHexEqual(expectedHmac, claimedHmac)) {
      verifiedClubId = candidate.clubId
      verifiedConnectionId = candidate.connectionId
      resolvedTransactionId = candidate.transactionId
      break
    }
  }

  if (!verifiedClubId || !verifiedConnectionId) {
    // Same reasoning as stripe-gateway-webhook: do not log an
    // unverified request to payment_gateway_webhook_events -- it
    // proves nothing trustworthy and would just be attacker-controlled
    // noise in the audit trail.
    return jsonResponse({ error: 'hmac verification failed' }, 400)
  }

  // From here on, PROVEN to have been sent by Paymob (or by someone
  // holding this specific connection's HMAC secret).
  const payloadHash = await sha256Hex(rawBody)

  // Dedup via payment_gateway_webhook_events' (provider_key,
  // payload_hash) unique index (added specifically for Paymob, which
  // has no dedicated event id -- see migration
  // 20260827161918_paymob_webhook_events_payload_hash_dedup.sql).
  const { error: insertEventError } = await admin.from('payment_gateway_webhook_events').insert({
    provider_key: 'paymob',
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
  if (!transactionId && merchantOrderId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('id', merchantOrderId)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }
  if (!transactionId && (paymobTransactionId || paymobOrderId)) {
    const refCandidates = [paymobTransactionId, paymobOrderId].filter((v): v is string => !!v)
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
      .eq('provider_key', 'paymob')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, unmatched: true })
  }

  const paymobStatus = obj.success === true ? 'success' : obj.pending === true ? 'pending' : 'failed'

  // REFUND/VOID EVENTS: Paymob sends the SAME "TRANSACTION" processed
  // callback shape for a refund confirmation on the PARENT
  // transaction, distinguished by is_refunded=true (per Paymob's own
  // Refund endpoint docs: "you will receive callbacks for the parent
  // transaction... with the flag is_refunded: true"). This is NOT a
  // "payment succeeded" event even though obj.success may also be
  // true on that same callback -- guard explicitly so a refund
  // confirmation callback can never be mis-posted as a NEW payment via
  // record_gateway_payment_service. Mal3aby's own paymob-create-refund
  // already posts the canonical refund SYNCHRONOUSLY on Paymob's own
  // synchronous Refund API response (mirroring stripe-create-refund's
  // design) -- this branch is a defensive reconciliation no-op today
  // (Paymob's refund API is documented as synchronous, unlike some of
  // Stripe's async payment methods), logged and acknowledged only.
  if (obj.is_refunded === true || obj.is_voided === true) {
    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'paymob')
      .eq('payload_hash', payloadHash)
    return jsonResponse({ received: true, refund_or_void_acknowledged: true })
  }

  if (obj.success === true) {
    const minorUnitAmount = typeof obj.amount_cents === 'number' ? obj.amount_cents : null
    const currencyRaw = typeof obj.currency === 'string' ? obj.currency : null

    if (minorUnitAmount === null || !currencyRaw) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'paymob success callback missing amount_cents/currency fields',
        p_provider_raw_status: paymobStatus,
      })
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
        .eq('provider_key', 'paymob')
        .eq('payload_hash', payloadHash)
      return jsonResponse({ received: true })
    }

    const confirmedAmount = minorUnitAmount / 100
    const confirmedCurrency = currencyRaw.toUpperCase()

    // provider_session_ref is now overwritten with Paymob's REAL
    // transaction id (obj.id) -- this is what paymob-create-refund
    // actually needs (Paymob's refund endpoint takes `transaction_id`,
    // not the intention id) -- see PAYMENT_GATEWAY_PROVIDER_MATRIX.md
    // "Paymob update" section, item 2, for why this handoff matters.
    const { data: paymentId, error: rpcError } = await admin.rpc('record_gateway_payment_service', {
      p_transaction_id: transactionId,
      p_confirmed_amount: confirmedAmount,
      p_confirmed_currency: confirmedCurrency,
      p_provider_session_ref: paymobTransactionId,
      p_provider_raw_status: paymobStatus,
    })

    if (rpcError) {
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: false, processing_error: rpcError.message })
        .eq('provider_key', 'paymob')
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
      .eq('provider_key', 'paymob')
      .eq('payload_hash', payloadHash)

    return jsonResponse({ received: true, payment_id: paymentId })
  }

  // Non-success (failed/declined) -- mark the staged transaction
  // failed so it does not sit in 'pending' forever.
  // mark_gateway_transaction_failed_service is idempotent/no-op-safe
  // if the transaction already reached a terminal state.
  await admin.rpc('mark_gateway_transaction_failed_service', {
    p_transaction_id: transactionId,
    p_reason: `paymob transaction ${paymobStatus} (error_occured: ${boolStr(obj.error_occured)})`,
    p_provider_raw_status: paymobStatus,
  })

  await admin
    .from('payment_gateway_webhook_events')
    .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
    .eq('provider_key', 'paymob')
    .eq('payload_hash', payloadHash)

  return jsonResponse({ received: true })
})
