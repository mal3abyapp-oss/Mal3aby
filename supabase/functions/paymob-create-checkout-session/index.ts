// paymob-create-checkout-session -- PHASE 2 MULTI-GATEWAY ONLINE
// PAYMENTS: real Paymob Intentions API checkout creation (2026-08-27).
//
// Deployed with verify_jwt=true -- mirrors stripe-create-checkout-session's
// authorization pattern exactly (see that function's own comment for
// the full trust-model rationale, repeated in short form here): the
// client supplies only `transaction_id`, an already-staged
// payment_gateway_transactions row created by start_gateway_checkout()
// (which independently validated amount vs. outstanding balance and
// invoice.view permission). Nothing about amount/currency/invoice is
// trusted from the client in this function; everything is RE-FETCHED
// from the staged transaction row itself, and authorization is
// independently RE-VERIFIED server-side via get_gateway_transaction_status()
// called through the CALLER's own JWT (never trusting that the client
// only ever passes a transaction_id it is entitled to).
//
// PAYMOB API SHAPE (OFFICIAL DOC VERIFIED 2026-08-27, see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Paymob update" section for full
// source URLs and cross-checks):
//   1. POST {base_url}/v1/intention/ with `Authorization: Token
//      {secret_key}` -- creates a payment intention, returns
//      `client_secret` and Paymob's own intention id (`id`, e.g.
//      `pi_...`) plus `intention_order_id` (Paymob's numeric order id).
//   2. Redirect the customer to
//      `https://eg.checkout.paymob.com/?publicKey={public_key}&clientSecret={client_secret}`
//      (Unified Checkout, hosted -- Mal3aby never touches card data).
//   3. `special_reference` in the intention request is echoed back on
//      the LATER transaction-processed callback as
//      `obj.order.merchant_order_id` (NOT a top-level
//      `special_reference` field on the callback) -- we set it to the
//      Mal3aby transaction id so paymob-gateway-webhook can resolve
//      the staged transaction in O(1), mirroring Stripe's
//      client_reference_id/metadata pattern.
//
// UNLIKE STRIPE: Paymob's hosted checkout URL is NOT returned directly
// by the API -- it must be constructed client-side from the region's
// checkout host + the connection's PUBLIC key (client-safe,
// club_gateway_connections.public_key, already a plain column -- not
// vaulted) + the client_secret from the Intentions API response. Only
// Egypt is wired below (payment_gateway_providers.paymob.supported_countries
// = ['EG'] confirms this is the only region Mal3aby's Paymob
// connections can exist for today; the region-to-host mapping is kept
// as an explicit table rather than a single hardcoded host so a future
// UAE/KSA/Oman connection is a data change, not a code change).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

// CORS tightened (pre-launch hardening, 2026-08-29): this function is
// called only by the authenticated Mal3aby app itself via
// supabase.functions.invoke (JWT-Bearer auth, not browser-ambient
// cookie auth -- so wildcard CORS was never a CSRF vector here, per
// the pre-launch edge-function audit), but a privilege-relevant
// endpoint should still not advertise itself as fetchable from any
// origin as a matter of defense-in-depth. Allowlisted to the real app
// origins plus the local dev server -- never widened to '*' again.
const ALLOWED_ORIGINS = new Set([
  'https://mal3aby.app',
  'https://www.mal3aby.app',
  'http://localhost:5173',
])

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://mal3aby.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeadersFor(req) },
  })
}

// Paymob's Intentions API base URL -- CONFIRMED same base URL for
// sandbox and live (mode is entirely determined by which secret/public
// key pair is used, not the host) -- see PAYMENT_GATEWAY_PROVIDER_MATRIX.md.
const PAYMOB_API_BASE_URL: Record<string, string> = {
  EG: 'https://accept.paymob.com',
}

// Unified Checkout hosted-redirect host -- a DIFFERENT host from the
// API base URL (confirmed live 2026-08-27: eg.checkout.paymob.com, not
// accept.paymob.com).
const PAYMOB_CHECKOUT_HOST: Record<string, string> = {
  EG: 'https://eg.checkout.paymob.com',
}

