// mala3by-email-worker -- EMAIL CHANNEL, ZERO-COST TRANSACTIONAL EMAIL
// (2026-08-24). See EMAIL_NOTIFICATION_AUDIT_2026-08-23.md for the
// full read-only audit + Resend/Cloudflare-Email-Sending verification
// this architecture is based on.
//
// This Worker has NO "fetch" handler wired to real public traffic --
// unlike ../frontend-worker (serves the SPA) and ../whatsapp-worker
// (proxies to the WhatsApp connector container), this Worker exists
// purely to run on its own Cron Trigger (wrangler.jsonc's
// "triggers.crons": ["* * * * *"] -- once per minute, never a hot
// loop per directive section 5) and poll Supabase's notification_queue
// table for channel='email' rows, mirroring the whatsapp-connector's
// own poll -> render -> send -> update-status loop -- just stateless,
// since a REST call per email needs no persistent session.
//
// FLOW (directive section 10, "what actually sends the email"):
//   Mal3aby DB (notification_queue, channel='email')
//     -> this Worker's scheduled() handler, on its own Cron Trigger
//     -> email_worker_claim_next_batch() (atomic, service_role RPC)
//     -> renderEmailTemplate() (./templates.ts, same pattern as the
//        WhatsApp connector's own templates.ts)
//     -> sendEmail() (./resend.ts) -> Resend REST API
//     -> email_worker_report_send_result() (service_role RPC)
//     -> recipient's real mail server (Gmail/Outlook/Yahoo/etc.)
//
// SECURITY (directive section 39/51): RESEND_API_KEY and
// SUPABASE_SERVICE_ROLE_KEY are read from env (Cloudflare Worker
// secrets, set via `wrangler secret put`) and used only in this
// file's two outbound calls -- never logged, never included in any
// thrown error text, never written to notification_queue or any
// other table.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { renderEmailTemplate } from './templates.js'
import { sendEmail } from './resend.js'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  RESEND_API_KEY: string
}

const FROM_ADDRESS = 'Mal3aby <notifications@mal3aby.app>'

// Directive section 15: "process the queue in reasonable batches" --
// a small batch per minute is enough headroom for Mal3aby's current
// volume (54 customers total, platform-wide, at the time this was
// built) while staying well inside Resend's free-tier daily/monthly
// limits without hardcoding those numbers into business logic (the
// limits themselves are enforced by Resend returning 429, which
// email_worker_report_send_result already handles via backoff -- this
// batch size just keeps a single Cron invocation short and predictable).
const BATCH_SIZE = 10

interface ClaimedRow {
  id: string
  club_id: string
  recipient_customer_id: string | null
  recipient_email: string
  template_key: string
  language: string
  variables: Record<string, unknown>
  attempts: number
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

    // Lease recovery first -- any row stuck in 'processing' from a
    // prior invocation that died mid-send (directive section 37) gets
    // resolved before this run claims anything new.
    const { error: expireError } = await supabase.rpc('email_worker_expire_stale')
    if (expireError) {
      // Safe to log -- this is a Postgres/PostgREST error object
      // (code/message/hint), never the service_role key itself, which
      // is only ever used in the Authorization header, never echoed
      // into any error payload.
      console.error('email_worker_expire_stale failed', expireError.message, expireError.code)
    }

    const { data: claimed, error: claimError } = await supabase.rpc('email_worker_claim_next_batch', { p_limit: BATCH_SIZE })
    if (claimError) {
      console.error('email_worker_claim_next_batch failed', claimError.message, claimError.code)
      return
    }
    if (!claimed) {
      return
    }

    const rows = claimed as ClaimedRow[]

    // Each row is processed independently -- one bad render/send
    // never blocks the rest of the batch (directive rule 5: "Failure
    // of one must never stop the other"). processRow() itself never
    // throws (its own try/catch covers render errors; sendEmail()
    // never throws either, it returns a discriminated result), so
    // Promise.allSettled is a final backstop, not the primary safety
    // mechanism.
    const work = Promise.allSettled(rows.map((row) => processRow(supabase, env, row)))
    ctx.waitUntil(work)
    await work
  },
}

async function processRow(supabase: SupabaseClient, env: Env, row: ClaimedRow): Promise<void> {
  let rendered: { subject: string; html: string; text: string }
  try {
    rendered = renderEmailTemplate(row.template_key, row.language, row.variables)
  } catch (err) {
    // Unknown template_key or (should never happen given the DB-side
    // guard) an activation_secret present in variables -- permanent,
    // not worth retrying since the payload itself is malformed, not
    // a transient delivery problem.
    await supabase.rpc('email_worker_report_send_result', {
      p_queue_id: row.id,
      p_success: false,
      p_permanent: true,
      p_error: `render_error: ${err instanceof Error ? err.message : 'unknown'}`,
    })
    return
  }

  // Idempotency key (directive section 38) -- deterministic, derived
  // from the queue row id itself, so a retried Resend call for the
  // SAME queue row (e.g. this Worker retried after a timeout but
  // Resend actually received the first request) is recognized by
  // Resend as the same logical send, not a duplicate. This is
  // IN ADDITION TO, never instead of, notification_queue.dedup_key's
  // own DB-level idempotency (which prevents a second queue ROW from
  // ever being created for the same event+channel in the first place).
  const idempotencyKey = `mal3aby-email-${row.id}`

  const result = await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: FROM_ADDRESS,
    to: row.recipient_email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey,
  })

  if (result.outcome === 'sent') {
    console.log('email sent', row.id, row.template_key)
    await supabase.rpc('email_worker_report_send_result', {
      p_queue_id: row.id,
      p_success: true,
      p_provider_reference: result.providerReference || null,
    })
    return
  }

  if (result.outcome === 'rate_limited') {
    await supabase.rpc('email_worker_report_send_result', {
      p_queue_id: row.id,
      p_success: false,
      p_permanent: false,
      p_error: 'rate_limited: Resend returned 429',
      p_retry_after_seconds: result.retryAfterSeconds,
    })
    return
  }

  if (result.outcome === 'permanent_failure') {
    await supabase.rpc('email_worker_report_send_result', {
      p_queue_id: row.id,
      p_success: false,
      p_permanent: true,
      p_error: `permanent_failure: ${result.errorClass} (status ${result.statusCode})`,
    })
    return
  }

  // temporary_failure -- 5xx or network error, bounded-retry via the
  // same backoff ladder every other temporary failure uses.
  await supabase.rpc('email_worker_report_send_result', {
    p_queue_id: row.id,
    p_success: false,
    p_permanent: false,
    p_error: `temporary_failure: ${result.errorClass} (status ${result.statusCode})`,
  })
}
