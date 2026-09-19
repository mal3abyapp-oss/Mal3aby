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
import { sendEmail, type SendEmailResult } from './resend.js'

export interface Env {
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  RESEND_API_KEY: string
  SALES_OUTREACH_FROM_ADDRESS?: string
}

const FROM_ADDRESS = 'Mal3aby <notifications@mal3aby.app>'

// SEND-1 fix (2026-09-19, owner brief): sales_outreach_messages (the
// Sales Intelligence module's own outreach queue -- a completely
// separate domain from notification_queue above, never touched by
// this addition) had a real, correct, one-message-at-a-time sender
// (supabase/functions/sales-outreach-email-sender) but nothing ever
// scheduled it -- confirmed live: pg_net is not installed on this
// project, so the pg_cron -> pg_net trigger design that function's own
// comment describes was never viable. Rather than add pg_net as a new
// DB-level dependency, or add a redundant HTTP hop through that Edge
// Function from here, this Worker's own already-running, already-
// proven Cron Trigger (once a minute) now ALSO drives sales outreach
// directly -- same sendEmail() client, same retry/backoff RPC shape
// (sales_mark_outreach_sent, migration 20260919020000, mirrors
// email_worker_report_send_result exactly), completely independent
// queue and independent failure domain from the transactional-email
// path above (a stall or bug in one can never block the other, since
// they're two separate claim/send/report calls with no shared state).
const SALES_OUTREACH_FROM_ADDRESS = 'Mal3aby Sales <sales@mal3aby.app>'
const SALES_OUTREACH_BATCH_SIZE = 5

interface ClaimedSalesOutreachRow {
  message_id: string
  lead_id: string
  subject: string | null
  body: string
  recipient_email: string | null
  language: string
  attempts: number
}

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

    // SEND-1 fix: sales outreach, completely independent of the
    // notification_queue processing above -- its own claim, its own
    // expire-stale, its own send loop. Never awaited together with the
    // block above (each already awaits its own work internally) so a
    // slow/failing run of one never delays the other within this same
    // once-a-minute invocation.
    await processSalesOutreachBatch(supabase, env, ctx)
  },
}

async function processSalesOutreachBatch(supabase: SupabaseClient, env: Env, ctx: ExecutionContext): Promise<void> {
  const { error: expireError } = await supabase.rpc('sales_expire_stale_outreach_processing')
  if (expireError) {
    console.error('sales_expire_stale_outreach_processing failed', expireError.message, expireError.code)
  }

  // One row per claim call (sales_claim_queued_outreach_message's own
  // design, unchanged by this fix -- see its migration comment), so
  // this loops up to SALES_OUTREACH_BATCH_SIZE times per invocation
  // instead of one RPC call returning a batch.
  const rows: ClaimedSalesOutreachRow[] = []
  for (let i = 0; i < SALES_OUTREACH_BATCH_SIZE; i++) {
    const { data: claimed, error: claimError } = await supabase.rpc('sales_claim_queued_outreach_message')
    if (claimError) {
      console.error('sales_claim_queued_outreach_message failed', claimError.message, claimError.code)
      break
    }
    const row = (claimed as ClaimedSalesOutreachRow[] | null)?.[0]
    if (!row) break
    rows.push(row)
  }

  if (rows.length === 0) return

  const work = Promise.allSettled(rows.map((row) => processSalesOutreachRow(supabase, env, row)))
  ctx.waitUntil(work)
  await work
}

interface MarkOutreachSentParams {
  p_message_id: string
  p_success: boolean
  p_provider_reference?: string | null
  p_error?: string | null
  p_permanent?: boolean
  p_retry_after_seconds?: number | null
}

// Pure decision logic -- a SendEmailResult (or the "no recipient"
// pre-check) maps to exactly one sales_mark_outreach_sent() call,
// deterministically, with no side effects. Exported and unit-tested
// directly (see index.test.ts) rather than only exercised indirectly
// through a mocked fetch()/SupabaseClient -- this is the actual new
// SEND-1 logic (which outcomes retry vs. fail permanently, and with
// what backoff hint), the part most worth protecting with a real test.
export function decideMarkOutreachSentParams(messageId: string, recipientEmail: string | null, result?: SendEmailResult): MarkOutreachSentParams {
  if (!recipientEmail) {
    return { p_message_id: messageId, p_success: false, p_permanent: true, p_error: 'lead has no public_email on file' }
  }
  if (!result) {
    throw new Error('decideMarkOutreachSentParams: result is required when recipientEmail is present')
  }
  if (result.outcome === 'sent') {
    return { p_message_id: messageId, p_success: true, p_provider_reference: result.providerReference || null }
  }
  if (result.outcome === 'rate_limited') {
    return {
      p_message_id: messageId,
      p_success: false,
      p_permanent: false,
      p_error: 'rate_limited: Resend returned 429',
      p_retry_after_seconds: result.retryAfterSeconds,
    }
  }
  if (result.outcome === 'permanent_failure') {
    return {
      p_message_id: messageId,
      p_success: false,
      p_permanent: true,
      p_error: `permanent_failure: ${result.errorClass} (status ${result.statusCode})`,
    }
  }
  // temporary_failure
  return {
    p_message_id: messageId,
    p_success: false,
    p_permanent: false,
    p_error: `temporary_failure: ${result.errorClass} (status ${result.statusCode})`,
  }
}

async function processSalesOutreachRow(supabase: SupabaseClient, env: Env, row: ClaimedSalesOutreachRow): Promise<void> {
  if (!row.recipient_email) {
    await supabase.rpc('sales_mark_outreach_sent', decideMarkOutreachSentParams(row.message_id, null))
    return
  }

  const idempotencyKey = `mal3aby-sales-outreach-${row.message_id}`

  const result = await sendEmail({
    apiKey: env.RESEND_API_KEY,
    from: env.SALES_OUTREACH_FROM_ADDRESS || SALES_OUTREACH_FROM_ADDRESS,
    to: row.recipient_email,
    subject: row.subject || 'Mal3aby',
    html: toHtmlParagraphs(row.body),
    text: row.body,
    idempotencyKey,
  })

  if (result.outcome === 'sent') {
    console.log('sales outreach email sent', row.message_id)
  }

  await supabase.rpc('sales_mark_outreach_sent', decideMarkOutreachSentParams(row.message_id, row.recipient_email, result))
}

// Plain-text-ish rendering, matching sales-outreach-email-sender's own
// toHtml() exactly (B2B sales outreach content, not a branded
// transactional template) -- kept here rather than importing across
// Deno/Workers runtime boundaries.
function toHtmlParagraphs(body: string): string {
  return body
    .split('\n\n')
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('\n')
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
