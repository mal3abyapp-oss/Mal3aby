// fawry-create-checkout-session -- PHASE 2 MULTI-GATEWAY ONLINE
// PAYMENTS: real Fawry Express Checkout Link charge creation
// (2026-08-27).
//
// Deployed with verify_jwt=true -- mirrors stripe-create-checkout-session's/
// paymob-create-checkout-session's/kashier-create-checkout-session's
// authorization pattern exactly: the client supplies only
// `transaction_id`, an already-staged payment_gateway_transactions row
// created by start_gateway_checkout() (which independently validated
// amount vs. outstanding balance and invoice.view permission). Nothing
// about amount/currency/invoice is trusted from the client in this
// function; everything is RE-FETCHED from the staged transaction row
// itself, and authorization is independently RE-VERIFIED server-side
// via get_gateway_transaction_status() called through the CALLER's own
// JWT.
//
// FAWRY HAS (AT LEAST) THREE STRUCTURALLY DIFFERENT PAYMENT PRODUCTS --
// see PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Fawry update" section for the
// full research trail. This function implements ONLY the "Express
// Checkout Link" product (OFFICIAL DOC VERIFIED 2026-08-27, verbatim
// quotes from developer.fawrystaging.com/docs/express-checkout/fawrypay-hosted-checkout):
//   "trigger FawryPay API below with the Charge Request, Fawry will
//   respond with a redirect URL to redirect your customer to."
// This is a genuine SERVER-TO-SERVER call-and-get-a-redirect-URL flow
// -- the SAME shape as Stripe's/Kashier's checkout-session creation --
// NOT Fawry's separate "Checkout Button" product, which is a
// client-side <script>/FawryPay.checkout(...) JS SDK embed (confirmed
// genuinely different by that product's own doc page). Mal3aby never
// embeds Fawry JS in its own frontend.
//
// REJECTED ALTERNATIVES (confirmed via research, not assumed):
//   - Raw-card charge (paymentMethod: "CARD" with cardNumber/cvv in
//     the REQUEST body) -- Fawry's own docs require PCI-DSS compliance
//     to collect card data this way. Mal3aby never handles raw card
//     data. Never a candidate.
//   - PAYATFAWRY reference-number charge -- returns a referenceNumber
//     for payment at a physical retail/kiosk point, NOT a real-time
//     online redirect. This is the "kiosk/cash-voucher" shape the task
//     brief anticipated as a possibility; it is real but is NOT used
//     here.
//
// ENDPOINT AND SIGNATURE -- OFFICIAL DOC VERIFIED 2026-08-27 (see
// PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Fawry update" section for full
// source URLs and independent cross-checks against the real
// open-source `fawry-api/fawry` Ruby gem):
//   POST {base_url}/payments/charge
//   Body: merchantCode, merchantRefNum, customerProfileId (optional),
//     customerMobile, customerEmail, customerName, paymentExpiry,
//     language, chargeItems (array), returnUrl, orderWebHookUrl,
//     authCaptureModePayment, signature.
//   Signature (OUTBOUND, genuinely DIFFERENT field set from the
//   inbound notification signature -- confirmed, not assumed to
//   match): SHA-256 of merchantCode + merchantRefNum + customerProfileId
//   (or "" if absent) + returnUrl + itemId+quantity+price (2dp) for
//   each chargeItem IN ITEMID-SORTED ORDER + secureKey. Mal3aby always
//   sends exactly ONE chargeItem (the staged transaction itself), so
//   the multi-item sort is implemented for correctness but is not
//   exercised by any current call site.
//
// GENUINE, DISCLOSED DOCUMENTATION GAP: the exact response field name
// holding the redirect URL is NOT shown in any code block on the
// fetched Express-Checkout-Link doc page (confirmed via a
// verbatim-quote-only re-fetch this session -- the page describes the
// REQUEST shape and the POST-REDIRECT-BACK shape in detail, but not
// the initial trigger-call's own response). This function therefore
// accepts EITHER `nextAction.redirectUrl` (CONFIRMED verbatim on
// Fawry's separate 3DS card-charge doc page,
// `server-apis/create-payment-3ds-apis`, real example:
// `{"type":"ChargeResponse","nextAction":{"type":"THREE_D_SECURE","redirectUrl":"..."},"statusCode":200,...}`)
// OR a plain top-level `redirectUrl`, and FAILS CLOSED with an honest
// error if NEITHER shape is present -- never guesses a field name and
// silently sends a customer to `undefined`. A future session with real
// credentials should confirm this first (the single highest-value
// open question for this adapter).
//
// CURRENCY/AMOUNT: major-unit decimal, 2dp (e.g. 580.55 EGP) --
// OFFICIAL DOC VERIFIED across every fetched Fawry example. NOT
// minor-unit cents (unlike Paymob).
//
// SANDBOX: no self-service signup exists (re-confirmed live 2026-08-27
// at developer.fawrystaging.com/docs/get-started -- manual merchant
// registration, ~2 business day turnaround, unchanged from the prior
// session's finding). Nothing in this function has been exercised
// against a real Fawry account -- see PAYMENT_GATEWAY_PROVIDER_MATRIX.md
// "What genuinely could not be tested" for the exact, honest evidence
// ceiling.
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

