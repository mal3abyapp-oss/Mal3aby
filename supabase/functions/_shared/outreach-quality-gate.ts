// _shared/outreach-quality-gate.ts -- Sales Intelligence: deterministic
// commercial quality gate (2026-09-04, owner directive: "these are
// SYSTEMIC GENERATION QUALITY defects... implement a deterministic
// COMMERCIAL QUALITY GATE after AI generation and before human
// approval... do not rely solely on the LLM to self-evaluate").
//
// LIFECYCLE (owner-specified): GENERATE -> GROUNDING VALIDATION ->
// COMMERCIAL QUALITY VALIDATION -> APPROVAL_READY -> HUMAN APPROVAL ->
// SEND. This module is the COMMERCIAL QUALITY VALIDATION step. Grounding
// validation is a separate, pre-existing concern (the AI is only ever
// given verified sales_lead_signals evidence; this gate does NOT
// re-verify factual grounding against the database -- it checks the
// TEXT ITSELF for structural/commercial defects: placeholders, missing
// subject, missing/weak CTA, missing signature, excessive length,
// overstated-confidence language, and (for call scripts) missing
// discovery questions / objection handling / literal opening).
//
// PURE FUNCTIONS, NO NETWORK, NO DATABASE. Deterministic and
// synchronously testable -- this is the "do not rely solely on the LLM
// to self-evaluate" requirement made concrete: every check here is a
// plain string/structure inspection, not a second AI call.
//
// A draft becomes APPROVAL_READY only if every MANDATORY gate for its
// channel passes. Otherwise QUALITY_REJECTED with the exact failing
// gate names, so a human (or a future regeneration) can see precisely
// what to fix -- never a vague "quality too low".

export type QualityGateName =
  | 'GROUNDING_PASS'
  | 'EVIDENCE_STRENGTH_PASS'
  | 'PLACEHOLDER_PASS'
  | 'SUBJECT_PASS'
  | 'SIGNATURE_PASS'
  | 'CTA_PASS'
  | 'LENGTH_PASS'
  | 'CHANNEL_STRUCTURE_PASS'
  | 'CONFIDENCE_LANGUAGE_PASS'
  | 'GENERATION_COMPLETENESS_PASS'
  | 'OUTPUT_INTEGRITY_PASS'

export type QualityRejectionReason =
  | 'MISSING_SUBJECT'
  | 'UNRESOLVED_PLACEHOLDER'
  | 'MISSING_SIGNATURE'
  | 'WEAK_CTA'
  | 'MISSING_CTA'
  | 'MESSAGE_TOO_LONG'
  | 'MESSAGE_TOO_SHORT'
  | 'CALL_SCRIPT_INCOMPLETE'
  | 'MISSING_LITERAL_OPENING'
  | 'INSUFFICIENT_DISCOVERY_QUESTIONS'
  | 'MISSING_OBJECTION_HANDLING'
  | 'CONFIDENCE_OVERSTATED'
  | 'UNSUPPORTED_CLAIM'
  | 'MULTIPLE_PRODUCT_PITCHES_DUMPED'
  | 'GENERATION_TRUNCATED'
  | 'OUTPUT_INTEGRITY_FAILED'
  | 'EVIDENCE_STRENGTH_OVERSTATED'

export interface QualityGateResult {
  gates: Record<QualityGateName, boolean>
  status: 'APPROVAL_READY' | 'QUALITY_REJECTED'
  rejection_reasons: QualityRejectionReason[]
  detail: Record<string, unknown>
}

export interface QualityGateInput {
  channel: 'email' | 'phone_script' | 'whatsapp_talking_points'
  language: 'ar' | 'en'
  subject: string | null
  body: string
  /** low-confidence signal keys present in this message's grounding, whose evidence must be phrased as inference, never certainty. */
  lowConfidenceSignalKeys: string[]
  /** Pass false if a grounding-level check (upstream) already found an unsupported factual claim -- lets that failure flow into the same gate result the owner asked for. */
  groundingPassed: boolean
  /**
   * Provider-reported finish reason for this generation (2026-09-04,
   * owner directive: "Do not infer completeness merely because required
   * topic keywords appeared. Use provider metadata where available:
   * finish_reason / stop_reason"). 'length' is treated as definitive
   * proof of truncation -- GENERATION_COMPLETENESS_PASS fails
   * unconditionally when this is 'length', regardless of what the text
   * itself contains. Pass null/undefined only when the provider
   * genuinely did not report one -- structural completeness checks
   * still run in that case, but the strongest signal (provider
   * metadata) is simply unavailable, matching the same fail-closed
   * posture the rest of this gate uses for missing evidence.
   */
  finishReason?: 'stop' | 'length' | 'content_filter' | 'other' | null
  /** signal keys whose evidence is CONTACT/CHANNEL metadata only (e.g. "a public email address exists") -- flags the specific evidence class the owner's Defect 3 targets: observed contact metadata must not be transformed into an operational workflow claim ("they use X to manage Y") without separate supporting evidence. */
  contactMetadataOnlySignalKeys?: string[]
  /** The lead's own business name, if it legitimately contains Latin-script words (e.g. "Mr Soccer Academy") -- allowlisted from the OUTPUT_INTEGRITY check so a real business name is never misdetected as an inserted artifact. */
  businessName?: string | null
}

