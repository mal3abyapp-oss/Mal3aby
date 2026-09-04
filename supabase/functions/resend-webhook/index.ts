// resend-webhook -- Sales Intelligence Phase 4 reply-path pipeline
// (2026-09-04): receives Resend's inbound webhook events (delivery
// lifecycle + inbound replies) and turns them into
// sales_outreach_events rows via sales_record_outreach_event(), which
// itself drives the Phase 14 automatic follow-up cancellation.
//
// Deployed with verify_jwt=false -- Resend calls this endpoint directly
// with no Supabase session/JWT, exactly like this codebase's other
// payment-gateway webhooks (stripe-gateway-webhook, paypal-gateway-webhook,
// etc.). Resend authenticates ITSELF to us via Svix-format signature
// headers instead (svix-id / svix-timestamp / svix-signature), keyed by
// the per-webhook signing secret Resend hands back at webhook-creation
// time and stored here as a vault reference
// (sales_email_webhook_config.secret_vault_id) -- same
// verify-locally-with-HMAC discipline as stripe-gateway-webhook, adapted
// to Resend/Svix's specific signing scheme (see verifySvixSignature
// below), NOT PayPal's verify-via-API scheme (Resend/Svix has no such
// endpoint -- local HMAC verification is the only documented option:
// https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests).
//
// SVIX SIGNING SCHEME (documented, verified against Resend's own docs
// text before writing this):
//   Headers: svix-id, svix-timestamp (unix seconds), svix-signature
//     (space-separated list of "v1,<base64 sig>" values -- Svix can
//     send multiple signatures during secret rotation; any ONE valid
//     match is accepted, matching Svix's own documented verification
//     algorithm).
//   Signed content: `${svix-id}.${svix-timestamp}.${raw_body}`
//   Secret: the whsec_... value Resend/Svix issues, BASE64-encoded
//     after stripping the "whsec_" prefix (per Svix's documented
//     "the secret is base64 encoded, remove the whsec_ prefix before
//     base64-decoding" rule) -- decoded to raw bytes and used as the
//     HMAC-SHA256 key.
//   Expected signature: base64(HMAC-SHA256(decoded_secret, signed_content))
//
// TRUST MODEL, SPELLED OUT (same discipline as every other webhook in
// this codebase): nothing this function reads from the request is
// trusted for any WRITE decision until the Svix signature has been
// verified using the stored secret. sales_record_outreach_event() is
// itself independently authorization-gated (service_role bypass is the
// SAME auth.uid()-is-null discriminator proven correct elsewhere in this
// module) -- but that gate only proves "a trusted service-role caller
// made this call", it does NOT re-verify the Resend signature itself,
// so signature verification in THIS function is the only thing standing
// between an attacker and a forged reply/bounce/do-not-contact event.
// Also STALE-TIMESTAMP GUARDED: a svix-timestamp more than 5 minutes
// old or in the future is rejected even with a valid signature, per
// Svix's own documented replay-protection recommendation.
//
// REPLY-CONTENT CLASSIFICATION SCOPE BOUNDARY (reported honestly, not
// silently skipped): Resend's `email.received` event delivers the raw
// inbound email (from/to/subject/text/html), but this function does
// NOT run automated NLP/sentiment/intent classification over that text
// to auto-select POSITIVE_REPLY vs NEGATIVE_REPLY vs DEMO_REQUESTED vs
// etc. Two reasons: (1) the $0 AI-budget mandate (Groq is configured
// for OFFER GENERATION, not wired for a second, different classification
// task in this pass -- doing so silently would be scope creep on a
// safety-relevant judgment call), and (2) misclassifying a reply (e.g.
// reading a real "please remove me" as neutral) has real consequences
// for the do-not-contact guarantee, which this mission treats as
// inviolable. So: `email.received` events are recorded as a NEUTRAL
// 'requested_information' placeholder event (the safest default -- it
// stops the follow-up-cancellation trigger from firing incorrectly...
// actually per Phase 14 ANY reply should cancel pending follow-ups, so
// 'requested_information' is deliberately IN the is_reply taxonomy,
// which is what we want) WITH THE FULL RAW EMAIL BODY preserved in
// raw_payload/reply_excerpt for a human platform-staff member to review
// and RECLASSIFY via sales_record_outreach_event() from the Sales UI
// (Phase 17) if the true intent is DO_NOT_CONTACT, NEGATIVE_REPLY, etc.
// This is a genuine, reported gap -- automated reply-intent
// classification is not implemented -- but the SAFETY property (a
// reply always cancels the follow-up, a human always sees the actual
// text) holds regardless.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, svix-id, svix-timestamp, svix-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_TIMESTAMP_SKEW_SECONDS = 300 // 5 minutes, per Svix's documented replay-protection recommendation

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// Constant-time comparison over base64 STRINGS -- same rationale as
// stripe-gateway-webhook's constantTimeHexEqual (never `===` on a
// value derived from a secret comparison), adapted from hex to base64
// alphabet since Svix signatures are base64, not hex.
function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

