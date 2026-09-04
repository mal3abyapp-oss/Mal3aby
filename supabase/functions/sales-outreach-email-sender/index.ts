// sales-outreach-email-sender -- Sales Intelligence Phase 11 SEND step
// (ADR-054, 2026-09-04): the only function in this module that
// actually dispatches an outbound message. Claims one QUEUED,
// channel='email' message at a time via sales_claim_queued_outreach_
// message() (which already refuses any non-email channel and any
// do_not_contact lead at the DB layer -- this function does not
// re-implement that check, it trusts the RPC's own guard, matching
// this codebase's "one source of truth per invariant" convention).
//
// Uses the SAME Resend REST API integration already proven in
// cloudflare/email-worker/src/resend.ts (no SMTP, no SDK dependency,
// same idempotency-key discipline) -- re-implemented here as a plain
// fetch since Cloudflare Worker modules aren't directly importable
// into a Deno Edge Function runtime, but the request shape and error
// classification are intentionally identical.
//
// Called on a schedule (pg_cron -> pg_net, or an external trigger) --
// this function processes ONE queued message per invocation and
// returns immediately; the caller is expected to invoke repeatedly
// (matching the whatsapp-connector's own poll-and-claim pattern) rather
// than looping internally, keeping each invocation short and bounded.
//
// AUTHORIZATION (2026-09-04, first-real-outreach pilot): originally
// this function accepted ONLY the raw service-role bearer token,
// designed for a pg_cron -> pg_net trigger that was never actually
// provisioned (pg_net is not installed on this project). Since there
// is currently no live scheduled trigger, a real platform-owner/staff
// caller must be able to invoke this directly for an explicitly
// human-authorized send -- so this function now ALSO accepts a caller
// JWT authorized via is_platform_owner() or the same
// 'platform.sales.send_outreach' permission that already gates
// sales_queue_outreach_message() (the step immediately before this
// one), matching this codebase's "one source of truth per invariant,
// checked the same way everywhere" convention. The service-role bearer
// path is kept fully intact for when a real scheduled trigger is
// eventually provisioned -- this is additive, not a replacement.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const SALES_OUTREACH_FROM_ADDRESS = Deno.env.get('SALES_OUTREACH_FROM_ADDRESS') ?? 'sales@mal3aby.app'

const RESEND_API_URL = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 15_000

// CORS (2026-09-04, first-real-outreach pilot): this function was
// originally invoked only by a same-origin/server-side trigger
// (service-role bearer, no browser involved), so it never needed CORS
// headers. Now that a real platform-owner/staff browser session can
// also invoke it directly (see the AUTHORIZATION comment on Deno.serve
// below), a browser POST with a JSON body triggers a CORS preflight
// OPTIONS request -- without these headers the browser blocks the call
// entirely, client-side, before it ever reaches this function. Same
// allowed-origins list as sales-ai-offer-generator's own corsHeadersFor().
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

// Plain-text fallback -- strip the minimal markdown-ish formatting the
// AI generator might produce; not a full HTML email template, since
// this is B2B sales outreach content, not a transactional/branded
// notification (those stay on the existing notification_queue/
// email-worker path, untouched by this module).
function toHtml(body: string): string {
  return body
    .split('\n\n')
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeadersFor(req) })
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method not allowed' }, 405)
  }

  // Two valid callers: (1) a trusted internal trigger presenting the raw
  // service-role secret (the original pg_cron/pg_net design, kept for
  // when that trigger is eventually provisioned), or (2) a real,
  // authenticated platform-owner/staff user with 'platform.sales.
  // send_outreach' -- the SAME permission that already gates
  // sales_queue_outreach_message(), the step immediately before this
  // one, so a caller who could queue a message can also trigger its
  // send. Never a bare "any authenticated user" check.
  const authHeader = req.headers.get('Authorization')
  const isServiceRoleCaller = authHeader === `Bearer ${SERVICE_ROLE_KEY}`

  if (!isServiceRoleCaller) {
    if (!authHeader) {
      return jsonResponse(req, { error: 'authentication required' }, 401)
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
    // has_platform_permission() already internally OR's in
    // is_platform_owner() (see 20260826121131_platform_staff_roles_rls_
    // and_helper.sql) -- a single call is the same check every other
    // privileged RPC in this schema performs (`is_platform_owner() or
    // has_platform_permission(key)` is the codebase's own idiom, kept
    // here for readability even though has_platform_permission alone
    // is sufficient).
    const { data: authorized, error: authError } = await callerClient.rpc('has_platform_permission', {
      p_key: 'platform.sales.send_outreach',
    })
    if (authError || !authorized) {
      return jsonResponse(req, { error: 'not authorized' }, 403)
    }
  }

  if (!RESEND_API_KEY) {
    return jsonResponse(req, { error: 'RESEND_API_KEY not configured -- outreach email sending is unavailable', processed: 0 }, 200)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: claimed, error: claimError } = await admin.rpc('sales_claim_queued_outreach_message')
  if (claimError) {
    return jsonResponse(req, { error: 'could not claim a queued message' }, 500)
  }
  if (!claimed || claimed.length === 0) {
    return jsonResponse(req, { processed: 0, detail: 'no queued messages' })
  }

  const msg = claimed[0]

  if (!msg.recipient_email) {
    await admin.rpc('sales_mark_outreach_sent', {
      p_message_id: msg.message_id,
      p_success: false,
      p_error: 'lead has no public_email on file',
    })
    return jsonResponse(req, { processed: 1, message_id: msg.message_id, outcome: 'failed', reason: 'no_recipient_email' })
  }

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `sales-outreach-${msg.message_id}`,
      },
      body: JSON.stringify({
        from: SALES_OUTREACH_FROM_ADDRESS,
        to: msg.recipient_email,
        subject: msg.subject ?? 'Mal3aby',
        html: toHtml(msg.body),
        text: msg.body,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    if (res.ok) {
      const data = await res.json()
      await admin.rpc('sales_mark_outreach_sent', {
        p_message_id: msg.message_id,
        p_success: true,
        p_provider_reference: data?.id ?? null,
      })
      return jsonResponse(req, { processed: 1, message_id: msg.message_id, outcome: 'sent' })
    }

    // Classify like resend.ts: 429/5xx = temporary (leave as failed here;
    // a future retry mechanism can requeue by resetting status to 'approved'
    // -- deliberately not auto-retried in this pass to avoid an
    // uncontrolled resend loop against a real prospect's inbox), 4xx = permanent.
    const errorText = await res.text().catch(() => '')
    await admin.rpc('sales_mark_outreach_sent', {
      p_message_id: msg.message_id,
      p_success: false,
      p_error: `Resend API error ${res.status}: ${errorText.slice(0, 300)}`,
    })
    return jsonResponse(req, { processed: 1, message_id: msg.message_id, outcome: 'failed', status: res.status })
  } catch (err) {
    const detail = err instanceof DOMException && err.name === 'AbortError' ? 'send timed out' : 'send failed unexpectedly'
    await admin.rpc('sales_mark_outreach_sent', {
      p_message_id: msg.message_id,
      p_success: false,
      p_error: detail,
    })
    return jsonResponse(req, { processed: 1, message_id: msg.message_id, outcome: 'failed', reason: detail })
  }
})
