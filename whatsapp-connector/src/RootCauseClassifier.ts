/**
 * RootCauseClassifier -- pure classification engine for the WhatsApp
 * Health & Root Cause Center. Takes only the diagnostic evidence
 * already collected elsewhere (SendDiagnostics.ts, ProcessDiagnostics.ts,
 * BaileysProvider.getDiagnostics()) and maps it to exactly one of the
 * fixed codes in whatsapp_root_cause_codes (Supabase), with an explicit
 * confidence level -- NEVER a guess dressed up as a fact.
 *
 * Design rule (explicit, non-negotiable): if the evidence is
 * insufficient to support a specific code with real confidence, this
 * returns UNKNOWN with confidence 'unproven' -- it does not invent a
 * plausible-sounding explanation. Every branch below cites the exact
 * evidence it depends on in a comment, so a future reader can verify
 * the classification logic isn't smuggling in an assumption.
 */

export type RootCauseCode =
  | 'DATABASE_QUEUE_DELAY'
  | 'QUEUE_CLAIM_FAILED'
  | 'NO_ACTIVE_PROVIDER'
  | 'SOCKET_NOT_CONNECTED'
  | 'SOCKET_STALE'
  | 'USYNC_TIMEOUT'
  | 'PROTOCOL_QUERY_TIMEOUT'
  | 'WEBSOCKET_WRITE_FAILURE'
  | 'WHATSAPP_ACK_TIMEOUT'
  | 'NETWORK_DNS_FAILURE'
  | 'NETWORK_TLS_FAILURE'
  | 'CONNECTION_LOST'
  | 'SESSION_RESTORE_FAILED'
  | 'SESSION_LOGGED_OUT'
  | 'DUPLICATE_SOCKET_CONFLICT'
  | 'RECONNECT_EXHAUSTED'
  | 'CONTAINER_RESTART'
  | 'CONTAINER_EVICTION'
  | 'PROCESS_UNCAUGHT_EXCEPTION'
  | 'PROCESS_UNHANDLED_REJECTION'
  | 'MEDIA_GENERATION_FAILED'
  | 'QR_GENERATION_FAILED'
  | 'PDF_GENERATION_FAILED'
  | 'MEDIA_UPLOAD_FAILED'
  | 'DELIVERY_UNCERTAIN'
  | 'RATE_LIMITED'
  | 'CIRCUIT_BREAKER_OPEN'
  | 'UNKNOWN'

export type Confidence = 'high' | 'medium' | 'low' | 'unproven'

export interface ClassificationResult {
  code: RootCauseCode
  confidence: Confidence
  /** Short, factual evidence bullets -- what was actually observed, never speculation. */
  evidence: string[]
}

export interface ClassificationInput {
  /** Did the send even get past a provider lookup at all? */
  hadActiveProvider: boolean
  /** Baileys' own reported connection state at send time, if known. */
  connectionState?: 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'qr_required' | 'logged_out' | 'failed' | 'error' | 'degraded' | 'restricted'
  /** The last pipeline stage genuinely reached (from SendDiagnostics.ts's stage timeline). */
  lastStageReached?: 'started' | 'text_sent' | 'media_sent' | 'timed_out' | 'error' | 'done' | 'queue_claimed' | 'template_rendered'
  /** true only if our OWN external timeout fired (BaileysProvider.ts's withSendTimeout()) -- never true for a Baileys-reported error. */
  wasOurOwnTimeout: boolean
  /** Verbatim Baileys-reported error message, ONLY when genuinely Baileys-reported (never our own timeout text). */
  baileysErrorMessage?: string
  /** Elapsed ms for the failed stage, if known. */
  elapsedMs?: number
  /** Was there a recent (correlatable) uncaughtException/unhandledRejection shortly before this failure? */
  recentProcessException?: boolean
  /** Was there a recent container restart/eviction (onStop with a Cloudflare-attributed reason) shortly before this failure? */
  recentContainerRestart?: { reason: 'exit' | 'runtime_signal' | 'rollout' | 'eviction' } | null
  /** Circuit breaker currently open for this club? */
  circuitBreakerOpen: boolean
  /** Media generation specifically failed (InvoicePdf.ts threw), distinct from the send itself. 'qr' kind is legacy/unreachable since the booking_qr media_intent was removed (2026-08-23) -- kept in the union only so historical incident records with that kind still type-check. */
  mediaGenerationFailed?: { kind: 'qr' | 'pdf' | 'unknown' }
  /** Media generation succeeded but the upload/send of it failed. */
  mediaUploadFailed?: boolean
  /** How many rows were ahead of this one in the same claimed batch (QueueConsumer.ts's sequential processing). */
  queuePositionInBatch?: number
}

