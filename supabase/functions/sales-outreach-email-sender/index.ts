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
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const SALES_OUTREACH_FROM_ADDRESS = Deno.env.get('SALES_OUTREACH_FROM_ADDRESS') ?? 'sales@mal3aby.app'

const RESEND_API_URL = 'https://api.resend.com/emails'
const SEND_TIMEOUT_MS = 15_000

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  // This function is invoked by a trusted internal trigger (pg_cron/pg_net
  // or an operator-triggered manual "process queue" action), never
  // directly by a browser client -- verified via the service-role secret
  // passed in the Authorization header, matching how this codebase's other
  // scheduled/service functions (e.g. WhatsApp queue consumers) authenticate.
  const authHeader = req.headers.get('Authorization')
  if (authHeader !== `Bearer ${SERVICE_ROLE_KEY}`) {
    return jsonResponse({ error: 'not authorized' }, 401)
  }

  if (!RESEND_API_KEY) {
    return jsonResponse({ error: 'RESEND_API_KEY not configured -- outreach email sending is unavailable', processed: 0 }, 200)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: claimed, error: claimError } = await admin.rpc('sales_claim_queued_outreach_message')
  if (claimError) {
    return jsonResponse({ error: 'could not claim a queued message' }, 500)
  }
  if (!claimed || claimed.length === 0) {
    return jsonResponse({ processed: 0, detail: 'no queued messages' })
  }

  const msg = claimed[0]

  if (!msg.recipient_email) {
    await admin.rpc('sales_mark_outreach_sent', {
      p_message_id: msg.message_id,
      p_success: false,
      p_error: 'lead has no public_email on file',
    })
    return jsonResponse({ processed: 1, message_id: msg.message_id, outcome: 'failed', reason: 'no_recipient_email' })
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
      return jsonResponse({ processed: 1, message_id: msg.message_id, outcome: 'sent' })
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
    return jsonResponse({ processed: 1, message_id: msg.message_id, outcome: 'failed', status: res.status })
  } catch (err) {
    const detail = err instanceof DOMException && err.name === 'AbortError' ? 'send timed out' : 'send failed unexpectedly'
    await admin.rpc('sales_mark_outreach_sent', {
      p_message_id: msg.message_id,
      p_success: false,
      p_error: detail,
    })
    return jsonResponse({ processed: 1, message_id: msg.message_id, outcome: 'failed', reason: detail })
  }
})