// ============================================================
// Generic placeholder detection -- NOT limited to the four literal
// tokens observed in the pilot ([Prospect Name], [Your Name], [Your
// Title], [Contact Information]). Owner's explicit instruction: "Detect
// placeholders generically... where context indicates unresolved
// template content."
// ============================================================
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\[[^\]\n]{1,60}\]/g, // [Anything Like This]
  /\{\{[^}\n]{1,60}\}\}/g, // {{anything}}
  /<[A-Za-z_][A-Za-z0-9_ ]{0,40}>/g, // <Your Name> -- deliberately excludes bare HTML-ish tags like </p> by requiring a letter/underscore start and no closing-slash
  /\bYOUR[_ ]NAME\b/gi,
  /\bPROSPECT[_ ]NAME\b/gi,
  /\bRECIPIENT[_ ]NAME\b/gi,
  /\bYOUR[_ ]TITLE\b/gi,
  /\bCONTACT[_ ]INFO(RMATION)?\b/gi,
  /\bTODO\b/g,
  /\bTBD\b/g,
  /\bLOREM IPSUM\b/gi,
]

export function findPlaceholders(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of PLACEHOLDER_PATTERNS) {
    const matches = text.match(pattern)
    if (matches) matches.forEach((m) => found.add(m.trim()))
  }
  return Array.from(found)
}

// ============================================================
// Word count -- language-aware. Arabic word-splitting on whitespace is
// adequate for this purpose (no ligature/clitic segmentation needed --
// the owner's 80-140-word target is a coarse length guard, not a
// linguistic analysis).
// ============================================================
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

// Owner's target: "approximately 80-140 words where linguistically
// reasonable" for a first-contact email. Bounds set with headroom
// (60-190) since Arabic and English word counts for the same content
// can differ, and "approximately"/"where reasonable" signals a soft
// target, not a hard 80/140 cutoff -- but a message far outside this
// range is a genuine defect (the pilot's Elmasry draft was well over
// 190 words with 5 bullet-listed features, exactly the "too long, too
// many features" defect reported).
const EMAIL_MIN_WORDS = 40
const EMAIL_MAX_WORDS = 190

// CTA detection: a real, low-friction ask for a next step, not a vague
// unstructured mention of "demo". Looks for a question mark (Arabic ؟
// U+061F or Latin ?) near a scheduling/call/demo-shaped phrase, OR an
// explicit clause offering a specific short duration -- covers both
// Arabic and English idioms this codebase's own drafts have used, plus
// generic patterns. NOTE: `\b` word boundaries are unreliable around
// Arabic script in JS regex (Arabic letters are not in `\w`), so Arabic
// sub-patterns below use plain substring matches, never `\b`-wrapped.
const QUESTION_MARK_CLASS = '[?؟]'
const CTA_STRONG_PATTERNS: RegExp[] = [
  new RegExp(`${QUESTION_MARK_CLASS}\\s*$`, 'm'), // ends a line with a question (Arabic or Latin mark) -- the low-friction-question CTA shape the owner asked for
  new RegExp(`(\\d{1,2}\\s*(minute|min)s?)\\b[\\s\\S]{0,80}${QUESTION_MARK_CLASS}`, 'i'),
  new RegExp(`(دقيقة|دقايق|دقائق)[\\s\\S]{0,80}${QUESTION_MARK_CLASS}`),
  /\bhappy to\b[\s\S]{0,40}\b(call|chat|demo|talk)\b/i,
  /\bwould you\b[\s\S]{0,40}\b(call|chat|demo|talk)\b/i,
  /هل يناسبكم|هل تفضلون|هل يمكن|هل عندكم وقت/,
]
// A CTA is considered WEAK (present but vague) if it mentions a demo/call
// without a question mark or a concrete duration/day -- e.g. "يسعدنا
// ترتيب عرض" (the exact phrase the owner flagged as vague) or "I'd
// welcome a conversation" with no question, no timeframe.
const CTA_MENTION_PATTERNS: RegExp[] = [
  /\bdemo\b/i,
  /\bconversation\b/i,
  /\bcall\b/i,
  /ديمو|مكالمة|عرض/,
]