/**
 * Maps input evidence to exactly one classification. Order matters:
 * more specific, higher-confidence branches are checked first so a
 * generic fallback never masks a specific, well-evidenced cause.
 */
export function classifyRootCause(input: ClassificationInput): ClassificationResult {
  // Media-specific failures are the most specific and unambiguous --
  // if media generation itself threw, that IS the cause, full stop.
  if (input.mediaGenerationFailed) {
    const evidence = [`Media generation for a ${input.mediaGenerationFailed.kind} attachment threw before any send attempt was made.`]
    return {
      code: input.mediaGenerationFailed.kind === 'qr' ? 'QR_GENERATION_FAILED' : input.mediaGenerationFailed.kind === 'pdf' ? 'PDF_GENERATION_FAILED' : 'MEDIA_GENERATION_FAILED',
      confidence: 'high',
      evidence,
    }
  }
  if (input.mediaUploadFailed) {
    return {
      code: 'MEDIA_UPLOAD_FAILED',
      confidence: 'high',
      evidence: ['Media was generated successfully but the WhatsApp send of that attachment failed.'],
    }
  }

  if (input.circuitBreakerOpen) {
    return {
      code: 'CIRCUIT_BREAKER_OPEN',
      confidence: 'high',
      evidence: ['whatsapp_accounts.circuit_breaker_open_until is in the future for this club at the time of this attempt.'],
    }
  }

  if (!input.hadActiveProvider) {
    return {
      code: 'NO_ACTIVE_PROVIDER',
      confidence: 'high',
      evidence: ['TenantConnectionManager had no provider instance for this club at send time.'],
    }
  }

  if (input.connectionState === 'logged_out') {
    return { code: 'SESSION_LOGGED_OUT', confidence: 'high', evidence: ['BaileysProvider reported connectionState=logged_out.'] }
  }
  if (input.connectionState === 'failed') {
    return { code: 'RECONNECT_EXHAUSTED', confidence: 'high', evidence: ['BaileysProvider reported connectionState=failed (reconnect attempt budget exhausted).'] }
  }
  if (input.connectionState === 'reconnecting' || input.connectionState === 'connecting' || input.connectionState === 'disconnected' || input.connectionState === 'qr_required') {
    return { code: 'SOCKET_NOT_CONNECTED', confidence: 'high', evidence: [`BaileysProvider reported connectionState=${input.connectionState} at send time.`] }
  }

  // A recent process-level exception is checked BEFORE the more
  // generic timeout classifications, since Node's own documented
  // "resuming after uncaughtException is unsafe" behavior could
  // plausibly be the reason a later operation behaves unexpectedly --
  // per the explicit P1 investigation, this correlation is evidence,
  // not proof, hence 'medium' not 'high'.
  if (input.recentProcessException && (input.wasOurOwnTimeout || input.lastStageReached === 'error')) {
    return {
      code: 'PROCESS_UNCAUGHT_EXCEPTION',
      confidence: 'medium',
      evidence: [
        'An uncaughtException or unhandledRejection was recorded shortly before this send attempt failed.',
        'Node.js documentation states resuming normal execution after uncaughtException is not guaranteed safe -- this correlation is suggestive, not conclusive on its own.',
      ],
    }
  }

  if (input.recentContainerRestart) {
    const r = input.recentContainerRestart.reason
    return {
      code: r === 'eviction' ? 'CONTAINER_EVICTION' : 'CONTAINER_RESTART',
      confidence: 'high',
      evidence: [`The container was restarted (reason=${r}) shortly before or during this send attempt.`],
    }
  }

  // The specific, evidence-backed USync hypothesis: our OWN timeout
  // fired (not a Baileys-reported error), the last stage reached was
  // still 'started' (never reached text_sent), and elapsed time is in
  // the range consistent with the getUSyncDevices()/query() path
  // (roughly 40s+ -- below that a genuine transient blip is more
  // likely than this specific mechanism). This is 'medium', not
  // 'high', until the live production A/B test the review directive
  // required actually confirms it end to end -- see BaileysProvider.ts's
  // class-level doc comment for the three possible outcomes that test
  // can produce.
  if (input.wasOurOwnTimeout && input.lastStageReached !== 'text_sent' && input.lastStageReached !== 'media_sent' && (input.elapsedMs ?? 0) >= 40_000) {
    const evidence = [
      'Our own external send timeout fired (not a Baileys-reported error).',
      `The send never progressed past its initial stage before timing out (elapsed ${input.elapsedMs}ms).`,
      'This matches the getUSyncDevices()/USync-query code path Baileys unconditionally runs on a direct message before building the message stanza -- NOT YET CONFIRMED by a live production A/B test (see BaileysProvider.ts).',
    ]
    if ((input.queuePositionInBatch ?? 0) > 0) {
      evidence.push(`This row was position ${(input.queuePositionInBatch ?? 0) + 1} in its claimed batch -- sequential processing means it may not have even started its own attempt until earlier rows' timeouts elapsed.`)
    }
    return { code: 'USYNC_TIMEOUT', confidence: 'medium', evidence }
  }

  if (input.wasOurOwnTimeout) {
    return {
      code: 'DELIVERY_UNCERTAIN',
      confidence: 'low',
      evidence: [`Our own external timeout fired after ${input.elapsedMs}ms, but the failure does not match the specific USync-timeout pattern with enough confidence to classify further.`],
    }
  }

  if (input.baileysErrorMessage) {
    const msg = input.baileysErrorMessage.toLowerCase()
    if (msg.includes('conflict') || msg.includes('replaced')) {
      return { code: 'DUPLICATE_SOCKET_CONFLICT', confidence: 'high', evidence: [`Baileys reported: ${input.baileysErrorMessage}`] }
    }
    if (msg.includes('connection closed') || msg.includes('connection lost')) {
      return { code: 'CONNECTION_LOST', confidence: 'high', evidence: [`Baileys reported: ${input.baileysErrorMessage}`] }
    }
    if (msg.includes('timed out') || msg.includes('timeout')) {
      return { code: 'PROTOCOL_QUERY_TIMEOUT', confidence: 'high', evidence: [`Baileys itself reported a timeout (not our own external wrapper): ${input.baileysErrorMessage}`] }
    }
    if (msg.includes('enotfound') || msg.includes('dns')) {
      return { code: 'NETWORK_DNS_FAILURE', confidence: 'high', evidence: [`Baileys reported: ${input.baileysErrorMessage}`] }
    }
    if (msg.includes('tls') || msg.includes('certificate') || msg.includes('ssl')) {
      return { code: 'NETWORK_TLS_FAILURE', confidence: 'high', evidence: [`Baileys reported: ${input.baileysErrorMessage}`] }
    }
    return {
      code: 'WEBSOCKET_WRITE_FAILURE',
      confidence: 'medium',
      evidence: [`Baileys reported an error that does not match a more specific known pattern: ${input.baileysErrorMessage}`],
    }
  }

  // No specific evidence matched any branch above -- honest fallback,
  // never a guess dressed as a fact.
  return {
    code: 'UNKNOWN',
    confidence: 'unproven',
    evidence: ['No specific evidence pattern matched -- the real cause has not been determined yet.'],
  }
}
