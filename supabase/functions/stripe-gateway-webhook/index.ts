// stripe-gateway-webhook -- PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS:
// Stripe webhook receiver (2026-08-27, updated 2026-08-27 once
// checkout-session-creation shipped).
//
// Deployed with verify_jwt=false -- deliberately: Stripe calls this
// endpoint directly with no Supabase session/JWT at all. Stripe
// authenticates ITSELF to us via the Stripe-Signature header instead
// (HMAC-SHA256 over "timestamp.raw_body", keyed by a per-connection
// webhook secret we store in Supabase Vault at connect_club_gateway()
// time). This mirrors this project's own existing convention for a
// self-authenticating, session-less public entrypoint
// (activate-portal-account is the other example already in this
// codebase, gated by a token hash instead of an HMAC).
//
// TRUST MODEL, SPELLED OUT: nothing this function reads from the
// request body is trusted for any WRITE decision until the signature
// has been verified. The two service-role RPCs this function calls
// (record_gateway_payment_service / mark_gateway_transaction_failed_service)
// are themselves service_role-only and re-validate everything that
// actually matters (staged transaction state, invoice state,
// amount/currency match) independently of whatever this function
// believes about the payload -- so even a bug in this function's own
// parsing can never, by itself, post a payment. Defense in depth, not
// single-layer trust.
//
// GAP UPDATE (2026-08-27): the checkout-session-creation Edge
// Function (stripe-create-checkout-session) now exists and writes
// payment_gateway_transactions.provider_session_ref = the real Stripe
// Checkout Session id (plus metadata.mal3aby_transaction_id and
// client_reference_id on the Stripe object itself) AT SESSION-CREATION
// TIME, before the customer ever reaches Stripe's hosted page. This
// means the exact-match candidate-resolution strategy below (try
// provider_session_ref first) now succeeds in the COMMON CASE with a
// single indexed lookup -- O(1), not O(N) -- for any transaction that
// went through the normal checkout flow. The O(N) "try every enabled
// Stripe connection's webhook secret" path below is retained as a
// genuine DEFENSIVE FALLBACK ONLY, for edge cases the primary path
// cannot cover (e.g. a transaction whose session-creation call
// partially failed after creating the Stripe session but before
// persisting provider_session_ref -- see stripe-create-checkout-session's
// own comment on that specific failure window; or any future direct/
// manual Stripe object created outside this flow). It is NOT a
// security gap in either state: an incorrect secret simply fails to
// produce a matching signature, it cannot forge one. This comment
// replaces the prior "KNOWN, DOCUMENTED GAP" framing now that the
// primary path is genuinely wired -- see PAYMENT_GATEWAY_WEBHOOK_MODEL.md
// for the full before/after writeup.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, stripe-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

// Constant-time hex-string comparison. Deliberately NOT `===` -- a
// naive string compare short-circuits on the first differing byte,
// which is a textbook timing side-channel for exactly this kind of
// "does the attacker-supplied signature match the real one" check.
// XOR-accumulate over the full length regardless of where (or
// whether) a mismatch occurs, so the comparison takes the same time
// either way. Length is checked separately (and safely -- comparing
// two known, non-secret lengths leaks nothing) before the loop.
function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

// Same deterministic string->UUID derivation stripe-create-refund uses
// -- given the SAME Stripe refund id, both this function's defensive
// 'charge.refunded'/'refund.updated' handling and stripe-create-refund's
// own synchronous posting always derive the SAME idempotency key, so
// create_gateway_refund_service's idempotency_key uniqueness converges
// them on one refunds row instead of creating a duplicate no matter
// which path processes the refund first.
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

// Parses Stripe's "Stripe-Signature" header, which looks like:
//   t=1730000000,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=...
// Only v1 (the current HMAC-SHA256 scheme) is used -- v0 is a legacy
// scheme Stripe still sends alongside v1 for backward compatibility
// with old integrations; we never fall back to it.
function parseStripeSignatureHeader(header: string): { timestamp: string; v1: string } | null {
  const parts = header.split(',').map((p) => p.trim())
  let timestamp: string | null = null
  let v1: string | null = null
  for (const part of parts) {
    const [k, v] = part.split('=')
    if (k === 't') timestamp = v
    if (k === 'v1') v1 = v
  }
  if (!timestamp || !v1) return null
  return { timestamp, v1 }
}