function sanitizePaymobError(body: unknown): string {
  // Paymob error responses are typically {"detail": "..."} or a field
  // -> [errors] validation map -- never relay the raw body verbatim
  // (it could echo back request fields including anything we sent,
  // though never the secret key itself since that's a header, not a
  // body field -- still, be conservative and only pluck known-safe
  // string shapes).
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.detail === 'string') return b.detail
    if (typeof b.message === 'string') return b.message
  }
  return 'paymob request failed'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeadersFor(req) })
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return jsonResponse(req, { error: 'authentication required' }, 401)
  }

  let body: { transaction_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'malformed JSON body' }, 400)
  }

  const transactionId = body.transaction_id
  if (!transactionId || typeof transactionId !== 'string') {
    return jsonResponse(req, { error: 'transaction_id is required' }, 400)
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser()

  if (userError || !user) {
    return jsonResponse(req, { error: 'invalid or expired session' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: txn, error: txnError } = await admin
    .from('payment_gateway_transactions')
    .select('id, club_id, invoice_id, gateway, amount, currency, status, connection_id, provider_session_ref')
    .eq('id', transactionId)
    .maybeSingle()

  if (txnError || !txn) {
    return jsonResponse(req, { error: 'transaction not found' }, 404)
  }

  if (txn.gateway !== 'paymob') {
    return jsonResponse(req, { error: 'this transaction was not staged for paymob' }, 400)
  }

  if (txn.status !== 'pending') {
    return jsonResponse(req, { error: `transaction is not pending (status: ${txn.status})` }, 409)
  }

  // Independent server-side re-authorization -- same rationale as
  // stripe-create-checkout-session: reuse get_gateway_transaction_status()
  // through the CALLER-scoped client so it raises for a transaction_id
  // the caller does not actually own.
  const { data: statusRows, error: authError } = await callerClient.rpc('get_gateway_transaction_status', {
    p_transaction_id: transactionId,
  })

  if (authError || !statusRows || statusRows.length === 0) {
    return jsonResponse(req, { error: 'not authorized for this transaction' }, 403)
  }

  if (!txn.connection_id) {
    return jsonResponse(req, { error: 'transaction has no linked gateway connection' }, 400)
  }

  const { data: connection, error: connError } = await admin
    .from('club_gateway_connections')
    .select('id, club_id, provider_key, environment, public_key, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== txn.club_id) {
    return jsonResponse(req, { error: 'gateway connection not found' }, 404)
  }

  if (!connection.enabled || !connection.secret_vault_id) {
    return jsonResponse(req, { error: 'gateway connection is not enabled or has no credentials configured' }, 400)
  }

  if (!connection.public_key) {
    // Paymob's Unified Checkout URL requires the public key -- unlike
    // Stripe, where the checkout URL is returned directly by the API.
    // Fail closed rather than constructing a checkout URL that would
    // 404/misbehave on Paymob's hosted page.
    return jsonResponse(req, { error: 'gateway connection has no public key configured' }, 400)
  }

  // Currency/country gating: payment_gateway_providers.paymob is
  // EG/EGP-only today (confirmed via the provider catalog seed) -- we
  // still derive the region from the connection/provider data rather
  // than hardcoding 'EG' at the call site, so a future non-EG Paymob
  // connection fails closed with a clear error instead of silently
  // hitting the wrong regional host.
  const region = 'EG' // TODO(paymob-multi-region): derive from connection once payment_gateway_providers.paymob.supported_countries widens beyond ['EG'].
  const apiBaseUrl = PAYMOB_API_BASE_URL[region]
  const checkoutHost = PAYMOB_CHECKOUT_HOST[region]

  if (!apiBaseUrl || !checkoutHost) {
    return jsonResponse(req, { error: `paymob is not configured for region ${region}` }, 400)
  }

  // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER SQL
  // RPC -- NOT admin.schema('vault').from('decrypted_secrets'), which
  // was live-tested and found broken this session for the Stripe
  // adapter (PostgREST does not expose the vault schema on this
  // project). See migration 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    return jsonResponse(req, { error: 'could not resolve gateway credentials' }, 500)
  }

  const paymobSecretKey = decryptedSecret

  // Paymob's `amount` field is in CENTS (integer minor units) --
  // confirmed live from the documented Create Intention example
  // (amount: 2000 for a 20.00 EGP-shaped transaction). EGP is a
  // standard 2-decimal currency (no zero-decimal special-casing
  // documented for Paymob, unlike Stripe's zero-decimal currency
  // list) -- payment_gateway_providers.paymob.supported_currencies is
  // ['EGP'] only today, so this conversion is safe as written; it is
  // not generalized to other currencies since Paymob's own catalog
  // entry never offers one.
  const amountCents = Math.round(Number(txn.amount) * 100)

  const origin = req.headers.get('origin') ?? Deno.env.get('APP_BASE_URL') ?? ''
  const redirectionUrl = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=return`
  // notification_url: Paymob's asynchronous server-to-server callback
  // -- this is the URL paymob-gateway-webhook is deployed at. Built
  // from SUPABASE_URL rather than trusting any client-controlled
  // value, since this is what Paymob will actually POST provider-
  // confirmed transaction data to.
  const notificationUrl = `${SUPABASE_URL}/functions/v1/paymob-gateway-webhook`

  // payment_methods is REQUIRED by Paymob's Intentions API and must be
  // Integration ID(s) (or quoted method names) configured on the
  // connection -- club_gateway_connections.provider_merchant_ref holds
  // this (documented as "provider's own merchant/account identifier
  // (e.g. Paymob integration ID...)" in that table's own migration
  // comment). Resolved and validated BEFORE constructing the request
  // body below -- fail closed rather than sending an invalid/empty
  // array Paymob would reject anyway.
  const { data: connectionFull } = await admin
    .from('club_gateway_connections')
    .select('provider_merchant_ref')
    .eq('id', connection.id)
    .maybeSingle()

  if (!connectionFull?.provider_merchant_ref) {
    return jsonResponse(req, { error: 'gateway connection has no integration id configured' }, 400)
  }

  // provider_merchant_ref may hold one or more comma-separated
  // Integration IDs (a club may enable more than one payment method
  // integration under the same Paymob account) -- split defensively,
  // Paymob accepts either an integer or a quoted name per method.
  const integrationIds: (number | string)[] = connectionFull.provider_merchant_ref
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (Number.isFinite(Number(s)) ? Number(s) : s))

  if (integrationIds.length === 0) {
    return jsonResponse(req, { error: 'gateway connection has no valid integration id configured' }, 400)
  }

  const intentionPayload = {
    amount: amountCents,
    currency: txn.currency,
    payment_methods: integrationIds,
    special_reference: transactionId,
    notification_url: notificationUrl,
    redirection_url: redirectionUrl,
    billing_data: {
      // Paymob's documented billing_data REQUIRES phone_number; the
      // other fields are accepted but not required per the docs.
      // Mal3aby does not collect a separate "billing address" for
      // online gateway payments -- "dumy"-shaped placeholders are
      // Paymob's OWN documented pattern for optional fields the
      // merchant does not collect (see their own worked example,
      // which uses literal "dumy" for every optional field), used
      // here for the fields we generally do not have on file at
      // checkout-start time for this transaction shape (venue/academy
      // invoice payments are not shipped goods -- there's no real
      // shipping/billing address to collect). phone_number is the one
      // genuinely required field; we do not have a reliable customer
      // phone at this generic RPC layer without an extra join, so a
      // placeholder E.164-shaped value is used and is NEVER treated
      // as real contact data (Paymob does not use it for anything but
      // populating their own dashboard/receipt cosmetics per their
      // docs -- it does not gate transaction success).
      first_name: 'Mal3aby',
      last_name: 'Customer',
      phone_number: '+201000000000',
      email: 'no-reply@mal3aby.app',
      apartment: 'NA',
      floor: 'NA',
      street: 'NA',
      building: 'NA',
      city: 'NA',
      country: 'EG',
      state: 'NA',
    },
  }

  let paymobResponse: Response
  try {
    paymobResponse = await fetch(`${apiBaseUrl}/v1/intention/`, {
      method: 'POST',
      headers: {
        Authorization: `Token ${paymobSecretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(intentionPayload),
      signal: AbortSignal.timeout(15000),
    })
  } catch (networkErr) {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: 'paymob intention creation: network error contacting paymob',
      p_provider_raw_status: null,
    })
    return jsonResponse(req, { error: 'could not reach paymob' }, 502)
  }

  const paymobBody = await paymobResponse.json().catch(() => null)

  if (!paymobResponse.ok || !paymobBody?.client_secret || !paymobBody?.id) {
    const sanitizedMessage = sanitizePaymobError(paymobBody)
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `paymob intention creation failed: ${sanitizedMessage}`,
      p_provider_raw_status: String(paymobResponse.status),
    })
    return jsonResponse(req, { error: sanitizedMessage }, 502)
  }

  // Persist provider_session_ref = Paymob's intention id -- this is
  // the O(1) fallback candidate for paymob-gateway-webhook (the
  // PRIMARY lookup is special_reference/merchant_order_id, set above
  // to the Mal3aby transaction id itself -- an even stronger direct
  // key than Stripe's session-id-based lookup, since it needs no
  // round-trip resolution at all). On a SUCCESSFUL webhook
  // confirmation, record_gateway_payment_service overwrites this
  // column with Paymob's real TRANSACTION id (obj.id from the
  // processed callback) -- which is what the refund endpoint actually
  // requires (transaction_id, not intention id) -- see
  // paymob-gateway-webhook's own comment on this handoff.
  const { error: updateError } = await admin
    .from('payment_gateway_transactions')
    .update({ provider_session_ref: paymobBody.id, updated_at: new Date().toISOString() })
    .eq('id', transactionId)
    .eq('status', 'pending')

  if (updateError) {
    console.error('failed to persist provider_session_ref', updateError)
  }

  const checkoutUrl = `${checkoutHost}/?publicKey=${encodeURIComponent(connection.public_key)}&clientSecret=${encodeURIComponent(paymobBody.client_secret)}`

  return jsonResponse(req, { checkout_url: checkoutUrl })
})
