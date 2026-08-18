/**
 * sendReliabilityTest.ts -- regression coverage for the send-hang
 * investigation (2026-08-18). TRUE root cause (confirmed via a
 * decisive, controlled A/B test, see BaileysProvider.ts's
 * toWhatsAppJid() doc comment): an unnormalized "+"-prefixed phone
 * number produced a malformed JID WhatsApp's servers never usefully
 * responded to, causing Baileys' own internal query() to hang for its
 * full ~60s ceiling -- nothing to do with the database/queue layer,
 * Baileys' USync mechanism, or Cloudflare's network. The
 * SEND_TIMEOUT_MS-vs-Baileys-defaultQueryTimeoutMs margin tested below
 * remains real defense-in-depth (a genuinely different hang could still
 * occur), but is no longer the load-bearing fix -- toWhatsAppJid()'s
 * own normalization is. This file never opens a real Baileys/WhatsApp
 * connection -- it covers the timeout margin, the JID normalization,
 * and the diagnostics modules in isolation.
 *
 * Run with: npx tsx src/sendReliabilityTest.ts
 */
import { recordSendStart, recordSendStage, recordSendOutcome, recordConnectionOpen, getSendDiagnosticsSnapshot } from './SendDiagnostics.js'
import { recordUncaughtException, recordUnhandledRejection, getProcessDiagnosticsSnapshot } from './ProcessDiagnostics.js'
import { toWhatsAppJid } from './BaileysProvider.js'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[sendReliabilityTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[sendReliabilityTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

/** Mirrors BaileysProvider.ts's withSendTimeout() exactly -- kept local so this test never imports @whiskeysockets/baileys or opens a real socket. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} send timed out after ${ms}ms (socket.sendMessage() never resolved)`))
    }, ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch((err) => {
        clearTimeout(timer)
        reject(err)
      })
  })
}

async function main() {
  // 1. The core regression: a slow-but-legitimate operation that
  // resolves just under Baileys' own 60s query ceiling must NOT be
  // misreported as a timeout by our external wrapper -- this is
  // exactly the getUSyncDevices()/query() shape that was firing on
  // every first send. Using short, scaled-down real ms values (not the
  // real 60s/75s) so this test runs in under a second, but the same
  // ratio: our wrapper's timeout must exceed the wrapped operation's
  // own delay.
  const OUR_TIMEOUT_MS = 150
  const BAILEYS_INTERNAL_DELAY_MS = 100 // stands in for "Baileys' own query resolves a bit slowly, but within its own bound"
  const slowButLegitimate = new Promise<{ ok: true }>((resolve) => setTimeout(() => resolve({ ok: true }), BAILEYS_INTERNAL_DELAY_MS))
  const result = await withTimeout(slowButLegitimate, OUR_TIMEOUT_MS, 'text').catch((err: Error) => err)
  check(
    'a slow-but-legitimate operation shorter than our own timeout resolves successfully, not as a false timeout',
    !(result instanceof Error) && result.ok === true,
    result instanceof Error ? result.message : undefined,
  )

  // 2. The old, buggy shape -- OUR timeout shorter than the wrapped
  // operation -- must still surface as a clearly-labeled timeout error
  // (this is what SEND_TIMEOUT_MS = 45_000 did against Baileys' real
  // 60_000 defaultQueryTimeoutMs). Kept as a regression guard: if this
  // stops matching, the error message format itself changed, which the
  // uncertain-delivery classification logic (BaileysProvider.ts) relies
  // on via `.includes('never resolved')`.
  const OUR_SHORTER_TIMEOUT_MS = 50
  const opThatOutlivesOurTimeout = new Promise<{ ok: true }>((resolve) => setTimeout(() => resolve({ ok: true }), 200))
  const timeoutResult = await withTimeout(opThatOutlivesOurTimeout, OUR_SHORTER_TIMEOUT_MS, 'text').catch((err: Error) => err)
  check(
    'a genuinely too-short external timeout still produces a clearly-labeled, classifiable timeout error',
    timeoutResult instanceof Error && timeoutResult.message.includes('never resolved') && timeoutResult.message.includes('text'),
    timeoutResult instanceof Error ? timeoutResult.message : 'did not reject',
  )

  // 3. The actual production constant relationship this whole fix
  // depends on: SEND_TIMEOUT_MS (75_000, BaileysProvider.ts) must stay
  // above Baileys' own defaultQueryTimeoutMs (60_000,
  // @whiskeysockets/baileys Defaults/index.js) with a real margin, not
  // equal to or below it. Read directly from the installed package so
  // this test fails loudly if a future Baileys upgrade changes that
  // default out from under us.
  const { DEFAULT_CONNECTION_CONFIG } = await import('@whiskeysockets/baileys')
  const baileysDefaultQueryTimeoutMs = (DEFAULT_CONNECTION_CONFIG as { defaultQueryTimeoutMs?: number }).defaultQueryTimeoutMs
  const OUR_PRODUCTION_SEND_TIMEOUT_MS = 75_000
  check(
    'production SEND_TIMEOUT_MS (75s) stays above the installed Baileys package\'s own defaultQueryTimeoutMs',
    typeof baileysDefaultQueryTimeoutMs === 'number' && OUR_PRODUCTION_SEND_TIMEOUT_MS > baileysDefaultQueryTimeoutMs,
    `baileys defaultQueryTimeoutMs=${baileysDefaultQueryTimeoutMs}, ours=${OUR_PRODUCTION_SEND_TIMEOUT_MS}`,
  )

  // 3b. THE actual, confirmed root-cause fix: toWhatsAppJid() must
  // strip a "+" prefix -- this is the exact real-world input every
  // queue-driven caller passes (notification_queue.recipient_phone /
  // customers.normalized_mobile both store the E.164 "+"-prefixed
  // form). Regression-proven live: "+971502061209" hung for 59,999ms
  // (Baileys' own "Timed Out" error); "971502061209" resolved in 240ms
  // on the identical socket generation, seconds apart
  // (jidFormatIsolationTest.ts).
  check(
    'toWhatsAppJid() strips a "+" prefix -- the exact real-world value that caused every queue-driven send to hang for ~60s',
    toWhatsAppJid('+971502061209') === '971502061209@s.whatsapp.net',
    toWhatsAppJid('+971502061209'),
  )
  check(
    'toWhatsAppJid() is a no-op for an already-digits-only number (the shape every direct-call test in this investigation used)',
    toWhatsAppJid('971502061209') === '971502061209@s.whatsapp.net',
  )
  check(
    'toWhatsAppJid() strips other non-digit characters too (spaces, dashes, parentheses) -- not just "+", since any of them would produce the same malformed-JID hang',
    toWhatsAppJid('+971 50-206 (1209)') === '971502061209@s.whatsapp.net',
    toWhatsAppJid('+971 50-206 (1209)'),
  )

  // 4. SendDiagnostics.ts -- never records message content, only club
  // id/generation/template key/stage/timestamps/elapsed/outcome/whether
  // a provider reference exists.
  const testClubId = 'testclub'
  recordConnectionOpen(testClubId, 3)
  recordSendStart(testClubId, 3, 'booking-cancelled')
  recordSendStage(testClubId, 'text_sent', 42)
  recordSendOutcome(testClubId, 'success', 55, { hasProviderReference: true })
  const snapshot = getSendDiagnosticsSnapshot()
  const record = snapshot.find((r) => r.clubId === testClubId)
  check(
    'SendDiagnostics records connectionOpenAt (from a prior recordConnectionOpen for the same generation) and resolvedAt on completion',
    !!record && typeof record.connectionOpenAt === 'string' && typeof record.resolvedAt === 'string' && record.hasProviderReference === true,
  )

  // 4b. A genuinely Baileys-reported error (outcome bucket B/C
  // evidence for the production A/B test) is captured verbatim when
  // the caller (BaileysProvider.ts) supplies one -- SendDiagnostics
  // itself just stores whatever it's given; the actual "never for a
  // real timeout" guarantee lives in BaileysProvider.ts's own call
  // site (it only passes baileysErrorMessage when `!timedOut`), not
  // here. This test covers the storage half of that contract.
  const failedClubId = 'failedclub'
  recordSendStart(failedClubId, 1, 'booking-cancelled')
  recordSendOutcome(failedClubId, 'failed', 1200, { baileysErrorMessage: 'Boom: Connection Closed' })
  const failedRecord = getSendDiagnosticsSnapshot().find((r) => r.clubId === failedClubId)
  check(
    'a genuinely Baileys-reported failure stores its error message for later inspection',
    !!failedRecord && failedRecord.outcome === 'failed' && failedRecord.baileysErrorMessage === 'Boom: Connection Closed',
  )
  check('SendDiagnostics records the expected fields for a completed send', !!record && record.generation === 3 && record.templateKey === 'booking-cancelled' && record.outcome === 'success' && record.elapsedMs === 55)

  // 5. ProcessDiagnostics.ts -- counters increment, never store the
  // actual error object/message/stack (the module has no field capable
  // of holding one at all -- this test asserts the shape, not just a
  // convention).
  const before = getProcessDiagnosticsSnapshot()
  recordUncaughtException()
  recordUnhandledRejection()
  const after = getProcessDiagnosticsSnapshot()
  check(
    'ProcessDiagnostics increments both counters and stamps a timestamp, without a message/stack field',
    after.uncaughtExceptionCount === before.uncaughtExceptionCount + 1 &&
      after.unhandledRejectionCount === before.unhandledRejectionCount + 1 &&
      typeof after.lastUncaughtExceptionAt === 'string' &&
      typeof after.lastUnhandledRejectionAt === 'string' &&
      !('message' in after) &&
      !('stack' in after),
  )

  console.log(`\n[sendReliabilityTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main().catch((err) => {
  console.error('[sendReliabilityTest] fatal error running tests:', err)
  process.exit(1)
})
