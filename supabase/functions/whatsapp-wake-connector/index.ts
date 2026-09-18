// whatsapp-wake-connector -- PLATFORM OWNER WHATSAPP QR NOT APPEARING FIX
// (2026-09-18, owner-reported: "واتساب المنصة للمالك لا يظهر الكيو ار").
//
// ROOT CAUSE (confirmed live against production, whatsapp_accounts /
// whatsapp_connection_events): start_whatsapp_pairing() only ever
// writes intent into Postgres (status='connecting'). The connector
// itself runs inside a Cloudflare Container (cloudflare/whatsapp-worker,
// WhatsAppAccountObject) that is allowed to sleep when idle (directive
// rule 77 -- idle accounts genuinely stop costing money). Nothing in
// this codebase previously woke a sleeping container back up when a new
// pairing intent was written: the only code path that calls
// ensureRunning() is the Worker's own /manage/:clubId/start route
// (cloudflare/whatsapp-worker/src/index.ts), and nothing ever called
// it automatically. A club whose container had gone to sleep (this
// exact case: last real connector activity 2026-09-01, after 620
// reconnect attempts were exhausted) would therefore sit at
// status='connecting' forever after any future "Connect"/"Retry"
// click -- the intent is recorded, but the process that would notice
// it (ConnectionRequestPoller, inside the connector) is not running to
// see it.
//
// FIX: this function is the missing wake-up call. The frontend invokes
// it immediately after start_whatsapp_pairing()/retry succeeds; it
// verifies the caller has manage_whatsapp_connection on the given club
// (same permission key start_whatsapp_pairing() itself enforces), then
// calls the whatsapp-worker's /manage/:clubId/start with the
// management token -- which is held ONLY here (Edge Function secret)
// and in the Worker's own secret store, never in frontend code/bundle.
// ensureRunning() is itself idempotent (checks Durable Object storage
// first, short-circuits if already running) -- see its own doc
// comment -- so calling this on every connect/retry click is always
// safe, never causes a duplicate container or duplicate Baileys socket.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WHATSAPP_WORKER_URL = Deno.env.get('WHATSAPP_WORKER_URL')!
const WHATSAPP_WORKER_MANAGEMENT_TOKEN = Deno.env.get('WHATSAPP_WORKER_MANAGEMENT_TOKEN')!

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

  let body: { club_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid request body' }, 400)
  }

  const clubId = body.club_id
  if (!clubId || typeof clubId !== 'string') {
    return jsonResponse({ error: 'club_id is required' }, 400)
  }

  // Caller-scoped client -- resolves the REAL calling user from their
  // own JWT, matching club-staff-admin's own established pattern.
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  if (callerError || !callerData.user) {
    return jsonResponse({ error: 'authentication required' }, 401)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Same permission key start_whatsapp_pairing()/disconnect_whatsapp()
  // themselves enforce -- this function grants no capability beyond
  // "wake a container this caller was already allowed to start".
  const { data: allowed, error: permError } = await admin.rpc('has_permission_as', {
    p_user_id: callerData.user.id,
    p_key: 'manage_whatsapp_connection',
    p_club_id: clubId,
  })
  if (permError || allowed !== true) {
    return jsonResponse({ error: 'not authorized' }, 403)
  }

  try {
    const workerRes = await fetch(`${WHATSAPP_WORKER_URL}/manage/${clubId}/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_WORKER_MANAGEMENT_TOKEN}` },
    })
    if (!workerRes.ok) {
      const text = await workerRes.text().catch(() => '')
      console.error(`whatsapp-wake-connector: worker returned ${workerRes.status} for club ${clubId}: ${text}`)
      return jsonResponse({ error: 'could not start the WhatsApp connector, please try again' }, 502)
    }
  } catch (err) {
    console.error('whatsapp-wake-connector: fetch to whatsapp-worker failed:', err instanceof Error ? err.message : err)
    return jsonResponse({ error: 'could not reach the WhatsApp connector service' }, 502)
  }

  return jsonResponse({ ok: true })
})
