/**
 * sendProtocolDiagnosticsTest.ts -- ROOT-CAUSE INVESTIGATION fix
 * (2026-08-22), regression coverage for inspectBaileysLogCall()
 * (SendProtocolDiagnostics.ts): the pure, allowlist-driven interceptor
 * that captures a strict, content-free subset of Baileys' own internal
 * debug-level log lines from the outbound send/relay path. See that
 * file's own doc comment for the full incident this closes.
 *
 * Run with: npx tsx src/sendProtocolDiagnosticsTest.ts
 */
import assert from 'node:assert/strict'
import { inspectBaileysLogCall, getSendProtocolDiagnosticsSnapshot } from './SendProtocolDiagnostics.js'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`[sendProtocolDiagnosticsTest] PASS - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`[sendProtocolDiagnosticsTest] FAIL - ${name}`)
    console.error(`  ${(err as Error).message}`)
  }
}

function latestRecorded() {
  return getSendProtocolDiagnosticsSnapshot().recent.at(-1)
}

check('a genuine "sending message to N devices" debug line (Baileys pino({msgId}, "text") call shape) is captured', () => {
  const before = getSendProtocolDiagnosticsSnapshot().totalRecorded
  inspectBaileysLogCall([{ msgId: 'ABC123' }, 'sending message to 3 devices'])
  const after = getSendProtocolDiagnosticsSnapshot()
  assert.equal(after.totalRecorded, before + 1)
  assert.equal(latestRecorded()?.pattern, 'sending_message_to_devices')
  assert.equal(latestRecorded()?.detail, 'sending message to 3 devices')
})

check('a session-error line (e.g. "Bad MAC") is captured under the session_error pattern', () => {
  inspectBaileysLogCall(['decryptMessage error: Bad MAC'])
  assert.equal(latestRecorded()?.pattern, 'session_error')
})

check('a "No session" line is captured', () => {
  inspectBaileysLogCall(['SessionError: No session found for this identity'])
  assert.equal(latestRecorded()?.pattern, 'session_error')
})

check('a retry-receipt line is captured', () => {
  inspectBaileysLogCall(['received retry receipt for message']) // matches /retry.?receipt/i
  assert.equal(latestRecorded()?.pattern, 'retry_receipt')
  assert.equal(latestRecorded()?.detail, 'retry receipt event')
})

check('an unrelated debug line not on the allowlist is NOT captured', () => {
  const before = getSendProtocolDiagnosticsSnapshot().totalRecorded
  inspectBaileysLogCall(['fetched profile picture url'])
  assert.equal(getSendProtocolDiagnosticsSnapshot().totalRecorded, before)
})

check('a call with no string argument at all is safely ignored, never throws', () => {
  const before = getSendProtocolDiagnosticsSnapshot().totalRecorded
  inspectBaileysLogCall([{ some: 'object' }])
  assert.equal(getSendProtocolDiagnosticsSnapshot().totalRecorded, before)
})

check('an empty args array is safely ignored, never throws', () => {
  const before = getSendProtocolDiagnosticsSnapshot().totalRecorded
  inspectBaileysLogCall([])
  assert.equal(getSendProtocolDiagnosticsSnapshot().totalRecorded, before)
})

check('a plain single-string call shape (args[0] is the message, no merging object) is still matched correctly', () => {
  const before = getSendProtocolDiagnosticsSnapshot().totalRecorded
  inspectBaileysLogCall(['sending message to 1 devices'])
  assert.equal(getSendProtocolDiagnosticsSnapshot().totalRecorded, before + 1)
  assert.equal(latestRecorded()?.pattern, 'sending_message_to_devices')
})

check('session_error detail is capped in length (defense in depth against an unexpectedly long log line)', () => {
  const longMsg = `Bad MAC ${'x'.repeat(500)}`
  inspectBaileysLogCall([longMsg])
  assert.ok((latestRecorded()?.detail.length ?? 0) <= 150)
})

console.log(`\n[sendProtocolDiagnosticsTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
if (failures > 0) process.exit(1)
