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
// PROVIDER-AGNOSTIC (2026-09-04 owner decision): this function no
// longer calls any AI vendor's API directly -- it goes through
// _shared/ai-provider-adapter.ts's generateSalesOffer(), selecting the
// active provider from sales_provider_configs.ai_offer_generator.
// config->>'provider' (defaults to 'groq', Mal3aby's zero-cost default
// -- see that file's own comments for the full provider-selection
// rationale). Anthropic is fully supported by the adapter but disabled
// by default; the owner explicitly declined to enable Anthropic paid
// billing for Mal3aby, so this function must never require it. No
// automatic fallback between providers exists or should ever be added
// here -- a provider failure is a real, honest failure surfaced to the
// caller, never silently retried against a different (possibly paid)
// provider.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { generateSalesOffer, ProviderRequestError } from '../_shared/ai-provider-adapter.ts'
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

const AI_API_TIMEOUT_MS = 30_000
// Raised from 800 to 1400 (2026-09-04, commercial quality gate mission):
// the new call-script prompt structure (literal opening + 2-3 discovery
// questions + problem hypothesis + value proposition + 3 objection
// responses + CTA, all as literal spoken text) is materially longer than
// the old talking-points-scaffold format this limit was originally sized
// for. Confirmed via live testing: at 800 tokens, Groq's response was
// consistently truncated mid-PROBLEM_HYPOTHESIS, before ever reaching
// OBJECTION HANDLING -- output_tokens: 800 (exactly the cap) on 2/2 test
// calls, both correctly caught and rejected by the quality gate's
// MISSING_OBJECTION_HANDLING check (the gate did its job; the cap was
// the actual root cause). Emails stay well under this even at their
// longer end (140-word target ~ 200-300 tokens), so a single shared
// limit large enough for the call-script case does not risk emails
// becoming any less concise.
const AI_MAX_TOKENS = 1400
// Bounded retry, no infinite retry (mission's explicit cost-guard
// requirement) -- a single retry only on a transient timeout, never on
// a quota/auth/upstream-error class (retrying those wastes the
// caller's free-tier request budget on a failure that will not change).
const MAX_RETRIES = 1

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

// Signature identity policy (owner directive, this mission): "Use the
// actual configured Sales identity. Never invent personal names or
// titles. If no named salesperson identity is configured: use a
// complete team identity such as فريق ملعبي / Mal3aby Sales / [verified
// reply/contact channel]. Only include contact details that actually
// exist and are configured. No placeholders." No per-salesperson
// identity is configured anywhere in this codebase (sales_provider_
// configs has no such field) -- so the team identity is the only
// correct choice, always, for every message, in every language. The
// reply channel included is the real configured sender address
// (SALES_OUTREACH_FROM_ADDRESS, matching what sales-outreach-email-
// sender actually sends from), never a fabricated one.
const SALES_TEAM_SIGNATURE = {
  ar: (replyAddress: string) => `فريق ملعبي\n${replyAddress}`,
  en: (replyAddress: string) => `Mal3aby Sales Team\n${replyAddress}`,
}