// Base URLs -- CODE VERIFIED against the real, open-source
// `fawry-api/fawry` Ruby gem's connection.rb, cross-confirmed against
// Fawry's own refund-endpoint doc page's own example URL (which uses
// the singly-slashed form -- the gem's sandbox constant has a literal
// double-slash typo, `.../Fawry//payments/...`, not reproduced here).
// LIVE base URL is CODE VERIFIED (matches the gem's constant, and is
// structurally consistent with the sandbox host) but NOT independently
// pinged this session -- flagged for a future live-mode connection to
// re-confirm first.
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
  // Never relay a raw Fawry error body verbatim -- same discipline as
  // sanitizePaymobError/sanitizeKashierError.
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.statusDescription === 'string') return b.statusDescription
    if (typeof b.message === 'string') return b.message
  }
  return 'fawry request failed'
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

  if (txn.gateway !== 'fawry') {
    return jsonResponse({ error: 'this transaction was not staged for fawry' }, 400)
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
    .select('id, club_id, provider_key, environment, secret_vault_id, provider_merchant_ref, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== txn.club_id) {
    return jsonResponse({ error: 'gateway connection not found' }, 404)
  }

  if (!connection.enabled || !connection.secret_vault_id) {
    return jsonResponse({ error: 'gateway connection is not enabled or has no credentials configured' }, 400)
  }

  if (!connection.provider_merchant_ref) {
    // provider_merchant_ref holds Fawry's merchantCode -- REQUIRED for
    // both the request body and the signature.
    return jsonResponse({ error: 'gateway connection has no merchant code configured' }, 400)
  }

  const environment = connection.environment === 'live' ? 'live' : 'sandbox'
  const baseUrl = FAWRY_BASE_URL[environment]

  // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER SQL
  // RPC -- NOT admin.schema('vault').from('decrypted_secrets'), which
  // was live-tested and found broken for the Stripe adapter (PostgREST
  // does not expose the vault schema on this project). See migration
  // 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
  //
  // secret_vault_id holds Fawry's Secure Hash Key here -- Fawry has
  // only ONE secret serving every purpose (charge signing, refund
  // signing, notification verification), same single-secret shape as
  // Paymob (unlike Kashier's genuine two-key split).
  const { data: secureKey, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !secureKey) {
    return jsonResponse({ error: 'could not resolve gateway credentials' }, 500)
  }

  const merchantCode = connection.provider_merchant_ref

  // EGP is the only currency payment_gateway_providers.fawry
  // documents as supported -- major-unit decimal, 2dp (OFFICIAL DOC
  // VERIFIED, e.g. Fawry's own example amount "580.55"). No
  // zero-decimal / minor-unit conversion, unlike Paymob's amount_cents.
  const itemPrice = Number(txn.amount)
  const itemQuantity = 1
  // A single, stable, Mal3aby-controlled itemId derived from the
  // transaction id itself -- Fawry's chargeItems.itemId is a
  // merchant-defined string, not a provider-assigned value, so this
  // is safe to set deterministically (also keeps the multi-item
  // sort-by-itemId rule trivially satisfied for Mal3aby's own
  // single-item carts).
  const chargeItemId = `mal3aby-${transactionId}`

  const origin = req.headers.get('origin') ?? Deno.env.get('APP_BASE_URL') ?? ''
  const returnUrl = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=return`
  // orderWebHookUrl: Fawry's asynchronous server-to-server Notification
  // V2 callback -- this is the URL fawry-gateway-webhook is deployed
  // at. Built from SUPABASE_URL rather than trusting any
  // client-controlled value.
  const orderWebHookUrl = `${SUPABASE_URL}/functions/v1/fawry-gateway-webhook`

  // customerProfileId is OPTIONAL per Fawry's own docs -- Mal3aby does
  // not maintain a Fawry-specific customer profile id, so this is
  // always absent, and the signature construction below uses "" for
  // it exactly as Fawry's own documented rule specifies ("if exists,
  // otherwise insert \"\"").
  const customerProfileId: string | null = null

  // OUTBOUND signature -- OFFICIAL DOC VERIFIED 2026-08-27 (see this
  // function's header comment and PAYMENT_GATEWAY_PROVIDER_MATRIX.md
  // "Fawry update" section): SHA-256 of merchantCode + merchantRefNum +
  // customerProfileId(or "") + returnUrl + itemId+quantity+price(2dp)
  // for each chargeItem in itemId-sorted order + secureKey. A single
  // chargeItem here, so the sort is a no-op but implemented for
  // correctness (see file header).
  const chargeItemsForSignature = [{ itemId: chargeItemId, quantity: itemQuantity, price: itemPrice }].sort((a, b) =>
    a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0,
  )
  const itemsSignaturePart = chargeItemsForSignature
    .map((item) => `${item.itemId}${item.quantity}${twoDp(item.price)}`)
    .join('')
  const signatureInput =
    `${merchantCode}${transactionId}${customerProfileId ?? ''}${returnUrl}${itemsSignaturePart}${secureKey}`
  const signature = await sha256Hex(signatureInput)

  const chargeRequestBody: Record<string, unknown> = {
    merchantCode,
    merchantRefNum: transactionId,
    customerProfileId: customerProfileId ?? undefined,
    language: 'en-gb',
    chargeItems: [
      {
        itemId: chargeItemId,
        description: `Mal3aby invoice payment (${transactionId})`,
        price: itemPrice,
        quantity: itemQuantity,
      },
    ],
    returnUrl,
    orderWebHookUrl,
    // authCaptureModePayment left at Fawry's own default (false) --
    // Mal3aby's adapter does not use the separate auth/capture flow
    // (see PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Fawry update" section,
    // Refund signature sub-section, for why the
    // authorized-but-uncaptured-cannot-be-refunded constraint is N/A
    // here).
    signature,
  }

  let fawryResponse: Response
  try {
    fawryResponse = await fetch(`${baseUrl}/payments/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chargeRequestBody),
    })
  } catch {
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: 'fawry charge creation: network error contacting fawry',
      p_provider_raw_status: null,
    })
    return jsonResponse({ error: 'could not reach fawry' }, 502)
  }

  const fawryBody = await fawryResponse.json().catch(() => null)

  if (!fawryResponse.ok) {
    const sanitizedMessage = sanitizeFawryError(fawryBody)
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `fawry charge creation failed: ${sanitizedMessage}`,
      p_provider_raw_status: String(fawryResponse.status),
    })
    return jsonResponse({ error: sanitizedMessage }, 502)
  }

  // GENUINE, DISCLOSED DOCUMENTATION GAP (see file header): the exact
  // response field name for the redirect URL was not confirmed in
  // Fawry's own fetched docs for THIS specific endpoint. Accept EITHER
  // documented shape seen elsewhere in Fawry's docs, fail closed on
  // neither.
  const redirectUrl: string | null =
    (fawryBody?.nextAction?.type === 'THREE_D_SECURE' && typeof fawryBody?.nextAction?.redirectUrl === 'string'
      ? fawryBody.nextAction.redirectUrl
      : null) ?? (typeof fawryBody?.redirectUrl === 'string' ? fawryBody.redirectUrl : null)

  if (!redirectUrl) {
    // Fawry accepted the request (HTTP ok) but did not return a
    // redirect URL in either of the two documented shapes this
    // adapter knows about -- fail closed rather than guessing. This
    // is the single highest-value thing a future session with real
    // credentials should confirm first (see
    // PAYMENT_GATEWAY_PROVIDER_MATRIX.md "Fawry update" section).
    const sanitizedMessage = sanitizeFawryError(fawryBody)
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `fawry charge response did not contain a recognizable redirect URL: ${sanitizedMessage}`,
      p_provider_raw_status: String(fawryResponse.status),
    })
    return jsonResponse({ error: 'fawry did not return a recognizable checkout redirect URL' }, 502)
  }

  // Persist provider_session_ref -- Fawry's own referenceNumber
  // (fawryRefNumber) is not necessarily present on the initial
  // trigger-call response (it is confirmed present on the
  // POST-REDIRECT-BACK and Notification V2 payloads); merchantRefNum
  // is ALREADY the Mal3aby transaction id itself (set above), which is
  // the PRIMARY lookup key fawry-gateway-webhook uses -- so
  // provider_session_ref here is best-effort only (Fawry's own
  // referenceNumber if present on this response) and is unconditionally
  // overwritten by fawry-gateway-webhook's success handler with the
  // REAL fawryRefNumber once a notification arrives, exactly mirroring
  // Paymob's/Kashier's own "webhook hands off the real provider
  // reference" pattern.
  const bestEffortProviderRef =
    typeof fawryBody?.referenceNumber === 'string' || typeof fawryBody?.referenceNumber === 'number'
      ? String(fawryBody.referenceNumber)
      : null

  if (bestEffortProviderRef) {
    const { error: updateError } = await admin
      .from('payment_gateway_transactions')
      .update({ provider_session_ref: bestEffortProviderRef, updated_at: new Date().toISOString() })
      .eq('id', transactionId)
      .eq('status', 'pending')

    if (updateError) {
      console.error('failed to persist provider_session_ref', updateError)
    }
  }

  return jsonResponse({ checkout_url: redirectUrl })
})