const REPLAY_WINDOW_SECONDS = 5 * 60 // Stripe's own documented recommendation.

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  // CRITICAL ORDERING: read the raw body as TEXT first, before any
  // JSON parsing. Stripe's signature is computed over the exact raw
  // bytes Stripe sent -- if we JSON.parse() first and later
  // re-serialize (or even just parse into a JS object and stringify a
  // DIFFERENT object shape/key order for hashing), the signature we
  // compute will not match Stripe's, even for a completely genuine
  // request. Every use of the payload below for verification purposes
  // uses this exact rawBody string.
  const rawBody = await req.text()

  const signatureHeader = req.headers.get('stripe-signature')
  if (!signatureHeader) {
    return jsonResponse({ error: 'missing stripe-signature header' }, 400)
  }

  const parsedSig = parseStripeSignatureHeader(signatureHeader)
  if (!parsedSig) {
    return jsonResponse({ error: 'malformed stripe-signature header' }, 400)
  }

  const { timestamp, v1: claimedSignature } = parsedSig

  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) {
    return jsonResponse({ error: 'malformed stripe-signature timestamp' }, 400)
  }
  const nowSeconds = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSeconds - timestampSeconds) > REPLAY_WINDOW_SECONDS) {
    // Reject outright -- do not even attempt verification. An old
    // timestamp outside the replay window is rejected regardless of
    // whether the signature would otherwise match, per Stripe's own
    // documented recommendation.
    return jsonResponse({ error: 'timestamp outside replay window' }, 400)
  }

  // service_role client -- required both to call get_vault_secret_service()
  // (service_role-only, reads vault.decrypted_secrets server-side --
  // NOT via PostgREST's .schema('vault'), which this project does not
  // expose; see that RPC's own migration comment) and to call the two
  // service_role-only payment-posting RPCs below.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Best-effort, READ-ONLY parse of the unverified body purely to
  // narrow which club/connections to try -- see the GAP UPDATE note at
  // the top of this file. This value is never used to make a trust or
  // payment decision; it only shrinks the candidate-connection list
  // we attempt HMAC verification against below.
  let unverifiedEvent: Record<string, unknown> | null = null
  try {
    unverifiedEvent = JSON.parse(rawBody)
  } catch {
    // Malformed JSON -- verification will fail regardless once we
    // reach it (no valid Stripe event has an unparseable body), so we
    // simply proceed with unverifiedEvent = null and let candidate
    // resolution below fall back to "all enabled stripe connections".
  }

  const dataObject = (unverifiedEvent?.data as Record<string, unknown> | undefined)?.object as
    | Record<string, unknown>
    | undefined
  const unverifiedObjectId = typeof dataObject?.id === 'string' ? dataObject.id : null
  const unverifiedMetadataTxnId =
    typeof (dataObject?.metadata as Record<string, unknown> | undefined)?.mal3aby_transaction_id === 'string'
      ? ((dataObject!.metadata as Record<string, unknown>).mal3aby_transaction_id as string)
      : null

  // Candidate resolution, in priority order:
  //   1. Exact match via provider_session_ref (the Stripe Checkout
  //      Session id) -- populated by stripe-create-checkout-session at
  //      session-creation time. THIS IS NOW THE COMMON-CASE PATH for
  //      every transaction created through the normal checkout flow --
  //      a single indexed lookup, O(1).
  //   2. metadata.mal3aby_transaction_id carried on the Stripe object
  //      itself -- also set by stripe-create-checkout-session, a
  //      redundant second lookup path per the directive's design (in
  //      case provider_session_ref persistence failed after the
  //      Stripe session was already created -- see that function's own
  //      comment on this specific window).
  //   3. Defensive fallback: every enabled Stripe connection, trying
  //      each one's webhook secret in turn until one verifies. Only
  //      reached if both of the above come up empty -- expected to be
  //      rare now, not the common case. Verification itself is what
  //      proves which one is genuine, not this lookup; a wrong secret
  //      simply fails to produce a matching signature, it cannot forge
  //      one, so this remains safe even though it's O(connections).
  type Candidate = { connectionId: string; clubId: string; webhookSecretVaultId: string }
  let candidates: Candidate[] = []

  if (unverifiedObjectId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('connection_id, club_id')
      .eq('provider_session_ref', unverifiedObjectId)
      .eq('gateway', 'stripe')
      .limit(1)
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, webhook_secret_vault_id')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.webhook_secret_vault_id) {
        candidates = [{ connectionId: conn.id, clubId: conn.club_id, webhookSecretVaultId: conn.webhook_secret_vault_id }]
      }
    }
  }

  if (candidates.length === 0 && unverifiedMetadataTxnId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('connection_id, club_id')
      .eq('id', unverifiedMetadataTxnId)
      .eq('gateway', 'stripe')
      .maybeSingle()
    if (txnMatch?.connection_id) {
      const { data: conn } = await admin
        .from('club_gateway_connections')
        .select('id, club_id, webhook_secret_vault_id')
        .eq('id', txnMatch.connection_id)
        .maybeSingle()
      if (conn?.webhook_secret_vault_id) {
        candidates = [{ connectionId: conn.id, clubId: conn.club_id, webhookSecretVaultId: conn.webhook_secret_vault_id }]
      }
    }
  }

  if (candidates.length === 0) {
    // Defensive fallback only (see GAP UPDATE comment at top) -- every
    // enabled Stripe connection with a webhook secret configured.
    // Correctness does not depend on this list being small -- an
    // invalid secret simply fails to verify.
    const { data: allConns } = await admin
      .from('club_gateway_connections')
      .select('id, club_id, webhook_secret_vault_id')
      .eq('provider_key', 'stripe')
      .eq('enabled', true)
      .not('webhook_secret_vault_id', 'is', null)
    candidates = (allConns ?? []).map((c) => ({
      connectionId: c.id,
      clubId: c.club_id,
      webhookSecretVaultId: c.webhook_secret_vault_id as string,
    }))
  }

  if (candidates.length === 0) {
    // No connection to even attempt verification against. Return 400
    // (not 200) -- this is a genuine "we cannot verify this request"
    // outcome, distinct from "verified and durably logged", so Stripe
    // should NOT be told to stop retrying (a future connection setup
    // completing, or the real matching connection existing but this
    // lookup strategy simply not finding it yet, should still get a
    // chance via Stripe's own retry schedule).
    return jsonResponse({ error: 'no matching gateway connection to verify against' }, 400)
  }

  let verifiedClubId: string | null = null
  let verifiedConnectionId: string | null = null

  for (const candidate of candidates) {
    // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER
    // SQL RPC -- NOT admin.schema('vault').from('decrypted_secrets').
    // Live-tested and found broken this session: PostgREST does not
    // expose the `vault` schema in this project (a genuine "Invalid
    // schema: vault" rejection, not an RLS denial), so every
    // .schema('vault') call from a client library silently failed to
    // read any secret at all. The RPC reads vault.decrypted_secrets via
    // plain SQL inside the database, unaffected by PostgREST schema
    // exposure. See migration 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
    const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
      p_secret_id: candidate.webhookSecretVaultId,
    })

    if (secretError || !decryptedSecret) continue

    const expectedSignature = await hmacSha256Hex(decryptedSecret, `${timestamp}.${rawBody}`)

    if (constantTimeHexEqual(expectedSignature, claimedSignature)) {
      verifiedClubId = candidate.clubId
      verifiedConnectionId = candidate.connectionId
      break
    }
  }

  if (!verifiedClubId || !verifiedConnectionId) {
    // No candidate's secret produced a matching signature -- reject.
    // This is the one case where we do NOT log to
    // payment_gateway_webhook_events (an unverified request proves
    // nothing about which club/provider it even claims to be from in
    // a trustworthy way, and logging arbitrary unverified payloads
    // keyed by nothing real is not useful audit trail -- it is noise
    // an attacker fully controls the shape of).
    return jsonResponse({ error: 'signature verification failed' }, 400)
  }

  // From here on, the request is PROVEN to have been sent by Stripe
  // (or by someone holding this specific connection's webhook
  // secret) -- rawBody and the parsed event are now safe to trust for
  // dedup logging and event-type dispatch.
  const event = unverifiedEvent as {
    id?: string
    type?: string
    data?: { object?: Record<string, unknown> }
  } | null

  if (!event?.id || !event.type) {
    return jsonResponse({ error: 'malformed event payload' }, 400)
  }

  const payloadHash = await sha256Hex(rawBody)

  // Dedup via payment_gateway_webhook_events' own unique index on
  // (provider_key, provider_event_id). A duplicate delivery of an
  // event we already logged is a no-op: return 200 immediately without
  // reprocessing, matching Stripe's own retry semantics (Stripe
  // retries on any non-2xx; we must not let a retry double-call the
  // payment RPC even though that RPC is independently idempotent too
  // -- belt and braces).
  const { error: insertEventError } = await admin.from('payment_gateway_webhook_events').insert({
    provider_key: 'stripe',
    connection_id: verifiedConnectionId,
    provider_event_id: event.id,
    payload_hash: payloadHash,
    signature_valid: true,
  })

  if (insertEventError) {
    // Unique-violation on (provider_key, provider_event_id) means this
    // exact Stripe event was already durably logged (and, per Stripe's
    // at-least-once delivery guarantee, was already processed or is
    // being processed by that earlier delivery). Acknowledge with 200
    // and do NOT call the payment RPC again.
    if (insertEventError.code === '23505') {
      return jsonResponse({ received: true, duplicate: true })
    }
    // Any other insert failure: we could not durably log this event at
    // all. Do not proceed to mutate payment state without a durable
    // record of having done so -- ask Stripe to retry.
    return jsonResponse({ error: 'failed to log webhook event' }, 500)
  }

  const dataObj = event.data?.object as Record<string, unknown> | undefined
  const stripeObjectId = typeof dataObj?.id === 'string' ? dataObj.id : null
  const stripeStatus = typeof dataObj?.status === 'string' ? dataObj.status : null

  // Resolve the staged payment_gateway_transactions row for this
  // event. Prefer the metadata-carried transaction id; fall back to
  // matching on provider_session_ref = the Stripe object id. Both are
  // now populated up front by stripe-create-checkout-session for every
  // transaction created through the normal flow.
  const metadataTxnId =
    typeof (dataObj?.metadata as Record<string, unknown> | undefined)?.mal3aby_transaction_id === 'string'
      ? ((dataObj!.metadata as Record<string, unknown>).mal3aby_transaction_id as string)
      : null

  let transactionId: string | null = metadataTxnId

  if (!transactionId && stripeObjectId) {
    const { data: txnMatch } = await admin
      .from('payment_gateway_transactions')
      .select('id')
      .eq('provider_session_ref', stripeObjectId)
      .eq('connection_id', verifiedConnectionId)
      .maybeSingle()
    transactionId = txnMatch?.id ?? null
  }

  // REFUND EVENTS ONLY: 'charge.refunded'/'refund.updated' carry a
  // Charge id ('ch_...') or Refund id ('re_...') as data.object.id --
  // neither matches provider_session_ref (which stores the Checkout
  // Session id, 'cs_...'). The reliable linkage for these event types
  // is the Charge's own `payment_intent` field ('pi_...'), which we
  // resolve against payment_gateway_transactions by reverse-looking-up
  // the Checkout Session (one authenticated Stripe API call, using the
  // SAME already-verified connection's secret we just proved owns this
  // webhook) and matching its id back to provider_session_ref. This is
  // the one place this webhook makes an outbound Stripe call -- scoped
  // narrowly to the refund-reconciliation fallback, never the primary
  // payment-posting path (which never calls out to Stripe at all).
  if (!transactionId && (event.type === 'charge.refunded' || event.type === 'refund.updated')) {
    // 'charge.refunded': data.object is the Charge, which carries
    // `payment_intent` directly. 'refund.updated': data.object is the
    // Refund, which does not carry payment_intent directly (only
    // `charge`) -- left unresolved for that event type in this pass;
    // 'charge.refunded' is Stripe's primary/documented refund
    // notification event and covers the common case, so this is a
    // narrowing of the defensive fallback's own coverage, not the
    // primary posting path.
    const paymentIntentId = typeof dataObj?.payment_intent === 'string' ? dataObj.payment_intent : null

    if (paymentIntentId) {
      // Read the connection's secret_vault_id (the Stripe API secret
      // key -- a different Vault entry than webhook_secret_vault_id,
      // which only ever contains the webhook SIGNING secret) to make
      // an authenticated lookup of the PaymentIntent's originating
      // Checkout Session.
      const { data: connRow } = await admin
        .from('club_gateway_connections')
        .select('secret_vault_id')
        .eq('id', verifiedConnectionId)
        .maybeSingle()

      if (connRow?.secret_vault_id) {
        const { data: apiDecryptedSecret } = await admin.rpc('get_vault_secret_service', {
          p_secret_id: connRow.secret_vault_id,
        })

        if (apiDecryptedSecret) {
          try {
            const sessionSearch = await fetch(
              `https://api.stripe.com/v1/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntentId)}&limit=1`,
              {
                headers: { Authorization: `Bearer ${apiDecryptedSecret}` },
                signal: AbortSignal.timeout(15000),
              },
            )
            const sessionSearchBody = await sessionSearch.json().catch(() => null)
            const sessionId = sessionSearchBody?.data?.[0]?.id
            if (sessionSearch.ok && typeof sessionId === 'string') {
              const { data: txnMatch } = await admin
                .from('payment_gateway_transactions')
                .select('id')
                .eq('provider_session_ref', sessionId)
                .eq('connection_id', verifiedConnectionId)
                .maybeSingle()
              transactionId = txnMatch?.id ?? null
            }
          } catch {
            // Network failure resolving the linkage -- fall through to
            // 'unmatched' below; this is the defensive path, and the
            // primary synchronous refund-posting path in
            // stripe-create-refund already covers the common case.
          }
        }
      }
    }
  }

  if (!transactionId) {
    // We verified this is a genuine Stripe event for a connection we
    // recognize, but we cannot map it to any staged Mal3aby
    // transaction. Durably logged above already; acknowledge 200
    // (this is not a delivery failure Stripe should retry -- retrying
    // will not make the linkage appear) but do not attempt to post or
    // fail any payment.
    return jsonResponse({ received: true, unmatched: true })
  }

  // Only the two success event types are handled as "attempt to post
  // a payment" in this first cut -- everything else (e.g.
  // payment_intent.payment_failed, checkout.session.expired,
  // charge.refunded) is routed to mark-failed so the staged
  // transaction does not sit in 'pending' forever, without this
  // function trying to interpret every Stripe event type's semantics
  // in this initial implementation.
  const SUCCESS_EVENT_TYPES = new Set(['checkout.session.completed', 'payment_intent.succeeded'])

  if (SUCCESS_EVENT_TYPES.has(event.type)) {
    // amount_total (Checkout Session) / amount_received or amount
    // (PaymentIntent) are both integer minor-unit values in Stripe's
    // API (e.g. piastres for EGP-like 2-decimal currencies) -- convert
    // to the same decimal-major-unit numeric shape
    // payment_gateway_transactions.amount already uses.
    const minorUnitAmount =
      (dataObj?.amount_total as number | undefined) ??
      (dataObj?.amount_received as number | undefined) ??
      (dataObj?.amount as number | undefined)
    const currencyRaw = typeof dataObj?.currency === 'string' ? dataObj.currency : null

    if (typeof minorUnitAmount !== 'number' || !currencyRaw) {
      await admin.rpc('mark_gateway_transaction_failed_service', {
        p_transaction_id: transactionId,
        p_reason: 'stripe success event missing amount/currency fields',
        p_provider_raw_status: stripeStatus,
      })
      return jsonResponse({ received: true })
    }

    const confirmedAmount = minorUnitAmount / 100
    const confirmedCurrency = currencyRaw.toUpperCase()

    const { data: paymentId, error: rpcError } = await admin.rpc('record_gateway_payment_service', {
      p_transaction_id: transactionId,
      p_confirmed_amount: confirmedAmount,
      p_confirmed_currency: confirmedCurrency,
      p_provider_session_ref: stripeObjectId,
      p_provider_raw_status: stripeStatus,
    })

    if (rpcError) {
      // A genuine, unexpected RPC-level error (not a business
      // rejection -- those return null, not an error, per
      // record_gateway_payment_service's own contract). Mark the
      // webhook event's processing_error for later inspection; still
      // return 200 since the event itself is durably logged and a
      // retry would hit the same dedup row -- an operator needs to
      // look at this, retries will not fix it.
      await admin
        .from('payment_gateway_webhook_events')
        .update({ processed: false, processing_error: rpcError.message })
        .eq('provider_key', 'stripe')
        .eq('provider_event_id', event.id)
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
      .eq('provider_key', 'stripe')
      .eq('provider_event_id', event.id)

    return jsonResponse({ received: true, payment_id: paymentId })
  }

  // REFUND CONFIRMATION -- defensive reconciliation path (item 8).
  // stripe-create-refund posts the canonical refund SYNCHRONOUSLY on
  // Stripe's own synchronous Refunds API response in the common case;
  // this branch exists for the cases that path cannot cover: a refund
  // that confirms asynchronously after that function already returned
  // (Stripe explicitly documents this as possible for some payment
  // methods), or a refund created directly in the Stripe Dashboard
  // rather than through Mal3aby. 'charge.refunded' carries the
  // refund(s) nested under data.object.refunds.data[]; we post each
  // one that isn't already recorded. Fully idempotent: the SAME
  // deterministic-UUID-from-refund-id key stripe-create-refund itself
  // derives ensures a refund already posted synchronously is a no-op
  // here (create_gateway_refund_service's own idempotency_key
  // uniqueness returns the existing row rather than reprocessing).
  const REFUND_EVENT_TYPES = new Set(['charge.refunded', 'refund.updated'])

  if (REFUND_EVENT_TYPES.has(event.type)) {
    const refundObjects: Record<string, unknown>[] =
      event.type === 'charge.refunded'
        ? (((dataObj?.refunds as Record<string, unknown> | undefined)?.data as Record<string, unknown>[] | undefined) ?? [])
        : dataObj
          ? [dataObj]
          : []

    for (const refundObj of refundObjects) {
      const refundStatus = typeof refundObj.status === 'string' ? refundObj.status : null
      if (refundStatus !== 'succeeded') continue // Only post genuinely confirmed refunds -- never a pending/failed one.

      const refundId = typeof refundObj.id === 'string' ? refundObj.id : null
      const refundMinorAmount = typeof refundObj.amount === 'number' ? refundObj.amount : null
      if (!refundId || refundMinorAmount === null) continue

      // Resolve the payment this transaction produced -- refunds are
      // always posted against the CANONICAL payment id, never the
      // gateway transaction id directly.
      const { data: txnRow } = await admin
        .from('payment_gateway_transactions')
        .select('payment_id, currency')
        .eq('id', transactionId)
        .maybeSingle()

      if (!txnRow?.payment_id) continue // Nothing to reconcile against yet -- skip silently, this event carries no actionable linkage.

      const currencyLower = (txnRow.currency ?? 'usd').toLowerCase()
      const isZeroDecimal = ['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf'].includes(currencyLower)
      const refundAmount = isZeroDecimal ? refundMinorAmount : refundMinorAmount / 100

      const idempotencyKey = await deterministicUuidFromString(refundId)

      await admin.rpc('create_gateway_refund_service', {
        p_payment_id: txnRow.payment_id,
        p_amount: refundAmount,
        p_reason: `stripe ${event.type} (webhook reconciliation)`,
        p_provider_refund_ref: refundId,
        p_transaction_id: transactionId,
        p_actor_id: null,
        p_idempotency_key: idempotencyKey,
      })
      // Errors here (e.g. amount exceeds refundable balance, because
      // stripe-create-refund already posted the SAME logical refund
      // moments earlier through a different amount rounding path) are
      // intentionally swallowed rather than failing the whole webhook
      // response -- this is a best-effort reconciliation safety net,
      // not the primary posting path, and the webhook event itself is
      // already durably logged above regardless of this outcome.
    }

    await admin
      .from('payment_gateway_webhook_events')
      .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
      .eq('provider_key', 'stripe')
      .eq('provider_event_id', event.id)

    return jsonResponse({ received: true })
  }

  // Non-success event for a transaction we recognize -- mark it failed
  // so it does not sit in 'pending' forever. mark_gateway_transaction_failed_service
  // is itself idempotent/no-op-safe if the transaction already reached
  // a terminal state (including 'succeeded', which it explicitly
  // refuses to overwrite).
  await admin.rpc('mark_gateway_transaction_failed_service', {
    p_transaction_id: transactionId,
    p_reason: `stripe event ${event.type}`,
    p_provider_raw_status: stripeStatus,
  })

  await admin
    .from('payment_gateway_webhook_events')
    .update({ processed: true, transaction_id: transactionId, processed_at: new Date().toISOString() })
    .eq('provider_key', 'stripe')
    .eq('provider_event_id', event.id)

  return jsonResponse({ received: true })
})
