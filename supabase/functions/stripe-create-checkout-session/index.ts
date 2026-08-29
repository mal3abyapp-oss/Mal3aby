// stripe-create-checkout-session -- PHASE 2 MULTI-GATEWAY ONLINE
// PAYMENTS: real Stripe Checkout Session creation (2026-08-27).
//
// Deployed with verify_jwt=true -- unlike stripe-gateway-webhook, this
// function IS called by an authenticated Mal3aby staff/customer
// session (via supabase.functions.invoke, which forwards the caller's
// JWT in the Authorization header). We use the caller's own JWT to
// build a Supabase client scoped to their session so every read this
// function performs is subject to the SAME RLS/permission checks the
// client would get calling the DB directly -- and additionally
// independently re-verify invoice.view authorization server-side
// (never trust that a client passing a transaction_id it doesn't
// actually own would be blocked by RLS alone; we re-check explicitly,
// matching start_gateway_checkout()'s own has_permission('invoice.view', ...)
// gate).
//
// TRUST MODEL: the client supplies only `transaction_id` -- a value
// that already exists server-side (created by start_gateway_checkout(),
// which itself independently validated amount vs. outstanding balance
// and invoice.view permission). Nothing about amount/currency/invoice
// is trusted from the client in this function; everything is
// RE-FETCHED from the staged transaction row itself. The Stripe secret
// key is read from Vault using a service-role client -- never returned
// to, or derivable by, the caller.
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

// Stripe's documented "two-decimal currency" default applies to EGP --
// EGP does NOT appear on Stripe's zero-decimal list (JPY, KRW, VND,
// etc.) or the special-cased list (ISK, HUF, TWD, UGX), confirmed live
// against https://docs.stripe.com/currencies this session (OFFICIAL
// DOC VERIFIED). This is moot in practice today anyway --
// payment_gateway_providers.supported_currencies for 'stripe' is
// ['USD','EUR','GBP'] only (PAYMENT_GATEWAY_PROVIDER_MATRIX.md: Stripe
// does not support Egypt as an account country, so a club's Stripe
// connection can never be staged in EGP in the first place) -- but the
// conversion factor is applied generically here (all three of
// USD/EUR/GBP are ordinary two-decimal currencies, x100) rather than
// hardcoding an assumption that would silently misbehave if the
// provider catalog is ever widened.
const ZERO_DECIMAL_CURRENCIES = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg',
  'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
])

function toStripeMinorUnits(amount: number, currencyLower: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currencyLower)) {
    return Math.round(amount)
  }
  // Round to avoid float artifacts (e.g. 19.99 * 100 = 1998.9999...).
  return Math.round(amount * 100)
}

