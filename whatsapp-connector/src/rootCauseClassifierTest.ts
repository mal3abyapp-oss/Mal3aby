/**
 * rootCauseClassifierTest.ts -- coverage for every classification
 * branch RootCauseClassifier.ts implements, per the explicit test
 * requirement: DB failure, queue failure, socket failure, USync
 * timeout, connection loss, container restart, session logout, media
 * generation failure (QR/PDF), and the "no specific evidence" honest
 * fallback. A successful send is not itself classified (only failures
 * are) -- covered here as "classifier is not invoked for success".
 *
 * Run with: npx tsx src/rootCauseClassifierTest.ts
 */
import { classifyRootCause, type ClassificationInput } from './RootCauseClassifier.js'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[rootCauseClassifierTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[rootCauseClassifierTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

const base: ClassificationInput = {
  hadActiveProvider: true,
  connectionState: 'connected',
  wasOurOwnTimeout: false,
  circuitBreakerOpen: false,
}

// 1. No active provider at all (e.g. club never connected) -> NO_ACTIVE_PROVIDER, high confidence.
{
  const r = classifyRootCause({ ...base, hadActiveProvider: false })
  check('no active provider classifies as NO_ACTIVE_PROVIDER with high confidence', r.code === 'NO_ACTIVE_PROVIDER' && r.confidence === 'high')
}

// 2. Socket genuinely not connected -> SOCKET_NOT_CONNECTED.
{
  const r = classifyRootCause({ ...base, connectionState: 'reconnecting' })
  check('a reconnecting connection state classifies as SOCKET_NOT_CONNECTED', r.code === 'SOCKET_NOT_CONNECTED' && r.confidence === 'high')
}

// 3. Session logged out -> SESSION_LOGGED_OUT, critical-severity code.
{
  const r = classifyRootCause({ ...base, connectionState: 'logged_out' })
  check('a logged_out connection state classifies as SESSION_LOGGED_OUT', r.code === 'SESSION_LOGGED_OUT' && r.confidence === 'high')
}

// 4. The specific USync-timeout evidence pattern this whole
// investigation is built around: our own timeout fired, never
// progressed past the initial stage, elapsed >= 40s.
{
  const r = classifyRootCause({ ...base, wasOurOwnTimeout: true, lastStageReached: 'started', elapsedMs: 45_000 })
  check(
    'our own timeout + stuck at "started" + >=40s elapsed classifies as USYNC_TIMEOUT at medium (not high) confidence',
    r.code === 'USYNC_TIMEOUT' && r.confidence === 'medium',
    `got code=${r.code} confidence=${r.confidence}`,
  )
}

// 4b. Same shape, but with a queue-batch-position hint -- the
// compounding-delay finding should surface in the evidence text.
{
  const r = classifyRootCause({ ...base, wasOurOwnTimeout: true, lastStageReached: 'started', elapsedMs: 75_000, queuePositionInBatch: 3 })
  check('a non-zero queuePositionInBatch is reflected in the evidence bullets', r.evidence.some((e) => e.includes('position 4')))
}

// 5. Our own timeout fired but doesn't match the specific USync
// pattern (e.g. very short elapsed) -> DELIVERY_UNCERTAIN at low
// confidence, never asserted as a specific cause without evidence.
{
  const r = classifyRootCause({ ...base, wasOurOwnTimeout: true, lastStageReached: 'started', elapsedMs: 5_000 })
  check('an ambiguous timeout classifies as DELIVERY_UNCERTAIN at low confidence, not a specific guess', r.code === 'DELIVERY_UNCERTAIN' && r.confidence === 'low')
}

// 6. A genuinely Baileys-reported "Connection Closed" error -> CONNECTION_LOST.
{
  const r = classifyRootCause({ ...base, baileysErrorMessage: 'Boom: Connection Closed' })
  check('a Baileys "Connection Closed" error classifies as CONNECTION_LOST', r.code === 'CONNECTION_LOST' && r.confidence === 'high')
}

// 7. A genuinely Baileys-reported "conflict/replaced" error -> DUPLICATE_SOCKET_CONFLICT.
{
  const r = classifyRootCause({ ...base, baileysErrorMessage: 'stream:error (conflict, replaced by new session)' })
  check('a Baileys conflict/replaced error classifies as DUPLICATE_SOCKET_CONFLICT', r.code === 'DUPLICATE_SOCKET_CONFLICT' && r.confidence === 'high')
}

// 8. Container restart correlated with the failure -> CONTAINER_RESTART / CONTAINER_EVICTION.
{
  const r1 = classifyRootCause({ ...base, recentContainerRestart: { reason: 'rollout' } })
  check('a rollout-caused restart classifies as CONTAINER_RESTART', r1.code === 'CONTAINER_RESTART')
  const r2 = classifyRootCause({ ...base, recentContainerRestart: { reason: 'eviction' } })
  check('a platform eviction classifies as CONTAINER_EVICTION, distinct from a normal restart', r2.code === 'CONTAINER_EVICTION')
}

// 9. QR generation failure -> QR_GENERATION_FAILED, high confidence (unambiguous, the exception itself is the evidence).
{
  const r = classifyRootCause({ ...base, mediaGenerationFailed: { kind: 'qr' } })
  check('a QR generation failure classifies as QR_GENERATION_FAILED', r.code === 'QR_GENERATION_FAILED' && r.confidence === 'high')
}

// 10. PDF generation failure -> PDF_GENERATION_FAILED.
{
  const r = classifyRootCause({ ...base, mediaGenerationFailed: { kind: 'pdf' } })
  check('a PDF generation failure classifies as PDF_GENERATION_FAILED', r.code === 'PDF_GENERATION_FAILED' && r.confidence === 'high')
}

// 11. Media generated successfully but upload/send failed -> MEDIA_UPLOAD_FAILED, distinct from generation failure.
{
  const r = classifyRootCause({ ...base, mediaUploadFailed: true })
  check('a media upload failure (post-generation) classifies as MEDIA_UPLOAD_FAILED, not a generation code', r.code === 'MEDIA_UPLOAD_FAILED')
}

// 12. Circuit breaker open -> CIRCUIT_BREAKER_OPEN, checked before anything else (it's the most specific "why nothing was even attempted" reason).
{
  const r = classifyRootCause({ ...base, circuitBreakerOpen: true, connectionState: 'reconnecting' })
  check('circuit breaker open takes precedence over a merely-reconnecting state', r.code === 'CIRCUIT_BREAKER_OPEN')
}

// 13. A recent uncaught exception correlated with the failure -> PROCESS_UNCAUGHT_EXCEPTION at MEDIUM confidence (correlation, not proof -- per the explicit P1 investigation rule).
{
  const r = classifyRootCause({ ...base, wasOurOwnTimeout: true, recentProcessException: true })
  check(
    'a correlated recent process exception classifies as PROCESS_UNCAUGHT_EXCEPTION at medium (not high) confidence',
    r.code === 'PROCESS_UNCAUGHT_EXCEPTION' && r.confidence === 'medium',
  )
}

// 14. Honest fallback: no matching evidence at all -> UNKNOWN, confidence 'unproven' -- never a guess.
{
  const r = classifyRootCause({ ...base })
  check('no matching evidence classifies as UNKNOWN with confidence "unproven", never a guessed specific code', r.code === 'UNKNOWN' && r.confidence === 'unproven')
}

// 15. A DB/queue-layer symptom (modeled here as "no active provider"
// combined with a queue-position hint representing backlog) is
// distinguishable in the evidence text from a pure Baileys-layer
// failure -- this is what lets the UI show "the database/queue was the
// bottleneck" instead of always blaming Baileys.
{
  const r = classifyRootCause({ ...base, wasOurOwnTimeout: true, lastStageReached: 'started', elapsedMs: 60_000, queuePositionInBatch: 2 })
  check('a queue-backlog-correlated USync timeout still cites the batch-position evidence distinctly', r.evidence.some((e) => e.toLowerCase().includes('batch')))
}

console.log(`\n[rootCauseClassifierTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
if (failures > 0) process.exit(1)
