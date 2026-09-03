// sales-ai-offer-generator -- Sales Intelligence Phase 10 (ADR-054,
// 2026-09-04): personalized offer/outreach content generation from
// VERIFIED lead evidence only. The AI must not invent facts (mission's
// explicit requirement) -- this function builds its prompt exclusively
// from real sales_leads columns and active sales_lead_signals rows
// (each with their own source_url/evidence), and the exact grounding
// payload sent to the model is persisted alongside the generated
// message (sales_outreach_messages.grounding) as a factual-grounding
// audit trail, so any claim in the output can be traced back to real,
// cited evidence.
//
// CONFIGURATION_BLOCKED behavior: if sales_provider_configs.ai_offer_
// generator has no secret_vault_id configured, this function returns a
// distinct 409 CONFIGURATION_BLOCKED response rather than a generic
// error or a silent fallback -- the frontend surfaces this precisely
// (Phase 18/mission's own directive: "if a required paid external
// provider is not already authorized: do not purchase/enable it
// automatically... surface it as configuration required").
//
// This function does NOT call any specific AI provider's SDK inline --
// it uses a plain HTTPS fetch to a configurable endpoint (Anthropic
// Messages API shape by default, since that's this assistant's own
// provider and the most likely first configuration), matching this
// codebase's own "no bundled provider SDKs in Edge Functions, plain
// fetch + AbortSignal.timeout()" convention from every gateway function.
import { createClient } from 'jsr:@supabase/supabase-js@2'

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

const AI_API_TIMEOUT_MS = 30_000

interface LeadEvidence {
  business_name: string
  business_type: string | null
  city: string | null
  country: string | null
  rating: number | null
  review_count: number | null
  branch_count_estimate: number | null
  facility_count_estimate: number | null
  has_academy_presence: boolean | null
  signals: Array<{ signal_key: string; confidence: string; evidence: unknown; source_url: string | null }>
}

// Static pitch guidance per signal (Phase 10's worked examples) --
// grounds the model's talking points in this codebase's own real
// module names, never left to the model to invent Mal3aby feature claims.
const SIGNAL_PITCH_HINTS: Record<string, { en: string; ar: string }> = {
  no_online_booking: {
    en: 'online booking, real-time field availability, booking controls, customer portal, automatic confirmations, and reporting',
    ar: 'الحجز الإلكتروني، توفر الملاعب اللحظي، أدوات التحكم في الحجوزات، بوابة العملاء، التأكيدات التلقائية، والتقارير',
  },
  whatsapp_only_booking: {
    en: 'moving from manual WhatsApp booking to a structured online booking flow with automatic confirmations',
    ar: 'الانتقال من الحجز اليدوي عبر واتساب إلى نظام حجز إلكتروني منظم مع تأكيدات تلقائية',
  },
  phone_only_booking: {
    en: 'reducing phone-booking overhead with self-service online booking',
    ar: 'تقليل عبء الحجز الهاتفي من خلال الحجز الذاتي عبر الإنترنت',
  },
  academy_present: {
    en: 'academy enrollment management, attendance tracking, player/parent profiles, subscriptions, QR-based attendance, and the parent/customer experience',
    ar: 'إدارة تسجيل الأكاديمية، تتبع الحضور، ملفات اللاعبين وأولياء الأمور، الاشتراكات، الحضور عبر رمز QR، وتجربة أولياء الأمور',
  },
  multi_branch: {
    en: 'centralized multi-branch management, consolidated reporting, role-based staff access, and financial visibility across all locations',
    ar: 'إدارة مركزية متعددة الفروع، تقارير موحدة، صلاحيات موظفين حسب الدور، ورؤية مالية شاملة لكل الفروع',
  },
  multi_field_facility: {
    en: 'availability management, conflict-free booking, flexible pricing rules, and full operational control across all fields',
    ar: 'إدارة التوفر، الحجز بدون تعارض، قواعد تسعير مرنة، وتحكم تشغيلي كامل في كل الملاعب',
  },
}

