/**
 * index.test.ts -- SEND-1 fix (2026-09-19, owner brief): covers the
 * real new logic this fix adds -- deciding what
 * sales_mark_outreach_sent() call a given send outcome maps to (which
 * failures retry with backoff vs. fail permanently, no recipient
 * pre-check). Same plain-node-assertions pattern as
 * ./templates.test.ts. Run with:
 *   npx tsx src/index.test.ts
 */
import assert from 'node:assert/strict'
import { decideMarkOutreachSentParams } from './index.js'

let passed = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    passed += 1
    console.log(`[index.test] PASS: ${name}`)
  } catch (err) {
    console.error(`[index.test] FAIL: ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

check('no recipient email is a permanent failure, never retried', () => {
  const params = decideMarkOutreachSentParams('msg-1', null)
  assert.equal(params.p_success, false)
  assert.equal(params.p_permanent, true)
  assert.match(params.p_error ?? '', /no public_email/)
})

check('a sent result reports success with the provider reference', () => {
  const params = decideMarkOutreachSentParams('msg-2', 'lead@example.com', {
    outcome: 'sent',
    providerReference: 're_abc123',
  })
  assert.equal(params.p_success, true)
  assert.equal(params.p_provider_reference, 're_abc123')
})

check('a sent result with no provider reference falls back to null, never undefined', () => {
  const params = decideMarkOutreachSentParams('msg-3', 'lead@example.com', {
    outcome: 'sent',
    providerReference: '',
  })
  assert.equal(params.p_provider_reference, null)
})

check('rate_limited retries (not permanent) and carries the Retry-After hint through', () => {
  const params = decideMarkOutreachSentParams('msg-4', 'lead@example.com', {
    outcome: 'rate_limited',
    retryAfterSeconds: 30,
  })
  assert.equal(params.p_success, false)
  assert.equal(params.p_permanent, false)
  assert.equal(params.p_retry_after_seconds, 30)
})

check('rate_limited with no Retry-After header still retries, with a null hint (backoff ladder decides the delay)', () => {
  const params = decideMarkOutreachSentParams('msg-5', 'lead@example.com', {
    outcome: 'rate_limited',
    retryAfterSeconds: null,
  })
  assert.equal(params.p_permanent, false)
  assert.equal(params.p_retry_after_seconds, null)
})

check('permanent_failure (4xx, invalid recipient/request) fails immediately, never retried', () => {
  const params = decideMarkOutreachSentParams('msg-6', 'lead@example.com', {
    outcome: 'permanent_failure',
    statusCode: 422,
    errorClass: 'invalid_request_or_recipient',
  })
  assert.equal(params.p_success, false)
  assert.equal(params.p_permanent, true)
  assert.match(params.p_error ?? '', /permanent_failure: invalid_request_or_recipient \(status 422\)/)
})

check('temporary_failure (5xx/network) retries with backoff, never fails immediately', () => {
  const params = decideMarkOutreachSentParams('msg-7', 'lead@example.com', {
    outcome: 'temporary_failure',
    statusCode: 503,
    errorClass: 'provider_5xx',
  })
  assert.equal(params.p_success, false)
  assert.equal(params.p_permanent, false)
  assert.match(params.p_error ?? '', /temporary_failure: provider_5xx \(status 503\)/)
})

check('a recipient email present but no result argument throws rather than silently marking sent/failed', () => {
  assert.throws(() => decideMarkOutreachSentParams('msg-8', 'lead@example.com'))
})

console.log(`\n[index.test] ${passed} test(s) passed.`)
if (process.exitCode !== 1) {
  console.log('[index.test] ALL TESTS PASSED.')
}
