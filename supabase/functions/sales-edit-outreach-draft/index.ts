// sales-edit-outreach-draft -- DRAFT-1 (owner brief, live QA 2026-09-19/
// 20): sales_edit_outreach_draft() (20260910130000) let an owner edit a
// whatsapp_message draft's text with NO re-check against the commercial
// quality gate (_shared/outreach-quality-gate.ts) every AI-generated
// draft is already held to -- a manual edit could silently reintroduce a
// placeholder, an empty CTA, or an overstated evidence claim, the exact
// defect class the gate exists to catch (see
// 20260904190000_sales_outreach_commercial_quality_gate.sql's own header
// re: the real Elmasry Giza/Gaza-transliteration incident). This Edge
// Function is the fix: it re-runs evaluateOutreachQuality() against the
// EDITED text using the message's own already-persisted `grounding`
// (same deterministic, non-LLM gate, same evidence, no new AI call, no
// quota cost, no new secret access), then calls
// sales_edit_outreach_draft() (now service_role-only,
// 20260920030000_draft1_edit_reruns_quality_gate.sql) with the fresh
// quality_status/quality_gate_result. A quality_rejected edit is still
// SAVED (an owner must be able to see and fix what they typed) but can
// no longer be approved/sent until it passes -- exactly the same
// guarantee sales_approve_outreach_message() already gives generated
// drafts, now also given to edited ones.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { evaluateOutreachQuality } from '../_shared/outreach-quality-gate.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

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

// Same grounding shape sales-ai-offer-generator persists as
// sales_outreach_messages.grounding -- read back here to re-derive the
// exact lowConfidenceSignalKeys/contactMetadataOnlySignalKeys the
// original generation used, so the edit is judged by the same evidence
// standard, not a looser one.
interface StoredGrounding {
  business_name?: string
  signals?: Array<{ signal_key: string; confidence: string }>
  hasPublicEmailContact?: boolean
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

  let body: { message_id?: string; edited_body?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'malformed JSON body' }, 400)
  }

  const { message_id: messageId, edited_body: editedBody } = body

  if (!messageId || typeof messageId !== 'string') {
    return jsonResponse(req, { error: 'message_id is required' }, 400)
  }
  if (!editedBody || typeof editedBody !== 'string' || !editedBody.trim()) {
    return jsonResponse(req, { error: 'edited message body cannot be empty' }, 400)
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

  // Re-authorization here mirrors sales_edit_outreach_draft()'s own
  // permission check -- the RPC itself is now service_role-only (this
  // function is its sole caller), so this is the real enforcement point,
  // not a UI-only guard.
  const { data: isOwner } = await callerClient.rpc('is_platform_owner')
  const { data: hasEditPermission } = await callerClient.rpc('has_platform_permission', { p_key: 'platform.sales.edit' })
  if (!isOwner && !hasEditPermission) {
    return jsonResponse(req, { error: 'not authorized' }, 403)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: message, error: fetchError } = await admin
    .from('sales_outreach_messages')
    .select('id, channel, language, subject, status, grounding')
    .eq('id', messageId)
    .maybeSingle()

  if (fetchError || !message) {
    return jsonResponse(req, { error: 'message not found' }, 404)
  }
  if (!['generated', 'approved'].includes(message.status)) {
    return jsonResponse(req, { error: `message not in generated/approved status (current: ${message.status})` }, 409)
  }

  const grounding = (message.grounding ?? {}) as StoredGrounding
  const signals = grounding.signals ?? []
  const lowConfidenceSignalKeys = signals.filter((s) => s.confidence === 'low').map((s) => s.signal_key)
  const contactMetadataOnlySignalKeys = grounding.hasPublicEmailContact ? ['public_email_contact'] : []

  // groundingPassed is true for the same reason sales-ai-offer-generator
  // sets it true: the grounding evidence itself was already verified at
  // generation time and is unchanged here -- only the wording (body) is
  // being re-judged, not the factual grounding. finishReason is
  // undefined -- there is no provider generation to report a finish
  // reason for; the structural/content checks still run regardless (see
  // outreach-quality-gate.ts's own finishReason doc comment).
  const qualityResult = evaluateOutreachQuality({
    channel: message.channel,
    language: message.language,
    subject: message.subject,
    body: editedBody,
    lowConfidenceSignalKeys,
    groundingPassed: true,
    finishReason: undefined,
    contactMetadataOnlySignalKeys,
    businessName: grounding.business_name ?? '',
  })

  const quality_status = qualityResult.status === 'APPROVAL_READY' ? 'approval_ready' : 'quality_rejected'

  const { error: rpcError } = await admin.rpc('sales_edit_outreach_draft', {
    p_message_id: messageId,
    p_edited_body: editedBody,
    p_quality_status: quality_status,
    p_quality_gate_result: qualityResult,
  })

  if (rpcError) {
    return jsonResponse(req, { error: rpcError.message || 'could not save edit' }, 500)
  }

  return jsonResponse(req, {
    message_id: messageId,
    quality_status,
    quality_gate_result: qualityResult,
  })
})
