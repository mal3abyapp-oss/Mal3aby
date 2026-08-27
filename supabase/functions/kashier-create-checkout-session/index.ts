// kashier-create-checkout-session -- PHASE 2 MULTI-GATEWAY ONLINE
// PAYMENTS: real Kashier Payment Sessions API (v3) checkout creation
// (2026-08-27).
//
// Deployed with verify_jwt=true -- mirrors stripe-create-checkout-session
// and paymob-create-checkout-session's authorization pattern exactly:
// the client supplies only `transaction_id`, an already-staged
// payment_gateway_transactions row created by start_gateway_checkout()
// (which independently validated amount vs. outstanding balance and
// invoice.view permission). Nothing about amount/currency/invoice is
// trusted from the client in this function; everything is RE-FETCHED
// from the staged transaction row itself, and authorization is
// independently RE-VERIFIED server-side via get_gateway_transaction_status()
// called through the CALLER's own JWT.
//
// KASHIER API SHAPE -- OFFICIAL DOC VERIFIED 2026-08-27 against
// Kashier's live developer portal (developers.kashier.io -- a JS SPA,
// same as Paymob's; several deep links 404 on a cold WebFetch, the
// content below was reached via the docs' own rendered page content
// and cross-checked against a second independent source (Kashier's
// own public GitHub org / search-result snippets) where noted -- see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Kashier update" section for full
// source URLs):
//
//   POST {base_url}/v3/payment/sessions
//   Headers: `Authorization: {{secret_key}}`, `api-key: {{payment_api_key}}`
//   Body (fields actually used here): amount (string), currency,
//     merchantId (format "MID-XXXX-XXX"), order (merchant's own order
//     reference -- THIS is what Kashier echoes back on the webhook
//     payload as `merchantOrderId`, not a field literally named
//     "merchantOrderId" on the REQUEST), merchantRedirect, enable3DS,
//     serverWebhook.
//   Response: `sessionUrl` (hosted redirect URL, returned DIRECTLY by
//     the API -- like Stripe, UNLIKE Paymob, which requires
//     client-side URL construction from a separate public key).
//
// TWO DISTINCT KASHIER KEYS -- OFFICIAL DOC VERIFIED, load-bearing for
// how this function reads Vault (see PAYMENT_GATEWAY_PROVIDER_MATRIX.md):
//   - "Payment API Key" (`api-key` header) -- used for creating a
//     Payment Session AND for HMAC webhook signature verification.
//   - "Secret Key" (`Authorization` header) -- used ONLY for the
//     refund endpoint's server-to-server auth.
// These are DIFFERENT values, not two names for the same secret
// (confirmed: "Each account has a total of four keys: a Payment Api
// Key and Secret Key pair for test mode and live mode").
// club_gateway_connections has exactly two vault slots
// (secret_vault_id, webhook_secret_vault_id) -- this adapter
// deliberately maps:
//   - secret_vault_id       = Kashier SECRET KEY (used by
//                              kashier-create-refund's Authorization
//                              header only)
//   - webhook_secret_vault_id = Kashier PAYMENT API KEY (used HERE for
//                              the `api-key` header AND by
//                              kashier-gateway-webhook's HMAC)
// This is a DELIBERATE, DOCUMENTED deviation from the Paymob adapter's
// mapping (where secret_vault_id served every purpose) -- it exists
// because Kashier, unlike Paymob, genuinely has two independent keys
// serving disjoint purposes, and this mapping keeps each vault slot
// matched to the function(s) that actually need that specific key,
// rather than overloading one slot for two semantically different
// secrets. Documented explicitly here and in
// PAYMENT_GATEWAY_ARCHITECTURE.md so a future connect_club_gateway()
// caller for Kashier does not accidentally swap p_secret/p_webhook_secret.
//
// SANDBOX VS LIVE -- OFFICIAL DOC VERIFIED (code-example-level, not
// just prose): Kashier genuinely uses a DISTINCT HOSTNAME per
// environment for the Payment Sessions API
// (api.kashier.io vs test-api.kashier.io) -- UNLIKE both Stripe and
// Paymob, which use the SAME host and vary only the key. This function
// selects the base URL from the connection's own `environment` column
// (sandbox|live), not from any client-supplied value.
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