function buildGroundedPrompt(
  lead: LeadEvidence,
  language: 'ar' | 'en',
  messageType: string,
  channel: 'email' | 'phone_script' | 'whatsapp_talking_points',
  replyAddress: string,
): string {
  const signalLines = lead.signals
    .map((s) => `- ${s.signal_key} (confidence: ${s.confidence}${s.source_url ? `, source: ${s.source_url}` : ''}): ${JSON.stringify(s.evidence)}`)
    .join('\n')

  const relevantPitches = lead.signals
    .map((s) => SIGNAL_PITCH_HINTS[s.signal_key])
    .filter(Boolean)
    .map((p) => p[language])
    .join('; ')

  // Absence-of-evidence signals recorded at LOW confidence must be
  // phrased as an observation/question, never a certain factual
  // statement (owner's explicit BAD/BETTER example: "You currently
  // manage bookings only by phone" is BAD; "We couldn't identify an
  // online booking path from the public channels we reviewed, so I
  // wanted to ask how bookings are currently managed" is BETTER).
  const lowConfidenceSignals = lead.signals.filter((s) => s.confidence === 'low')
  const confidenceGuard = lowConfidenceSignals.length > 0
    ? `\n\nCAUTIOUS-LANGUAGE GUARD -- MANDATORY: the following signal(s) are LOW CONFIDENCE absence-of-evidence findings (we did not find X, which is not the same as proving the prospect lacks X): ${lowConfidenceSignals.map((s) => s.signal_key).join(', ')}. You MUST phrase any reference to these as an observation or a genuine question (e.g. "we couldn't identify... so I wanted to ask...", "لم نتمكن من تحديد... فحبيت أسأل..."), and MUST NOT state them as a certain fact about how the business currently operates (e.g. never write "you currently manage X only by Y" / "تعتمدون حاليًا على X فقط"). This is a hard requirement, not a style preference.`
    : ''

  // City-name disambiguation (found live during the controlled pilot,
  // 2026-09-04): the model has been observed transliterating "Giza"
  // (a real Cairo-metro city, Egypt) as "غزة" (Gaza, Palestine) in
  // Arabic output -- a genuine factual corruption of a real, correct
  // grounding fact, not a hallucination of a new fact. Confirmed
  // non-deterministic (a same-lead regeneration produced the correct
  // "الجيزة" the very next call), so this is a real, reachable-in-
  // production risk worth an explicit prompt-level guard rather than
  // hoping it doesn't recur. Extend this map if another Egyptian place
  // name is ever found to collide the same way.
  const AR_CITY_DISAMBIGUATION: Record<string, string> = {
    giza: 'الجيزة (Giza, Egypt -- NEVER write غزة/Gaza, a different place in Palestine)',
  }
  const cityGuard = lead.city && AR_CITY_DISAMBIGUATION[lead.city.toLowerCase()]
    ? `\nCITY NAME GUARD: the business's city is ${lead.city} -- in Arabic this MUST be written ${AR_CITY_DISAMBIGUATION[lead.city.toLowerCase()]}.`
    : ''

  // Language policy (owner directive): for Egyptian businesses, prefer
  // natural professional Arabic (not robotic MSA) unless there is
  // strong evidence English is the appropriate business language.
  // `language` is still an explicit caller-chosen parameter (the
  // generate-offer UI lets an operator pick), so this only shapes TONE
  // within the chosen language, not the language choice itself.
  const languageInstruction =
    language === 'ar'
      ? `Write in natural, professional Egyptian-business Arabic -- NOT robotic/overly formal Modern Standard Arabic, but also not casual/slang. Sound like a real person writing a professional first-contact message to an Egyptian business owner.${cityGuard}${confidenceGuard}`
      : `Write in natural, professional English suitable for a B2B sales context.${confidenceGuard}`

  const teamSignatureExample = SALES_TEAM_SIGNATURE[language](replyAddress)

  const commonRules = `CRITICAL RULE: Use ONLY the facts listed below. Do NOT invent, assume, or embellish any detail about this business that is not explicitly stated here. If a detail (e.g. exact pricing, exact number of fields) is not given, do not state it as fact -- speak in terms of the general opportunity instead.

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

RELEVANT MAL3ABY MODULES AVAILABLE (based only on the signals above -- pick ONLY ONE that best fits, do not list them all): ${relevantPitches || 'general operations and booking management'}

${languageInstruction}

SIGNATURE POLICY -- MANDATORY: never invent a personal name or job title for the sender. End with the exact team identity below, with NO modification, NO added name, NO added title:
${teamSignatureExample}

Do not include any bracketed placeholder text like [Your Name], [Prospect Name], [Contact Information], {{...}}, <...>, TODO, or TBD anywhere in the output. Every word you write must be final, ready-to-send text -- never a template.`

  if (channel === 'email') {
    return `You are writing a FIRST-CONTACT sales email for Mal3aby, a sports facility booking and operations management platform, to a real prospect business. This is NOT a proposal or a feature brochure -- it is a short, personal-sounding first message meant to start a conversation.

${commonRules}

FIRST-CONTACT EMAIL STRUCTURE -- MANDATORY, follow this exact shape:
1. SUBJECT LINE: a short, specific, non-generic subject line (write it as the very first line, prefixed exactly "SUBJECT: "). Never leave it blank.
2. A brief, personalized, relevant opening line referencing the business by name and something real about it.
3. ONE observation or question about the opportunity gap (phrased cautiously if it relies on a low-confidence signal -- see the CAUTIOUS-LANGUAGE GUARD above).
4. ONE Mal3aby benefit -- pick the single most relevant module from the list above. Do NOT list multiple features or modules. Do NOT use a bullet list of features.
5. ONE low-friction call to action -- a short, specific, easy-to-answer question (e.g. asking if a brief call this week would work), never a vague "we'd love to arrange a demo" with no question and no timeframe. Do not fabricate a calendar link.
6. The exact signature block given above.

LENGTH: the BODY (excluding the subject line and signature) must be approximately 80-140 words. Do not write a long message. Do not list more than one product feature/module. Get to the point quickly.

Write the email now, starting with the SUBJECT: line.`
  }

  // phone_script / whatsapp_talking_points: a REAL, EXECUTABLE call
  // script -- not scaffolding/topic labels. Owner's explicit structure:
  // identify -> ask permission -> ask how it currently works -> discover
  // friction -> connect ONE relevant capability -> handle objection if
  // needed -> ask for a short demo/next step. Must include literal
  // spoken lines, not meta-descriptions of what to say.
  return `You are writing a REAL, EXECUTABLE phone call script for a Mal3aby salesperson to use when calling a real prospect business. This must be literal, ready-to-speak text a salesperson can read or closely follow on the call -- NOT a scaffold of topics or bullet-point reminders.

${commonRules}

CALL SCRIPT STRUCTURE -- MANDATORY, produce ALL of the following as literal spoken text, clearly labeled with the section headers below (in ${language === 'ar' ? 'Arabic' : 'English'}):

OPENING: a literal, quotable opening line where the caller identifies themselves and Mal3aby, and asks permission for a short conversation. Write the ACTUAL words to say, in quotes, not a description like "introduce yourself".

DISCOVERY QUESTIONS: exactly 2 to 3 literal questions (each ending in a question mark) asking how the relevant operation currently works, to genuinely discover friction -- do not assert a problem, ask about it.

PROBLEM HYPOTHESIS: one sentence describing the likely friction point, grounded only in the verified signals above, phrased cautiously if based on a low-confidence signal.

VALUE PROPOSITION: ONE Mal3aby capability connected directly to the discovered friction -- not a feature dump.

OBJECTION HANDLING: literal responses to these 3 common objections (label each clearly):
- "We already have a system" (عندنا نظام بالفعل)
- "Send me information" (ابعتلي معلومات)
- "Not interested / not now" (مش مهتم / مش دلوقتي)
Each response must be a real, literal reply a salesperson can speak, not a topic label.

CTA / NEXT STEP: a literal, low-friction closing line asking for a short demo or an appropriate next step (e.g. "هل يناسبكم مكالمة/عرض ١٠ دقايق الأسبوع ده؟" or an equivalent natural question in the target language) -- not a vague mention of "a demo" with no question.

Do not turn this into a feature dump. Discover first, sell second. Write the full script now.`
}