function buildGroundedPrompt(lead: LeadEvidence, language: 'ar' | 'en', messageType: string): string {
  const signalLines = lead.signals
    .map((s) => `- ${s.signal_key} (confidence: ${s.confidence}${s.source_url ? `, source: ${s.source_url}` : ''}): ${JSON.stringify(s.evidence)}`)
    .join('\n')

  const relevantPitches = lead.signals
    .map((s) => SIGNAL_PITCH_HINTS[s.signal_key])
    .filter(Boolean)
    .map((p) => p[language])
    .join('; ')

  const languageInstruction =
    language === 'ar'
      ? 'Write in natural, professional Arabic suitable for a business context in Egypt/the Gulf, appropriate for the given country if specified.'
      : 'Write in natural, professional English suitable for a B2B sales context.'

  return `You are writing a ${messageType} for Mal3aby, a sports facility booking and operations management platform, targeting a real prospect business.

CRITICAL RULE: Use ONLY the facts listed below. Do NOT invent, assume, or embellish any detail about this business that is not explicitly stated here. If a detail (e.g. exact pricing, exact number of fields) is not given, do not state it as fact -- speak in terms of the general opportunity instead.

VERIFIED LEAD FACTS:
- Business name: ${lead.business_name}
- Type: ${lead.business_type ?? 'not specified'}
- Location: ${[lead.city, lead.country].filter(Boolean).join(', ') || 'not specified'}
- Rating: ${lead.rating ?? 'not available'} (${lead.review_count ?? 0} reviews)
- Estimated branches: ${lead.branch_count_estimate ?? 'unknown'}
- Estimated facilities/fields: ${lead.facility_count_estimate ?? 'unknown'}
- Academy presence: ${lead.has_academy_presence ? 'yes' : 'not confirmed'}

VERIFIED OPPORTUNITY SIGNALS (each with its own evidence source):
${signalLines || '(none recorded yet)'}

RELEVANT MAL3ABY MODULES TO PITCH (based only on the signals above): ${relevantPitches || 'general operations and booking management'}

${languageInstruction}

Write the ${messageType} now. Keep it concise, specific to the facts given, and professional. Do not include a subject line unless writing an email offer.`
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

  let body: { lead_id?: string; message_type?: string; language?: string; channel?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'malformed JSON body' }, 400)
  }

  const { lead_id: leadId, message_type: messageType, language, channel } = body

  if (!leadId || typeof leadId !== 'string') {
    return jsonResponse(req, { error: 'lead_id is required' }, 400)
  }
  if (!messageType || !['intro', 'offer', 'followup', 'demo_pitch', 'proposal_summary'].includes(messageType)) {
    return jsonResponse(req, { error: 'message_type must be one of: intro, offer, followup, demo_pitch, proposal_summary' }, 400)
  }
  if (language !== 'ar' && language !== 'en') {
    return jsonResponse(req, { error: 'language must be ar or en' }, 400)
  }
  const resolvedChannel = channel && ['email', 'phone_script', 'whatsapp_talking_points'].includes(channel) ? channel : 'email'

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

  // Re-authorization + quota, via the CALLER-scoped client (the real
  // platform-owner/staff session, not the admin client) -- both the
  // 'platform.sales.generate_offer' permission and the daily quota are
  // independently re-verified server-side here, never trusted from a
  // client-side "I'm allowed" assumption.
  const { data: quota, error: quotaError } = await callerClient.rpc('sales_check_and_increment_quota', {
    p_provider_key: 'ai_offer_generator',
  })
  if (quotaError) {
    return jsonResponse(req, { error: 'not authorized' }, 403)
  }
  if (!quota || !quota[0]?.allowed) {
    return jsonResponse(req, { error: 'daily AI-generation quota exceeded', quota: quota?.[0] }, 429)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: providerConfig } = await admin
    .from('sales_provider_configs')
    .select('enabled, secret_vault_id')
    .eq('provider_key', 'ai_offer_generator')
    .maybeSingle()

  if (!providerConfig?.enabled || !providerConfig.secret_vault_id) {
    return jsonResponse(req, {
      error: 'CONFIGURATION_BLOCKED',
      detail: 'The AI offer generator provider has not been configured with credentials. An operator must configure this in Sales Intelligence > Settings before AI-generated offers can be produced.',
    }, 409)
  }

  const { data: leadRow, error: leadError } = await admin
    .from('sales_leads')
    .select('id, business_name, business_type, city, country, rating, review_count, branch_count_estimate, facility_count_estimate, has_academy_presence, status')
    .eq('id', leadId)
    .maybeSingle()

  if (leadError || !leadRow) {
    return jsonResponse(req, { error: 'lead not found' }, 404)
  }

  if (leadRow.status === 'do_not_contact') {
    return jsonResponse(req, { error: 'this lead is marked do_not_contact -- outreach content cannot be generated for it' }, 400)
  }

  const { data: signalRows } = await admin
    .from('sales_lead_signals')
    .select('signal_key, confidence, evidence, source_url')
    .eq('lead_id', leadId)
    .eq('is_active', true)

  const evidence: LeadEvidence = {
    business_name: leadRow.business_name,
    business_type: leadRow.business_type,
    city: leadRow.city,
    country: leadRow.country,
    rating: leadRow.rating,
    review_count: leadRow.review_count,
    branch_count_estimate: leadRow.branch_count_estimate,
    facility_count_estimate: leadRow.facility_count_estimate,
    has_academy_presence: leadRow.has_academy_presence,
    signals: signalRows ?? [],
  }

  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: providerConfig.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    return jsonResponse(req, { error: 'could not resolve AI provider credentials' }, 500)
  }

  const prompt = buildGroundedPrompt(evidence, language, messageType)

  let generatedText: string
  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': decryptedSecret,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(AI_API_TIMEOUT_MS),
    })

    if (!aiRes.ok) {
      return jsonResponse(req, { error: 'AI provider request failed' }, 502)
    }

    const aiJson = await aiRes.json()
    generatedText = aiJson?.content?.[0]?.text ?? ''
    if (!generatedText) {
      return jsonResponse(req, { error: 'AI provider returned no content' }, 502)
    }
  } catch (err) {
    const detail = err instanceof DOMException && err.name === 'AbortError' ? 'AI provider request timed out' : 'AI provider request failed unexpectedly'
    return jsonResponse(req, { error: detail }, 502)
  }

  // Subject line only meaningful for email offers -- extract the first line if it looks like one, else leave null.
  const subject = resolvedChannel === 'email' && messageType === 'offer' ? generatedText.split('\n')[0].slice(0, 120) : null

  // Persist via the RPC (GENERATE step of Phase 11's lifecycle) using the
  // CALLER-scoped client so created_by correctly reflects the real user who
  // triggered generation, not the service role.
  const { data: messageId, error: insertError } = await callerClient.rpc('sales_generate_outreach_message', {
    p_lead_id: leadId,
    p_channel: resolvedChannel,
    p_message_type: messageType,
    p_language: language,
    p_subject: subject,
    p_body: generatedText,
    p_grounding: evidence,
    p_campaign_id: null,
  })

  if (insertError) {
    return jsonResponse(req, { error: 'could not persist generated message' }, 500)
  }

  return jsonResponse(req, { message_id: messageId, body: generatedText, subject, channel: resolvedChannel, grounding_signal_count: evidence.signals.length })
})