function sanitizeStripeError(err: unknown): { message: string; type?: string; code?: string } {
  // Stripe errors carry .type/.code/.message that are safe to relay --
  // NEVER relay .raw, .headers, or any embedded request echo (which
  // could contain the Authorization header we sent, i.e. the secret
  // key itself). Only pluck the three known-safe string fields.
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>
    const inner = (e.error && typeof e.error === 'object' ? e.error : e) as Record<string, unknown>
    return {
      message: typeof inner.message === 'string' ? inner.message : 'stripe request failed',
      type: typeof inner.type === 'string' ? inner.type : undefined,
      code: typeof inner.code === 'string' ? inner.code : undefined,
    }
  }
  return { message: 'stripe request failed' }
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

  // Caller-scoped client -- every read through this client is subject
  // to the caller's own RLS policies (club_gateway_connections_select,
  // etc.), exactly as if the client had called the DB directly.
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

  // service-role client -- required to read the transaction/connection
  // rows regardless of RLS (so we can independently authorize below
  // rather than relying solely on RLS having filtered correctly) and
  // to read the Vault-stored secret key.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: txn, error: txnError } = await admin
    .from('payment_gateway_transactions')
    .select('id, club_id, invoice_id, gateway, amount, currency, status, connection_id, provider_session_ref')
    .eq('id', transactionId)
    .maybeSingle()

  if (txnError || !txn) {
    return jsonResponse(req, { error: 'transaction not found' }, 404)
  }

  if (txn.gateway !== 'stripe') {
    return jsonResponse(req, { error: 'this transaction was not staged for stripe' }, 400)
  }

  if (txn.status !== 'pending') {
    // Not an error necessarily (e.g. the customer already completed
    // checkout, or a prior session already exists) -- but this
    // function's job is specifically "create a NEW checkout session",
    // and creating one for a non-pending transaction would risk a
    // second, orphaned Stripe session for an already-resolved
    // Mal3aby-side transaction. Refuse explicitly.
    return jsonResponse(req, { error: `transaction is not pending (status: ${txn.status})` }, 409)
  }

  // Independent server-side re-authorization -- reuse
  // get_gateway_transaction_status(), which performs the EXACT SAME
  // check start_gateway_checkout() itself requires
  // (v_club_id in user_club_ids() and has_permission('invoice.view', v_club_id)),
  // called here through the CALLER-scoped client (their own JWT, not
  // service_role) so it raises "not authorized" for a transaction_id
  // the caller does not actually own -- never trusting that the client
  // only ever passes a transaction_id it's entitled to. This
  // deliberately reuses the same authorization code path rather than
  // re-implementing the has_permission/user_club_ids logic here in
  // TypeScript, where a subtle port mistake could silently diverge
  // from the DB-side check.
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
    .select('id, club_id, provider_key, environment, secret_vault_id, enabled')
    .eq('id', txn.connection_id)
    .maybeSingle()

  if (connError || !connection || connection.club_id !== txn.club_id) {
    return jsonResponse(req, { error: 'gateway connection not found' }, 404)
  }

  if (!connection.enabled || !connection.secret_vault_id) {
    return jsonResponse(req, { error: 'gateway connection is not enabled or has no credentials configured' }, 400)
  }

  // NOTE: reads via get_vault_secret_service(), a SECURITY DEFINER SQL
  // RPC -- NOT admin.schema('vault').from('decrypted_secrets'), which
  // was live-tested and found broken this session (PostgREST does not
  // expose the `vault` schema in this project -- a genuine "Invalid
  // schema: vault" rejection, not an RLS denial). See migration
  // 20260827093045_fix_vault_secret_read_service_role_rpc.sql.
  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: connection.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    return jsonResponse(req, { error: 'could not resolve gateway credentials' }, 500)
  }

  const stripeSecretKey = decryptedSecret

  const currencyLower = txn.currency.toLowerCase()
  const minorUnitAmount = toStripeMinorUnits(Number(txn.amount), currencyLower)

  const origin = req.headers.get('origin') ?? Deno.env.get('APP_BASE_URL') ?? ''
  const successUrl = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=success`
  const cancelUrl = `${origin}/app/finance/gateway-return?transaction_id=${transactionId}&outcome=cancelled`

  // https://docs.stripe.com/api/checkout/sessions/create -- confirmed
  // live this session (OFFICIAL DOC VERIFIED): POST
  // https://api.stripe.com/v1/checkout/sessions, form-urlencoded body,
  // mode=payment, line_items[0][price_data][...], success_url,
  // cancel_url, metadata, client_reference_id all real, current
  // parameters. Idempotency-Key is a REQUEST HEADER (not a body
  // param), keyed here off the Mal3aby transaction id so a retried
  // client call (e.g. a double-click or a network-retry) against the
  // SAME transaction never creates two distinct Stripe Checkout
  // Sessions -- this is on top of, not instead of, Mal3aby's own
  // DB-side idempotency (payment_gateway_transactions.idempotency_key,
  // enforced at start_gateway_checkout() time).
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', successUrl)
  params.set('cancel_url', cancelUrl)
  params.set('client_reference_id', transactionId)
  params.set(`metadata[mal3aby_transaction_id]`, transactionId)
  params.set('line_items[0][price_data][currency]', currencyLower)
  params.set('line_items[0][price_data][unit_amount]', String(minorUnitAmount))
  params.set('line_items[0][price_data][product_data][name]', `Invoice payment (${txn.invoice_id})`)
  params.set('line_items[0][quantity]', '1')

  let stripeResponse: Response
  try {
    stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': `checkout-session:${transactionId}`,
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    })
  } catch (networkErr) {
    // Genuine connection-level failure -- fail closed: mark the
    // transaction failed via the service-role RPC so it never sits in
    // 'pending' forever with no explanation.
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: 'stripe checkout session creation: network error contacting stripe',
      p_provider_raw_status: null,
    })
    return jsonResponse(req, { error: 'could not reach stripe' }, 502)
  }

  const stripeBody = await stripeResponse.json().catch(() => null)

  if (!stripeResponse.ok || !stripeBody?.id || !stripeBody?.url) {
    const sanitized = sanitizeStripeError(stripeBody)
    await admin.rpc('mark_gateway_transaction_failed_service', {
      p_transaction_id: transactionId,
      p_reason: `stripe checkout session creation failed: ${sanitized.type ?? 'error'} - ${sanitized.message}`,
      p_provider_raw_status: sanitized.code ?? null,
    })
    return jsonResponse(req, { error: sanitized.message, type: sanitized.type }, 502)
  }

  // Persist provider_session_ref -- this is EXACTLY what closes the
  // webhook's documented O(N) gap (see PAYMENT_GATEWAY_WEBHOOK_MODEL.md):
  // once this column is populated, stripe-gateway-webhook's first
  // lookup strategy (exact provider_session_ref match) succeeds in a
  // single indexed query instead of falling through to the
  // try-every-connection fallback.
  const { error: updateError } = await admin
    .from('payment_gateway_transactions')
    .update({ provider_session_ref: stripeBody.id, updated_at: new Date().toISOString() })
    .eq('id', transactionId)
    .eq('status', 'pending')

  if (updateError) {
    // We already created a real Stripe session at this point -- do NOT
    // mark the transaction failed (that would orphan a live, payable
    // Stripe session while telling Mal3aby it failed). Log and still
    // return the checkout_url -- the webhook's fallback path (metadata
    // match, then O(N) secret-trial) still correctly resolves this
    // transaction even without provider_session_ref persisted.
    console.error('failed to persist provider_session_ref', updateError)
  }

  return jsonResponse(req, { checkout_url: stripeBody.url })
})