// Payment Sessions API base URL -- CONFIRMED distinct per environment
// (see file header). sandbox -> test-api.kashier.io, live -> api.kashier.io.
const KASHIER_SESSIONS_BASE_URL: Record<string, string> = {
  sandbox: 'https://test-api.kashier.io',
  live: 'https://api.kashier.io',
}

function sanitizeKashierError(body: unknown): string {
  // Never relay a raw Kashier error body verbatim -- be conservative
  // and only pluck known-safe string shapes, same discipline as
  // paymob-create-checkout-session's sanitizePaymobError.
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.message === 'string') return b.message
    if (typeof b.error === 'string') return b.error
    if (Array.isArray(b.errors) && b.errors.length > 0) return String(b.errors[0])
  }
  return 'kashier request failed'
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

  let body: { transaction_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'malformed JSON body' }, 400)
  }

  const transactionId = body.transaction_id
  if (!transactionId || typeof transactionId !== 'string') {
    return jsonResponse({ error: 'transaction_id is required' }, 400)
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

  const { data: txn, error: txnError } = await admin
    .from('payment_gateway_transactions')
    .select('id, club_id, invoice_id, gateway, amount, currency, status, connection_id, provider_session_ref')
    .eq('id', transactionId)
    .maybeSingle()

  if (txnError || !txn) {
    return jsonResponse({ error: 'transaction not found' }, 404)
  }

  if (txn.gateway !== 'kashier') {
    return jsonResponse({ error: 'this transaction was not staged for kashier' }, 400)
  }

  if (txn.status !== 'pending') {
    return jsonResponse({ error: `transaction is not pending (status: ${txn.status})` }, 409)
  }

  // Independent server-side re-authorization -- reuses
  // get_gateway_transaction_status() through the CALLER-scoped client
  // so it raises for a transaction_id the caller does not actually own.
  const { data: statusRows, error: authError } = await callerClient.rpc('get_gateway_transaction_status', {
    p_transaction_id: transactionId,
  })

  if (authError || !statusRows || statusRows.length === 0) {
    return jsonResponse({ error: 'not authorized for this transaction' }, 403)
  }

  if (!txn.connection_id) {
    return jsonResponse({ error: 'transaction has no linked gateway connection' }, 400)
  }

  const { data: connection, error: connError } = await admin
    .from('club_gateway_connections')
    .select('id, club_id, provider_key, environment, secret_vault_id, webhook_secret_vault_id, provider_merchant_ref, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== txn.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.enabled || !connection.webhook_secret_vault_id) {
    // webhook_secret_vault_id holds the Payment API Key for Kashier
    // (see file header) -- required to create a session at all.
    return jsonResponse({ error: 'gateway connection is not enabled or has no credentials configured' }, 400)
  }

  if (!connection.provider_merchant_ref) {
    // provider_merchant_ref holds Kashier's Merchant ID (MID-XXXX-XXX)
    // -- a REQUIRED body field for Payment Sessions creation.
    return jsonResponse({ error: 'gateway connection has no merchant id configured' }, 400)
  }

  const environment = connection.environment === 'live' ? 'live' : 'sandbox'
  const baseUrl = KASHIER_SESSIONS_BASE_URL[environment]

  // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER SQL
  // RPC -- NOT admin.schema('vault').from('decrypted_secrets'), which
  // was live-tested and found broken for the Stripe adapter (PostgREST
  // does not expose the vault schema on this project). See migration
  // 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
  //
  // webhook_secret_vault_id holds the Kashier PAYMENT API KEY here
  // (see file header for why) -- used as the `api-key` header below.
  const { data: paymentApiKey, error: apiKeyError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.webhook_secret_vault_id,
  })

  if (apiKeyError || !paymentApiKey) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  // secret_vault_id holds the Kashier SECRET KEY here -- the Payment
  // Sessions API's documented example sends BOTH `Authorization:
  // {{secret_key}}` and `api-key: {{api_key}}` headers, so both are
  // required for this call, not just the Payment API Key.
  let secretKey: string | null = null
  if (connection.secret_vault_id) {
    const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
      p_secret_id: connection.secret_vault_id,
    })
    if (!secretError && decryptedSecret) {
      secretKey = decryptedSecret
    }
  }

  if (!secretKey) {
    return jsonResponse({ error: 'gateway connection has no secret key configured' }, 400)
  }

  // EGP/USD/EUR/GBP are all standard 2-decimal currencies for Kashier
  // (payment_gateway_providers.kashier.supported_currencies) -- no
  // zero-decimal special-casing documented, and Kashier's own
  // documented `amount` field is a plain decimal STRING (e.g. "1.00"),
  // NOT minor units/cents (a genuine difference from both Stripe's
  // integer-minor-units convention and Paymob's amount_cents -- the
  // Payment Sessions example shows "amount": "1.00" for a 1.00 EGP
  // transaction, not "100").
  const amountString = Number(txn.amount).toFixed(2)

  const origin = req.headers.get('origin') ?? Deno.env.get('APP_BASE_URL') ?? ''
  const merchantRedirect = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=return`
  // serverWebhook: Kashier's asynchronous server-to-server callback --
  // this is the URL kashier-gateway-webhook is deployed at. Built from
  // SUPABASE_URL rather than trusting any client-controlled value.
  const serverWebhook = `${SUPABASE_URL}/functions/v1/kashier-gateway-webhook`

  const sessionPayload = {
    amount: amountString,
    currency: txn.currency,
    merchantId: connection.provider_merchant_ref,
    // `order` is the merchant's own order reference field on the
    // REQUEST -- Kashier echoes it back on the webhook payload as
    // `merchantOrderId` (a DIFFERENT field name on the response side).
    // Set to the Mal3aby transaction id itself so
    // kashier-gateway-webhook can resolve the staged transaction in
    // O(1), mirroring Paymob's special_reference/order.merchant_order_id
    // pattern and Stripe's client_reference_id/metadata pattern.
    order: transactionId,
    merchantRedirect,
    serverWebhook,
    type: 'one-time',
    paymentType: 'credit',
    enable3DS: true,
  }

  let kashierResponse: Response
  try {
    kashierResponse = await fetch(`${baseUrl}/v3/payment/sessions`, {
      method: 'POST',
      headers: {
        Authorization: secretKey,
        'api-key': paymentApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(sessionPayload),
    })
  } catch {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: 'kashier session creation: network error contacting kashier',
      p_provider_raw_status: null,
    })
    return jsonResponse({ error: 'could not reach kashier' }, 502)
  }

  const kashierBody = await kashierResponse.json().catch(() => null)

  if (!kashierResponse.ok || !kashierBody?.sessionUrl) {
    const sanitizedMessage = sanitizeKashierError(kashierBody)
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `kashier session creation failed: ${sanitizedMessage}`,
      p_provider_raw_status: String(kashierResponse.status),
    })
    return jsonResponse({ error: sanitizedMessage }, 502)
  }

  // Persist provider_session_ref = Kashier's session id (`_id`) as a
  // fallback candidate for kashier-gateway-webhook (the PRIMARY lookup
  // is `order`/`merchantOrderId`, set above to the Mal3aby transaction
  // id itself -- a direct key needing no round-trip resolution, same
  // strength as Paymob's special_reference pattern).
  const { error: updateError } = await admin
    .from('payment_gateway_transactions')
    .update({ provider_session_ref: kashierBody._id ?? null, updated_at: new Date().toISOString() })
    .eq('id', transactionId)
    .eq('status', 'pending')

  if (updateError) {
    console.error('failed to persist provider_session_ref', updateError)
  }

  // sessionUrl is returned DIRECTLY by Kashier's API (like Stripe,
  // unlike Paymob) -- no client-side URL construction needed.
  return jsonResponse({ checkout_url: kashierBody.sessionUrl })
})