async function hmacSha256Base64(keyBytes: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const messageBytes = new TextEncoder().encode(message)
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, messageBytes)
  return bytesToBase64(new Uint8Array(signature))
}

// Verifies a Svix-signed webhook request. Returns true only if AT LEAST
// ONE of the space-separated `v1,<sig>` values in svix-signature matches
// the locally computed HMAC, AND the timestamp is within the allowed
// skew window. Fails closed on any parsing error.
async function verifySvixSignature(
  secret: string, // raw whsec_... value as issued by Resend/Svix
  svixId: string,
  svixTimestamp: string,
  svixSignature: string,
  rawBody: string,
): Promise<boolean> {
  const tsNum = Number(svixTimestamp)
  if (!Number.isFinite(tsNum)) return false
  const nowSeconds = Date.now() / 1000
  if (Math.abs(nowSeconds - tsNum) > MAX_TIMESTAMP_SKEW_SECONDS) return false

  if (!secret.startsWith('whsec_')) return false
  const secretB64 = secret.slice('whsec_'.length)
  let keyBytes: Uint8Array
  try {
    keyBytes = base64ToBytes(secretB64)
  } catch {
    return false
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`
  const expectedSig = await hmacSha256Base64(keyBytes, signedContent)

  const candidates = svixSignature
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith('v1,') ? part.slice('v1,'.length) : null))
    .filter((v): v is string => v !== null)

  return candidates.some((candidate) => constantTimeStringEqual(candidate, expectedSig))
}

// Maps a Resend event `type` to this module's sales_outreach_events
// taxonomy. Delivery-lifecycle events map 1:1 (factual, unambiguous).
// email.received (an actual reply) maps to 'requested_information' as
// the safe neutral default -- see file header's REPLY-CONTENT
// CLASSIFICATION SCOPE BOUNDARY. Anything else is acknowledged but not
// recorded as a sales_outreach_events row (e.g. email.opened/clicked --
// tracking is disabled on this domain per Resend's own get-domain
// output, open_tracking/click_tracking both false, so these should not
// arrive in practice, but are handled defensively regardless).
function mapResendEventType(resendType: string): { eventType: string; isReplyLike: boolean } | null {
  switch (resendType) {
    case 'email.delivered':
      return { eventType: 'delivered', isReplyLike: false }
    case 'email.delivery_delayed':
      return { eventType: 'delivery_delayed', isReplyLike: false }
    case 'email.bounced':
      return { eventType: 'bounced', isReplyLike: false }
    case 'email.complained':
      return { eventType: 'complained', isReplyLike: false }
    case 'email.failed':
      return { eventType: 'failed', isReplyLike: false }
    case 'email.received':
      return { eventType: 'requested_information', isReplyLike: true }
    default:
      return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  const svixId = req.headers.get('svix-id')
  const svixTimestamp = req.headers.get('svix-timestamp')
  const svixSignature = req.headers.get('svix-signature')

  if (!svixId || !svixTimestamp || !svixSignature) {
    return jsonResponse({ error: 'missing required svix signature headers' }, 400)
  }

  const rawBody = await req.text()

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: webhookConfig, error: configError } = await admin
    .from('sales_email_webhook_config')
    .select('enabled, secret_vault_id')
    .eq('id', true)
    .maybeSingle()

  if (configError || !webhookConfig?.enabled || !webhookConfig.secret_vault_id) {
    // Fails closed -- if the webhook isn't configured, nothing can be
    // verified, so nothing is trusted. Distinct 200 (not 400/401) so
    // Resend does not endlessly retry a delivery this deployment simply
    // isn't configured to accept yet -- matches this codebase's other
    // "provider not configured -- acknowledge, do not error" convention
    // (e.g. sales-outreach-email-sender's RESEND_API_KEY-missing branch).
    return jsonResponse({ received: true, ignored: true, reason: 'webhook not configured' })
  }

  const { data: secret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: webhookConfig.secret_vault_id,
  })
  if (secretError || !secret) {
    return jsonResponse({ received: true, ignored: true, reason: 'signing secret unavailable' })
  }

  const verified = await verifySvixSignature(secret, svixId, svixTimestamp, svixSignature, rawBody)
  if (!verified) {
    // Deliberately NOT logged to sales_outreach_events -- an unverified
    // request proves nothing trustworthy, same discipline as every
    // other webhook in this codebase.
    return jsonResponse({ error: 'signature verification failed' }, 400)
  }

  // From here on, PROVEN to have been sent by Resend for this
  // platform's own registered webhook subscription.
  let payload: Record<string, unknown> | null = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ error: 'malformed JSON body' }, 400)
  }
  if (!payload) {
    return jsonResponse({ received: true, ignored: true })
  }

  const resendType = typeof payload.type === 'string' ? payload.type : null
  const data = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>

  if (!resendType) {
    return jsonResponse({ error: 'missing type on webhook envelope' }, 400)
  }

  const mapped = mapResendEventType(resendType)
  if (!mapped) {
    // Unrecognized/untracked event type -- acknowledge without action,
    // fails closed on ambiguity, same as the other webhooks' fallthrough.
    return jsonResponse({ received: true, unrecognized_event_acknowledged: true, resend_type: resendType })
  }

  // Resolve the sales_outreach_messages row this event belongs to.
  // sales-outreach-email-sender sets provider_reference = Resend's own
  // email id at send time -- the SAME id Resend echoes back on every
  // subsequent webhook event for that email (data.email_id, per
  // Resend's documented webhook payload shape). This is the only
  // reliable join key -- Resend does not echo back our own message_id.
  const resendEmailId = typeof data.email_id === 'string' ? data.email_id : null
  if (!resendEmailId) {
    return jsonResponse({ received: true, ignored: true, reason: 'no email_id on event payload' })
  }

  const { data: matchedMessage } = await admin
    .from('sales_outreach_messages')
    .select('id')
    .eq('provider_reference', resendEmailId)
    .eq('channel', 'email')
    .maybeSingle()

  if (!matchedMessage) {
    // No matching outreach message -- this deployment's Resend account
    // may send other, non-sales email too (transactional notifications
    // via cloudflare/email-worker) which share the same domain but are
    // NOT sales_outreach_messages rows. Acknowledge without error --
    // this is an expected, benign case, not a failure.
    return jsonResponse({ received: true, unmatched: true })
  }

  const replyExcerpt = mapped.isReplyLike
    ? [
        typeof data.subject === 'string' ? `Subject: ${data.subject}` : null,
        typeof data.text === 'string' ? data.text.slice(0, 2000) : null,
      ]
        .filter(Boolean)
        .join('\n\n') || null
    : null

  const { data: eventId, error: rpcError } = await admin.rpc('sales_record_outreach_event', {
    p_message_id: matchedMessage.id,
    p_event_type: mapped.eventType,
    p_raw_payload: payload,
    p_reply_excerpt: replyExcerpt,
    p_provider_event_id: svixId, // Resend/Svix's own per-delivery id -- stable per event, used for idempotent dedup via the unique index
  })

  if (rpcError) {
    // A duplicate-delivery conflict on the unique index surfaces here as
    // a Postgres error -- treat as a benign, already-processed duplicate
    // rather than a failure (Resend/Svix webhooks are at-least-once).
    if (rpcError.code === '23505' || /duplicate key/i.test(rpcError.message ?? '')) {
      return jsonResponse({ received: true, duplicate: true })
    }
    return jsonResponse({ received: true, processing_error: rpcError.message })
  }

  return jsonResponse({ received: true, event_id: eventId, event_type: mapped.eventType })
})
