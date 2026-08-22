/**
 * resolveRealSendJidTest.ts -- ROOT-CAUSE INVESTIGATION fix (2026-08-22),
 * regression coverage for selectRealSendJid() (BaileysProvider.ts): the
 * pure decision logic behind resolving a recipient's real send-target
 * JID, preferring a genuine LID over the constructed plain-PN JID when
 * WhatsApp's own onWhatsApp() query proves one exists. See
 * sendMessage()'s and resolveRealSendJid()'s own doc comments in
 * BaileysProvider.ts for the full incident this fixes: the installed
 * @whiskeysockets/baileys@6.7.24 never auto-upgrades a recipient's PN
 * JID to LID even when that recipient's real account has migrated,
 * confirmed to correlate with real production sends that showed
 * provider_accepted_at but zero delivery receipt on a real,
 * physically-verified recipient phone.
 *
 * Run with: npx tsx src/resolveRealSendJidTest.ts
 */
import assert from 'node:assert/strict'
import { selectRealSendJid } from './BaileysProvider.js'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`[resolveRealSendJidTest] PASS - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`[resolveRealSendJidTest] FAIL - ${name}`)
    console.error(`  ${(err as Error).message}`)
  }
}

const PN_JID = '971502061209@s.whatsapp.net'

check('a genuine registered contact with a real LID resolves to the LID, not the PN JID', () => {
  const result = selectRealSendJid(
    [{ jid: PN_JID, exists: true, lid: '214417870442550@lid' }],
    PN_JID,
    '971502061209',
  )
  assert.equal(result, '214417870442550@lid')
})

check('a registered contact with NO lid field falls back to the original PN JID unchanged', () => {
  const result = selectRealSendJid([{ jid: PN_JID, exists: true, lid: undefined }], PN_JID, '971502061209')
  assert.equal(result, PN_JID)
})

check('a registered contact whose lid is an empty string falls back to the PN JID (not a usable LID)', () => {
  const result = selectRealSendJid([{ jid: PN_JID, exists: true, lid: '' }], PN_JID, '971502061209')
  assert.equal(result, PN_JID)
})

check('exists:false (should not normally appear -- onWhatsApp() itself filters these -- but handled defensively) never uses the lid even if present', () => {
  const result = selectRealSendJid([{ jid: PN_JID, exists: false, lid: '214417870442550@lid' }], PN_JID, '971502061209')
  assert.equal(result, PN_JID)
})

check('undefined results array (a failed/empty lookup) falls back to the PN JID, never throws', () => {
  const result = selectRealSendJid(undefined, PN_JID, '971502061209')
  assert.equal(result, PN_JID)
})

check('an empty results array falls back to the PN JID', () => {
  const result = selectRealSendJid([], PN_JID, '971502061209')
  assert.equal(result, PN_JID)
})

check('no matching entry for this specific JID in a multi-result array falls back to the PN JID', () => {
  const result = selectRealSendJid(
    [{ jid: '201012345678@s.whatsapp.net', exists: true, lid: '999@lid' }],
    PN_JID,
    '971502061209',
  )
  assert.equal(result, PN_JID)
})

check('matches by phone-digits prefix when the returned jid has a device suffix, not an exact string match', () => {
  const result = selectRealSendJid(
    [{ jid: '971502061209:5@s.whatsapp.net', exists: true, lid: '214417870442550@lid' }],
    PN_JID,
    '971502061209',
  )
  assert.equal(result, '214417870442550@lid')
})

check('a non-string lid value (defensive -- the upstream type is genuinely `unknown`) falls back to the PN JID', () => {
  const result = selectRealSendJid([{ jid: PN_JID, exists: true, lid: 12345 }], PN_JID, '971502061209')
  assert.equal(result, PN_JID)
})

console.log(`\n[resolveRealSendJidTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
if (failures > 0) process.exit(1)
