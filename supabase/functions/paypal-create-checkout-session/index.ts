// paypal-create-checkout-session -- PHASE 2 MULTI-GATEWAY ONLINE
// PAYMENTS: real PayPal Orders API v2 order creation (2026-08-27).
// This is the FIFTH and FINAL provider adapter of this directive.
//
// Deployed with verify_jwt=true -- mirrors stripe-create-checkout-session's/
// paymob-create-checkout-session's/kashier-create-checkout-session's/
// fawry-create-checkout-session's authorization pattern exactly: the
// client supplies only `transaction_id`, an already-staged
// payment_gateway_transactions row created by start_gateway_checkout()
// (which independently validated amount vs. outstanding balance and
// invoice.view permission). Nothing about amount/currency/invoice is
// trusted from the client in this function; everything is RE-FETCHED
// from the staged transaction row itself, and authorization is
// independently RE-VERIFIED server-side via
// get_gateway_transaction_status() called through the CALLER's own JWT.
//
// PAYPAL API SHAPE -- OFFICIAL DOC VERIFIED, cross-checked across
// developer.paypal.com and docs.paypal.ai mirrors (see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "PayPal" section):
//   1. OAuth2: POST {base}/v1/oauth2/token, Basic auth of
//      client_id:client_secret, body `grant_type=client_credentials`,
//      response {access_token, token_type: "Bearer", expires_in, ...}.
//   2. Orders v2 create: POST {base}/v2/checkout/orders,
//      purchase_units[].amount.{currency_code,value},
//      purchase_units[].custom_id, payment_source.paypal.
//      experience_context.{return_url,cancel_url}. Response: id,
//      status (CREATED|SAVED|APPROVED|VOIDED|COMPLETED|
//      PAYER_ACTION_REQUIRED), links[] with rel:"approve" (or
//      "payer-action" on newer responses) as the customer redirect.
//
// CUSTOM_ID CHOICE -- `purchase_units[0].custom_id` (NOT invoice_id) is
// set to the Mal3aby transaction id. Reasoning: PayPal's own webhook
// event payloads for BOTH order-level events (CHECKOUT.ORDER.APPROVED,
// whose `resource` IS the order and directly exposes
// `purchase_units[].custom_id`) AND capture-level events
// (PAYMENT.CAPTURE.COMPLETED/DENIED/REFUNDED, whose `resource` is a
// Capture object that carries its own top-level `custom_id` -- PayPal
// copies custom_id from the purchase unit onto the resulting capture
// resource, OFFICIAL DOC VERIFIED on the Captures resource schema)
// consistently expose custom_id at a stable, predictable path. Using
// invoice_id was considered and rejected: invoice_id has stricter
// PayPal-side uniqueness/format expectations across the merchant
// account (documented as needing to be unique for the payer over time)
// and is not necessary here since custom_id already serves the lookup
// role reliably. This mirrors Stripe's client_reference_id/metadata
// pattern and Paymob's special_reference pattern: a single
// merchant-controlled correlation field usable everywhere.
//
// CAPTURE TIMING -- DESIGN DECISION, per this session's own research
// trail: PayPal's `CHECKOUT.ORDER.APPROVED` webhook event is a
// standard, reliably-fired event (fired server-to-server by PayPal the
// moment the buyer completes approval, independent of whether the
// buyer's browser ever successfully redirects back to Mal3aby -- this
// is precisely why it is preferred over a client/return-page-triggered
// capture call). paypal-gateway-webhook (this adapter's second
// function) performs the actual POST .../capture call when it receives
// CHECKOUT.ORDER.APPROVED, and ONLY a SUBSEQUENT, independently
// verified PAYMENT.CAPTURE.COMPLETED webhook event ever calls
// record_gateway_payment_service. This function (checkout-session
// creation) and GatewayReturnPage.tsx never call the Capture API and
// never mark anything paid -- consistent with this project's hard rule
// that a redirect landing page is never authoritative for payment
// state. See paypal-gateway-webhook's own header comment for the full
// reasoning and the fallback branch for a race where capture is
// triggered before Mal3aby's webhook handler for ORDER.APPROVED
// finishes (PayPal's own capture call is idempotent -- see that
// function's comments).
//
// NATIVE IDEMPOTENCY: PayPal is one of only two of Mal3aby's five
// providers (alongside Stripe) with genuine native idempotency support
// (payment_gateway_providers.paypal.supports_native_idempotency_key =
// true, confirmed live). The `PayPal-Request-Id` header is sent on the
// Orders API create call, keyed off the Mal3aby transaction id itself,
// so a retried call (e.g. a network-timeout retry from this function)
// converges on the SAME PayPal order rather than creating a duplicate
// -- in addition to, not instead of, Mal3aby's own idempotency_key
// mechanism upstream in start_gateway_checkout().
//
// TWO-CREDENTIAL MAPPING -- Client ID + Client Secret, mirrors the
// two-vault-slot pattern kashier-create-checkout-session established.
// PayPal's OAuth Basic-auth step genuinely needs BOTH values, but only
// the Client Secret is treated as sensitive by PayPal itself (Client
// IDs are routinely shown in PayPal's own dashboard UI and are not
// access-granting on their own -- OAuth also requires the secret).
// This mirrors exactly how Stripe's publishable key goes in
// `public_key` while its secret key goes in `secret_vault_id`:
//   - public_key       = PayPal Client ID (not secret; used directly,
//                          no vault round-trip needed)
//   - secret_vault_id  = PayPal Client Secret (used for OAuth Basic
//                          auth by ALL THREE PayPal functions)
//   - provider_merchant_ref = PayPal Webhook ID (the id PayPal assigns
//                          when the club owner registers a webhook
//                          subscription in their own PayPal app
//                          dashboard -- required by
//                          verify-webhook-signature, read by
//                          paypal-gateway-webhook only). Confirmed via
//                          live schema inspection this session that
//                          provider_merchant_ref carries no column
//                          doc-comment restricting its meaning, so this
//                          reuse is safe and consistent with how Fawry
//                          uses the same column for its merchantCode.
//   - webhook_secret_vault_id = UNUSED for PayPal (left null) -- PayPal
//                          verification is API-based against a
//                          webhook_id + the 5 request headers, not a
//                          locally-held HMAC secret, so there is no
//                          second "secret" value that would belong in
//                          this slot.
//
// SANDBOX BASE URL: https://api-m.sandbox.paypal.com (OFFICIAL DOC
// VERIFIED). LIVE: https://api-m.paypal.com (OFFICIAL DOC VERIFIED).
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