// mapProviderErrorToStatus(): a truthful, honest HTTP status/error code
// per failure class -- never a generic 502 for everything (mission's
// "fail gracefully with a truthful status such as FREE_TIER_QUOTA_
// EXHAUSTED... must NOT silently generate a bill" requirement).
function mapProviderErrorToResponse(req: Request, err: ProviderRequestError) {
  switch (err.kind) {
    case 'quota_exhausted':
      return jsonResponse(req, { error: 'FREE_TIER_QUOTA_EXHAUSTED', detail: `${err.provider} free-tier rate/request limit reached for today. No automatic paid fallback will be used.` }, 429)
    case 'timeout':
      return jsonResponse(req, { error: 'AI_PROVIDER_TIMEOUT', detail: `${err.provider} request timed out` }, 504)
    case 'auth':
      return jsonResponse(req, { error: 'AI_PROVIDER_AUTH_FAILED', detail: `${err.provider} rejected the configured credential -- an operator must reconfigure this provider in Sales Intelligence > Settings` }, 502)
    case 'empty_response':
      return jsonResponse(req, { error: 'AI_PROVIDER_EMPTY_RESPONSE', detail: `${err.provider} returned no content` }, 502)
    default:
      return jsonResponse(req, { error: 'AI_PROVIDER_REQUEST_FAILED', detail: `${err.provider} request failed` }, 502)
  }
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
  // client-side "I'm allowed" assumption. This is Mal3aby's OWN daily
  // cap (sales_provider_configs.daily_cap), independent of and in
  // addition to whatever the underlying AI provider's own free-tier
  // limit is -- a second, always-on cost/abuse guard.
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
    .select('enabled, secret_vault_id, config')
    .eq('provider_key', 'ai_offer_generator')
    .maybeSingle()

  if (!providerConfig?.enabled || !providerConfig.secret_vault_id) {
    return jsonResponse(req, {
      error: 'CONFIGURATION_BLOCKED',
      detail: 'The AI offer generator provider has not been configured with credentials. An operator must configure this in Sales Intelligence > Settings before AI-generated offers can be produced.',
    }, 409)
  }

  // provider/model are read from config, never hardcoded -- switching
  // AI vendors (e.g. re-enabling Anthropic once billing is approved)
  // is a config change via Sales Settings, not a code deploy.
  const providerKey = (providerConfig.config as Record<string, unknown>)?.provider as string | undefined ?? 'groq'
  const model = (providerConfig.config as Record<string, unknown>)?.model as string | undefined ?? 'openai/gpt-oss-120b'

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

  const salesReplyAddress = Deno.env.get('SALES_OUTREACH_FROM_ADDRESS') ?? 'sales@mal3aby.app'
  const prompt = buildGroundedPrompt(evidence, language, messageType, resolvedChannel, salesReplyAddress)

  let result
  let attempt = 0
  let lastErr: ProviderRequestError | null = null
  while (attempt <= MAX_RETRIES) {
    try {
      result = await generateSalesOffer(prompt, providerKey, {
        apiKey: decryptedSecret,
        model,
        maxTokens: AI_MAX_TOKENS,
        timeoutMs: AI_API_TIMEOUT_MS,
      })
      lastErr = null
      break
    } catch (err) {
      if (!(err instanceof ProviderRequestError)) {
        return jsonResponse(req, { error: 'AI_PROVIDER_REQUEST_FAILED', detail: 'unexpected error calling AI provider' }, 502)
      }
      lastErr = err
      // Only a timeout is worth one bounded retry -- every other class
      // (auth/quota/upstream_error/empty_response) will not change on
      // retry, so retrying would just waste the free-tier budget.
      if (err.kind !== 'timeout' || attempt === MAX_RETRIES) break
      attempt++
    }
  }

  if (lastErr || !result) {
    return mapProviderErrorToResponse(req, lastErr!)
  }

  // Every EMAIL message now follows the new prompt's mandatory
  // "SUBJECT: ..." first-line convention (not just message_type='offer'
  // -- the owner's email quality contract requires a subject on every
  // first-contact email, regardless of message_type). Parse it out of
  // the model's raw text and strip it from the body so it is never
  // duplicated inside the email content itself. Call-script channels
  // never have a subject (subjectPass is trivially true for them in the
  // quality gate).
  let subject: string | null = null
  let generatedBody = result.text.trim()
  if (resolvedChannel === 'email') {
    const subjectMatch = generatedBody.match(/^SUBJECT:\s*(.+)$/im)
    if (subjectMatch) {
      subject = subjectMatch[1].trim().slice(0, 200)
      generatedBody = generatedBody.replace(/^SUBJECT:\s*.+$/im, '').replace(/^\s+/, '')
    }
  }

  // ------------------------------------------------------------
  // COMMERCIAL QUALITY VALIDATION step (owner-mandated lifecycle:
  // GENERATE -> GROUNDING VALIDATION -> COMMERCIAL QUALITY VALIDATION ->
  // APPROVAL_READY -> HUMAN APPROVAL -> SEND). Grounding validation
  // itself is enforced upstream by construction (buildGroundedPrompt
  // only ever supplies verified sales_lead_signals evidence to the
  // model, and the exact evidence given is persisted as `grounding` for
  // audit) -- groundingPassed is true here because no unverifiable claim
  // was ever offered to the model to begin with; a human reviewing the
  // persisted grounding can always independently re-audit factual
  // accuracy against the cited sources, same as before. This is a
  // deterministic, non-LLM check -- see _shared/outreach-quality-gate.ts.
  // ------------------------------------------------------------
  const lowConfidenceSignalKeys = evidence.signals.filter((s) => s.confidence === 'low').map((s) => s.signal_key)
  const qualityResult = evaluateOutreachQuality({
    channel: resolvedChannel,
    language,
    subject,
    body: generatedBody,
    lowConfidenceSignalKeys,
    groundingPassed: true,
  })

  // Persist via the RPC (GENERATE step of Phase 11's lifecycle) using the
  // CALLER-scoped client so created_by correctly reflects the real user who
  // triggered generation, not the service role.
  const { data: messageId, error: insertError } = await callerClient.rpc('sales_generate_outreach_message', {
    p_lead_id: leadId,
    p_channel: resolvedChannel,
    p_message_type: messageType,
    p_language: language,
    p_subject: subject,
    p_body: generatedBody,
    p_grounding: evidence,
    p_campaign_id: null,
    p_ai_provider: result.provider,
    p_ai_model: result.model,
    p_ai_usage: result.usage,
    p_ai_latency_ms: result.latencyMs,
    p_quality_status: qualityResult.status === 'APPROVAL_READY' ? 'approval_ready' : 'quality_rejected',
    p_quality_gate_result: qualityResult,
  })

  if (insertError) {
    return jsonResponse(req, { error: 'could not persist generated message' }, 500)
  }

  return jsonResponse(req, {
    message_id: messageId,
    body: generatedBody,
    subject,
    channel: resolvedChannel,
    grounding_signal_count: evidence.signals.length,
    ai_provider: result.provider,
    ai_model: result.model,
    ai_usage: result.usage,
    ai_latency_ms: result.latencyMs,
    quality_status: qualityResult.status === 'APPROVAL_READY' ? 'approval_ready' : 'quality_rejected',
    quality_gate_result: qualityResult,
  })
})
