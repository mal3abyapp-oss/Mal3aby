/**
 * banProtectionTest.ts -- regression coverage for the ban-protection
 * hardening (2026-09-12): RestrictionSignalDetector.ts and
 * OptOutKeywordMatcher.ts. No real Baileys socket, no real Supabase
 * call -- pure functions/modules tested directly, same discipline as
 * statusFencingTest.ts / authDirClearedOnLogoutTest.ts.
 *
 * Run with: npx tsx src/banProtectionTest.ts
 */
import {
  recordForbiddenDisconnect,
  clearForbiddenDisconnectHistory,
  describeForbiddenPattern,
} from './RestrictionSignalDetector.js'
import { isOptOutKeyword, isKnownBanNoticeShape } from './OptOutKeywordMatcher.js'

let failures = 0
function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`[banProtectionTest] PASS - ${name}`)
  } else {
    failures += 1
    console.error(`[banProtectionTest] FAIL - ${name}${detail ? ` (${detail})` : ''}`)
  }
}

function main() {
  // ---- RestrictionSignalDetector ----
  {
    const key = 'test-club-restriction-1'
    clearForbiddenDisconnectHistory(key)

    check('a single 403 does NOT confirm a restriction pattern (threshold is 3)', !recordForbiddenDisconnect(key))
    check('a second 403 within the window still does NOT confirm the pattern', !recordForbiddenDisconnect(key))
    check('a THIRD 403 within the window DOES confirm the pattern (threshold reached)', recordForbiddenDisconnect(key))
    check(
      'the pattern description names the real count',
      describeForbiddenPattern(key).includes('3x'),
      describeForbiddenPattern(key),
    )

    clearForbiddenDisconnectHistory(key)
    check('clearing history resets the count -- a single 403 after clearing does not re-confirm', !recordForbiddenDisconnect(key))
  }

  {
    const keyA = 'test-club-restriction-a'
    const keyB = 'test-club-restriction-b'
    clearForbiddenDisconnectHistory(keyA)
    clearForbiddenDisconnectHistory(keyB)
    // Drive keyA's history to a confirmed pattern (3 disconnects).
    recordForbiddenDisconnect(keyA)
    recordForbiddenDisconnect(keyA)
    recordForbiddenDisconnect(keyA)
    // keyB has never recorded anything -- its own first call must NOT
    // confirm, proving the two identity keys track fully independent
    // histories rather than sharing one global counter.
    const keyBFirstCall = recordForbiddenDisconnect(keyB)
    check('two different identity keys (clubId / platform sentinel key) track fully independent histories -- a fresh key\'s first 403 never confirms regardless of another key\'s state', !keyBFirstCall)
  }

  // ---- OptOutKeywordMatcher: opt-out ----
  const optOutCases: Array<[string, boolean]> = [
    ['stop', true],
    ['STOP', true],
    ['unsubscribe', true],
    ['cancel', true],
    ['إيقاف', true],
    ['ايقاف', true], // common un-hamzated spelling -- hamzas are frequently dropped on phone keyboards
    ['توقف', true], // arguably the single most natural everyday Arabic word for "stop"
    ['وقف', true],
    ['إلغاء الاشتراك', true],
    ['  stop  ', true], // whitespace-tolerant
    ['please stop sending me these, I am busy at work today', false], // NOT a bare keyword -- ordinary sentence containing the word
    ['هل يمكنكم إيقاف تشغيل النظام؟', false], // contains إيقاف but is a real question, not a bare opt-out
    ['thanks, interested, tell me more', false],
    ['', false],
  ]
  for (const [text, expected] of optOutCases) {
    check(`isOptOutKeyword(${JSON.stringify(text)}) === ${expected}`, isOptOutKeyword(text) === expected)
  }

  // ---- OptOutKeywordMatcher: ban-notice shape ----
  const banNoticeCases: Array<[string, boolean]> = [
    ['Your account has been banned for violating our terms of service.', true],
    ['This account has been temporarily restricted.', true],
    ['We noticed you might be using an unauthorized app. Your account has been suspended.', true],
    ['Thanks for your message, we will get back to you soon.', false],
    ['Can you send the invoice again please?', false],
    ['', false],
  ]
  for (const [text, expected] of banNoticeCases) {
    check(`isKnownBanNoticeShape(${JSON.stringify(text.slice(0, 30))}...) === ${expected}`, isKnownBanNoticeShape(text) === expected)
  }

  console.log(`\n[banProtectionTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
  if (failures > 0) process.exit(1)
}

main()