function evaluateCta(body: string): { present: boolean; strong: boolean } {
  const mentioned = CTA_MENTION_PATTERNS.some((p) => p.test(body))
  const strong = CTA_STRONG_PATTERNS.some((p) => p.test(body))
  return { present: mentioned || strong, strong }
}

// Signature: a real closing identity block near the end of the message
// -- either a team identity (فريق ملعبي / Mal3aby Sales / Mal3aby Team)
// or, if a named individual is used, one with NO placeholder tokens (a
// named signature with [Your Name] still intact fails PLACEHOLDER_PASS
// independently, so this check only needs to confirm SOME closing
// identity line exists at all).
const SIGNATURE_PATTERNS: RegExp[] = [
  /فريق\s*(ملعبي|Mal3aby)/i,
  /Mal3aby\s*(Sales|Team)/i,
  /مع\s*(خالص\s*)?(التحية|تحياتنا)/,
  /Best regards/i,
  /Regards,/i,
  /تحياتنا/,
]

function hasSignature(body: string): boolean {
  return SIGNATURE_PATTERNS.some((p) => p.test(body))
}

// Overstated-confidence language: a LOW-confidence absence-of-evidence
// signal (e.g. phone_only_booking recorded at confidence:'low') must be
// phrased as an observation/question, never a flat assertion. Detects
// certainty phrasing ("you currently manage X only by Y", "تعتمدون
// حاليًا على X فقط") when at least one low-confidence signal is present
// in this message's grounding -- the owner's exact BAD/BETTER example.
const CERTAINTY_PHRASING_PATTERNS: RegExp[] = [
  /\byou (currently|only|solely) (manages?|operates?|runs?|rely on)\b/i,
  /\byour (club|academy|business)?\s*(currently )?manages?[\s\S]{0,20}\bonly\b/i,
  /\byour (booking|registration|operation)s? (is|are) (only|solely|entirely)\b/i,
  /تعتمدون[\s\S]{0,20}على[\s\S]{0,40}فقط/,
  /يتم[\s\S]{0,20}عبر[\s\S]{0,40}فقط/,
]
const HEDGED_PHRASING_PATTERNS: RegExp[] = [
  /\bwe (couldn'?t|could not|weren'?t able to) (identify|find)\b/i,
  /\bwanted to ask\b/i,
  /\bي بدو أن|\bلم نتمكن|\bلاحظنا احتمال|\bربما\b/,
  /\bلم نتمكن من (تحديد|إيجاد|العثور على)\b/,
]

function overstatesLowConfidence(body: string, lowConfidenceSignalKeys: string[]): boolean {
  if (lowConfidenceSignalKeys.length === 0) return false
  const hasCertainty = CERTAINTY_PHRASING_PATTERNS.some((p) => p.test(body))
  const hasHedge = HEDGED_PHRASING_PATTERNS.some((p) => p.test(body))
  // Flag only when certainty phrasing appears AND no hedging phrasing
  // offsets it -- a message can legitimately state OTHER, non-low-
  // confidence facts with certainty; this only guards the specific
  // low-confidence claim class.
  return hasCertainty && !hasHedge
}

