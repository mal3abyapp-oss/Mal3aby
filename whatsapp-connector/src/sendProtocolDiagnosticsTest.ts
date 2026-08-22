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

check('assertSessions call with jids extracts ONLY the jids array LENGTH, never the JIDs themselves', () => {
  inspectBaileysLogCall([{ jids: ['971502061209@s.whatsapp.net', '201116505553@s.whatsapp.net', 'x@lid'] }, 'assertSessions call with jids'])
  const entry = latestRecorded()
  assert.equal(entry?.pattern, 'assertSessions_call_with_jids_counts')
  assert.equal(entry?.detail, 'jids=3')
  assert.ok(!entry?.detail.includes('@'), 'must never leak a raw JID into the captured detail')
})

check('fetching sessions extracts jidsRequiringFetch and wireJids array lengths, never their contents', () => {
  inspectBaileysLogCall([
    { jidsRequiringFetch: ['a@lid'], wireJids: ['a@lid', 'b@lid'] },
    'fetching sessions',
  ])
  const entry = latestRecorded()
  assert.equal(entry?.pattern, 'fetching_sessions_counts')
  assert.equal(entry?.detail, 'jidsRequiringFetch=1, wireJids=2')
})

check('a missing/non-array key in the merging object degrades to "?" instead of throwing', () => {
  inspectBaileysLogCall([{ jids: 'not-an-array' }, 'assertSessions call with jids'])
  assert.equal(latestRecorded()?.detail, 'jids=?')
})

check('an empty jids array is reported as 0, not treated as absent', () => {
  inspectBaileysLogCall([{ jids: [] }, 'assertSessions call with jids'])
  assert.equal(latestRecorded()?.detail, 'jids=0')
})

check('LID identity choice for this conversation is captured verbatim (no JID leakage in the template itself)', () => {
  inspectBaileysLogCall(['Using LID identity for @lid conversation'])
  assert.equal(latestRecorded()?.pattern, 'lid_or_pn_identity_choice')
  assert.equal(latestRecorded()?.detail, 'Using LID identity for @lid conversation')
})

check('PN identity choice for this conversation is captured verbatim', () => {
  inspectBaileysLogCall(['Using PN identity for @s.whatsapp.net conversation'])
  assert.equal(latestRecorded()?.pattern, 'lid_or_pn_identity_choice')
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