// OFFICIAL DOC VERIFIED -- developer.paypal.com REST API base hosts.
const PAYPAL_BASE_URL: Record<string, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
}

function sanitizePaypalError(body: unknown): string {
  // Never relay a raw PayPal error body verbatim -- same discipline as
  // the other four adapters' sanitize*Error helpers. PayPal's own
  // error shape is {name, message, details:[{issue,description}],
  // debug_id} -- pluck only known-safe string fields.
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

// Never logged, never returned to the client -- short-lived OAuth
// access token fetched fresh per invocation (no cross-invocation
// caching, keeping this function stateless like the other four
// adapters and avoiding any risk of serving a stale/revoked token).
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

  if (txn.gateway !== 'paypal') {
    return jsonResponse({ error: 'this transaction was not staged for paypal' }, 400)
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
    .select('id, club_id, provider_key, environment, public_key, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== txn.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.enabled || !connection.secret_vault_id) {
    return jsonResponse({ error: 'gateway connection is not enabled or has no credentials configured' }, 400)
  }

  if (!connection.public_key) {
    // public_key holds the PayPal Client ID here -- required alongside
    // the Client Secret for OAuth Basic auth (see file header).
    return jsonResponse({ error: 'gateway connection has no client id configured' }, 400)
  }

  const environment = connection.environment === 'live' ? 'live' : 'sandbox'
  const baseUrl = PAYPAL_BASE_URL[environment]

  // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER SQL
  // RPC -- NOT admin.schema('vault').from('decrypted_secrets'), which
  // was live-tested and found broken for the Stripe adapter (PostgREST
  // does not expose the vault schema on this project). See migration
  // 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
  const { data: clientSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !clientSecret) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  const clientId = connection.public_key

  const tokenResult = await fetchAccessToken(baseUrl, clientId, clientSecret)
  if ('error' in tokenResult) {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `paypal oauth token request failed: ${tokenResult.error}`,
      p_provider_raw_status: null,
    })
    return jsonResponse({ error: 'could not authenticate with paypal' }, 502)
  }
  const accessToken = tokenResult.token

  // PayPal's amount.value is a decimal string, 2dp for USD/EUR/GBP (the
  // only three currencies payment_gateway_providers.paypal documents
  // as supported -- none of them are PayPal's own documented
  // zero-decimal currency list, so no special-casing needed here,
  // unlike Stripe's minor-unit conversion).
  const amountValue = Number(txn.amount).toFixed(2)
  const currencyCode = (txn.currency ?? 'USD').toUpperCase()

  const origin = req.headers.get('origin') ?? Deno.env.get('APP_BASE_URL') ?? ''
  const returnUrl = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=return`
  const cancelUrl = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=cancel`

  const orderRequestBody = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        // custom_id -- see file header for why this (not invoice_id)
        // was chosen as the correlation field paypal-gateway-webhook
        // resolves the staged transaction from.
        custom_id: transactionId,
        amount: {
          currency_code: currencyCode,
          value: amountValue,
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          user_action: 'PAY_NOW',
        },
      },
    },
  }

  let paypalResponse: Response
  try {
    paypalResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        // Native idempotency (see file header) -- keyed off the
        // Mal3aby transaction id so a retried call converges on the
        // SAME PayPal order rather than creating a duplicate.
        'PayPal-Request-Id': `mal3aby-checkout-${transactionId}`,
      },
      body: JSON.stringify(orderRequestBody),
    })
  } catch {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: 'paypal order creation: network error contacting paypal',
      p_provider_raw_status: null,
    })
    return jsonResponse({ error: 'could not reach paypal' }, 502)
  }

  const paypalBody = await paypalResponse.json().catch(() => null)

  if (!paypalResponse.ok || typeof paypalBody?.id !== 'string') {
    const sanitizedMessage = sanitizePaypalError(paypalBody)
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `paypal order creation failed: ${sanitizedMessage}`,
      p_provider_raw_status: String(paypalResponse.status),
    })
    return jsonResponse({ error: sanitizedMessage }, 502)
  }

  // Extract the approve link -- fail closed if neither documented
  // relation is present, same "don't guess a field name" discipline as
  // fawry-create-checkout-session's own redirect-URL gap handling.
  const links = Array.isArray(paypalBody.links) ? paypalBody.links : []
  const approveLink = links.find(
    (l: Record<string, unknown>) => l && (l.rel === 'approve' || l.rel === 'payer-action'),
  ) as { href?: string } | undefined

  if (!approveLink?.href) {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: 'paypal order response did not contain an approve/payer-action link',
      p_provider_raw_status: String(paypalBody.status ?? ''),
    })
    return jsonResponse({ error: 'paypal did not return a recognizable checkout redirect URL' }, 502)
  }

  // Persist provider_session_ref = PayPal's order id -- this is the
  // PRIMARY correlation value paypal-gateway-webhook and
  // paypal-create-refund both rely on (order id for
  // capture/lookup purposes; the capture id is resolved and stored
  // separately once CHECKOUT.ORDER.APPROVED is captured).
  const { error: updateError } = await admin
    .from('payment_gateway_transactions')
    .update({ provider_session_ref: paypalBody.id, updated_at: new Date().toISOString() })
    .eq('id', transactionId)
    .eq('status', 'pending')

  if (updateError) {
    console.error('failed to persist provider_session_ref', updateError)
  }

  return jsonResponse({ checkout_url: approveLink.href })
})