// ============================================================
// GENERATION COMPLETENESS (Defect 1, 2026-09-04 owner directive):
// "Implement deterministic detection of incomplete/truncated
// generation... If generation terminates because of token limit /
// length: QUALITY_REJECTED, reason GENERATION_TRUNCATED. Do not infer
// completeness merely because required topic keywords appeared."
//
// Two independent checks, EITHER of which fails the gate:
//   1. PROVIDER METADATA (authoritative): finishReason === 'length'
//      means the provider itself truncated the response. This is
//      checked FIRST and unconditionally -- no text-shape heuristic can
//      override a provider's own truncation report.
//   2. STRUCTURAL COMPLETENESS (defense in depth, for the finishReason
//      === null/undefined case where provider metadata is unavailable,
//      or as a second independent signal even when metadata says
//      'stop'): the text must not end mid-sentence/mid-clause. A
//      complete message ends with terminal punctuation (.!?؟) or a
//      closing quote/parenthesis following one -- never a dangling
//      conjunction, an open quote, or bare mid-word truncation.
// ============================================================
const TERMINAL_PUNCTUATION_PATTERN = /[.!?؟…]["'”’)»]?\s*$/
// A truncated Arabic sentence very often ends on a connector word
// ("و", "أو", "لكن", "عشان", "علشان", "بحيث") right where the token
// budget ran out -- these are never legitimate sentence-final words in
// either language's business-writing register.
const DANGLING_CONNECTOR_PATTERN = /\b(and|or|but|so|because)\s*$|(^|\s)(و|أو|لكن|عشان|علشان|بحيث|اللي|إن|عشان)\s*$/i

// A legitimate closing SIGNATURE line (team identity + reply address)
// never ends in terminal punctuation -- "sales@mal3aby.app" is a
// complete, correct ending, not a truncation. Strip a trailing
// signature block (matched via the same SIGNATURE_PATTERNS this module
// already uses, plus a trailing email-address line) before checking for
// sentence-completeness, so the completeness check runs against the
// last PROSE content, not the non-sentence identity block that
// correctly follows it.
function stripTrailingSignatureBlock(text: string): string {
  const lines = text.trim().split('\n')
  while (lines.length > 0) {
    const lastLine = lines[lines.length - 1].trim()
    if (lastLine.length === 0) {
      lines.pop()
      continue
    }
    const isSignatureLine = SIGNATURE_PATTERNS.some((p) => p.test(lastLine)) || EMAIL_PATTERN.test(lastLine)
    // Reset EMAIL_PATTERN's lastIndex (it's a /g regex reused across
    // calls) so a stateful match here never leaks into a later,
    // unrelated .test()/.match() call elsewhere in this module.
    EMAIL_PATTERN.lastIndex = 0
    if (!isSignatureLine) break
    lines.pop()
  }
  return lines.join('\n')
}

function endsIncomplete(text: string): boolean {
  const trimmed = stripTrailingSignatureBlock(text).trim()
  if (trimmed.length === 0) return true
  if (DANGLING_CONNECTOR_PATTERN.test(trimmed)) return true
  return !TERMINAL_PUNCTUATION_PATTERN.test(trimmed)
}

function evaluateGenerationCompleteness(
  body: string,
  finishReason: QualityGateInput['finishReason'],
): { pass: boolean; truncatedByProvider: boolean; structurallyIncomplete: boolean } {
  const truncatedByProvider = finishReason === 'length'
  const structurallyIncomplete = endsIncomplete(body)
  return {
    pass: !truncatedByProvider && !structurallyIncomplete,
    truncatedByProvider,
    structurallyIncomplete,
  }
}

// ============================================================
// OUTPUT INTEGRITY (Defect 2, 2026-09-04 owner directive): "Add a
// conservative output-integrity check for obvious isolated generation
// artifacts / unexpected language fragments where they conflict with
// the expected message language and structure... Do NOT over-reject
// legitimate bilingual business names, product names, URLs, email
// addresses, or common technical terms."
//
// Conservative by construction: only flags a Latin-script TOKEN
// (word-like run of Latin letters) inside an otherwise-Arabic message
// when that token is BOTH (a) capitalized-word-shaped (starts with an
// uppercase letter, the shape of the real "Alley" artifact -- a random
// English word inserted mid-Arabic-sentence, not a deliberate proper
// noun the model was instructed to use) AND (b) NOT one of the
// allowlisted exceptions: email addresses, URLs, known business/product
// names (Mal3aby, and the lead's own business_name when provided), or a
// short list of common technical/business terms this codebase's own
// prompts legitimately use (QR, CTA-adjacent words are not in Arabic
// output anyway). A single ALL-CAPS acronym (QR, CRM, etc.) is also
// allowed -- acronyms are conservative-safe, they are never the "random
// inserted English word" failure shape.
//
// 2026-09-04 addition: 'gmail' -- found live in the first production
// regeneration under this hardened gate. Elmasry's regenerated draft
// correctly hedged the EVIDENCE_STRENGTH concern ("لاحظنا... بريدكم
// الإلكتروني كـ Gmail شخصي" -- an observation, not a workflow claim),
// but was then wrongly rejected by OUTPUT_INTEGRITY for the word
// "Gmail" itself. Gmail is a globally recognized email-service brand
// name, the exact same legitimate-proper-noun shape as "Mal3aby" --
// not a random inserted artifact like the real "Alley" defect this
// check exists to catch. Added here, plus its sibling common contact-
// channel/tech brand names most likely to appear in this same
// evidence-observation context, all conservative, well-established
// global brand names -- never a broad allowance for arbitrary
// capitalized English words.
// ============================================================
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const URL_PATTERN = /\bhttps?:\/\/[^\s]+/gi
const KNOWN_SAFE_LATIN_TERMS = new Set(['mal3aby', 'qr', 'cta', 'sms', 'whatsapp', 'email', 'url', 'gmail', 'outlook', 'yahoo', 'facebook', 'instagram', 'google'])

function stripAllowlistedLatinSpans(text: string, extraAllowedTerms: string[]): string {
  let stripped = text.replace(EMAIL_PATTERN, ' ').replace(URL_PATTERN, ' ')
  for (const term of extraAllowedTerms) {
    if (!term) continue
    // Escape regex metacharacters in a lead/business name before using it as a literal match.
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    stripped = stripped.replace(new RegExp(escaped, 'gi'), ' ')
  }
  return stripped
}

function hasForeignScriptArtifact(body: string, language: 'ar' | 'en', extraAllowedTerms: string[]): boolean {
  // English-language output is never checked for this -- the artifact
  // class this guards against is specifically "a stray Latin-script
  // word inserted into otherwise-Arabic output", which cannot occur
  // when the whole message is already in Latin script.
  if (language !== 'ar') return false

  const cleaned = stripAllowlistedLatinSpans(body, extraAllowedTerms)
  const latinWordMatches = cleaned.match(/\b[A-Za-z][A-Za-z]{2,}\b/g) ?? []

  for (const word of latinWordMatches) {
    const lower = word.toLowerCase()
    if (KNOWN_SAFE_LATIN_TERMS.has(lower)) continue
    // An ALL-CAPS run (an acronym, e.g. "PDF", "CRM") is conservative-safe.
    if (word === word.toUpperCase()) continue
    // A capitalized-word-shaped Latin token that survived every
    // allowlist above is the actual artifact shape observed live
    // ("Alley") -- flag it.
    if (/^[A-Z][a-z]+$/.test(word)) return true
  }
  return false
}

function evaluateOutputIntegrity(body: string, language: 'ar' | 'en', extraAllowedTerms: string[]): { pass: boolean; artifactFound: boolean } {
  const artifactFound = hasForeignScriptArtifact(body, language, extraAllowedTerms)
  return { pass: !artifactFound, artifactFound }
}

// ============================================================
// EVIDENCE STRENGTH (Defect 3, 2026-09-04 owner directive): "Observed
// contact/channel metadata must not be transformed into operational
// workflow claims without supporting evidence." Example: a public Gmail
// address being observed does NOT establish "they rely on Gmail to
// manage communications" -- that is a claim about an internal workflow,
// which the mere existence of a public contact address does not prove.
// ============================================================
const WORKFLOW_CLAIM_ABOUT_CONTACT_PATTERNS: RegExp[] = [
  // English: "rely on/manage/use ... email/gmail ... to manage/handle/run communications/outreach"
  /\b(rely on|relies on|manage|manages|use|uses|handle|handles)\b[\s\S]{0,30}\b(email|gmail|inbox)\b[\s\S]{0,40}\b(to manage|to handle|to run|for)\b[\s\S]{0,30}\b(communication|communications|outreach|inquiries|correspondence)\b/i,
  // Arabic: any surface form of "rely on / use" (verb تعتمدون/تستخدمون OR
  // the nominal "الاعتماد على" -- the exact construction the real
  // Elmasry defect used) ... بريد/جيميل/إيميل ... لإدارة/في إدارة/لتنظيم
  // ... التواصل/المراسلات/الاتصال.
  /(تعتمدون|تستخدمون|بتعتمدوا|بتستخدموا|الاعتماد على|اعتماد(كم|هم)? على|يعتمدون على)[\s\S]{0,20}(بريد|جيميل|إيميل)[\s\S]{0,40}(لإدارة|في إدارة|لتنظيم|بإدارة)[\s\S]{0,20}(التواصل|المراسلات|الاتصال)/,
]
const HEDGED_CONTACT_OBSERVATION_PATTERNS: RegExp[] = [
  /\bwe noticed\b[\s\S]{0,40}\b(is|as)\b[\s\S]{0,20}\bcontact\b/i,
  /\blisted as\b|\bappears to be\b|\bis published as\b/i,
  /لاحظنا[\s\S]{0,40}(وسيلة|قناة)[\s\S]{0,30}(المعلنة|المذكورة|الظاهرة)/,
]

function overstatesContactMetadataAsWorkflow(body: string, contactMetadataOnlySignalKeys: string[]): boolean {
  if (contactMetadataOnlySignalKeys.length === 0) return false
  const hasWorkflowClaim = WORKFLOW_CLAIM_ABOUT_CONTACT_PATTERNS.some((p) => p.test(body))
  const hasHedge = HEDGED_CONTACT_OBSERVATION_PATTERNS.some((p) => p.test(body))
  return hasWorkflowClaim && !hasHedge
}

function evaluateEvidenceStrength(body: string, contactMetadataOnlySignalKeys: string[]): { pass: boolean; overstated: boolean } {
  const overstated = overstatesContactMetadataAsWorkflow(body, contactMetadataOnlySignalKeys)
  return { pass: !overstated, overstated }
}

// "Multiple unrelated product pitches dumped" heuristic: counts bullet-
// list lines (markdown "- **Bold**:" or "-" items) introducing distinct
// feature names. More than 3 in a first-contact EMAIL is the "too many
// features at once" defect the owner flagged on Elmasry's draft (5
// bullets). Call scripts are exempt (their own CHANNEL_STRUCTURE_PASS
// gate governs them instead).
function countFeatureBullets(body: string): number {
  const bulletLines = body.split('\n').filter((line) => /^\s*[-*•]\s+/.test(line))
  return bulletLines.length
}
const MAX_EMAIL_FEATURE_BULLETS = 3

// ============================================================
// Email gate
// ============================================================
function evaluateEmail(input: QualityGateInput): QualityGateResult {
  const placeholders = findPlaceholders(`${input.subject ?? ''}\n${input.body}`)
  const words = wordCount(input.body)
  const cta = evaluateCta(input.body)
  const signaturePresent = hasSignature(input.body)
  const overstated = overstatesLowConfidence(input.body, input.lowConfidenceSignalKeys)
  const featureBullets = countFeatureBullets(input.body)
  const completeness = evaluateGenerationCompleteness(input.body, input.finishReason)
  const integrity = evaluateOutputIntegrity(input.body, input.language, [input.subject ?? '', input.businessName ?? ''])
  const evidenceStrength = evaluateEvidenceStrength(input.body, input.contactMetadataOnlySignalKeys ?? [])

  const reasons: QualityRejectionReason[] = []

  const subjectPass = !!input.subject && input.subject.trim().length > 0
  if (!subjectPass) reasons.push('MISSING_SUBJECT')

  const placeholderPass = placeholders.length === 0
  if (!placeholderPass) reasons.push('UNRESOLVED_PLACEHOLDER')

  const signaturePass = signaturePresent
  if (!signaturePass) reasons.push('MISSING_SIGNATURE')

  const ctaPass = cta.strong
  if (!cta.present) reasons.push('MISSING_CTA')
  else if (!cta.strong) reasons.push('WEAK_CTA')

  const lengthPass = words >= EMAIL_MIN_WORDS && words <= EMAIL_MAX_WORDS
  if (words > EMAIL_MAX_WORDS) reasons.push('MESSAGE_TOO_LONG')
  if (words < EMAIL_MIN_WORDS) reasons.push('MESSAGE_TOO_SHORT')

  const channelStructurePass = featureBullets <= MAX_EMAIL_FEATURE_BULLETS
  if (!channelStructurePass) reasons.push('MULTIPLE_PRODUCT_PITCHES_DUMPED')

  const confidenceLanguagePass = !overstated
  if (overstated) reasons.push('CONFIDENCE_OVERSTATED')

  const groundingPass = input.groundingPassed
  if (!groundingPass) reasons.push('UNSUPPORTED_CLAIM')

  const generationCompletenessPass = completeness.pass
  if (!generationCompletenessPass) reasons.push('GENERATION_TRUNCATED')

  const outputIntegrityPass = integrity.pass
  if (!outputIntegrityPass) reasons.push('OUTPUT_INTEGRITY_FAILED')

  const evidenceStrengthPass = evidenceStrength.pass
  if (!evidenceStrengthPass) reasons.push('EVIDENCE_STRENGTH_OVERSTATED')

  const gates: Record<QualityGateName, boolean> = {
    GROUNDING_PASS: groundingPass,
    EVIDENCE_STRENGTH_PASS: evidenceStrengthPass,
    PLACEHOLDER_PASS: placeholderPass,
    SUBJECT_PASS: subjectPass,
    SIGNATURE_PASS: signaturePass,
    CTA_PASS: ctaPass,
    LENGTH_PASS: lengthPass,
    CHANNEL_STRUCTURE_PASS: channelStructurePass,
    CONFIDENCE_LANGUAGE_PASS: confidenceLanguagePass,
    GENERATION_COMPLETENESS_PASS: generationCompletenessPass,
    OUTPUT_INTEGRITY_PASS: outputIntegrityPass,
  }

  const allPass = Object.values(gates).every(Boolean)

  return {
    gates,
    status: allPass ? 'APPROVAL_READY' : 'QUALITY_REJECTED',
    rejection_reasons: reasons,
    detail: {
      word_count: words,
      placeholders_found: placeholders,
      feature_bullet_count: featureBullets,
      cta_present: cta.present,
      cta_strong: cta.strong,
      truncated_by_provider: completeness.truncatedByProvider,
      structurally_incomplete: completeness.structurallyIncomplete,
      output_artifact_found: integrity.artifactFound,
      evidence_overstated: evidenceStrength.overstated,
    },
  }
}

// ============================================================
// Call-task (phone_script / whatsapp_talking_points) gate
// ============================================================
// Literal opening: a real, quotable spoken line -- not a topic label
// like "افتتاحية عن ملعبي". Detected via quoted text ("..."/"..."/«...»)
// OR a line that reads as first-person spoken address (starts with a
// greeting/self-intro pattern) rather than a meta-description of what
// the opening SHOULD cover.
const QUOTED_LINE_PATTERN = /["“”«»][^"“”«»]{8,300}["“”«»]/
const FIRST_PERSON_OPENING_PATTERNS: RegExp[] = [
  /\bmy name is\b|\bthis is\b.*\bcalling\b|\bhi[,!]?\s+(this|i)\b/i,
  /\bمعاك من\b|\bمعك من\b|\bاسمي\b|\bمساء الخير\b|\bصباح الخير\b|\bاتصل بحضرتك\b/,
]

// Scope the opening check to the OPENING SECTION only (roughly the
// first ~400 characters, or up to the first section-boundary keyword,
// whichever is shorter) -- otherwise a quoted objection-response line
// deep in the script (e.g. "عندنا نظام بالفعل": ...) would be
// misdetected as a literal opening even though the actual opening is
// just a meta-description like "افتتاحية: مقدمة عن ملعبي...".
const SECTION_BOUNDARY_PATTERN = /(discovery|أسئلة استكشافية|value proposition|القيمة المقترحة|objection|الرد على الاعتراضات)/i

function openingSection(body: string): string {
  const boundaryMatch = body.match(SECTION_BOUNDARY_PATTERN)
  const cutoff = boundaryMatch?.index ?? body.length
  return body.slice(0, Math.min(cutoff, 400))
}

function hasLiteralOpening(body: string): boolean {
  const section = openingSection(body)
  return QUOTED_LINE_PATTERN.test(section) || FIRST_PERSON_OPENING_PATTERNS.some((p) => p.test(section))
}

// Discovery questions: count lines/sentences containing a question mark
// (Arabic ؟ or Latin ?) that appear in a "discovery"-labeled section OR
// simply count total question-marked sentences in the script as a
// reasonable proxy (a call script's questions ARE its discovery
// questions in this codebase's format -- no separate free-text
// commentary to exclude).
function countQuestions(body: string): number {
  const matches = body.match(/[^.!\n]*[؟?]/g)
  return matches ? matches.length : 0
}

// Objection handling: requires evidence of at least the 3 minimum
// objections the owner specified, matched by topic (already-have-a-
// system / send-me-info / not-interested), each near an answering
// clause. Heuristic: looks for objection-topic phrases; a real
// objection-response PAIR is confirmed by proximity to a response-cue
// word (رد/الرد/جواب/response/reply/because/لأن) within the same
// paragraph, but for the deterministic gate we require at minimum the
// 3 objection TOPICS to be textually present (topic-only match still
// counts as "addressed" for gate purposes -- the exact reply wording is
// reviewed by the human approver, the gate's job is to prove the
// objection was not skipped entirely).
// NOTE: `\b` word boundaries are unreliable around Arabic script in JS
// regex (Arabic letters are outside `\w`), so each language variant is
// its own pattern -- `\b`-wrapped only for the English alternatives,
// plain substring match for the Arabic ones. Grouped by TOPIC (each
// inner array = one of the 3 minimum objections) so a script written in
// either language, or mixing both, is still counted as ONE topic
// addressed, not zero or double-counted.
const OBJECTION_TOPICS: RegExp[][] = [
  [/\b(already have|existing system)\b/i, /عندنا نظام|لدينا نظام|بنستخدم نظام|عندنا بالفعل/],
  [/\bsend (me|us) (information|info)\b/i, /ابعتلي معلومات|ابعت لينا تفاصيل|أرسل لنا|ابعتلنا تفاصيل/],
  [/\b(not interested|not now)\b/i, /مش مهتم|مش محتاجين|مش دلوقتي|مش الوقت المناسب|مش وقتها/],
]

function countObjectionsAddressed(body: string): number {
  return OBJECTION_TOPICS.filter((patterns) => patterns.some((p) => p.test(body))).length
}

const MIN_DISCOVERY_QUESTIONS = 2
const MIN_OBJECTIONS = 3

function evaluateCallTask(input: QualityGateInput): QualityGateResult {
  const placeholders = findPlaceholders(input.body)
  const literalOpening = hasLiteralOpening(input.body)
  const discoveryQuestions = countQuestions(input.body)
  const objectionsAddressed = countObjectionsAddressed(input.body)
  const cta = evaluateCta(input.body)
  const overstated = overstatesLowConfidence(input.body, input.lowConfidenceSignalKeys)
  const completeness = evaluateGenerationCompleteness(input.body, input.finishReason)
  const integrity = evaluateOutputIntegrity(input.body, input.language, [input.businessName ?? ''])
  const evidenceStrength = evaluateEvidenceStrength(input.body, input.contactMetadataOnlySignalKeys ?? [])

  const reasons: QualityRejectionReason[] = []

  const placeholderPass = placeholders.length === 0
  if (!placeholderPass) reasons.push('UNRESOLVED_PLACEHOLDER')

  // No email subject concept for a call script -- always trivially
  // satisfied so the shared gate-shape stays uniform across channels.
  const subjectPass = true

  // No closing "signature" concept for a spoken call -- a call task's
  // "signature" equivalent is the caller identifying themselves in the
  // literal opening, already covered by CHANNEL_STRUCTURE_PASS/opening
  // check below; kept true here for the same shared-shape reason.
  const signaturePass = true

  const ctaPass = cta.present
  if (!cta.present) reasons.push('MISSING_CTA')

  // No hard word-length ceiling for a spoken script (owner did not
  // specify one) -- LENGTH_PASS here instead guards the MINIMUM: a
  // one-sentence scaffold (the exact CIC Arenas/Nasr City defect) is
  // too short to be an executable script.
  const words = wordCount(input.body)
  const CALL_SCRIPT_MIN_WORDS = 40
  const lengthPass = words >= CALL_SCRIPT_MIN_WORDS
  if (!lengthPass) reasons.push('MESSAGE_TOO_SHORT')

  const openingOk = literalOpening
  const discoveryOk = discoveryQuestions >= MIN_DISCOVERY_QUESTIONS
  const objectionsOk = objectionsAddressed >= MIN_OBJECTIONS
  const channelStructurePass = openingOk && discoveryOk && objectionsOk
  if (!openingOk) reasons.push('MISSING_LITERAL_OPENING')
  if (!discoveryOk) reasons.push('INSUFFICIENT_DISCOVERY_QUESTIONS')
  if (!objectionsOk) reasons.push('MISSING_OBJECTION_HANDLING')

  const confidenceLanguagePass = !overstated
  if (overstated) reasons.push('CONFIDENCE_OVERSTATED')

  const groundingPass = input.groundingPassed
  if (!groundingPass) reasons.push('UNSUPPORTED_CLAIM')

  const generationCompletenessPass = completeness.pass
  if (!generationCompletenessPass) reasons.push('GENERATION_TRUNCATED')

  const outputIntegrityPass = integrity.pass
  if (!outputIntegrityPass) reasons.push('OUTPUT_INTEGRITY_FAILED')

  const evidenceStrengthPass = evidenceStrength.pass
  if (!evidenceStrengthPass) reasons.push('EVIDENCE_STRENGTH_OVERSTATED')

  const gates: Record<QualityGateName, boolean> = {
    GROUNDING_PASS: groundingPass,
    EVIDENCE_STRENGTH_PASS: evidenceStrengthPass,
    PLACEHOLDER_PASS: placeholderPass,
    SUBJECT_PASS: subjectPass,
    SIGNATURE_PASS: signaturePass,
    CTA_PASS: ctaPass,
    LENGTH_PASS: lengthPass,
    CHANNEL_STRUCTURE_PASS: channelStructurePass,
    CONFIDENCE_LANGUAGE_PASS: confidenceLanguagePass,
    GENERATION_COMPLETENESS_PASS: generationCompletenessPass,
    OUTPUT_INTEGRITY_PASS: outputIntegrityPass,
  }

  const allPass = Object.values(gates).every(Boolean)

  return {
    gates,
    status: allPass ? 'APPROVAL_READY' : 'QUALITY_REJECTED',
    rejection_reasons: reasons,
    detail: {
      word_count: words,
      placeholders_found: placeholders,
      literal_opening_found: literalOpening,
      discovery_question_count: discoveryQuestions,
      objections_addressed_count: objectionsAddressed,
      cta_present: cta.present,
      truncated_by_provider: completeness.truncatedByProvider,
      structurally_incomplete: completeness.structurallyIncomplete,
      output_artifact_found: integrity.artifactFound,
      evidence_overstated: evidenceStrength.overstated,
    },
  }
}

// ============================================================
// Entry point
// ============================================================
export function evaluateOutreachQuality(input: QualityGateInput): QualityGateResult {
  if (input.channel === 'email') return evaluateEmail(input)
  return evaluateCallTask(input)
}
